const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');

const config = require('./lib/config');
require('./lib/logfile').attachLogFile(process.env.MANAGER_LOG_FILE);
const { JsonStore } = require('./lib/store');
const { createAuth, parseCookieHeader } = require('./lib/auth');
const { Operations } = require('./lib/operations');
const { MinecraftServer } = require('./lib/minecraft');
const { Metrics } = require('./lib/metrics');
const { PlayerTracker } = require('./lib/players');
const { WorldManager } = require('./lib/worlds');
const { ServerInstaller } = require('./lib/installer');
const { BackupManager } = require('./lib/backups');
const { AddonManager } = require('./lib/addons');
const { ModrinthProvider } = require('./lib/addons/modrinth');
const { CurseForgeProvider } = require('./lib/addons/curseforge');
const { ModPack } = require('./lib/modpack');
const { DiscordSync } = require('./lib/discord');
const { SetupManager } = require('./lib/setups');
const { WorldSwitcher } = require('./lib/world-switcher');
const { ClientSync } = require('./lib/client-sync');
const { LogEvents } = require('./lib/log-events');
const { Roster } = require('./lib/roster');
const { SystemInfo, parseTickQuery } = require('./lib/system-info');
const { MapControl } = require('./lib/map-control');
const { updateMotd } = require('./lib/motd');
const mojang = require('./lib/installer/mojang');

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
// The Multiplayer list shows which world is running, so players on an old entry see the switch.
minecraft.beforeStart = () => {
    const { profile, worlds: list = [], activeWorldId } = state.get();
    const world = list.find((entry) => entry.id === activeWorldId);
    updateMotd(config.PROPERTIES_FILE, { worldName: world?.name, loader: profile?.loader, minecraftVersion: profile?.minecraftVersion });
};
const installer = new ServerInstaller({ config, state, minecraft, operations, worlds });
const backups = new BackupManager({ config, state, minecraft, worlds, operations });
const addons = new AddonManager({
    config,
    state,
    minecraft,
    operations,
    providers: [
        new ModrinthProvider({ userAgent: config.MODRINTH_USER_AGENT }),
        new CurseForgeProvider({ apiKey: config.CURSEFORGE_API_KEY }),
    ],
});
const setups = new SetupManager({ config, state, minecraft, addons });
installer.setups = setups;
setups.migrate();
const switcher = new WorldSwitcher({ worlds, setups, backups, operations, minecraft, listReleases: mojang.listReleases });
const modpack = new ModPack({ config, state, addons });
const discord = new DiscordSync({ config, state, minecraft, worlds, players, modpack });
const clientSync = new ClientSync({ config, state, setups, addons, worlds, discord, modpack });
discord.clientSync = clientSync;
const logEvents = new LogEvents({ minecraft, requestsFile: path.join(config.DATA_DIR, 'join-requests.json') });
const roster = new Roster({ config, minecraft, players, logEvents });
const systemInfo = new SystemInfo({ config, state, minecraft });
const mapControl = new MapControl({ config, state, minecraft, addons });
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
const COMMS_ROOM = 'comms_room';
const CONSOLE_ROOM = 'console_room';
const MAP_ROOM = 'map_room';
const roomSize = (room) => io.of('/').adapter.rooms.get(room)?.size || 0;

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'client/dist')));

// BlueMap files (admin and user), served from the active world's map folder.
app.use('/map', (req, res) => {
    if (!auth.verify(req.cookies.auth_token)) return res.status(401).send('Unauthorized');
    return mapControl.serve(req, res);
});

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

const routeDeps = { config, auth, state, minecraft, operations, players, worlds, installer, backups, addons, discord, setups, switcher, clientSync, roster, systemInfo, mapControl, io, shutdownManager };
app.use('/api', require('./routes/core')(routeDeps));
app.use('/api/server', require('./routes/server-install')(routeDeps));
app.use('/api/worlds', require('./routes/worlds')(routeDeps));
app.use('/api/backups', require('./routes/backups')(routeDeps));
app.use('/api/addons', require('./routes/addons')(routeDeps));
app.use('/api/discord', require('./routes/discord')(routeDeps));
app.use('/api/setups', require('./routes/setups')(routeDeps));
app.use('/api/client', require('./routes/client').adminRouter(routeDeps));
app.use('/api/roster', require('./routes/roster')(routeDeps));
app.use('/api/system', require('./routes/system')(routeDeps));
app.use('/api/map', require('./routes/map')(routeDeps));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Player mod pack download (linked from Discord). The unguessable token is the only gate.
app.get('/pack/:token/:name', async (req, res, next) => {
    if (!discord.isValidToken(req.params.token)) return res.status(404).send('Not found');
    try {
        const pack = await modpack.build();
        res.download(pack.file, pack.fileName);
    } catch (error) {
        next(error);
    }
});

// Player game sync (setup script, agent, manifest, files).
app.use('/client/:token', require('./routes/client').publicRouter(routeDeps));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
        error: status >= 500 && !err.code ? 'Internal server error' : err.message,
        code: err.code,
        current: err.current,
        details: err.details,
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Minecraft -> clients
minecraft.on('status', (status) => io.emit('status', status));
minecraft.on('log', (text) => {
    if (roomSize(CONSOLE_ROOM)) io.to(CONSOLE_ROOM).emit('log', text);
});
minecraft.on('start_error', (message) => io.emit('start_error', message));
minecraft.on('status', (status) => {
    if (status === 'ONLINE') worlds.touchActive();
    discord.schedule();
});
minecraft.on('exit', () => {
    worlds.touchActive();
    if (players.clearOnline()) io.to(ADMIN_ROOM).emit('player_list', players.snapshot());
});
operations.on('change', (operation) => {
    io.emit('operation', operation);
    // Any finished operation may have changed mods, worlds or the install.
    if (!operation) discord.schedule();
});
operations.on('job', (job) => io.to(ADMIN_ROOM).emit('job_update', job));

// Players come and go through log lines (no polling); RCON `list` resyncs once it connects.
const playersChanged = () => {
    io.to(ADMIN_ROOM).emit('player_list', players.snapshot());
    discord.schedule();
};
const syncPlayers = async () => {
    if (!minecraft.rcon) return;
    try {
        if (players.update(await minecraft.sendCommand('list'))) playersChanged();
    } catch (error) {
        console.error('Error fetching player list:', error.message);
    }
};
minecraft.on('rcon', syncPlayers);
logEvents.on('event', (event) => {
    if (event.type === 'join' && players.join(event.name)) playersChanged();
    if (event.type === 'leave' && players.leave(event.name)) playersChanged();
    if (roomSize(COMMS_ROOM)) io.to(COMMS_ROOM).emit('comms_event', event);
});
logEvents.on('requests', () => io.to(ADMIN_ROOM).emit('roster_changed'));

// BlueMap follows the map room: render while watched, pause a minute after the last viewer leaves.
const onRoomChange = (room) => {
    if (room === MAP_ROOM) mapControl.setViewers(roomSize(MAP_ROOM));
};
io.of('/').adapter.on('join-room', onRoomChange);
io.of('/').adapter.on('leave-room', onRoomChange);
mapControl.onStatus = (view) => io.to(MAP_ROOM).emit('map_status', view);

// One shared stats sampler; only samples while someone has the System page open.
// Tick timing (RCON `tick query`) is sampled every other round.
let statsRound = 0;
setInterval(async () => {
    if (!roomSize(STATS_ROOM)) return;
    try {
        const sample = await metrics.sample();
        statsRound += 1;
        if (minecraft.rcon && statsRound % 2 === 0) {
            sample.tick = parseTickQuery(await minecraft.sendCommand('tick query').catch(() => ''));
        }
        io.to(STATS_ROOM).emit('stats', sample);
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

    socket.on('comms_subscribe', () => {
        if (!isAdmin) return;
        socket.join(COMMS_ROOM);
        socket.emit('comms_history', logEvents.history());
    });
    socket.on('comms_unsubscribe', () => socket.leave(COMMS_ROOM));

    socket.on('console_subscribe', () => {
        if (!isAdmin) return;
        socket.join(CONSOLE_ROOM);
        socket.emit('log_history', minecraft.logBuffer);
    });
    socket.on('console_unsubscribe', () => socket.leave(CONSOLE_ROOM));

    // Any role may watch the map; BlueMap renders only while someone does.
    socket.on('map_subscribe', () => {
        socket.join(MAP_ROOM);
        socket.emit('map_status', mapControl.view());
    });
    socket.on('map_unsubscribe', () => socket.leave(MAP_ROOM));

    socket.on('command', async (command) => {
        if (!isAdmin || typeof command !== 'string' || !command.trim()) return;
        try {
            const response = await minecraft.sendCommand(command.trim().slice(0, 1000));
            minecraft.appendLog(`> ${command}\n${response}\n`);
        } catch (error) {
            socket.emit('log', `Error: ${error.message}\n`);
        }
    });

    socket.on('chat_send', async (message) => {
        if (!isAdmin || !minecraft.rcon || typeof message !== 'string' || !message.trim()) return;
        const text = message.trim().slice(0, 256);
        try {
            await minecraft.sendCommand(`tellraw @a ${JSON.stringify([{ text: `[Admin] ${text}`, color: 'gold' }])}`);
            logEvents.push({ type: 'chat', name: 'Admin', message: text, dashboard: true });
        } catch (error) {
            socket.emit('start_error', `Message not sent: ${error.message}`);
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
    if (state.get().autoStartMinecraft && minecraft.isConfigured()) {
        console.log('Auto-start is on; starting Minecraft.');
        setTimeout(() => minecraft.start().catch((error) => console.error('Auto-start failed:', error.message)), 2000);
    }
});
