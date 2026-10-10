const fs = require('fs');
const path = require('path');
const { isLoaderArtifact } = require('./installer');
const { OperationError } = require('./operations');

// Belong to a setup (moved when switching); everything else in server/ is shared.
const isSetupEntry = (name) => isLoaderArtifact(name) || ['mods', 'config', 'defaultconfigs'].includes(name);

const setupIdFor = (profile) => `${profile.loader}-${profile.minecraftVersion}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');

/**
 * A setup is one server install (loader, version, Java, memory, mods, mod
 * configs). Only the active setup lives in server/; the others are parked in
 * setups/<id>/files on the same drive, so switching is a few renames.
 */
class SetupManager {
    constructor({ config, state, minecraft, addons }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.addons = addons;
        this.root = path.join(config.SANDBOX_ROOT, 'setups');
    }

    /** Turns the single pre-setups install into the first setup. */
    migrate() {
        const s = this.state.get();
        if (!s.profile || s.activeSetupId) return;
        const id = setupIdFor(s.profile);
        this.state.update((draft) => {
            draft.setups = { ...(draft.setups || {}), [id]: draft.profile };
            draft.activeSetupId = id;
            for (const world of draft.worlds) if (!world.setupId) world.setupId = id;
        });
    }

    activeId() {
        return this.state.get().activeSetupId || null;
    }

    profileOf(id) {
        const s = this.state.get();
        return id === s.activeSetupId ? s.profile : s.setups?.[id] || null;
    }

    get(id) {
        const profile = this.profileOf(id);
        if (!profile) throw new OperationError(`Setup not found: ${id}`, { code: 'SETUP_NOT_FOUND', status: 404 });
        return profile;
    }

    manifestFile(id) {
        return path.join(this.root, id, 'addons-manifest.json');
    }

    modsOf(id) {
        if (id === this.activeId()) return this.addons.manifest.get().mods;
        try {
            return JSON.parse(fs.readFileSync(this.manifestFile(id), 'utf8')).mods || [];
        } catch {
            return [];
        }
    }

    list() {
        const s = this.state.get();
        return Object.keys(s.setups || {}).map((id) => {
            const profile = this.profileOf(id);
            return {
                id,
                active: id === s.activeSetupId,
                loader: profile.loader,
                minecraftVersion: profile.minecraftVersion,
                loaderVersion: profile.loaderVersion,
                memory: profile.memory,
                javaMajor: profile.javaMajor,
                installedAt: profile.installedAt,
                mods: this.modsOf(id).map((mod) => ({ title: mod.title, versionNumber: mod.versionNumber })),
                worlds: s.worlds.filter((world) => world.setupId === id).map((world) => ({ id: world.id, name: world.name })),
            };
        });
    }

    uniqueId(profile) {
        const base = setupIdFor(profile);
        const taken = new Set(Object.keys(this.state.get().setups || {}));
        if (!taken.has(base)) return base;
        for (let i = 2; ; i += 1) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
    }

    /** Moves the active setup's files out of server/. Returns an undo function. */
    park(id) {
        const serverDir = this.config.SERVER_DIR;
        const filesDir = path.join(this.root, id, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        const moved = [];
        const undo = () => {
            for (const name of moved.reverse()) {
                if (name === '@manifest') fs.renameSync(this.manifestFile(id), this.addons.manifest.file);
                else fs.renameSync(path.join(filesDir, name), path.join(serverDir, name));
            }
            this.addons.manifest.reload();
        };
        try {
            for (const name of fs.readdirSync(serverDir).filter(isSetupEntry)) {
                if (fs.existsSync(path.join(filesDir, name))) fs.rmSync(path.join(filesDir, name), { recursive: true, force: true });
                fs.renameSync(path.join(serverDir, name), path.join(filesDir, name));
                moved.push(name);
            }
            if (fs.existsSync(this.addons.manifest.file)) {
                fs.renameSync(this.addons.manifest.file, this.manifestFile(id));
                moved.push('@manifest');
            }
            this.addons.manifest.reload();
            return undo;
        } catch (error) {
            undo();
            throw error;
        }
    }

    /** Moves a parked setup's files into server/. Returns an undo function. */
    unpark(id) {
        const serverDir = this.config.SERVER_DIR;
        const filesDir = path.join(this.root, id, 'files');
        const moved = [];
        const undo = () => {
            for (const name of moved.reverse()) {
                if (name === '@manifest') fs.renameSync(this.addons.manifest.file, this.manifestFile(id));
                else fs.renameSync(path.join(serverDir, name), path.join(filesDir, name));
            }
            this.addons.manifest.reload();
        };
        try {
            const conflicts = fs.readdirSync(serverDir).filter(isSetupEntry);
            if (conflicts.length) throw new OperationError(`server/ still has setup files: ${conflicts.join(', ')}`, { code: 'SETUP_CONFLICT' });
            for (const name of fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []) {
                fs.renameSync(path.join(filesDir, name), path.join(serverDir, name));
                moved.push(name);
            }
            if (fs.existsSync(this.manifestFile(id))) {
                fs.renameSync(this.manifestFile(id), this.addons.manifest.file);
                moved.push('@manifest');
            }
            this.addons.manifest.reload();
            return undo;
        } catch (error) {
            undo();
            throw error;
        }
    }

    /** Parks the active setup (if any) so a new one can be installed into server/. */
    parkActive() {
        const activeId = this.activeId();
        if (!activeId) return () => {};
        const profile = this.state.get().profile;
        const undo = this.park(activeId);
        this.state.update((draft) => {
            draft.setups = { ...(draft.setups || {}), [activeId]: profile };
            draft.activeSetupId = null;
            draft.profile = null;
        });
        return () => {
            undo();
            this.state.update((draft) => {
                draft.activeSetupId = activeId;
                draft.profile = profile;
            });
        };
    }

    /** Records a freshly installed profile as a new, active setup. */
    register(profile) {
        const id = this.uniqueId(profile);
        this.state.update((draft) => {
            draft.setups = { ...(draft.setups || {}), [id]: profile };
            draft.activeSetupId = id;
            draft.profile = profile;
        });
        return id;
    }

    /** Keeps the setups map in sync after the active profile was edited or reinstalled. */
    syncActiveProfile() {
        const s = this.state.get();
        if (!s.activeSetupId || !s.profile) return;
        this.state.update((draft) => {
            draft.setups = { ...(draft.setups || {}), [draft.activeSetupId]: draft.profile };
        });
    }

    /** Makes `id` the active setup. The server must be stopped. */
    switchTo(id) {
        if (this.minecraft.isRunning()) throw new OperationError('Stop the server before switching setups.', { code: 'SERVER_RUNNING', status: 409 });
        const target = this.get(id);
        const activeId = this.activeId();
        if (activeId === id) return;
        const undoPark = this.parkActive();
        try {
            this.unpark(id);
        } catch (error) {
            undoPark();
            throw error;
        }
        this.state.update((draft) => {
            draft.activeSetupId = id;
            draft.profile = target;
        });
        this.minecraft.refreshStatus();
    }

    /** Deletes a parked setup that no world uses. */
    remove(id) {
        if (id === this.activeId()) throw new OperationError('The active setup cannot be removed.', { code: 'SETUP_ACTIVE', status: 409 });
        this.get(id);
        const users = this.state.get().worlds.filter((world) => world.setupId === id);
        if (users.length) throw new OperationError(`Still used by: ${users.map((w) => w.name).join(', ')}`, { code: 'SETUP_IN_USE', status: 409 });
        fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
        this.state.update((draft) => {
            delete draft.setups[id];
        });
    }
}

module.exports = { SetupManager, isSetupEntry, setupIdFor };
