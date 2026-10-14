const fs = require('fs');
const { JsonStore } = require('./store');

const parseOnlinePlayers = (listResponse) => {
    const match = /online:(.*)$/m.exec(listResponse || '');
    if (!match) return [];
    return match[1].split(',').map((name) => name.trim()).filter(Boolean);
};

/**
 * Who is online and who has played. Kept current from join/leave lines in the
 * server log; an RCON `list` resyncs it when RCON connects.
 */
class PlayerTracker {
    constructor({ file, legacyFile }) {
        if (legacyFile && !fs.existsSync(file) && fs.existsSync(legacyFile)) {
            fs.copyFileSync(legacyFile, file);
        }
        this.store = new JsonStore(file, {});
        this.online = [];
    }

    snapshot() {
        const history = this.store.get();
        return {
            active: this.online.map((name) => history[name]).filter(Boolean),
            history: Object.values(history).filter((player) => !this.online.includes(player.name)),
        };
    }

    all() {
        return this.store.get();
    }

    /** A player joined. Returns true when the online set changed. */
    join(name) {
        if (this.online.includes(name)) return false;
        this.online = [...this.online, name];
        const now = Date.now();
        this.store.update((history) => {
            if (!history[name]) history[name] = { name, firstSeen: now, actions: [] };
            Object.assign(history[name], { online: true, lastSeen: now, sessionStart: now, joins: (history[name].joins || 0) + 1 });
        });
        return true;
    }

    /** A player left; their session is added to their playtime. Returns true when the online set changed. */
    leave(name) {
        const wasOnline = this.online.includes(name);
        this.online = this.online.filter((entry) => entry !== name);
        const now = Date.now();
        this.store.update((history) => {
            const player = history[name];
            if (!player) return;
            if (player.sessionStart) player.playtimeMs = (player.playtimeMs || 0) + Math.max(0, now - player.sessionStart);
            Object.assign(player, { online: false, lastSeen: now, sessionStart: null });
        });
        return wasOnline;
    }

    // Applies an RCON `list` response. Returns true when the online set changed.
    update(listResponse) {
        const names = parseOnlinePlayers(listResponse);
        let changed = false;
        for (const name of this.online.filter((entry) => !names.includes(entry))) changed = this.leave(name) || changed;
        for (const name of names) changed = this.join(name) || changed;
        return changed;
    }

    clearOnline() {
        if (!this.online.length) return false;
        for (const name of [...this.online]) this.leave(name);
        return true;
    }

    count() {
        return this.online.length;
    }
}

module.exports = { PlayerTracker, parseOnlinePlayers };
