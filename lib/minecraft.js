const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Rcon } = require('rcon-client');
const { readPropertiesFile } = require('./properties');
const { OperationError } = require('./operations');

const LOG_BUFFER_LINES = 1000;
const GRACEFUL_STOP_MS = 60000;
const DONE_PATTERN = /\bDone \([\d.,]+s\)!/;

const parseMemory = (value) => {
    const match = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(String(value || '').trim());
    if (!match) return null;
    const units = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
    return Math.round(Number(match[1]) * (units[(match[2] || 'M').toUpperCase()]));
};

const formatGb = (bytes) => (bytes / 1024 ** 3).toFixed(2);

class MinecraftServer extends EventEmitter {
    constructor({ config, getProfile, operations }) {
        super();
        this.config = config;
        this.getProfile = getProfile;
        this.operations = operations;
        this.process = null;
        this.rcon = null;
        this.rconRetryTimer = null;
        this.logBuffer = [];
        this.partialLine = '';
        this.startedAt = null;
        this.status = this.isConfigured() ? 'OFFLINE' : 'UNCONFIGURED';
    }

    // Describes how to launch the server: from the installed profile, or the
    // .env fallback for a server that was set up by hand.
    getLaunchSpec() {
        const profile = this.getProfile();
        const serverDir = this.config.SERVER_DIR;
        if (profile) {
            const memory = profile.memory || {};
            const launch = profile.launch || {};
            const launchArgs = launch.type === 'argsfile'
                ? launch.argsFiles.map((file) => `@${file}`)
                : ['-jar', launch.jar];
            const requiredFiles = launch.type === 'argsfile'
                ? launch.argsFiles.map((file) => path.join(serverDir, file))
                : [path.join(serverDir, launch.jar)];
            return {
                javaBin: profile.javaPath,
                cwd: serverDir,
                minMemory: memory.min || this.config.fallback.minMemory,
                maxMemory: memory.max || this.config.fallback.maxMemory,
                launchArgs,
                requiredFiles,
            };
        }
        return {
            javaBin: this.config.fallback.javaBin,
            cwd: serverDir,
            minMemory: this.config.fallback.minMemory,
            maxMemory: this.config.fallback.maxMemory,
            launchArgs: ['-jar', this.config.fallback.serverJar],
            requiredFiles: [this.config.fallback.serverJar],
        };
    }

    isConfigured() {
        const spec = this.getLaunchSpec();
        return fs.existsSync(spec.cwd) && spec.requiredFiles.every((file) => fs.existsSync(file));
    }

    isRunning() {
        return Boolean(this.process);
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.emit('status', status);
    }

    refreshStatus() {
        if (!this.process) this.setStatus(this.isConfigured() ? 'OFFLINE' : 'UNCONFIGURED');
        return this.status;
    }

    appendLog(text) {
        this.logBuffer.push(text);
        if (this.logBuffer.length > LOG_BUFFER_LINES) this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_LINES);
        this.emit('log', text);
    }

    handleOutput(chunk) {
        const text = chunk.toString();
        this.appendLog(text);

        const lines = (this.partialLine + text).split(/\r?\n/);
        this.partialLine = lines.pop();
        for (const line of lines) {
            this.emit('line', line);
            if (this.status === 'STARTING' && DONE_PATTERN.test(line)) {
                this.setStatus('ONLINE');
                this.connectRcon(0);
            }
        }
    }

    // Resolves with the first output line matching pattern, or null on timeout.
    waitForLine(pattern, timeoutMs) {
        return new Promise((resolve) => {
            const onLine = (line) => {
                if (!pattern.test(line)) return;
                cleanup();
                resolve(line);
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve(null);
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                this.off('line', onLine);
            };
            this.on('line', onLine);
        });
    }

    rconSettings() {
        const properties = readPropertiesFile(this.config.PROPERTIES_FILE) || {};
        const fallback = this.config.fallback.rcon;
        if (properties['enable-rcon'] === 'true' && properties['rcon.password']) {
            return {
                host: '127.0.0.1',
                port: Number.parseInt(properties['rcon.port'] || '25575', 10),
                password: properties['rcon.password'],
            };
        }
        return fallback.password ? fallback : null;
    }

    async connectRcon(attempt) {
        clearTimeout(this.rconRetryTimer);
        if (!this.process || this.rcon) return;
        const settings = this.rconSettings();
        if (!settings) {
            this.appendLog('RCON is not enabled in server.properties; console commands are unavailable.\n');
            return;
        }

        try {
            const client = await Rcon.connect(settings);
            if (!this.process) {
                client.end().catch(() => {});
                return;
            }
            client.on('end', () => {
                if (this.rcon === client) this.rcon = null;
            });
            client.on('error', (error) => console.error('RCON error:', error.message));
            this.rcon = client;
            this.appendLog('RCON Connected\n');
            this.emit('rcon', true);
        } catch (error) {
            if (this.process && attempt < 12) {
                this.rconRetryTimer = setTimeout(() => this.connectRcon(attempt + 1), 5000);
            } else {
                console.error('RCON Connection Error:', error.message);
            }
        }
    }

    async sendCommand(command) {
        if (!this.rcon) throw new OperationError('RCON not connected.', { code: 'RCON_UNAVAILABLE', status: 409 });
        return this.rcon.send(command);
    }

    start() {
        return this.operations.runExclusive('start', () => this.startUnlocked());
    }

    stop() {
        return this.operations.runExclusive('stop', () => this.stopUnlocked());
    }

    restart() {
        return this.operations.runExclusive('restart', async () => {
            await this.stopUnlocked();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await this.startUnlocked();
        });
    }

    async startUnlocked() {
        if (this.process) return;

        if (!this.isConfigured()) {
            this.setStatus('UNCONFIGURED');
            throw new OperationError('Minecraft is not installed. Install the server from the Server page first.', {
                code: 'MINECRAFT_NOT_CONFIGURED',
            });
        }

        const spec = this.getLaunchSpec();
        const required = parseMemory(spec.maxMemory);
        const free = os.freemem();
        if (required && free < required) {
            throw new OperationError(
                `Not enough free RAM! Available: ${formatGb(free)} GB. Required: ${formatGb(required)} GB.`,
                { code: 'INSUFFICIENT_MEMORY' }
            );
        }

        this.setStatus('STARTING');
        this.appendLog(`Starting Minecraft Server... (Free RAM: ${formatGb(free)} GB)\n`);
        this.partialLine = '';
        this.startedAt = Date.now();

        const child = spawn(spec.javaBin, [
            `-Xms${spec.minMemory}`,
            `-Xmx${spec.maxMemory}`,
            ...spec.launchArgs,
            'nogui',
        ], {
            cwd: spec.cwd,
            shell: false,
            windowsHide: true,
        });
        this.process = child;

        child.stdout.on('data', (chunk) => this.handleOutput(chunk));
        child.stderr.on('data', (chunk) => this.handleOutput(chunk));

        child.on('error', (error) => {
            console.error('Failed to start server process:', error);
            this.emit('start_error', `Failed to launch server: ${error.message}`);
        });

        child.on('close', (code) => {
            const uptime = Date.now() - this.startedAt;
            this.appendLog(`Minecraft server exited with code ${code}\n`);
            if (this.process === child) this.process = null;
            clearTimeout(this.rconRetryTimer);
            if (this.rcon) {
                this.rcon.end().catch(() => {});
                this.rcon = null;
            }
            this.refreshStatus();
            this.emit('exit', { code, uptime });

            if (uptime < 10000 && code !== 0 && code !== null) {
                this.emit('start_error', `Server crashed immediately (Code ${code}). Check Console for details.`);
            }
        });
    }

    waitForExit(child, timeoutMs) {
        if (!child || child.exitCode !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            child.once('close', () => {
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    async stopUnlocked() {
        const child = this.process;
        if (!child) {
            this.refreshStatus();
            return;
        }

        this.setStatus('STOPPING');

        // RCON when available; the server console on stdin otherwise (e.g. while
        // still starting, before RCON is up).
        let requested = false;
        if (this.rcon) {
            try {
                await this.rcon.send('stop');
                requested = true;
            } catch (error) {
                console.error('Error stopping via RCON:', error.message);
            }
        }
        if (!requested && child.stdin && child.stdin.writable) {
            child.stdin.write('stop\n');
        }

        if (await this.waitForExit(child, GRACEFUL_STOP_MS)) return;

        this.appendLog('Server did not stop in time; terminating the process.\n');
        if (process.platform === 'win32') {
            spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
                .on('error', (error) => console.error('Failed to terminate Minecraft process tree:', error));
        } else {
            child.kill('SIGKILL');
        }
        await this.waitForExit(child, 10000);
    }
}

module.exports = { MinecraftServer, parseMemory };
