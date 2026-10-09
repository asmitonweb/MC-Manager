const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPropertiesFile, updatePropertiesFile } = require('./properties');
const { OperationError } = require('./operations');

const WORLDS_DIRNAME = 'worlds';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LEVEL_TYPES = {
    default: 'minecraft\\:normal',
    flat: 'minecraft\\:flat',
    amplified: 'minecraft\\:amplified',
    large_biomes: 'minecraft\\:large_biomes',
};

const slugify = (name) => String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'world';

const validateName = (name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > 60 || /[\r\n]/.test(trimmed)) {
        throw new OperationError('World names must be 1-60 characters.', { code: 'INVALID_WORLD_NAME' });
    }
    return trimmed;
};

const directorySize = async (dir) => {
    let total = 0;
    let entries = [];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await directorySize(full);
        else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
    }
    return total;
};

class WorldManager {
    constructor({ config, state, minecraft }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.worldsDir = path.join(config.SERVER_DIR, WORLDS_DIRNAME);
        this.sizeCache = new Map();
    }

    list() {
        return this.state.get().worlds;
    }

    activeId() {
        return this.state.get().activeWorldId;
    }

    get(id) {
        const world = this.list().find((entry) => entry.id === id);
        if (!world) throw new OperationError(`World not found: ${id}`, { code: 'WORLD_NOT_FOUND', status: 404 });
        return world;
    }

    dirFor(id) {
        if (!ID_PATTERN.test(id)) throw new OperationError(`Invalid world id: ${id}`, { code: 'INVALID_WORLD_ID' });
        return path.join(this.worldsDir, id);
    }

    levelNameFor(id) {
        return `${WORLDS_DIRNAME}/${id}`;
    }

    uniqueId(name) {
        const base = slugify(name);
        const taken = new Set(this.list().map((world) => world.id));
        if (!taken.has(base) && !fs.existsSync(path.join(this.worldsDir, base))) return base;
        for (;;) {
            const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
            if (!taken.has(candidate) && !fs.existsSync(path.join(this.worldsDir, candidate))) return candidate;
        }
    }

    assertStopped(action) {
        if (this.minecraft.isRunning()) {
            throw new OperationError(`Stop the Minecraft server before you ${action}.`, {
                code: 'SERVER_RUNNING',
                status: 409,
            });
        }
    }

    /** Registers a new world; Minecraft generates it on the first start. */
    create({ name, seed = '', levelType = 'default', source = 'created', id } = {}) {
        const displayName = validateName(name);
        if (!LEVEL_TYPES[levelType]) {
            throw new OperationError(`Unknown world type: ${levelType}`, { code: 'INVALID_LEVEL_TYPE' });
        }
        if (/[\r\n]/.test(String(seed))) throw new OperationError('Invalid seed.', { code: 'INVALID_SEED' });

        const worldId = id || this.uniqueId(displayName);
        fs.mkdirSync(this.dirFor(worldId), { recursive: true });
        const world = {
            id: worldId,
            name: displayName,
            createdAt: new Date().toISOString(),
            seed: String(seed || ''),
            levelType,
            source,
            lastPlayedAt: null,
            minecraftVersion: this.state.get().profile?.minecraftVersion || null,
        };
        this.state.update((draft) => {
            draft.worlds.push(world);
        });
        return world;
    }

    /**
     * Points server.properties at a world. Seed and type only matter while the
     * world has not been generated yet, so they are cleared for existing worlds.
     */
    activate(id) {
        this.assertStopped('switch worlds');
        const world = this.get(id);
        const generated = fs.existsSync(path.join(this.dirFor(id), 'level.dat'));
        updatePropertiesFile(this.config.PROPERTIES_FILE, {
            'level-name': this.levelNameFor(id),
            'level-seed': generated ? '' : world.seed,
            'level-type': generated ? LEVEL_TYPES.default : LEVEL_TYPES[world.levelType || 'default'],
        });
        this.state.update((draft) => {
            draft.activeWorldId = id;
        });
        return world;
    }

    rename(id, name) {
        const displayName = validateName(name);
        this.get(id);
        this.state.update((draft) => {
            draft.worlds.find((world) => world.id === id).name = displayName;
        });
        return this.get(id);
    }

    touchActive() {
        const id = this.activeId();
        if (!id) return;
        this.state.update((draft) => {
            const world = draft.worlds.find((entry) => entry.id === id);
            if (world) world.lastPlayedAt = new Date().toISOString();
        });
    }

    async sizeOf(id) {
        const cached = this.sizeCache.get(id);
        if (cached && Date.now() - cached.at < 60000) return cached.size;
        const size = await directorySize(this.dirFor(id));
        this.sizeCache.set(id, { at: Date.now(), size });
        return size;
    }

    invalidateSize(id) {
        this.sizeCache.delete(id);
    }

    /**
     * Brings the registry in line with the disk: registers world folders under
     * worlds/ that are unknown, and follows level-name if it was changed by hand.
     */
    reconcile() {
        if (!fs.existsSync(this.config.SERVER_DIR)) return;
        const known = new Set(this.list().map((world) => world.id));
        let entries = [];
        try {
            entries = fs.readdirSync(this.worldsDir, { withFileTypes: true });
        } catch {
            entries = [];
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || !ID_PATTERN.test(entry.name) || known.has(entry.name)) continue;
            if (!fs.existsSync(path.join(this.worldsDir, entry.name, 'level.dat'))) continue;
            this.create({ name: entry.name, id: entry.name, source: 'imported' });
        }

        const levelName = (readPropertiesFile(this.config.PROPERTIES_FILE) || {})['level-name'];
        const match = levelName && /^worlds\/([a-z0-9-]+)$/.exec(levelName);
        if (match && this.list().some((world) => world.id === match[1]) && this.activeId() !== match[1]) {
            this.state.update((draft) => {
                draft.activeWorldId = match[1];
            });
        }
    }

    /** A world at the vanilla location (server/world) that is not managed yet. */
    legacyWorld() {
        const legacy = path.join(this.config.SERVER_DIR, 'world');
        return fs.existsSync(path.join(legacy, 'level.dat')) ? legacy : null;
    }

    /** Moves server/world into worlds/<id> and registers it. */
    adoptLegacy(name = 'World') {
        this.assertStopped('adopt the existing world');
        const legacy = this.legacyWorld();
        if (!legacy) throw new OperationError('No unmanaged world found.', { code: 'WORLD_NOT_FOUND', status: 404 });
        const id = this.uniqueId(name);
        fs.mkdirSync(this.worldsDir, { recursive: true });
        fs.renameSync(legacy, this.dirFor(id));
        const world = this.create({ name, id, source: 'imported' });
        if (!this.activeId()) this.activate(id);
        return world;
    }
}

module.exports = { WorldManager, slugify, LEVEL_TYPES, ID_PATTERN, directorySize };
