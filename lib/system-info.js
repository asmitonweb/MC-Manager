const fs = require('fs');
const path = require('path');
const { freeDiskBytes } = require('./archive');

const DISK_CACHE_MS = 5 * 60 * 1000;

const dirSize = async (dir) => {
    let total = 0;
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await dirSize(full);
        else if (entry.isFile()) total += (await fs.promises.stat(full).catch(() => ({ size: 0 }))).size;
    }
    return total;
};

/** "Average time per tick: 3.2ms" from `tick query` (Minecraft 1.20.3+). */
const parseTickQuery = (text) => {
    const mspt = Number.parseFloat((/Average time per tick: ([\d.]+)\s*ms/i.exec(text || '') || [])[1]);
    const target = Number.parseFloat((/Target tick rate: ([\d.]+)/i.exec(text || '') || [])[1]) || 20;
    if (!Number.isFinite(mspt)) return null;
    return {
        mspt: Math.round(mspt * 10) / 10,
        tps: Math.round(Math.min(target, 1000 / Math.max(mspt, 0.001)) * 10) / 10,
        frozen: /frozen|paused/i.test(text),
    };
};

/** Slow-changing facts for the System page; disk usage is cached for five minutes. */
class SystemInfo {
    constructor({ config, state, minecraft }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.startedAt = Date.now();
        this.disk = null;
        this.diskPromise = null;
    }

    async diskUsage(force = false) {
        if (!force && this.disk && Date.now() - this.disk.at < DISK_CACHE_MS) return this.disk;
        if (!this.diskPromise) {
            this.diskPromise = (async () => {
                const [worlds, backups, setups, server, free] = await Promise.all([
                    dirSize(path.join(this.config.SERVER_DIR, 'worlds')),
                    dirSize(this.config.BACKUP_DIR),
                    dirSize(path.join(this.config.SANDBOX_ROOT, 'setups')),
                    dirSize(this.config.SERVER_DIR),
                    freeDiskBytes(this.config.SANDBOX_ROOT).catch(() => null),
                ]);
                this.disk = { at: Date.now(), worlds, backups, setups, serverOther: Math.max(0, server - worlds), free };
                return this.disk;
            })().finally(() => {
                this.diskPromise = null;
            });
        }
        return this.diskPromise;
    }

    async view() {
        const s = this.state.get();
        const world = s.worlds.find((entry) => entry.id === s.activeWorldId);
        return {
            managerUptimeMs: Date.now() - this.startedAt,
            minecraftUptimeMs: this.minecraft.startedAt && this.minecraft.process ? Date.now() - this.minecraft.startedAt : null,
            node: process.version,
            setup: s.profile ? { id: s.activeSetupId, loader: s.profile.loader, minecraftVersion: s.profile.minecraftVersion, loaderVersion: s.profile.loaderVersion, javaMajor: s.profile.javaMajor, memory: s.profile.memory } : null,
            world: world ? { id: world.id, name: world.name } : null,
            disk: await this.diskUsage(),
        };
    }
}

module.exports = { SystemInfo, parseTickQuery, dirSize };
