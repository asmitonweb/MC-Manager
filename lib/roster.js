const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./store');
const { readPropertiesFile, updatePropertiesFile } = require('./properties');
const { offlineUuid } = require('./offline-uuid');
const { OperationError } = require('./operations');

const NAME = /^[A-Za-z0-9_]{1,16}$/;
const ACTIONS = ['whitelist-add', 'whitelist-remove', 'approve', 'deny', 'op', 'deop', 'ban', 'pardon', 'kick'];

const readJson = (file, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
};

// banned-players.json uses "yyyy-MM-dd HH:mm:ss +ZZZZ".
const banDate = (date = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
};

/**
 * Personnel: one list merged from the server's whitelist, ops and bans, the
 * manager's play history and refused logins (join requests). Changes go
 * through RCON while the server runs, otherwise straight into the JSON files.
 */
class Roster {
    constructor({ config, minecraft, players, logEvents }) {
        this.config = config;
        this.minecraft = minecraft;
        this.players = players;
        this.logEvents = logEvents;
    }

    file(name) {
        return path.join(this.config.SERVER_DIR, name);
    }

    properties() {
        return readPropertiesFile(this.config.PROPERTIES_FILE) || {};
    }

    offlineMode() {
        return this.properties()['online-mode'] === 'false';
    }

    running() {
        return Boolean(this.minecraft.rcon);
    }

    uuidFor(name) {
        const cached = readJson(this.file('usercache.json'), []).find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
        if (cached?.uuid) return cached.uuid;
        return this.offlineMode() ? offlineUuid(name) : null;
    }

    view() {
        const props = this.properties();
        const whitelist = readJson(this.file('whitelist.json'), []);
        const ops = readJson(this.file('ops.json'), []);
        const bans = readJson(this.file('banned-players.json'), []);
        const history = this.players.all();
        const online = new Set(this.players.online);
        const byName = new Map();
        const entry = (name) => {
            const key = name.toLowerCase();
            if (!byName.has(key)) byName.set(key, { name, online: false, whitelisted: false, op: false, banned: false });
            return byName.get(key);
        };
        for (const player of Object.values(history)) {
            Object.assign(entry(player.name), {
                firstSeen: player.firstSeen || null,
                lastSeen: player.lastSeen || null,
                playtimeMs: (player.playtimeMs || 0) + (player.sessionStart && online.has(player.name) ? Date.now() - player.sessionStart : 0),
                joins: player.joins || 0,
            });
        }
        for (const name of online) entry(name).online = true;
        for (const item of whitelist) if (item.name) entry(item.name).whitelisted = true;
        for (const item of ops) if (item.name) Object.assign(entry(item.name), { op: true, opLevel: item.level });
        for (const item of bans) if (item.name) Object.assign(entry(item.name), { banned: true, banReason: item.reason || null, bannedAt: item.created || null });
        return {
            whitelistEnabled: props['white-list'] === 'true',
            enforceWhitelist: props['enforce-whitelist'] === 'true',
            offlineMode: props['online-mode'] === 'false',
            running: this.running(),
            players: [...byName.values()].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name)),
            requests: this.logEvents.listRequests().filter((request) => !whitelist.some((item) => item.name?.toLowerCase() === request.name.toLowerCase())),
        };
    }

    async rcon(command) {
        const response = await this.minecraft.sendCommand(command);
        this.minecraft.appendLog(`[Personnel] ${command}: ${response}\n`);
        return response;
    }

    editList(fileName, name, add, extra = {}) {
        const file = this.file(fileName);
        const list = readJson(file, []).filter((item) => item.name?.toLowerCase() !== name.toLowerCase());
        if (add) {
            const uuid = this.uuidFor(name);
            if (!uuid) throw new OperationError(`Can't look up ${name}'s account while the server is stopped. Start it and try again.`, { code: 'UUID_UNKNOWN', status: 409 });
            list.push({ uuid, name, ...extra });
        }
        writeJsonAtomic(file, list);
    }

    async act({ action, name } = {}) {
        if (!ACTIONS.includes(action)) throw new OperationError('Unknown action.', { code: 'INVALID_REQUEST' });
        if (!NAME.test(name || '')) throw new OperationError('Player names are 1–16 letters, digits or _.', { code: 'INVALID_REQUEST' });
        const running = this.running();
        let message = null;
        switch (action) {
            case 'approve':
            case 'whitelist-add':
                // Offline-mode servers resolve names to Mojang accounts in commands, so edit the file and reload.
                if (running && !this.offlineMode()) {
                    message = await this.rcon(`whitelist add ${name}`);
                } else {
                    this.editList('whitelist.json', name, true);
                    if (running) message = await this.rcon('whitelist reload');
                }
                this.logEvents.dismissRequest(name);
                break;
            case 'deny':
                this.logEvents.dismissRequest(name);
                break;
            case 'whitelist-remove':
                if (running) message = await this.rcon(`whitelist remove ${name}`);
                else this.editList('whitelist.json', name, false);
                break;
            case 'op':
            case 'deop':
                if (running) message = await this.rcon(`${action} ${name}`);
                else this.editList('ops.json', name, action === 'op', { level: 4, bypassesPlayerLimit: false });
                break;
            case 'ban':
            case 'pardon':
                if (running) message = await this.rcon(`${action} ${name}`);
                else this.editList('banned-players.json', name, action === 'ban', { created: banDate(), source: 'MC Manager', expires: 'forever', reason: 'Banned by an operator.' });
                break;
            case 'kick':
                if (!running) throw new OperationError('The server is not running.', { code: 'SERVER_NOT_RUNNING', status: 409 });
                message = await this.rcon(`kick ${name}`);
                break;
            default:
                break;
        }
        return { message, ...this.view() };
    }

    async setWhitelist(enabled) {
        updatePropertiesFile(this.config.PROPERTIES_FILE, { 'white-list': String(Boolean(enabled)), 'enforce-whitelist': String(Boolean(enabled)) });
        let message = null;
        if (this.running()) message = await this.rcon(`whitelist ${enabled ? 'on' : 'off'}`);
        return { message, ...this.view() };
    }
}

module.exports = { Roster, banDate };
