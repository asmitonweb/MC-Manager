/* eslint-disable no-console */
// End-to-end check against a throwaway sandbox. Starts a second manager on
// 127.0.0.1:3999 with SANDBOX_ROOT pointing at an empty folder, so the real
// server, worlds and backups are never touched.
//
//   node test/e2e/e2e.cjs <sandbox-dir> [fabric|forge] [minecraft-version] [scenarios...]
//
// Scenarios: install (always), run, worlds, backups, mods
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const { io } = require(path.join(APP_ROOT, 'client', 'node_modules', 'socket.io-client'));

const [sandbox, loader = 'fabric', minecraftVersion = '', ...scenarioArgs] = process.argv.slice(2);
if (!sandbox) {
    console.error('Usage: node test/e2e/e2e.cjs <sandbox-dir> [fabric|forge] [minecraft-version] [scenarios...]');
    process.exit(2);
}
const scenarios = new Set(scenarioArgs.length ? scenarioArgs : ['run']);
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'e2e-admin';
let cookie = '';

const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const api = async (method, url, body) => {
    const res = await fetch(BASE + url, {
        method,
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
};

const waitForJob = async (job, timeoutMs = 15 * 60 * 1000) => {
    const deadline = Date.now() + timeoutMs;
    let lastStep = '';
    while (Date.now() < deadline) {
        const current = await api('GET', `/api/jobs/${job.id}`);
        if (current.step !== lastStep) {
            log(`  job ${current.kind}: ${current.progress}% ${current.step}`);
            lastStep = current.step;
        }
        if (current.status === 'succeeded') return current;
        if (current.status === 'failed') throw new Error(`Job failed: ${current.error.message}\n${current.log.slice(-15).join('\n')}`);
        await sleep(1500);
    }
    throw new Error('Job timed out');
};

const connectSocket = () => new Promise((resolve, reject) => {
    const socket = io(BASE, { extraHeaders: { cookie } });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
});

const waitForStatus = (socket, wanted, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${wanted}`)), timeoutMs);
    const onStatus = (status) => {
        if (status !== wanted) return;
        clearTimeout(timer);
        socket.off('status', onStatus);
        resolve();
    };
    socket.on('status', onStatus);
});

const startAndCheck = async (socket) => {
    const errors = [];
    socket.on('start_error', (message) => errors.push(message));
    const online = waitForStatus(socket, 'ONLINE', 5 * 60 * 1000);
    socket.emit('start');
    await Promise.race([online, sleep(5 * 60 * 1000).then(() => { throw new Error(errors.join('; ') || 'no ONLINE'); })]);
    log('  server ONLINE');
    for (let i = 0; i < 20; i += 1) {
        const status = await api('GET', '/api/status');
        if (status.status === 'ONLINE') break;
        await sleep(500);
    }
};

const runCommand = (socket, command) => new Promise((resolve) => {
    const onLog = (text) => {
        if (!text.startsWith(`> ${command}`)) return;
        socket.off('log', onLog);
        resolve(text);
    };
    socket.on('log', onLog);
    socket.emit('command', command);
    setTimeout(() => resolve(null), 10000);
});

const stopAndCheck = async (socket) => {
    const offline = waitForStatus(socket, 'OFFLINE', 120000);
    socket.emit('stop');
    await offline;
    log('  server OFFLINE');
};

const main = async () => {
    fs.mkdirSync(sandbox, { recursive: true });
    const manager = spawn(process.execPath, ['server.js'], {
        cwd: APP_ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            HOST: '127.0.0.1',
            ADMIN_PASSWORD: ADMIN,
            USER_PASSWORD: 'e2e-user',
            SESSION_SECRET: 'e2e-session-secret',
            SUPERVISOR_TOKEN: 'e2e-supervisor',
            SANDBOX_ROOT: sandbox,
            MC_SERVER_DIR: '',
            BACKUP_DIR: '',
            MANAGER_DATA_DIR: '',
            RCON_PASSWORD: '',
            CURSEFORGE_API_KEY: process.env.CURSEFORGE_API_KEY || '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const managerLog = fs.createWriteStream(path.join(sandbox, 'manager.log'));
    manager.stdout.pipe(managerLog);
    manager.stderr.pipe(managerLog);

    try {
        for (let i = 0; i < 30; i += 1) {
            try {
                await api('GET', '/api/health');
                break;
            } catch {
                await sleep(500);
            }
        }
        // The user role must not reach admin APIs.
        const userLogin = await fetch(`${BASE}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'e2e-user' }),
        });
        const userCookie = userLogin.headers.get('set-cookie').split(';')[0];
        for (const url of ['/api/worlds', '/api/backups', '/api/addons/providers', '/api/server/install/options', '/api/properties', '/api/jobs']) {
            const res = await fetch(BASE + url, { headers: { cookie: userCookie } });
            if (res.status !== 403) throw new Error(`user role got ${res.status} for ${url}`);
        }
        log('User role is refused by admin APIs (403)');

        await api('POST', '/api/login', { password: ADMIN });

        const versions = await api('GET', `/api/server/install/versions?loader=${loader}`);
        const mc = minecraftVersion || versions[0].id;
        log(`Installing ${loader} for Minecraft ${mc}`);
        const preview = await api('POST', '/api/server/install/preview', { loader, minecraftVersion: mc, worldName: 'E2E World', memory: { min: '1G', max: '2G' } });
        log(`  preview: ${preview.loaderVersion}, Java ${preview.java && preview.java.major}, warnings=${JSON.stringify(preview.warnings)}`);
        const job = await api('POST', '/api/server/install', {
            loader,
            minecraftVersion: mc,
            worldName: 'E2E World',
            memory: { min: '1G', max: '2G' },
            acceptEula: true,
            acceptJavaRisk: true,
        });
        await waitForJob(job);
        const status = await api('GET', '/api/status');
        log(`  installed; status=${status.status}`);
        if (status.status !== 'OFFLINE') throw new Error('Expected OFFLINE after install');

        // Keep the test server off the network.
        const props = path.join(sandbox, 'server', 'server.properties');
        fs.appendFileSync(props, 'server-ip=127.0.0.1\nserver-port=25599\nrcon.port=25598\nonline-mode=false\n');

        const socket = await connectSocket();
        const context = { api, socket, log, sleep, waitForJob, startAndCheck, stopAndCheck, runCommand, sandbox, loader, mc };

        if (scenarios.has('run')) {
            log('Scenario: run');
            await startAndCheck(socket);
            const list = await runCommand(socket, 'list');
            if (!list || !/players online/.test(list)) throw new Error(`RCON list failed: ${list}`);
            log('  RCON list ok');
            await stopAndCheck(socket);
        }
        for (const name of ['worlds', 'backups', 'mods', 'setups']) {
            if (!scenarios.has(name)) continue;
            log(`Scenario: ${name}`);
            await require(`./scenario-${name}.cjs`)(context);
        }

        socket.disconnect();
        log('E2E PASSED');
    } finally {
        await fetch(`${BASE}/api/supervisor/shutdown`, { method: 'POST', headers: { 'x-manager-supervisor-token': 'e2e-supervisor' } }).catch(() => {});
        await sleep(2000);
        if (manager.exitCode === null) manager.kill();
    }
};

main().then(() => process.exit(0), (error) => {
    console.error('E2E FAILED:', error.message);
    process.exit(1);
});
