const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Busboy = require('busboy');
const { asyncHandler } = require('../lib/auth');
const { extractWorld, streamZip, freeDiskBytes } = require('../lib/archive');
const { OperationError } = require('../lib/operations');

const MAX_IMPORT_BYTES = 8 * 1024 ** 3;

// Streams a multipart upload's "file" field to disk. Resolves { file, fields }.
const receiveUpload = (req, directory) => new Promise((resolve, reject) => {
    let busboy;
    try {
        busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_IMPORT_BYTES, fields: 5 } });
    } catch (error) {
        reject(new OperationError('Expected a multipart upload.', { code: 'INVALID_UPLOAD' }));
        return;
    }
    const fields = {};
    let target = null;
    let writeDone = null;
    let truncated = false;

    busboy.on('field', (name, value) => {
        fields[name] = value;
    });
    busboy.on('file', (name, stream, info) => {
        if (name !== 'file' || !/\.zip$/i.test(info.filename || '')) {
            stream.resume();
            return;
        }
        fs.mkdirSync(directory, { recursive: true });
        target = path.join(directory, `${crypto.randomUUID()}.zip`);
        const out = fs.createWriteStream(target);
        stream.on('limit', () => {
            truncated = true;
        });
        writeDone = new Promise((done, fail) => {
            out.on('finish', done);
            out.on('error', fail);
        });
        stream.pipe(out);
    });
    busboy.on('error', reject);
    busboy.on('close', async () => {
        try {
            if (writeDone) await writeDone;
            if (!target) throw new OperationError('Upload a .zip file in the "file" field.', { code: 'INVALID_UPLOAD' });
            if (truncated) {
                fs.rmSync(target, { force: true });
                throw new OperationError('The upload is larger than 8 GB.', { code: 'UPLOAD_TOO_LARGE' });
            }
            resolve({ file: target, fields });
        } catch (error) {
            reject(error);
        }
    });
    req.pipe(busboy);
});

module.exports = ({ auth, config, worlds, backups, minecraft, operations }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    const describe = async (world) => {
        const dir = worlds.dirFor(world.id);
        return {
            ...world,
            active: worlds.activeId() === world.id,
            generated: fs.existsSync(path.join(dir, 'level.dat')),
            sizeBytes: await worlds.sizeOf(world.id),
        };
    };

    router.get('/', asyncHandler(async (req, res) => {
        res.json({
            worlds: await Promise.all(worlds.list().map(describe)),
            activeWorldId: worlds.activeId(),
            legacyWorld: Boolean(worlds.legacyWorld()),
            installed: Boolean(worlds.state.get().profile) || minecraft.isConfigured(),
        });
    }));

    router.post('/', asyncHandler(async (req, res) => {
        const { name, seed, levelType, setActive } = req.body || {};
        const world = await operations.runExclusive('world.create', async () => {
            if (setActive) worlds.assertStopped('switch worlds');
            const created = worlds.create({ name, seed, levelType });
            if (setActive) worlds.activate(created.id);
            return created;
        });
        res.status(201).json(await describe(world));
    }));

    router.post('/adopt', asyncHandler(async (req, res) => {
        const world = await operations.runExclusive('world.adopt', async () => worlds.adoptLegacy(req.body?.name || 'World'));
        res.status(201).json(await describe(world));
    }));

    router.post('/import', asyncHandler(async (req, res) => {
        if (operations.current) throw new OperationError(`Another operation is in progress: ${operations.current.kind}`, { code: 'BUSY', status: 409 });
        const { file, fields } = await receiveUpload(req, path.join(config.DATA_DIR, 'tmp'));
        let job;
        try {
            const name = String(fields.name || '').trim() || 'Imported world';
            job = operations.startJob('world.import', async (ctx) => {
                const world = worlds.create({ name, source: 'imported' });
                try {
                    ctx.progress(5, 'Extracting world');
                    await extractWorld(file, worlds.dirFor(world.id), {
                        freeBytes: await freeDiskBytes(config.SERVER_DIR),
                        onProgress: (done, total) => total && ctx.progress(5 + (90 * done) / total),
                    });
                    return { worldId: world.id };
                } catch (error) {
                    worlds.forget(world.id);
                    fs.rmSync(worlds.dirFor(world.id), { recursive: true, force: true });
                    throw error;
                } finally {
                    fs.rmSync(file, { force: true });
                }
            }, { name });
        } catch (error) {
            fs.rmSync(file, { force: true });
            throw error;
        }
        res.status(202).json(job);
    }));

    router.post('/:id/activate', asyncHandler(async (req, res) => {
        const world = await operations.runExclusive('world.switch', async () => worlds.activate(req.params.id));
        res.json(await describe(world));
    }));

    router.patch('/:id', asyncHandler(async (req, res) => {
        res.json(await describe(worlds.rename(req.params.id, req.body?.name)));
    }));

    router.post('/:id/duplicate', asyncHandler(async (req, res) => {
        const source = worlds.get(req.params.id);
        const job = operations.startJob('world.duplicate', async (ctx) => {
            ctx.progress(5, `Copying ${source.name}`);
            const copy = await worlds.duplicate(source.id, req.body?.name);
            return { worldId: copy.id };
        }, { worldId: source.id });
        res.status(202).json(job);
    }));

    router.delete('/:id', asyncHandler(async (req, res) => {
        const world = worlds.get(req.params.id);
        if (req.query.confirm !== world.id) {
            throw new OperationError('Confirm the deletion by passing ?confirm=<world id>.', { code: 'CONFIRMATION_REQUIRED' });
        }
        if (worlds.activeId() === world.id) {
            throw new OperationError('Switch to another world before deleting the active one.', { code: 'WORLD_ACTIVE', status: 409 });
        }
        const job = operations.startJob('world.delete', async (ctx) => {
            const dir = worlds.dirFor(world.id);
            if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
                await backups.createBackup({ ...ctx, progress: (p, step) => ctx.progress(p * 0.9, step) }, world, 'pre-delete');
            }
            ctx.progress(92, 'Deleting world files');
            await worlds.remove(world.id);
            return { worldId: world.id };
        }, { worldId: world.id });
        res.status(202).json(job);
    }));

    router.get('/:id/download', asyncHandler(async (req, res) => {
        const world = worlds.get(req.params.id);
        if (minecraft.isRunning() && worlds.activeId() === world.id) {
            throw new OperationError('Stop the server (or make a backup and download that) to download the active world.', { code: 'SERVER_RUNNING', status: 409 });
        }
        res.attachment(`${world.id}.zip`);
        await streamZip(worlds.dirFor(world.id), res);
    }));

    return router;
};
