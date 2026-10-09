const fs = require('fs');
const { JsonStore } = require('./store');

const parseOnlinePlayers = (listResponse) => {
    const match = /online:(.*)$/m.exec(listResponse || '');
    if (!match) return [];
    return match[1].split(',').map((name) => name.trim()).filter(Boolean);
};

class PlayerTracker {
    constructor({ file, legacyFile }) {
        if (legacyFile && !fs.existsSync(file) && fs.existsSync(legacyFile)) {
            fs.copyFileSync(legacyFile, file);
        }
        this.store = new JsonStore(file, {});
        this.online = [];
        this.lastWrite = 0;
    }

    snapshot() {
        const history = this.store.get();
        return {
            active: this.online.map((name) => history[name]).filter(Boolean),
            history: Object.values(history).filter((player) => !this.online.includes(player.name)),
        };
    }

    // Applies an RCON `list` response. Returns true when the online set changed.
    update(listResponse) {
        const names = parseOnlinePlayers(listResponse);
        const changed = names.length !== this.online.length || names.some((name) => !this.online.includes(name));
        const now = Date.now();
        this.online = names;
        // lastSeen only needs minute precision; avoid rewriting the file every poll.
        if (!changed && now - this.lastWrite < 60000) return false;

        this.store.update((history) => {
            for (const name of names) {
                if (!history[name]) history[name] = { name, firstSeen: now, actions: [] };
                history[name].lastSeen = now;
                history[name].online = true;
            }
            for (const name of Object.keys(history)) {
                if (!names.includes(name)) history[name].online = false;
            }
        });
        this.lastWrite = now;
        return changed;
    }

    clearOnline() {
        if (!this.online.length) return false;
        this.online = [];
        this.store.update((history) => {
            for (const player of Object.values(history)) player.online = false;
        });
        return true;
    }

    count() {
        return this.online.length;
    }
}

module.exports = { PlayerTracker, parseOnlinePlayers };
