const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');

const config = require('./lib/config');
const { JsonStore } = require('./lib/store');
const { createAuth, parseCookieHeader } = require('./lib/auth');
const { Operations } = require('./lib/operations');
const { MinecraftServer } = require('./lib/minecraft');
const { Metrics } = require('./lib/metrics');
const { PlayerTracker } = require('./lib/players');
const { WorldManager } = require('./lib/worlds');
const { ServerInstaller } = require('./lib/installer');
const { BackupManager } = require('./lib/backups');

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const state = new JsonStore(path.join(config.DATA_DIR, 'state.json'), {
    schemaVersion: 1,
    profile: null,
    worlds: [],
    activeWorldId: null,
});
const operations = new Operations({ jobsDir: path.join(config.DATA_DIR, 'jobs') });
const minecraft = new MinecraftServer({ config, getProfile: () => state.get().profile, operations });
const players = new PlayerTracker({
    file: path.join(config.DATA_DIR, 'players.json'),
    legacyFile: path.join(__dirname, 'players.json'),
});
const metrics = new Metrics({ getMinecraftPid: () => minecraft.process?.pid });
const worlds = new WorldManager({ config, state, minecraft });
const installer = new ServerInstaller({ config, state, minecraft, operations, worlds });
const backups = new BackupManager({ config, state, minecraft, worlds, operations });
const auth = createAuth(config.SESSION_SECRET);

try {
    worlds.reconcile();
} catch (error) {
    console.error('World reconciliation failed:', error.message);
}

if (!config.AUTH_CONFIGURED) {
    console.warn('Authentication is not configured. Copy .env.example to .env and set the required secrets.');
}

process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: config.CORS_ORIGIN, methods: ['GET', 'POST'], credentials: true },
});

const ADMIN_ROOM = 'admin_room';
const STATS_ROOM = 'stats_room';
const roomSize = (room) => io.of('/').adapter.rooms.get(room)?.size || 0;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'client/dist')));

// BlueMap proxy (admin and user)
app.use('/map', (req, res, next) => {
    if (!auth.verify(req.cookies.auth_token)) return res.status(401).send('Unauthorized');
    next();
}, createProxyMiddleware({
    target: config.MAP_TARGET,
    changeOrigin: true,
    pathRewrite: { '^/map': '' },
    logLevel: 'error',
}));

let shutdownInProgress = false;
const shutdownManager = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    try {
        await minecraft.stopUnlocked();
    } catch (error) {
        console.error('Error stopping Minecraft during manager shutdown:', error);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
};

const routeDeps = { config, auth, state, minecraft, operations, players, worlds, installer, backups, io, shutdownManager };
app.use('/api', require('./routes/core')(routeDeps));
app.use('/api/server', require('./routes/server-install')(routeDeps));
app.use('/api/worlds', require('./routes/worlds')(routeDeps));
app.use('/api/backups', require('./routes/backups')(routeDeps));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
        error: status >= 500 && !err.code ? 'Internal server error' : err.message,
        code: err.code,
        current: err.current,
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Minecraft -> clients
minecraft.on('status', (status) => io.emit('status', status));
minecraft.on('log', (text) => io.to(ADMIN_ROOM).emit('log', text));
minecraft.on('start_error', (message) => io.emit('start_error', message));
minecraft.on('status', (status) => {
    if (status === 'ONLINE') worlds.touchActive();
});
minecraft.on('exit', () => {
    worlds.touchActive();
    if (players.clearOnline()) io.to(ADMIN_ROOM).emit('player_list', players.snapshot());
});
operations.on('change', (operation) => io.emit('operation', operation));
operations.on('job', (job) => io.to(ADMIN_ROOM).emit('job_update', job));

// One shared player poller; only polls while an admin is connected and RCON is up.
const pollPlayers = async () => {
    if (!roomSize(ADMIN_ROOM) || !minecraft.rcon) return;
    try {
        if (players.update(await minecraft.sendCommand('list'))) {
            io.to(ADMIN_ROOM).emit('player_list', players.snapshot());
        }
    } catch (error) {
        console.error('Error fetching player list:', error.message);
    }
};
setInterval(pollPlayers, 5000).unref();

// One shared stats sampler; only samples while someone has the System page open.
setInterval(async () => {
    if (!roomSize(STATS_ROOM)) return;
    try {
        io.to(STATS_ROOM).emit('stats', await metrics.sample());
    } catch (error) {
        console.error('Stats error:', error.message);
    }
}, 2000).unref();

const reportError = (socket, error) => {
    socket.emit('start_error', error.code === 'BUSY' ? `Busy: ${error.current.kind} is in progress.` : error.message);
};

io.use((socket, next) => {
    const user = auth.verify(parseCookieHeader(socket.handshake.headers.cookie).auth_token);
    if (!user) return next(new Error('Authentication error'));
    socket.user = user;
    next();
});

io.on('connection', (socket) => {
    const isAdmin = socket.user.role === 'admin';

    socket.emit('status', minecraft.refreshStatus());
    socket.emit('operation', operations.snapshot());

    if (isAdmin) {
        socket.join(ADMIN_ROOM);
        socket.emit('log_history', minecraft.logBuffer);
        socket.emit('player_list', players.snapshot());
        socket.emit('jobs', operations.listJobs({ active: true }));
    }

    // Start/stop/restart are allowed for every role.
    socket.on('start', () => minecraft.start().catch((error) => reportError(socket, error)));
    socket.on('stop', () => minecraft.stop().catch((error) => reportError(socket, error)));
    socket.on('restart', () => minecraft.restart().catch((error) => reportError(socket, error)));

    socket.on('stats_subscribe', () => {
        if (isAdmin) socket.join(STATS_ROOM);
    });
    socket.on('stats_unsubscribe', () => socket.leave(STATS_ROOM));

    socket.on('command', async (command) => {
        if (!isAdmin || typeof command !== 'string' || !command.trim()) return;
        try {
            const response = await minecraft.sendCommand(command.trim().slice(0, 1000));
            minecraft.appendLog(`> ${command}\n${response}\n`);
        } catch (error) {
            socket.emit('log', `Error: ${error.message}\n`);
        }
    });

    socket.on('player_action', async ({ action, player } = {}) => {
        if (!isAdmin || !minecraft.rcon) return;
        if (!['kick', 'ban', 'op', 'deop'].includes(action) || !/^[A-Za-z0-9_]{1,16}$/.test(player || '')) return;
        const command = `${action} ${player}`;
        try {
            const response = await minecraft.sendCommand(command);
            minecraft.appendLog(`[ACTION] ${command}: ${response}\n`);
            pollPlayers();
        } catch (error) {
            console.error('Action failed:', error.message);
        }
    });

    socket.on('chat_send', async (message) => {
        if (!minecraft.rcon || typeof message !== 'string' || !message.trim()) return;
        const sender = isAdmin ? 'Admin' : 'User';
        const text = message.trim().slice(0, 256);
        try {
            await minecraft.sendCommand(`tellraw @a ${JSON.stringify([{ text: `[${sender}] ${text}`, color: 'gold' }])}`);
            io.emit('chat_message', { sender, message: text, timestamp: Date.now() });
        } catch (error) {
            console.error('Chat send error:', error.message);
        }
    });

    socket.on('ping', (cb) => {
        if (typeof cb === 'function') cb();
    });
});

process.once('SIGINT', shutdownManager);
process.once('SIGTERM', shutdownManager);

server.listen(config.PORT, config.HOST, () => {
    console.log(`MC Manager running on http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
});
