const fs = require('fs');
const path = require('path');
const { zipDirectory, sha256File, extractWorld, freeDiskBytes } = require('./archive');
const { directorySize } = require('./worlds');
const { writeJsonAtomic, readJson } = require('./store');
const { OperationError } = require('./operations');

const KINDS = ['manual', 'pre-restore', 'pre-delete', 'pre-reinstall', 'pre-upgrade'];
const SAFETY_SNAPSHOTS_KEPT = 5;
const ID_PATTERN = /^[a-z0-9-]{1,40}_\d{8}-\d{6}(?:-\d+)?_[a-z-]+$/;
const SAVE_TIMEOUT_MS = 60000;

const stamp = (date = new Date()) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

class BackupManager {
    constructor({ config, state, minecraft, worlds, operations }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.worlds = worlds;
        this.operations = operations;
        this.root = path.join(config.BACKUP_DIR, 'worlds');
    }

    /** All backups (optionally for one world), newest first, read from sidecars. */
    list({ worldId } = {}) {
        let worldDirs = [];
        try {
            worldDirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            return [];
        }
        const backups = [];
        for (const dir of worldDirs) {
            if (worldId && dir !== worldId) continue;
            for (const file of fs.readdirSync(path.join(this.root, dir))) {
                if (!file.endsWith('.zip.json')) continue;
                const meta = readJson(path.join(this.root, dir, file), null);
                if (meta && fs.existsSync(path.join(this.root, dir, file.slice(0, -'.json'.length)))) backups.push(meta);
            }
        }
        return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    get(id) {
        if (!ID_PATTERN.test(String(id || ''))) throw new OperationError('Invalid backup id.', { code: 'INVALID_BACKUP_ID' });
        const worldId = id.split('_')[0];
        const meta = readJson(path.join(this.root, worldId, `${id}.zip.json`), null);
        if (!meta || !fs.existsSync(this.fileFor(meta))) throw new OperationError('Backup not found.', { code: 'BACKUP_NOT_FOUND', status: 404 });
        return meta;
    }

    fileFor(meta) {
        return path.join(this.root, meta.worldId, `${meta.id}.zip`);
    }

    /** Starts a manual backup job. */
    backup({ worldId, note = '' } = {}) {
        const world = this.worlds.get(worldId);
        return this.operations.startJob('backup', (ctx) => this.createBackup(ctx, world, 'manual', note), { worldId });
    }

    /**
     * Zips a world. If it is the running world, Minecraft's autosave is paused
     * and a flush is forced first, then autosave is always re-enabled.
     */
    async createBackup(ctx, world, kind, note = '') {
        if (!KINDS.includes(kind)) throw new OperationError(`Unknown backup kind: ${kind}`);
        const worldDir = this.worlds.dirFor(world.id);
        if (!fs.existsSync(worldDir) || !fs.readdirSync(worldDir).length) {
            throw new OperationError(`World "${world.name}" has not been generated yet; there is nothing to back up.`, { code: 'WORLD_EMPTY' });
        }

        const isLive = this.minecraft.isRunning() && this.worlds.activeId() === world.id;
        // RCON connects a moment after the server reports ONLINE; give it a few seconds.
        for (let i = 0; isLive && this.minecraft.status === 'ONLINE' && !this.minecraft.rcon && i < 20; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (isLive && (this.minecraft.status !== 'ONLINE' || !this.minecraft.rcon)) {
            throw new OperationError('The server is running but not ready (RCON unavailable). Try again once it is ONLINE, or stop it first.', {
                code: 'SERVER_NOT_READY',
                status: 409,
            });
        }

        const estimated = await directorySize(worldDir);
        const free = await freeDiskBytes(this.config.BACKUP_DIR) ?? await freeDiskBytes(this.config.SANDBOX_ROOT);
        if (free !== undefined && free < estimated * 1.1) {
            throw new OperationError('Not enough free disk space for this backup.', { code: 'INSUFFICIENT_DISK' });
        }

        let base = `${world.id}_${stamp()}`;
        let counter = 1;
        while (fs.existsSync(path.join(this.root, world.id, `${base}_${kind}.zip`))) base = `${world.id}_${stamp()}-${counter++}`;
        const id = `${base}_${kind}`;
        const destination = path.join(this.root, world.id, `${id}.zip`);

        let savePaused = false;
        try {
            if (isLive) {
                ctx.progress(2, 'Pausing autosave and flushing the world to disk');
                await this.minecraft.sendCommand('tellraw @a {"text":"[Backup] Starting world backup...","color":"gray"}').catch(() => {});
                await this.minecraft.sendCommand('save-off');
                savePaused = true;
                // RCON replies once the command has run, so the reply to a flush
                // means the world is on disk.
                const reply = await Promise.race([
                    this.minecraft.sendCommand('save-all flush'),
                    new Promise((resolve) => setTimeout(() => resolve(null), SAVE_TIMEOUT_MS)),
                ]);
                if (reply === null) throw new OperationError('The server did not finish saving within 60 seconds.', { code: 'SAVE_TIMEOUT' });
                ctx.log(`save-all flush: ${String(reply).trim() || '(no reply)'}`);
            }

            ctx.progress(5, `Compressing ${world.name}`);
            const result = await zipDirectory(worldDir, destination, {
                onProgress: (processed, total) => total && ctx.progress(5 + (90 * processed) / total),
            });

            const profile = this.state.get().profile;
            const meta = {
                id,
                worldId: world.id,
                worldName: world.name,
                kind,
                note: String(note || '').slice(0, 200),
                createdAt: new Date().toISOString(),
                sizeBytes: result.size,
                sha256: result.sha256,
                minecraftVersion: profile?.minecraftVersion || world.minecraftVersion || null,
                loader: profile?.loader || null,
                hot: isLive,
            };
            writeJsonAtomic(`${destination}.json`, meta);
            ctx.log(`Backup written: ${destination}`);
            if (kind !== 'manual') this.pruneSafetySnapshots(world.id);
            return meta;
        } finally {
            if (savePaused) {
                await this.minecraft.sendCommand('save-on').catch((error) => ctx.log(`Failed to re-enable autosave: ${error.message}`));
                await this.minecraft.sendCommand('tellraw @a {"text":"[Backup] World backup finished.","color":"gray"}').catch(() => {});
            }
        }
    }

    pruneSafetySnapshots(worldId) {
        const safety = this.list({ worldId }).filter((backup) => backup.kind !== 'manual');
        for (const backup of safety.slice(SAFETY_SNAPSHOTS_KEPT)) this.deleteFiles(backup);
    }

    deleteFiles(meta) {
        fs.rmSync(this.fileFor(meta), { force: true });
        fs.rmSync(`${this.fileFor(meta)}.json`, { force: true });
    }

    remove(id) {
        const meta = this.get(id);
        if (this.operations.current?.kind === 'restore') {
            throw new OperationError('A restore is in progress.', { code: 'BUSY', status: 409 });
        }
        this.deleteFiles(meta);
        return meta;
    }

    async verify(id) {
        const meta = this.get(id);
        const actual = await sha256File(this.fileFor(meta));
        return { id, ok: actual === meta.sha256, expected: meta.sha256, actual };
    }

    restore(id, { mode = 'replace', newName } = {}) {
        const meta = this.get(id);
        if (!['replace', 'new'].includes(mode)) throw new OperationError('Restore mode must be "replace" or "new".');
        if (mode === 'replace') {
            const world = this.worlds.get(meta.worldId);
            if (this.minecraft.isRunning() && this.worlds.activeId() === world.id) {
                throw new OperationError('Stop the server before restoring over the active world.', { code: 'SERVER_RUNNING', status: 409 });
            }
        }
        return this.operations.startJob('restore', (ctx) => (mode === 'replace'
            ? this.restoreReplace(ctx, meta)
            : this.restoreAsNew(ctx, meta, newName || `${meta.worldName} (restored)`)), { backupId: id, mode });
    }

    async checkIntegrity(ctx, meta) {
        ctx.progress(2, 'Verifying backup checksum');
        if ((await sha256File(this.fileFor(meta))) !== meta.sha256) {
            throw new OperationError('The backup file is corrupted (checksum mismatch).', { code: 'CHECKSUM_MISMATCH' });
        }
    }

    async restoreReplace(ctx, meta) {
        const world = this.worlds.get(meta.worldId);
        await this.checkIntegrity(ctx, meta);

        const worldDir = this.worlds.dirFor(world.id);
        if (fs.existsSync(worldDir) && fs.readdirSync(worldDir).length) {
            ctx.progress(10, 'Taking a safety snapshot of the current world');
            await this.createBackup({ ...ctx, progress: (p, step) => ctx.progress(10 + p * 0.3, step) }, world, 'pre-restore');
        }

        const worldsDir = path.dirname(worldDir);
        const staging = path.join(worldsDir, '.restore-staging', ctx.job.id);
        const trash = path.join(worldsDir, '.trash', `${world.id}-${Date.now()}`);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });

        try {
            ctx.progress(40, 'Extracting backup');
            await extractWorld(this.fileFor(meta), staging, {
                freeBytes: await freeDiskBytes(worldsDir),
                onProgress: (done, total) => total && ctx.progress(40 + (50 * done) / total),
            });

            ctx.progress(92, 'Swapping world files');
            fs.mkdirSync(path.dirname(trash), { recursive: true });
            const hadWorld = fs.existsSync(worldDir);
            if (hadWorld) fs.renameSync(worldDir, trash);
            try {
                fs.renameSync(staging, worldDir);
            } catch (error) {
                if (hadWorld) fs.renameSync(trash, worldDir);
                throw error;
            }
            fs.rmSync(trash, { recursive: true, force: true });
            this.worlds.invalidateSize(world.id);
            return { worldId: world.id };
        } finally {
            fs.rmSync(path.join(worldsDir, '.restore-staging'), { recursive: true, force: true });
            fs.rmSync(path.join(worldsDir, '.trash'), { recursive: true, force: true });
        }
    }

    async restoreAsNew(ctx, meta, name) {
        await this.checkIntegrity(ctx, meta);
        const world = this.worlds.create({ name, source: 'restored' });
        const worldDir = this.worlds.dirFor(world.id);
        try {
            ctx.progress(10, `Extracting into new world "${world.name}"`);
            await extractWorld(this.fileFor(meta), worldDir, {
                freeBytes: await freeDiskBytes(path.dirname(worldDir)),
                onProgress: (done, total) => total && ctx.progress(10 + (85 * done) / total),
            });
            return { worldId: world.id };
        } catch (error) {
            this.worlds.forget(world.id);
            fs.rmSync(worldDir, { recursive: true, force: true });
            throw error;
        }
    }
}

module.exports = { BackupManager, KINDS, stamp };
