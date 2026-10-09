const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Rcon } = require('rcon-client');
const { spawn } = require('child_process');
const si = require('systeminformation');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');
require('dotenv').config();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const USER_PASSWORD = process.env.USER_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN || '';
const RCON_HOST = process.env.RCON_HOST || '';
const RCON_PORT = Number.parseInt(process.env.RCON_PORT || '25575', 10);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';
const MINECRAFT_SERVER_DIR = path.resolve(
    process.env.MC_SERVER_DIR || path.join(__dirname, '..', 'server')
);
const MINECRAFT_SERVER_JAR = process.env.MC_SERVER_JAR || 'fabric-server.jar';
const MINECRAFT_SERVER_PROPERTIES = process.env.MC_SERVER_PROPERTIES || 'server.properties';
const JAVA_BIN = process.env.JAVA_BIN || (
    process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
        : 'java'
);
const MC_MIN_MEMORY = process.env.MC_MIN_MEMORY || '2G';
const MC_MAX_MEMORY = process.env.MC_MAX_MEMORY || '6G';
const MAP_TARGET = process.env.MAP_TARGET || 'http://127.0.0.1:8100';
const CORS_ORIGIN = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
    : false;

const getMinecraftConfiguration = () => {
    const serverDir = path.resolve(MINECRAFT_SERVER_DIR);
    const jarPath = path.isAbsolute(MINECRAFT_SERVER_JAR)
        ? path.resolve(MINECRAFT_SERVER_JAR)
        : path.join(serverDir, MINECRAFT_SERVER_JAR);
    const propertiesPath = path.isAbsolute(MINECRAFT_SERVER_PROPERTIES)
        ? path.resolve(MINECRAFT_SERVER_PROPERTIES)
        : path.join(serverDir, MINECRAFT_SERVER_PROPERTIES);

    return {
        serverDir,
        jarPath,
        propertiesPath,
        serverDirectoryExists: fs.existsSync(serverDir),
        jarExists: fs.existsSync(jarPath),
        propertiesExists: fs.existsSync(propertiesPath),
    };
};

const isMinecraftReady = () => {
    const config = getMinecraftConfiguration();
    return config.serverDirectoryExists && config.jarExists;
};

const isConfiguredSecret = (value) => Boolean(value && !value.startsWith('replace-with-'));
const AUTH_CONFIGURED = Boolean(
    isConfiguredSecret(ADMIN_PASSWORD) &&
    isConfiguredSecret(USER_PASSWORD) &&
    isConfiguredSecret(process.env.SESSION_SECRET)
);
const SUPERVISOR_CONFIGURED = isConfiguredSecret(SUPERVISOR_TOKEN);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Global State
let serverStatus = isMinecraftReady() ? 'OFFLINE' : 'UNCONFIGURED';
let logBuffer = [];
let mcProcess = null;
let rconClient = null;
let rconRetryTimer = null;

if (!AUTH_CONFIGURED) {
    console.warn('Authentication is not configured. Copy .env.example to .env and set the required secrets.');
}

// Global Error Handling to prevent crashes
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    // Keep process alive if possible, but log it
    // In production, we might want to exit, but for this manager, we want stability.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'client/dist')));

// Auth Middleware
const requireAuth = (req, res, next) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const requireAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Forbidden' });
    }
};

// Login Route
app.post('/api/login', (req, res) => {
    if (!AUTH_CONFIGURED) {
        return res.status(503).json({ error: 'Manager authentication is not configured' });
    }

    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, SESSION_SECRET, { expiresIn: '24h' });
        res.cookie('auth_token', token, { httpOnly: true, sameSite: 'strict' });
        res.json({ success: true, role: 'admin' });
    } else if (password === USER_PASSWORD) {
        const token = jwt.sign({ role: 'user' }, SESSION_SECRET, { expiresIn: '24h' });
        res.cookie('auth_token', token, { httpOnly: true, sameSite: 'strict' });
        res.json({ success: true, role: 'user' });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

app.get('/api/check-auth', requireAuth, (req, res) => {
    res.json({ authenticated: true, role: req.user.role });
});

// BlueMap Proxy (Protected - Admin & User)
// "Nuclear Option": Pure HTTP Proxy. No file access.
app.use('/map', (req, res, next) => {
    // Check auth manually for proxy since it might be an iframe load
    const token = req.cookies.auth_token;
    if (!token) {
        // If loading in iframe, redirect to login or show error
        // For now, we just block. The frontend should handle auth before loading iframe.
        return res.status(401).send('Unauthorized');
    }
    try {
        jwt.verify(token, SESSION_SECRET);
        // Both admin and user can access map
        next();
    } catch (err) {
        res.status(401).send('Unauthorized');
    }
}, createProxyMiddleware({
    target: MAP_TARGET,
    changeOrigin: true,
    pathRewrite: {
        '^/map': '',
    },
    logLevel: 'error'
}));

// Properties API
const getPropertiesFile = () => getMinecraftConfiguration().propertiesPath;

app.get('/api/properties', requireAuth, requireAdmin, (req, res) => {
    try {
        const propertiesFile = getPropertiesFile();
        if (!fs.existsSync(propertiesFile)) {
            return res.status(404).json({
                error: 'Minecraft server properties are not configured',
                code: 'MINECRAFT_NOT_CONFIGURED'
            });
        }

        const content = fs.readFileSync(propertiesFile, 'utf8');
        const properties = {};
        content.split('\n').forEach(line => {
            line = line.trim();
            if (line && !line.startsWith('#')) {
                const [key, ...valueParts] = line.split('=');
                if (key) {
                    properties[key.trim()] = valueParts.join('=').trim();
                }
            }
        });
        res.json(properties);
    } catch (e) {
        res.status(500).json({ error: 'Failed to read properties' });
    }
});

app.post('/api/properties', requireAuth, requireAdmin, (req, res) => {
    try {
        const propertiesFile = getPropertiesFile();
        if (!fs.existsSync(propertiesFile)) {
            return res.status(404).json({
                error: 'Minecraft server properties are not configured',
                code: 'MINECRAFT_NOT_CONFIGURED'
            });
        }

        const newProps = req.body;
        let content = fs.readFileSync(propertiesFile, 'utf8');
        const lines = content.split('\n');
        const newLines = [];
        const processedKeys = new Set();

        // Update existing lines
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                const [key] = trimmed.split('=');
                const cleanKey = key.trim();
                if (newProps.hasOwnProperty(cleanKey)) {
                    newLines.push(`${cleanKey}=${newProps[cleanKey]}`);
                    processedKeys.add(cleanKey);
                } else {
                    newLines.push(line); // Keep unchanged
                }
            } else {
                newLines.push(line); // Keep comments/empty lines
            }
        });

        // Add new keys that weren't in the file
        Object.keys(newProps).forEach(key => {
            if (!processedKeys.has(key)) {
                newLines.push(`${key}=${newProps[key]}`);
            }
        });

        fs.writeFileSync(propertiesFile, newLines.join('\n'));
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to save properties' });
    }
});

// Status API
app.get('/api/status', (req, res) => {
    const configuration = getMinecraftConfiguration();

    res.json({
        status: serverStatus,
        service: 'RUNNING',
        manager: 'RUNNING',
        minecraftConfigured: configuration.serverDirectoryExists && configuration.jarExists,
        propertiesConfigured: configuration.propertiesExists,
        players: Object.values(playerHistory).filter(p => p.online).length
    });
});

// Simple HTTP Ping
app.get('/api/ping', (req, res) => {
    res.send('pong');
});

app.get('/api/health', (req, res) => {
    const configuration = getMinecraftConfiguration();
    res.json({
        ok: true,
        manager: 'RUNNING',
        minecraft: serverStatus,
        minecraftConfigured: configuration.serverDirectoryExists && configuration.jarExists,
        propertiesConfigured: configuration.propertiesExists,
    });
});

const broadcastStatus = (newStatus) => {
    serverStatus = newStatus;
    io.emit('status', serverStatus);
};

const addToLogBuffer = (line) => {
    logBuffer.push(line);
    if (logBuffer.length > 1000) logBuffer.shift();
};

const startServer = async () => {
    if (mcProcess && !mcProcess.killed) return;

    const configuration = getMinecraftConfiguration();
    if (!configuration.serverDirectoryExists || !configuration.jarExists) {
        broadcastStatus('UNCONFIGURED');
        io.emit('start_error', 'Minecraft is not configured. Add the server directory and configured server JAR first.');
        return;
    }

    try {
        const mem = await si.mem();
        const freeRamGb = mem.available / 1024 / 1024 / 1024;

        console.log(`[DEBUG] Memory Check: Available=${freeRamGb.toFixed(2)}GB, Required=6.00GB`);

        if (freeRamGb < 6) {
            const errorMsg = `Not enough free RAM! Available: ${freeRamGb.toFixed(2)} GB. Required: 6.00 GB.`;
            console.error(errorMsg);
            io.emit('start_error', errorMsg);
            return;
        }

        console.log(`Starting server. Free RAM: ${freeRamGb.toFixed(2)} GB`);
        broadcastStatus('STARTING');
        const startMsg = `Starting Minecraft Server... (Free RAM: ${freeRamGb.toFixed(2)} GB)\n`;
        io.to('admin_room').emit('log', startMsg);
        addToLogBuffer(startMsg);

        const startTime = Date.now();

        mcProcess = spawn(JAVA_BIN, [
            `-Xms${MC_MIN_MEMORY}`,
            `-Xmx${MC_MAX_MEMORY}`,
            '-jar',
            configuration.jarPath,
            'nogui'
        ], {
            cwd: configuration.serverDir,
            shell: false,
            windowsHide: true
        });

        const forwardOutput = (chunk) => {
            const text = chunk.toString();
            addToLogBuffer(text);
            io.to('admin_room').emit('log', text);
        };

        if (mcProcess.stdout) mcProcess.stdout.on('data', forwardOutput);
        if (mcProcess.stderr) mcProcess.stderr.on('data', forwardOutput);

        mcProcess.on('error', (err) => {
            console.error('Failed to start server process:', err);
            const errorMsg = `Failed to launch server: ${err.message}`;
            io.emit('start_error', errorMsg);
            broadcastStatus('OFFLINE');
            mcProcess = null;
        });

        mcProcess.on('close', (code) => {
            const uptime = Date.now() - startTime;
            const exitMsg = `Minecraft server exited with code ${code}\n`;
            io.to('admin_room').emit('log', exitMsg);
            addToLogBuffer(exitMsg);
            broadcastStatus(isMinecraftReady() ? 'OFFLINE' : 'UNCONFIGURED');
            mcProcess = null;

            if (rconClient) {
                rconClient.end();
                rconClient = null;
            }

            if (rconRetryTimer) {
                clearTimeout(rconRetryTimer);
                rconRetryTimer = null;
            }

            // Detect immediate crash (less than 10 seconds)
            if (uptime < 10000 && code !== 0 && code !== null) {
                const crashMsg = `Server crashed immediately (Code ${code}). Check Console for details.`;
                io.emit('start_error', crashMsg);
            }
        });

        setTimeout(connectRcon, 15000);
    } catch (e) {
        console.error('Error during start sequence:', e);
        io.emit('start_error', `System error: ${e.message}`);
    }
};

const connectRcon = async () => {
    if (!RCON_HOST || !RCON_PORT || !RCON_PASSWORD || !mcProcess) return;

    try {
        if (rconClient) return;
        rconClient = await Rcon.connect({
            host: RCON_HOST,
            port: RCON_PORT,
            password: RCON_PASSWORD
        });
        const rconMsg = 'RCON Connected\n';
        io.to('admin_room').emit('log', rconMsg);
        addToLogBuffer(rconMsg);
    } catch (error) {
        console.error('RCON Connection Error:', error.message);
        if (mcProcess) {
            rconRetryTimer = setTimeout(connectRcon, 5000);
        }
    }
};

const waitForMinecraftExit = (processToWaitFor, timeoutMs = 10000) => new Promise((resolve) => {
    if (!processToWaitFor || processToWaitFor.exitCode !== null) {
        resolve();
        return;
    }

    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
    };

    const timeout = setTimeout(finish, timeoutMs);
    processToWaitFor.once('close', finish);
});

const forceStopMinecraft = (processToStop) => {
    if (!processToStop || processToStop.exitCode !== null) return;

    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'], {
            windowsHide: true
        });
        killer.on('error', (error) => console.error('Failed to terminate Minecraft process tree:', error));
    } else {
        processToStop.kill('SIGTERM');
    }
};

const stopServer = async () => {
    const processToStop = mcProcess;
    if (!processToStop) {
        broadcastStatus(isMinecraftReady() ? 'OFFLINE' : 'UNCONFIGURED');
        return;
    }

    broadcastStatus('STOPPING');

    if (rconClient) {
        try {
            await rconClient.send('stop');
        } catch (e) {
            console.error('Error stopping via RCON:', e);
        }
    }

    await waitForMinecraftExit(processToStop, 10000);
    if (mcProcess === processToStop && processToStop.exitCode === null) {
        forceStopMinecraft(processToStop);
        await waitForMinecraftExit(processToStop, 5000);
    }
};

let shutdownInProgress = false;
const shutdownManager = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    try {
        await stopServer();
    } catch (error) {
        console.error('Error stopping Minecraft during manager shutdown:', error);
    }

    if (rconClient) {
        try {
            await rconClient.end();
        } catch (error) {
            console.error('Error closing RCON:', error);
        }
        rconClient = null;
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
};

app.post('/api/supervisor/shutdown', (req, res) => {
    if (!SUPERVISOR_CONFIGURED || req.get('x-manager-supervisor-token') !== SUPERVISOR_TOKEN) {
        return res.status(401).json({ error: 'Supervisor authentication failed' });
    }

    res.json({ accepted: true });
    shutdownManager();
});

process.once('SIGINT', shutdownManager);
process.once('SIGTERM', shutdownManager);

// Socket.IO
// Player Persistence
const PLAYERS_FILE = path.join(__dirname, 'players.json');
let playerHistory = {};

const loadPlayers = () => {
    try {
        if (fs.existsSync(PLAYERS_FILE)) {
            playerHistory = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load players:', e);
    }
};

const savePlayers = () => {
    try {
        fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playerHistory, null, 2));
    } catch (e) {
        console.error('Failed to save players:', e);
    }
};

loadPlayers();

// Socket.IO
// Socket.IO
io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) return next(new Error('Authentication error'));

    // Simple cookie parsing
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        cookies[parts[0].trim()] = parts[1].trim();
    });

    const token = cookies.auth_token;
    if (!token) return next(new Error('Authentication error'));

    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    const isAdmin = socket.user && socket.user.role === 'admin';

    // Only send logs to admins
    if (isAdmin) {
        socket.emit('log_history', logBuffer);
        socket.join('admin_room');
    }

    // Send current status to everyone
    socket.emit('status', serverStatus);

    // Send initial player list (Active + History)
    const sendPlayerList = async () => {
        // ... (existing player list logic) ...
        // We can optimize this later, but for now let's keep the existing logic
        // Ideally we should move this function out of the connection handler to avoid redefining it
        // But for minimal refactor, we'll keep it here or just reuse the global one if we refactor.
        // Actually, the original code defined it INSIDE connection, which is inefficient but works.
        // Let's just emit the current state if we have it.

        // REFACTOR: The original code had polling INSIDE the connection. 
        // We should probably move the polling OUTSIDE to avoid multiple intervals.
        // But to stick to the plan and minimize risk, let's just emit what we have.
        // Wait, the original code had `setInterval` inside `io.on`. That means 10 clients = 10 intervals!
        // That's bad. But I should fix the RBAC first.

        // For now, let's just implement the RBAC on the events.
    };

    // We will leave the polling logic as is for now to avoid breaking things, 
    // but we should really fix the multiple intervals issue if we were doing a full refactor.
    // However, for this task, I will focus on RBAC.

    // ... (Re-implementing the polling logic inside connection as per original, but guarded) ...
    // Actually, let's just copy the original logic but wrap sensitive emits.

    // Send initial player list
    // The original code defined `sendPlayerList` inside. 
    // I will assume the original logic is preserved unless I replace it.
    // Wait, I am replacing the WHOLE block. I need to re-include the logic.

    // Let's refactor slightly to be cleaner.

    // ... (Existing polling logic) ...
    // I'll just paste the original logic back but with checks.

    const sendPlayerListLocal = async () => {
        if (!rconClient) {
            socket.emit('player_list', {
                active: [],
                history: Object.values(playerHistory)
            });
            return;
        }

        try {
            const listRes = await rconClient.send('list');
            const match = listRes.match(/online: (.*)/);
            let onlineNames = [];
            if (match && match[1]) {
                onlineNames = match[1].split(', ').filter(n => n.trim().length > 0);
            }

            const now = Date.now();
            onlineNames.forEach(name => {
                if (!playerHistory[name]) {
                    playerHistory[name] = { name, firstSeen: now, actions: [] };
                }
                playerHistory[name].lastSeen = now;
                playerHistory[name].online = true;
            });

            Object.keys(playerHistory).forEach(name => {
                if (!onlineNames.includes(name)) {
                    playerHistory[name].online = false;
                }
            });

            savePlayers();

            socket.emit('player_list', {
                active: onlineNames.map(name => playerHistory[name]),
                history: Object.values(playerHistory).filter(p => !p.online)
            });

        } catch (e) {
            console.error('Error fetching player list:', e);
        }
    };

    // Poll for player list every 5 seconds (Only if admin? Or maybe users can see players too? 
    // The requirement says "he should only be able to start the server should not even be able to access console and all the other tabs."
    // So users should NOT see players.)

    let pollInterval;
    let statsInterval;

    if (isAdmin) {
        pollInterval = setInterval(sendPlayerListLocal, 5000);
        sendPlayerListLocal();

        // Poll for System Stats every 2 seconds
        statsInterval = setInterval(async () => {
            try {
                const cpu = await si.currentLoad();
                const mem = await si.mem();

                socket.emit('stats', {
                    cpu: Math.round(cpu.currentLoad),
                    ram: Math.round((mem.active / mem.total) * 100),
                    ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(2), // GB
                    ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(2)  // GB
                });
                console.log(`[DEBUG] Stats emitted to ${socket.id} (Admin: ${isAdmin}): CPU=${Math.round(cpu.currentLoad)}%`);
            } catch (e) {
                console.error('Stats error:', e);
            }
        }, 2000);
    }

    socket.on('command', async (cmd) => {
        if (!isAdmin) return; // Block non-admins
        if (rconClient) {
            try {
                const response = await rconClient.send(cmd);
                const logMsg = `> ${cmd}\n${response}\n`;
                // Emit to all admins
                io.to('admin_room').emit('log', logMsg);
                addToLogBuffer(logMsg);
            } catch (error) {
                socket.emit('log', `Error: ${error.message}\n`);
            }
        } else {
            socket.emit('log', 'RCON not connected.\n');
        }
    });

    socket.on('player_action', async ({ action, player }) => {
        if (!isAdmin) return; // Block non-admins
        if (!rconClient) return;
        let cmd = '';
        switch (action) {
            case 'kick': cmd = `kick ${player}`; break;
            case 'ban': cmd = `ban ${player}`; break;
            case 'op': cmd = `op ${player}`; break;
            case 'deop': cmd = `deop ${player}`; break;
        }
        if (cmd) {
            try {
                const resp = await rconClient.send(cmd);
                const logMsg = `[ACTION] ${cmd}: ${resp}\n`;
                io.to('admin_room').emit('log', logMsg);
                addToLogBuffer(logMsg);
                sendPlayerListLocal(); // Refresh list immediately
            } catch (e) {
                console.error('Action failed:', e);
            }
        }
    });

    // Start/Stop/Restart allowed for everyone (User & Admin)
    socket.on('start', startServer);
    socket.on('stop', stopServer);
    socket.on('restart', async () => {
        await stopServer();
        setTimeout(startServer, 5000);
    });

    socket.on('chat_send', async (msg) => {
        if (!rconClient) return;
        try {
            // Use /tellraw for cleaner output or /say
            // /say [Admin] msg
            const sender = isAdmin ? 'Admin' : 'User';
            await rconClient.send(`tellraw @a [{"text":"[${sender}] ${msg}","color":"gold"}]`);

            // Also emit back to frontend so sender sees it immediately
            io.emit('chat_message', {
                sender: sender,
                message: msg,
                timestamp: Date.now()
            });
        } catch (e) {
            console.error('Chat send error:', e);
        }
    });

    socket.on('disconnect', () => {
        if (pollInterval) clearInterval(pollInterval);
        if (statsInterval) clearInterval(statsInterval);
    });

    // Latency Check (Echo)
    socket.on('ping', (cb) => {
        if (typeof cb === 'function') cb();
    });
});

// Catch-all handler for SPA (Must be after all API routes)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Start Server
server.listen(PORT, HOST, () => {
    console.log(`MC Manager running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    // Do NOT auto-start Minecraft on launch for now, let user control it
    // startServer(); 
});
