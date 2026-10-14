const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipFiles } = require('./archive');

const KEPT_PACKS = 3;

/**
 * Builds the zip of mod jars players need in their own game. Server-only mods
 * (client_side: unsupported) are left out; files the manager did not install
 * are not included because their client requirements are unknown.
 */
class ModPack {
    constructor({ config, state, addons }) {
        this.config = config;
        this.state = state;
        this.addons = addons;
        this.dir = path.join(config.DATA_DIR, 'packs');
        this.building = null;
    }

    /** Fills in client-side requirements missing from older manifest entries. */
    async ensureClientSide() {
        const missing = this.addons.manifest.get().mods.filter((mod) => !mod.clientSide);
        const byProvider = {};
        for (const mod of missing) (byProvider[mod.provider] ||= []).push(mod.projectId);
        const found = {};
        for (const [providerId, ids] of Object.entries(byProvider)) {
            const provider = this.addons.providers[providerId];
            if (!provider || !provider.status().enabled) continue;
            try {
                for (const project of await provider.getProjects(ids)) found[`${providerId}:${project.id}`] = project.clientSide || 'unknown';
            } catch (error) {
                console.error('Could not look up client-side requirements:', error.message);
            }
        }
        if (!Object.keys(found).length) return;
        this.addons.manifest.update((draft) => {
            for (const mod of draft.mods) {
                const side = found[`${mod.provider}:${mod.projectId}`];
                if (side && !mod.clientSide) mod.clientSide = side;
            }
        });
    }

    async clientMods() {
        await this.ensureClientSide();
        return this.addons.manifest.get().mods
            .filter((mod) => mod.clientSide !== 'unsupported')
            .filter((mod) => fs.existsSync(path.join(this.addons.modsDir, mod.fileName)))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    static fingerprint(mods) {
        return crypto.createHash('sha1')
            .update(mods.map((mod) => `${mod.fileName}:${mod.sha1 || ''}`).sort().join('\n'))
            .digest('hex')
            .slice(0, 12);
    }

    fileName() {
        const profile = this.state.get().profile;
        const suffix = profile ? `${profile.loader}-${profile.minecraftVersion}` : 'mods';
        return `mods-${suffix}.zip`;
    }

    /** Returns { file, fingerprint, mods, fileName }, building the zip only when the mod set changed. */
    async build() {
        if (this.building) return this.building;
        this.building = (async () => {
            const mods = await this.clientMods();
            const fingerprint = ModPack.fingerprint(mods);
            const file = path.join(this.dir, `${fingerprint}.zip`);
            if (!fs.existsSync(file)) {
                await zipFiles(mods.map((mod) => ({ path: path.join(this.addons.modsDir, mod.fileName), name: mod.fileName })), file);
                this.prune(file);
            }
            return { file, fingerprint, mods, fileName: this.fileName() };
        })();
        try {
            return await this.building;
        } finally {
            this.building = null;
        }
    }

    prune(keep) {
        const packs = fs.readdirSync(this.dir)
            .filter((name) => name.endsWith('.zip'))
            .map((name) => ({ name, mtime: fs.statSync(path.join(this.dir, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        for (const pack of packs.slice(KEPT_PACKS)) {
            if (path.join(this.dir, pack.name) !== keep) fs.rmSync(path.join(this.dir, pack.name), { force: true });
        }
    }
}

module.exports = { ModPack };
