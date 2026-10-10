const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const express = require('express');
const { JsonStore } = require('../lib/store');
const { MapControl, BLUEMAP } = require('../lib/map-control');

const fakeTimers = () => {
    const pending = new Set();
    const add = (fn, ms) => {
        const timer = { fn, ms };
        pending.add(timer);
        return timer;
    };
    return {
        pending,
        setTimeout: add,
        setInterval: add,
        clearTimeout: (timer) => pending.delete(timer),
        clearInterval: (timer) => pending.delete(timer),
        run: (ms) => {
            for (const timer of [...pending]) {
                if (timer.ms === ms) {
                    pending.delete(timer);
                    timer.fn();
                }
            }
        },
    };
};

const setup = ({ installed = true } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-map-'));
    const server = path.join(root, 'server');
    const modsDir = path.join(server, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    fs.writeFileSync(path.join(server, 'server.properties'), 'level-name=worlds/w1\n');
    const manifest = new JsonStore(path.join(root, 'manifest.json'), { mods: [] });
    if (installed) {
        fs.writeFileSync(path.join(modsDir, 'bluemap.jar'), 'x');
        manifest.update((draft) => { draft.mods.push({ projectId: BLUEMAP, fileName: 'bluemap.jar' }); });
    }
    const state = new JsonStore(path.join(root, 'state.json'), { activeWorldId: 'w1', worlds: [] });
    const minecraft = Object.assign(new EventEmitter(), { rcon: {}, commands: [] });
    minecraft.sendCommand = async (command) => {
        minecraft.commands.push(command);
        return '§aok';
    };
    const timers = fakeTimers();
    const config = { SERVER_DIR: server, PROPERTIES_FILE: path.join(server, 'server.properties') };
    const map = new MapControl({ config, state, minecraft, addons: { manifest, modsDir }, timers });
    return { root, server, map, minecraft, timers };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('rendering pauses on server start, runs while watched and stops a minute after the last viewer', async () => {
    const { map, minecraft, timers } = setup();
    await map.prepare();
    assert.deepEqual(minecraft.commands, ['bluemap stop']);

    map.setViewers(1);
    await flush();
    assert.ok(minecraft.commands.includes('bluemap start'));
    assert.equal(map.rendering, true);
    map.setViewers(2);
    map.setViewers(0);
    minecraft.commands.length = 0;
    await flush();
    assert.ok(!minecraft.commands.includes('bluemap stop'), 'not stopped immediately');

    map.setViewers(1); // came back within the grace period
    timers.run(60000);
    await flush();
    assert.ok(!minecraft.commands.includes('bluemap stop'));

    map.setViewers(0);
    timers.run(60000);
    await flush();
    assert.ok(minecraft.commands.includes('bluemap stop'));
    assert.equal(map.rendering, false);
});

test('nothing is sent when BlueMap is not installed', async () => {
    const { map, minecraft } = setup({ installed: false });
    await map.prepare();
    map.setViewers(1);
    await flush();
    assert.deepEqual(minecraft.commands, []);
});

test('generated configs are patched: downloads accepted, one thread, no web server, per-world folders', async () => {
    const { map, server, minecraft } = setup();
    const dir = path.join(server, 'config', 'bluemap');
    fs.mkdirSync(path.join(dir, 'maps'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core.conf'), '# c\naccept-download: false\nrender-thread-count: 3\nmetrics: true\n');
    fs.writeFileSync(path.join(dir, 'webserver.conf'), 'enabled: true\nport: 8100\n');
    fs.writeFileSync(path.join(dir, 'webapp.conf'), 'enabled: true\nwebroot: "bluemap/web"\n');
    fs.writeFileSync(path.join(dir, 'storages', 'file.conf'), 'storage-type: FILE\nroot: "bluemap/web/maps"\n');
    fs.writeFileSync(path.join(dir, 'maps', 'world.conf'), 'world: "worlds/old"\ndimension: "minecraft:overworld"\n');
    fs.writeFileSync(path.join(dir, 'maps', 'nether.conf'), 'world: "world/DIM-1"\n');

    await map.prepare();
    assert.match(fs.readFileSync(path.join(dir, 'core.conf'), 'utf8'), /accept-download: true\nrender-thread-count: 1\nmetrics: false/);
    assert.match(fs.readFileSync(path.join(dir, 'webserver.conf'), 'utf8'), /^enabled: false$/m);
    assert.match(fs.readFileSync(path.join(dir, 'webapp.conf'), 'utf8'), /webroot: "bluemap\/w1\/web"/);
    assert.match(fs.readFileSync(path.join(dir, 'storages', 'file.conf'), 'utf8'), /root: "bluemap\/w1\/web\/maps"/);
    assert.match(fs.readFileSync(path.join(dir, 'maps', 'world.conf'), 'utf8'), /world: "worlds\/w1"/);
    assert.match(fs.readFileSync(path.join(dir, 'maps', 'nether.conf'), 'utf8'), /world: "worlds\/w1\/DIM-1"/);
    assert.equal(minecraft.commands[0], 'bluemap reload');
    assert.equal(map.patchConfigs(), false, 'second pass changes nothing');
});

test('map files are served with gzip tiles, 204 for missing tiles and no path escapes', async () => {
    const { map, server } = setup();
    const web = path.join(server, 'bluemap', 'w1', 'web');
    fs.mkdirSync(path.join(web, 'maps', 'world', 'tiles', '0'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<html>map</html>');
    fs.writeFileSync(path.join(web, 'maps', 'world', 'tiles', '0', 'x0z0.prbm.gz'), zlib.gzipSync('tile-data'));
    fs.writeFileSync(path.join(server, 'secret.txt'), 'nope');

    const app = express();
    app.use('/map', (req, res) => map.serve(req, res));
    const listener = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${listener.address().port}/map`;
    try {
        assert.equal(await (await fetch(`${base}/`)).text(), '<html>map</html>');
        const tile = await fetch(`${base}/maps/world/tiles/0/x0z0.prbm`);
        assert.equal(tile.status, 200);
        assert.equal(await tile.text(), 'tile-data', 'fetch decodes the gzip encoding');
        assert.equal((await fetch(`${base}/maps/world/tiles/0/x9z9.prbm`)).status, 204);
        assert.equal((await fetch(`${base}/maps/world/settings.json`)).status, 404);
        const escape = await fetch(`${base}/..%2f..%2fsecret.txt`);
        assert.ok([403, 404].includes(escape.status));
    } finally {
        listener.close();
    }
    assert.equal(map.view().ready, true);
});
