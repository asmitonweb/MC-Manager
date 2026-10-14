const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { JsonStore } = require('../lib/store');
const { Operations } = require('../lib/operations');
const { WorldManager } = require('../lib/worlds');
const { BackupManager } = require('../lib/backups');
const { extractWorld, safeEntryPath } = require('../lib/archive');

const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-backups-'));
    const config = {
        SANDBOX_ROOT: root,
        SERVER_DIR: path.join(root, 'server'),
        BACKUP_DIR: path.join(root, 'backups'),
        PROPERTIES_FILE: path.join(root, 'server', 'server.properties'),
    };
    fs.mkdirSync(config.SERVER_DIR, { recursive: true });
    const state = new JsonStore(path.join(root, 'state.json'), { profile: null, worlds: [], activeWorldId: null });
    const minecraft = { isRunning: () => false, status: 'OFFLINE', rcon: null };
    const operations = new Operations();
    const worlds = new WorldManager({ config, state, minecraft });
    const backups = new BackupManager({ config, state, minecraft, worlds, operations });
    return { root, config, worlds, backups, operations, minecraft };
};

const writeWorld = (worlds, id, content) => {
    const dir = worlds.dirFor(id);
    fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'level.dat'), content);
    fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), `${content}-region`);
    fs.writeFileSync(path.join(dir, 'session.lock'), 'locked');
};

const waitJob = async (operations, job) => {
    for (let i = 0; i < 200; i += 1) {
        const current = operations.getJob(job.id);
        if (current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('job timeout');
};

const makeZip = (file, entries) => new Promise((resolve, reject) => {
    const archive = archiver('zip');
    const out = fs.createWriteStream(file);
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, content] of entries) archive.append(content, { name });
    archive.finalize();
});

test('manual backup writes a zip and sidecar, skipping session.lock', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');

    const job = await waitJob(operations, backups.backup({ worldId: world.id, note: 'first' }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    const [meta] = backups.list();
    assert.equal(meta.worldId, world.id);
    assert.equal(meta.kind, 'manual');
    assert.equal(meta.note, 'first');
    assert.equal(meta.hot, false);
    assert.equal((await backups.verify(meta.id)).ok, true);

    const out = path.join(os.tmpdir(), `mcm-extract-${Date.now()}`);
    await extractWorld(backups.fileFor(meta), out);
    assert.equal(fs.existsSync(path.join(out, 'session.lock')), false);
    assert.equal(fs.readFileSync(path.join(out, 'region', 'r.0.0.mca'), 'utf8'), 'v1-region');
});

test('backing up an ungenerated world fails clearly', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Empty' });
    const job = await waitJob(operations, backups.backup({ worldId: world.id }));
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'WORLD_EMPTY');
});

test('live backups are refused while the server is not ready', async () => {
    const { worlds, backups, operations, minecraft } = setup();
    const world = worlds.create({ name: 'Live' });
    writeWorld(worlds, world.id, 'v1');
    worlds.activate(world.id);
    minecraft.isRunning = () => true;
    minecraft.status = 'STARTING';
    const job = await waitJob(operations, backups.backup({ worldId: world.id }));
    assert.equal(job.error.code, 'SERVER_NOT_READY');
});

test('hot backup pauses and always resumes autosave', async () => {
    const { worlds, backups, operations, minecraft } = setup();
    const world = worlds.create({ name: 'Hot' });
    writeWorld(worlds, world.id, 'v1');
    worlds.activate(world.id);
    const commands = [];
    Object.assign(minecraft, {
        isRunning: () => true,
        status: 'ONLINE',
        rcon: {},
        sendCommand: async (command) => { commands.push(command); return command === 'save-all flush' ? 'Saved the game' : ''; },
    });
    const job = await waitJob(operations, backups.backup({ worldId: world.id }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    assert.ok(commands.indexOf('save-off') < commands.indexOf('save-all flush'));
    assert.ok(commands.includes('save-on'));
    assert.equal(backups.list()[0].hot, true);
});

test('restore replace takes a safety snapshot and restores old content', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');
    await waitJob(operations, backups.backup({ worldId: world.id }));
    const [original] = backups.list();

    writeWorld(worlds, world.id, 'v2');
    const job = await waitJob(operations, backups.restore(original.id, { mode: 'replace' }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    assert.equal(fs.readFileSync(path.join(worlds.dirFor(world.id), 'level.dat'), 'utf8'), 'v1');
    assert.ok(backups.list().some((b) => b.kind === 'pre-restore'));
    assert.deepEqual(fs.readdirSync(path.dirname(worlds.dirFor(world.id))), [world.id]);
});

test('restore as new creates a separate world', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');
    await waitJob(operations, backups.backup({ worldId: world.id }));
    const job = await waitJob(operations, backups.restore(backups.list()[0].id, { mode: 'new', newName: 'Copy' }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    const copy = worlds.get(job.result.worldId);
    assert.equal(copy.name, 'Copy');
    assert.equal(fs.readFileSync(path.join(worlds.dirFor(copy.id), 'level.dat'), 'utf8'), 'v1');
});

test('a corrupted backup is refused and the world is left untouched', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');
    await waitJob(operations, backups.backup({ worldId: world.id }));
    const [meta] = backups.list();
    fs.appendFileSync(backups.fileFor(meta), 'garbage');
    writeWorld(worlds, world.id, 'v2');
    const job = await waitJob(operations, backups.restore(meta.id, { mode: 'replace' }));
    assert.equal(job.error.code, 'CHECKSUM_MISMATCH');
    assert.equal(fs.readFileSync(path.join(worlds.dirFor(world.id), 'level.dat'), 'utf8'), 'v2');
});

test('restore puts the original world back if the final swap fails', async () => {
    const { worlds, backups, operations } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');
    await waitJob(operations, backups.backup({ worldId: world.id }));
    const [meta] = backups.list();
    writeWorld(worlds, world.id, 'v2');

    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from.includes('.restore-staging')) throw new Error('rename failed');
        return realRename(from, to);
    };
    try {
        const job = await waitJob(operations, backups.restore(meta.id, { mode: 'replace' }));
        assert.equal(job.status, 'failed');
    } finally {
        fs.renameSync = realRename;
    }
    assert.equal(fs.readFileSync(path.join(worlds.dirFor(world.id), 'level.dat'), 'utf8'), 'v2');
});

test('safety snapshots are pruned to five while manual backups are kept', async () => {
    const { worlds, backups } = setup();
    const world = worlds.create({ name: 'Main' });
    writeWorld(worlds, world.id, 'v1');
    const ctx = { progress() {}, log() {} };
    await backups.createBackup(ctx, world, 'manual');
    for (let i = 0; i < 7; i += 1) await backups.createBackup(ctx, world, 'pre-restore');
    const all = backups.list({ worldId: world.id });
    assert.equal(all.filter((b) => b.kind === 'manual').length, 1);
    assert.equal(all.filter((b) => b.kind === 'pre-restore').length, 5);
});

test('extractWorld finds a nested world root and rejects bad archives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-zip-'));
    const nested = path.join(dir, 'nested.zip');
    await makeZip(nested, [['MyWorld/level.dat', 'x'], ['MyWorld/region/r.mca', 'y'], ['readme.txt', 'z']]);
    const out = path.join(dir, 'out');
    await extractWorld(nested, out);
    assert.deepEqual(fs.readdirSync(out).sort(), ['level.dat', 'region']);

    const two = path.join(dir, 'two.zip');
    await makeZip(two, [['a/level.dat', 'x'], ['b/level.dat', 'y']]);
    await assert.rejects(extractWorld(two, path.join(dir, 'o2')), { code: 'INVALID_WORLD_ARCHIVE' });

    const none = path.join(dir, 'none.zip');
    await makeZip(none, [['hello.txt', 'x']]);
    await assert.rejects(extractWorld(none, path.join(dir, 'o3')), { code: 'INVALID_WORLD_ARCHIVE' });

    await assert.rejects(extractWorld(nested, path.join(dir, 'o4'), { freeBytes: 1 }), { code: 'INSUFFICIENT_DISK' });
});

test('safeEntryPath rejects traversal and absolute paths', () => {
    assert.equal(safeEntryPath('world\\region\\r.mca'), 'world/region/r.mca');
    assert.throws(() => safeEntryPath('../evil'), { code: 'UNSAFE_ARCHIVE' });
    assert.throws(() => safeEntryPath('a/../../evil'), { code: 'UNSAFE_ARCHIVE' });
    assert.throws(() => safeEntryPath('/etc/passwd'), { code: 'UNSAFE_ARCHIVE' });
    assert.throws(() => safeEntryPath('C:/Windows/x'), { code: 'UNSAFE_ARCHIVE' });
});

test('deleting a world refuses the active one and removes others', async () => {
    const { worlds } = setup();
    const a = worlds.create({ name: 'A' });
    const b = worlds.create({ name: 'B' });
    worlds.activate(a.id);
    await assert.rejects(worlds.remove(a.id), { code: 'WORLD_ACTIVE' });
    writeWorld(worlds, b.id, 'v1');
    await worlds.remove(b.id);
    assert.deepEqual(worlds.list().map((w) => w.id), [a.id]);
    assert.equal(fs.existsSync(worlds.dirFor(b.id)), false);
});
