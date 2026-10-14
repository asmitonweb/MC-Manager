const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../lib/store');
const { WorldManager, slugify } = require('../lib/worlds');
const { readPropertiesFile } = require('../lib/properties');

const setup = ({ running = false } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-worlds-'));
    const config = { SERVER_DIR: path.join(root, 'server'), PROPERTIES_FILE: path.join(root, 'server', 'server.properties') };
    fs.mkdirSync(config.SERVER_DIR, { recursive: true });
    const state = new JsonStore(path.join(root, 'state.json'), { profile: null, worlds: [], activeWorldId: null });
    const minecraft = { isRunning: () => running };
    return { root, config, state, worlds: new WorldManager({ config, state, minecraft }) };
};

test('slugify produces safe ids', () => {
    assert.equal(slugify('My Survival World!'), 'my-survival-world');
    assert.equal(slugify('***'), 'world');
});

test('create registers unique worlds and activate rewrites level-name', () => {
    const { worlds, config } = setup();
    const a = worlds.create({ name: 'Survival', seed: '123', levelType: 'flat' });
    const b = worlds.create({ name: 'Survival' });
    assert.notEqual(a.id, b.id);
    assert.ok(fs.existsSync(path.join(config.SERVER_DIR, 'worlds', a.id)));

    worlds.activate(a.id);
    let props = readPropertiesFile(config.PROPERTIES_FILE);
    assert.equal(props['level-name'], `worlds/${a.id}`);
    assert.equal(props['level-seed'], '123');
    assert.equal(props['level-type'], 'minecraft\\:flat');
    assert.equal(worlds.activeId(), a.id);

    // Once generated, seed and type no longer apply.
    fs.writeFileSync(path.join(config.SERVER_DIR, 'worlds', a.id, 'level.dat'), '');
    worlds.activate(a.id);
    props = readPropertiesFile(config.PROPERTIES_FILE);
    assert.equal(props['level-seed'], '');
    assert.equal(props['level-type'], 'minecraft\\:normal');
});

test('switching worlds is refused while the server runs', () => {
    const { worlds } = setup({ running: true });
    const world = worlds.create({ name: 'A' });
    assert.throws(() => worlds.activate(world.id), { code: 'SERVER_RUNNING' });
});

test('invalid names and ids are rejected', () => {
    const { worlds } = setup();
    assert.throws(() => worlds.create({ name: '' }), { code: 'INVALID_WORLD_NAME' });
    assert.throws(() => worlds.create({ name: 'x', levelType: 'weird' }), { code: 'INVALID_LEVEL_TYPE' });
    assert.throws(() => worlds.dirFor('../etc'), { code: 'INVALID_WORLD_ID' });
});

test('reconcile registers unknown world folders and follows level-name', () => {
    const { worlds, config } = setup();
    fs.mkdirSync(path.join(config.SERVER_DIR, 'worlds', 'found'), { recursive: true });
    fs.writeFileSync(path.join(config.SERVER_DIR, 'worlds', 'found', 'level.dat'), '');
    fs.writeFileSync(config.PROPERTIES_FILE, 'level-name=worlds/found\n');
    worlds.reconcile();
    assert.deepEqual(worlds.list().map((w) => w.id), ['found']);
    assert.equal(worlds.activeId(), 'found');
});

test('adoptLegacy moves server/world under worlds/', () => {
    const { worlds, config } = setup();
    fs.mkdirSync(path.join(config.SERVER_DIR, 'world'));
    fs.writeFileSync(path.join(config.SERVER_DIR, 'world', 'level.dat'), '');
    const world = worlds.adoptLegacy('Old World');
    assert.ok(fs.existsSync(path.join(config.SERVER_DIR, 'worlds', world.id, 'level.dat')));
    assert.equal(worlds.activeId(), world.id);
});
