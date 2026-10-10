const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { JsonStore } = require('../lib/store');
const { Operations } = require('../lib/operations');
const { WorldManager } = require('../lib/worlds');
const { BackupManager } = require('../lib/backups');
const { SetupManager } = require('../lib/setups');
const { WorldSwitcher } = require('../lib/world-switcher');
const { readLevelInfo } = require('../lib/nbt');

// Writes a minimal gzipped level.dat with Data.Version.Name.
const writeLevelDat = (dir, versionName) => {
    const str = (s) => { const b = Buffer.from(s); const len = Buffer.alloc(2); len.writeUInt16BE(b.length); return Buffer.concat([len, b]); };
    const tag = (type, name, payload) => Buffer.concat([Buffer.from([type]), str(name), payload]);
    const int = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
    const version = tag(10, 'Version', Buffer.concat([tag(8, 'Name', str(versionName)), tag(3, 'Id', int(4903)), Buffer.from([0])]));
    const data = tag(10, 'Data', Buffer.concat([version, tag(3, 'DataVersion', int(4903)), tag(8, 'LevelName', str('world')), Buffer.from([0])]));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(tag(10, '', Buffer.concat([data, Buffer.from([0])]))));
};

const RELEASES = ['26.3', '26.2', '26.1', '1.21.1', '1.20.1'].map((id) => ({ id }));

const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-setups-'));
    const config = {
        SANDBOX_ROOT: root,
        SERVER_DIR: path.join(root, 'server'),
        BACKUP_DIR: path.join(root, 'backups'),
        DATA_DIR: path.join(root, 'data'),
        PROPERTIES_FILE: path.join(root, 'server', 'server.properties'),
    };
    const server = config.SERVER_DIR;
    fs.mkdirSync(path.join(server, 'libraries', 'x'), { recursive: true });
    fs.mkdirSync(path.join(server, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(server, 'config'), { recursive: true });
    fs.writeFileSync(path.join(server, 'fabric-server-launch.jar'), 'fabric 1.21.1');
    fs.writeFileSync(path.join(server, 'mods', 'aot.jar'), 'aot');
    fs.writeFileSync(path.join(server, 'server.properties'), 'motd=shared\n');
    fs.writeFileSync(path.join(server, 'ops.json'), '[]');

    const profile = { loader: 'fabric', minecraftVersion: '1.21.1', launch: { type: 'jar', jar: 'fabric-server-launch.jar' } };
    const state = new JsonStore(path.join(root, 'state.json'), { profile, worlds: [], activeWorldId: null });
    const minecraft = { isRunning: () => false, status: 'OFFLINE', refreshStatus() {} };
    const operations = new Operations();
    const manifest = new JsonStore(path.join(config.DATA_DIR, 'addons-manifest.json'), { mods: [] });
    manifest.update((draft) => { draft.mods = [{ title: "Danny's AOT", versionNumber: '2.5', fileName: 'aot.jar' }]; });
    const addons = { manifest };
    const worlds = new WorldManager({ config, state, minecraft });
    const setups = new SetupManager({ config, state, minecraft, addons });
    const backups = new BackupManager({ config, state, minecraft, worlds, operations });
    const switcher = new WorldSwitcher({ worlds, setups, backups, operations, minecraft, listReleases: async () => RELEASES });
    return { root, server, state, worlds, setups, switcher, operations, manifest, minecraft, backups };
};

const waitJob = async (operations, job) => {
    for (let i = 0; i < 200; i += 1) {
        const current = operations.getJob(job.id);
        if (current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job timeout');
};

// Simulates installing a second setup into the (parked) server folder.
const installSecond = (ctx, minecraftVersion) => {
    ctx.setups.parkActive();
    fs.writeFileSync(path.join(ctx.server, 'fabric-server-launch.jar'), `fabric ${minecraftVersion}`);
    return ctx.setups.register({ loader: 'fabric', minecraftVersion, launch: { type: 'jar', jar: 'fabric-server-launch.jar' } });
};

test('readLevelInfo reads the saved version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-nbt-'));
    writeLevelDat(dir, '26.2');
    assert.deepEqual(readLevelInfo(dir), { versionName: '26.2', dataVersion: 4903, levelName: 'world', modded: false });
    assert.equal(readLevelInfo(path.join(dir, 'missing')), null);
});

test('migrate turns the existing install into the first setup', () => {
    const ctx = setup();
    const world = ctx.worlds.create({ name: 'AOT' });
    ctx.state.update((draft) => { draft.worlds[0].setupId = null; });
    ctx.setups.migrate();
    assert.equal(ctx.setups.activeId(), 'fabric-1.21.1');
    assert.equal(ctx.worlds.get(world.id).setupId, 'fabric-1.21.1');
    assert.equal(ctx.setups.list()[0].mods[0].title, "Danny's AOT");
});

test('a new setup parks the old one; switching swaps files and mods but keeps shared data', () => {
    const ctx = setup();
    ctx.setups.migrate();
    const newId = installSecond(ctx, '26.3');
    assert.equal(newId, 'fabric-26.3');
    assert.equal(fs.readFileSync(path.join(ctx.server, 'fabric-server-launch.jar'), 'utf8'), 'fabric 26.3');
    assert.equal(fs.existsSync(path.join(ctx.server, 'mods')), false);
    assert.deepEqual(ctx.manifest.get().mods, []);
    assert.equal(ctx.setups.list().find((s) => s.id === 'fabric-1.21.1').mods.length, 1);

    ctx.setups.switchTo('fabric-1.21.1');
    assert.equal(fs.readFileSync(path.join(ctx.server, 'fabric-server-launch.jar'), 'utf8'), 'fabric 1.21.1');
    assert.ok(fs.existsSync(path.join(ctx.server, 'mods', 'aot.jar')));
    assert.ok(fs.existsSync(path.join(ctx.server, 'libraries', 'x')));
    assert.equal(ctx.manifest.get().mods.length, 1);
    assert.equal(ctx.state.get().profile.minecraftVersion, '1.21.1');
    assert.equal(fs.readFileSync(path.join(ctx.server, 'server.properties'), 'utf8'), 'motd=shared\n');
    assert.ok(fs.existsSync(path.join(ctx.server, 'ops.json')));

    ctx.setups.switchTo('fabric-26.3');
    assert.equal(fs.readFileSync(path.join(ctx.server, 'fabric-server-launch.jar'), 'utf8'), 'fabric 26.3');
});

test('a failed switch puts the previous setup back', () => {
    const ctx = setup();
    ctx.setups.migrate();
    installSecond(ctx, '26.3');
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (from.includes(path.join('setups', 'fabric-1.21.1', 'files', 'mods'))) throw new Error('locked');
        return realRename(from, to);
    };
    try {
        assert.throws(() => ctx.setups.switchTo('fabric-1.21.1'), /locked/);
    } finally {
        fs.renameSync = realRename;
    }
    assert.equal(ctx.setups.activeId(), 'fabric-26.3');
    assert.equal(fs.readFileSync(path.join(ctx.server, 'fabric-server-launch.jar'), 'utf8'), 'fabric 26.3');
});

test('switcher refuses downgrades and asks before upgrades', async () => {
    const ctx = setup();
    ctx.setups.migrate();
    installSecond(ctx, '26.3');
    const old = ctx.worlds.create({ name: 'Old', setupId: 'fabric-1.21.1' });
    writeLevelDat(ctx.worlds.dirFor(old.id), '26.2');

    await assert.rejects(ctx.switcher.activate(old.id), { code: 'WORLD_TOO_NEW' });
    await assert.rejects(ctx.switcher.moveToSetup(old.id, 'fabric-26.3'), { code: 'UPGRADE_CONFIRMATION_REQUIRED' });

    const { world } = await ctx.switcher.moveToSetup(old.id, 'fabric-26.3', { confirmUpgrade: true });
    assert.equal(world.setupId, 'fabric-26.3');
    await assert.rejects(ctx.switcher.activate(old.id), { code: 'UPGRADE_CONFIRMATION_REQUIRED' });

    const { job } = await ctx.switcher.activate(old.id, { confirmUpgrade: true });
    const done = await waitJob(ctx.operations, job);
    assert.equal(done.status, 'succeeded', done.error?.message);
    assert.equal(ctx.worlds.activeId(), old.id);
    assert.ok(ctx.backups.list({ worldId: old.id }).some((b) => b.kind === 'pre-upgrade'));
});

test('activating a world on another setup switches the server in one step', async () => {
    const ctx = setup();
    ctx.setups.migrate();
    const aot = ctx.worlds.create({ name: 'AOT' });
    ctx.worlds.activate(aot.id);
    installSecond(ctx, '26.3');
    const fresh = ctx.worlds.create({ name: 'Fresh', setupId: 'fabric-26.3' });
    ctx.worlds.activate(fresh.id);

    const { job } = await ctx.switcher.activate(aot.id);
    assert.equal((await waitJob(ctx.operations, job)).status, 'succeeded');
    assert.equal(ctx.setups.activeId(), 'fabric-1.21.1');
    assert.equal(ctx.worlds.activeId(), aot.id);
    assert.ok(fs.existsSync(path.join(ctx.server, 'mods', 'aot.jar')));

    const same = await ctx.switcher.activate(aot.id);
    assert.ok(same.world, 'no job when nothing needs switching');
});

test('setups in use or active cannot be removed', () => {
    const ctx = setup();
    ctx.setups.migrate();
    ctx.worlds.create({ name: 'AOT' });
    installSecond(ctx, '26.3');
    assert.throws(() => ctx.setups.remove('fabric-26.3'), { code: 'SETUP_ACTIVE' });
    assert.throws(() => ctx.setups.remove('fabric-1.21.1'), { code: 'SETUP_IN_USE' });
});
