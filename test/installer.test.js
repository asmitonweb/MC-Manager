const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMetadata, isSupportedMinecraft, findWinArgs, compareVersions } = require('../lib/installer/forge');
const { ServerInstaller, isLoaderArtifact } = require('../lib/installer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-install-'));
const bareInstaller = () => new ServerInstaller({ config: {}, state: {}, minecraft: {}, operations: {}, worlds: {} });

test('Forge metadata keeps supported versions, newest first', () => {
    const xml = ['1.7.10-10.13.4.1614-1.7.10', '1.16.5-36.2.39', '1.20.1-47.2.0', '1.20.1-47.10.1', '26.2-65.1.0']
        .map((v) => `<version>${v}</version>`).join('');
    assert.deepEqual(parseMetadata(xml), { '1.20.1': ['47.10.1', '47.2.0'], '26.2': ['65.1.0'] });
    assert.equal(isSupportedMinecraft('1.17'), true);
    assert.equal(isSupportedMinecraft('1.16.5'), false);
    assert.equal(isSupportedMinecraft('26.3'), true);
    assert.ok(compareVersions('1.21.10', '1.21.9') > 0);
});

test('findWinArgs reads run.bat, then falls back to the conventional path', () => {
    const dir = tmp();
    const rel = 'libraries/net/minecraftforge/forge/26.2-65.1.0/win_args.txt';
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '-jar shim.jar');
    assert.equal(findWinArgs(dir, '26.2', '65.1.0'), rel);
    fs.writeFileSync(path.join(dir, 'run.bat'), `java @user_jvm_args.txt @${rel} %*\r\n`);
    assert.equal(findWinArgs(dir, '26.2', '0.0.0'), rel);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(findWinArgs(tmp(), '26.2', '65.1.0'), null);
});

test('loader artifacts exclude user data', () => {
    assert.ok(isLoaderArtifact('fabric-server-launch.jar'));
    assert.ok(isLoaderArtifact('libraries'));
    assert.ok(!isLoaderArtifact('mods'));
    assert.ok(!isLoaderArtifact('server.properties'));
});

test('swapIn replaces loader files, keeps user data, and backs up the old install', () => {
    const root = tmp();
    const server = path.join(root, 'server');
    const staging = path.join(root, 'staging');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(path.join(server, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(server, 'libraries'), { recursive: true });
    fs.writeFileSync(path.join(server, 'fabric-server-launch.jar'), 'old');
    fs.writeFileSync(path.join(server, 'server.properties'), 'motd=keep\n');
    fs.mkdirSync(path.join(staging, 'libraries'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'forge-shim.jar'), 'new');

    bareInstaller().swapIn({ log() {} }, staging, server, backup);

    assert.deepEqual(fs.readdirSync(server).sort(), ['forge-shim.jar', 'libraries', 'mods', 'server.properties']);
    assert.deepEqual(fs.readdirSync(backup).sort(), ['fabric-server-launch.jar', 'libraries']);
    assert.equal(fs.readFileSync(path.join(server, 'server.properties'), 'utf8'), 'motd=keep\n');
    fs.rmSync(root, { recursive: true, force: true });
});

test('swapIn restores the previous install when a move fails', () => {
    const root = tmp();
    const server = path.join(root, 'server');
    const staging = path.join(root, 'staging');
    const backup = path.join(root, 'backup');
    fs.mkdirSync(server, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(server, 'old.jar'), 'old');
    fs.writeFileSync(path.join(staging, 'a.jar'), 'new');
    fs.writeFileSync(path.join(staging, 'b.jar'), 'new');

    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (path.basename(from) === 'b.jar' && to.startsWith(server)) throw new Error('disk full');
        return realRename(from, to);
    };
    try {
        assert.throws(() => bareInstaller().swapIn({ log() {} }, staging, server, backup), /disk full/);
    } finally {
        fs.renameSync = realRename;
    }
    assert.deepEqual(fs.readdirSync(server), ['old.jar']);
    fs.rmSync(root, { recursive: true, force: true });
});
