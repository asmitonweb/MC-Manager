const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const { JsonStore } = require('../lib/store');
const { Operations } = require('../lib/operations');
const { SetupManager } = require('../lib/setups');
const { ClientSync } = require('../lib/client-sync');
const { publicRouter } = require('../routes/client');

const TOKEN = 'a'.repeat(32);
const AGENT_JAR = path.join(__dirname, '..', 'client-agent', 'dist', 'agent.jar');
const sha = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');

const FABRIC_PROFILE = {
    id: 'fabric-loader-0.19.5-1.21.1',
    inheritsFrom: '1.21.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.19.5', url: 'https://maven.fabricmc.net/' }],
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
};

const waitJob = async (operations, job) => {
    for (let i = 0; i < 200; i += 1) {
        const current = operations.getJob(job.id);
        if (current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job timeout');
};

const setup = ({ agentFile = AGENT_JAR } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-client-'));
    const config = { SANDBOX_ROOT: root, SERVER_DIR: path.join(root, 'server'), DATA_DIR: path.join(root, 'data'), PORT: 3000 };
    const modsDir = path.join(config.SERVER_DIR, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const jar = (name, content) => {
        fs.writeFileSync(path.join(modsDir, name), content);
        return { fileName: name, sha1: sha('sha1', content), sha512: sha('sha512', content) };
    };
    const manifest = new JsonStore(path.join(config.DATA_DIR, 'addons-manifest.json'), { mods: [] });
    manifest.update((draft) => {
        draft.mods = [
            { provider: 'modrinth', projectId: 'aot', versionId: 'v1', title: "Danny's AOT", versionNumber: '2.5', clientSide: 'required', ...jar('aot.jar', 'aot-jar') },
            { provider: 'modrinth', projectId: 'P7dR8mSH', versionId: 'v2', title: 'Fabric API', versionNumber: '0.1', clientSide: 'optional', downloadUrl: 'https://cdn.modrinth.com/data/P7dR8mSH/versions/v2/fabric-api.jar', ...jar('fabric-api.jar', 'api-jar') },
            { provider: 'modrinth', projectId: 'srv', versionId: 'v3', title: 'Server Only', versionNumber: '1', clientSide: 'unsupported', ...jar('server-only.jar', 'srv-jar') },
        ];
    });
    const state = new JsonStore(path.join(root, 'state.json'), {
        profile: { loader: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.19.5' },
        worlds: [{ id: 'w1', name: 'Attack on Titan' }],
        activeWorldId: 'w1',
    });
    const operations = new Operations();
    const searches = [];
    const versions = {
        shader1: { id: 'sv', projectId: 'shader1', versionNumber: 's1', file: { url: 'https://cdn.modrinth.com/s.zip', fileName: 'Shader.zip', size: 3, hashes: {} }, dependencies: [] },
        YL57xq9U: { id: 'iv', projectId: 'YL57xq9U', versionNumber: 'i1', file: { url: 'https://cdn.modrinth.com/iris.jar', fileName: 'iris.jar', size: 3, hashes: {} }, dependencies: [{ projectId: 'AANobbMI', type: 'required' }] },
        AANobbMI: { id: 'sov', projectId: 'AANobbMI', versionNumber: 'so1', file: { url: 'https://cdn.modrinth.com/sodium.jar', fileName: 'sodium.jar', size: 3, hashes: {} }, dependencies: [] },
    };
    const modrinth = {
        search: async (args) => { searches.push(args); return { total: 0, offset: 0, hits: [] }; },
        bestVersion: async (projectId, target) => { searches.push({ projectId, ...target }); return versions[projectId] || null; },
        getProjects: async (ids) => ids.map((id) => ({ id, title: { shader1: 'Nice Shader', YL57xq9U: 'Iris', AANobbMI: 'Sodium' }[id] || id })),
    };
    const addons = { manifest, modsDir, operations, providers: { modrinth } };
    const minecraft = { isRunning: () => false, refreshStatus() {} };
    const setups = new SetupManager({ config, state, minecraft, addons });
    setups.migrate();
    state.update((draft) => { draft.worlds[0].setupId = 'fabric-1.21.1'; });
    const settings = { serverName: 'Closed Room — Attack on Titan', gameAddress: '100.64.0.10:25565', packToken: TOKEN };
    const discord = {
        settings: () => settings,
        saveSettings: (patch) => Object.assign(settings, patch),
        packToken: () => TOKEN,
        isValidToken: (token) => token === TOKEN,
        schedule() {},
    };
    const download = async (url, dest) => {
        const content = `content of ${url}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        return { size: content.length, sha1: sha('sha1', content), sha512: sha('sha512', content) };
    };
    const clientSync = new ClientSync({ config, state, setups, addons, worlds: null, discord, modpack: null, agentFile, download, getJson: async () => FABRIC_PROFILE });
    return { root, config, state, setups, clientSync, operations, searches, settings, modsDir, manifest };
};

test('brand, launcher ids and labels come from the server name', () => {
    const { clientSync } = setup();
    assert.deepEqual(clientSync.brand(), { name: 'Closed Room', slug: 'closedroom', setupFile: 'ClosedRoom-Setup.cmd' });
    assert.equal(clientSync.versionId('fabric-1.21.1'), 'closedroom-fabric-1.21.1');
    assert.equal(clientSync.label('fabric-1.21.1', { loader: 'fabric', minecraftVersion: '1.21.1' }), 'Closed Room · Attack on Titan');
});

test('manifest lists client mods with CDN and manager URLs, and skips server-only mods', async () => {
    const { clientSync } = setup();
    const manifest = await clientSync.manifest();
    assert.equal(manifest.activeSetupId, 'fabric-1.21.1');
    const [only] = manifest.setups;
    assert.equal(only.autoSync, true);
    assert.deepEqual(only.files.map((file) => file.name), ['aot.jar', 'fabric-api.jar']);
    const api = only.files.find((file) => file.name === 'fabric-api.jar');
    assert.deepEqual(api.urls, ['https://cdn.modrinth.com/data/P7dR8mSH/versions/v2/fabric-api.jar', 'file/fabric-1.21.1/mods/fabric-api.jar']);
    const aot = only.files.find((file) => file.name === 'aot.jar');
    assert.equal(aot.urls[0], 'https://cdn.modrinth.com/data/aot/versions/v1/aot.jar', 'CDN URL derived for older entries');
    assert.match(aot.hash, /^sha512:[0-9a-f]{128}$/);

    const text = ClientSync.syncText(manifest);
    assert.match(text, /^setup\tfabric-1\.21\.1\tclosedroom-fabric-1\.21\.1\tClosed Room · Attack on Titan\t1\.21\.1\tfabric\t0\.19\.5\t1\t[0-9a-f]{16}$/m);
    assert.match(text, /^file\tfabric-1\.21\.1\tmods\taot\.jar\tsha512:/m);
    assert.doesNotMatch(text, /server-only/);
});

test('parked setups are included with their own mods', async () => {
    const ctx = setup();
    ctx.setups.parkActive();
    ctx.setups.register({ loader: 'fabric', minecraftVersion: '26.3', loaderVersion: '0.19.5' });
    const manifest = await ctx.clientSync.manifest();
    const parked = manifest.setups.find((entry) => entry.id === 'fabric-1.21.1');
    assert.equal(parked.active, false);
    assert.deepEqual(parked.files.map((file) => file.name), ['aot.jar', 'fabric-api.jar']);
    assert.ok(ctx.clientSync.resolveFile('fabric-1.21.1', 'mods', 'aot.jar').includes(path.join('setups', 'fabric-1.21.1', 'files', 'mods')));
    assert.equal(manifest.setups.find((entry) => entry.id === 'fabric-26.3').files.length, 0);
});

test('version JSON isolates the mods folder and loads the agent', async () => {
    const { clientSync } = setup();
    const { text } = await clientSync.versionJson('fabric-1.21.1');
    const json = JSON.parse(text);
    assert.equal(json.id, 'closedroom-fabric-1.21.1');
    assert.equal(json.inheritsFrom, '1.21.1');
    const agent = clientSync.agentInfo();
    const jvm = json.arguments.jvm;
    assert.equal(jvm[0], '-DFabricMcEmu= net.minecraft.client.main.Main ');
    if (agent) assert.ok(jvm.includes(`-javaagent:@@CLIENT@@/${agent.fileName}=fabric-1.21.1`));
    assert.ok(jvm.includes('-Dfabric.modsFolder=@@CLIENT@@/instances/fabric-1.21.1/mods'));
    assert.ok(jvm.includes('-Dfabric.addMods=@@CLIENT@@/instances/fabric-1.21.1/extra-mods'));
    assert.ok(jvm.includes('-Dmcmanager.gameDir=@@GAME@@'));
});

test('without a built agent the version JSON has no -javaagent', async () => {
    const { clientSync } = setup({ agentFile: path.join(os.tmpdir(), 'missing-agent.jar') });
    const json = JSON.parse((await clientSync.versionJson('fabric-1.21.1')).text);
    assert.ok(!json.arguments.jvm.some((arg) => arg.startsWith('-javaagent')));
});

test('only listed files can be downloaded', () => {
    const { clientSync } = setup();
    assert.ok(clientSync.resolveFile('fabric-1.21.1', 'mods', 'aot.jar'));
    assert.equal(clientSync.resolveFile('fabric-1.21.1', 'mods', 'server-only.jar'), null);
    assert.equal(clientSync.resolveFile('fabric-1.21.1', 'mods', '../state.json'), null);
    assert.equal(clientSync.resolveFile('nope', 'mods', 'aot.jar'), null);
    assert.equal(clientSync.resolveFile('fabric-1.21.1', 'config', 'aot.jar'), null);
});

test('a shader brings Iris and Sodium; removing it removes them too', async () => {
    const ctx = setup();
    const preview = await ctx.clientSync.preview({ setupId: 'fabric-1.21.1', type: 'shader', projectId: 'shader1' });
    assert.deepEqual(preview.items.map((item) => `${item.title}:${item.kind}`), ['Nice Shader:shaderpacks', 'Iris:mods', 'Sodium:mods']);
    assert.ok(ctx.searches.some((s) => s.projectId === 'shader1' && s.loaders.includes('iris')));

    const job = await ctx.clientSync.install({ setupId: 'fabric-1.21.1', type: 'shader', projectId: 'shader1' });
    const done = await waitJob(ctx.operations, job);
    assert.equal(done.status, 'succeeded', done.error?.message);
    const files = (await ctx.clientSync.manifest()).setups[0].files;
    assert.deepEqual(files.map((file) => `${file.kind}/${file.name}`).sort(), ['mods/aot.jar', 'mods/fabric-api.jar', 'mods/iris.jar', 'mods/sodium.jar', 'shaderpacks/Shader.zip']);
    assert.equal(files.find((file) => file.name === 'Shader.zip').urls[0], 'https://cdn.modrinth.com/s.zip');

    const { removed } = ctx.clientSync.remove({ setupId: 'fabric-1.21.1', projectId: 'shader1' });
    assert.deepEqual(removed.sort(), ['Iris', 'Nice Shader', 'Sodium']);
    assert.equal((await ctx.clientSync.manifest()).setups[0].files.length, 2);
});

const listen = (ctx) => new Promise((resolve) => {
    const app = express();
    app.use('/client/:token', publicRouter({ discord: { ...ctxDiscord(ctx) }, clientSync: ctx.clientSync }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
});
const ctxDiscord = (ctx) => ({
    settings: () => ctx.settings,
    isValidToken: (token) => token === TOKEN,
});

test('player endpoints need the token and serve the setup files', async () => {
    const ctx = setup();
    const server = await listen(ctx);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${base}/client/${'b'.repeat(32)}/sync.txt`)).status, 404);
        const sync = await fetch(`${base}/client/${TOKEN}/sync.txt`);
        assert.equal(sync.status, 200);
        assert.match(await sync.text(), /^v\t1\n/);
        const ps1 = await (await fetch(`${base}/client/${TOKEN}/setup.ps1`)).text();
        assert.ok(ps1.includes(`$Token = '${TOKEN}'`));
        assert.ok(ps1.includes("$Slug = 'closedroom'"));
        assert.ok(!/[^\x00-\x7f]/.test(ps1), 'setup script is ASCII');
        const cmd = await fetch(`${base}/client/${TOKEN}/ClosedRoom-Setup.cmd`);
        assert.match(cmd.headers.get('content-disposition'), /ClosedRoom-Setup\.cmd/);
        const cmdText = await cmd.text();
        assert.doesNotMatch(cmdText, /\biex\b|\birm /, 'no download-and-evaluate cradle');
        assert.ok(cmdText.includes('##MCM-SCRIPT\r\n# '), 'script embedded after the marker');
        assert.ok(cmdText.includes(`$Token = '${TOKEN}'`));
        assert.equal(ctx.clientSync.setupCommand('http://h:3000', TOKEN),
            `$f="$env:TEMP\\ClosedRoom-Setup.cmd"; iwr http://h:3000/client/${TOKEN}/ClosedRoom-Setup.cmd -UseBasicParsing -OutFile $f; & $f`);
        assert.equal((await fetch(`${base}/client/${TOKEN}/file/fabric-1.21.1/mods/server-only.jar`)).status, 404);
        assert.equal(await (await fetch(`${base}/client/${TOKEN}/file/fabric-1.21.1/mods/aot.jar`)).text(), 'aot-jar');
    } finally {
        server.close();
    }
});

const hasJava = (() => {
    try {
        execFileSync('java', ['-version'], { stdio: 'ignore' });
        return fs.existsSync(AGENT_JAR);
    } catch {
        return false;
    }
})();

test('the agent syncs a player folder against the manager', { skip: !hasJava && 'needs java and client-agent/dist/agent.jar' }, async () => {
    const ctx = setup();
    // CDN URLs would leave the machine; serve everything from the manager.
    ctx.manifest.update((draft) => {
        for (const mod of draft.mods) {
            mod.downloadUrl = null;
            mod.provider = 'local';
        }
    });
    const server = await listen(ctx);
    const base = `http://127.0.0.1:${server.address().port}`;
    const player = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-player-'));
    const clientRoot = path.join(player, '.closedroom');
    const game = path.join(player, '.minecraft');
    fs.mkdirSync(path.join(clientRoot, 'instances', 'fabric-1.21.1', 'mods'), { recursive: true });
    fs.mkdirSync(path.join(game, 'shaderpacks'), { recursive: true });
    fs.writeFileSync(path.join(clientRoot, 'client.properties'), `base=${base}\ntoken=${TOKEN}\nslug=closedroom\n`);
    fs.writeFileSync(path.join(clientRoot, 'instances', 'fabric-1.21.1', 'mods', 'stale.jar'), 'old');
    fs.writeFileSync(path.join(game, 'shaderpacks', 'PlayersOwn.zip'), 'mine');
    fs.writeFileSync(path.join(game, 'launcher_profiles.json'), '{\n  "profiles": {\n    "abc": { "name": "Mine", "type": "custom" }\n  },\n  "version": 3\n}');
    const run = () => new Promise((resolve, reject) => {
        require('child_process').execFile('java', [`-Dmcmanager.root=${clientRoot}`, '-jar', AGENT_JAR, 'fabric-1.21.1', game], { timeout: 60000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
    try {
        const out = await run();
        const mods = fs.readdirSync(path.join(clientRoot, 'instances', 'fabric-1.21.1', 'mods')).sort();
        assert.deepEqual(mods, ['aot.jar', 'fabric-api.jar'], out);
        assert.ok(fs.existsSync(path.join(game, 'shaderpacks', 'PlayersOwn.zip')), 'player files untouched');
        const agentName = ctx.clientSync.agentInfo().fileName;
        assert.ok(fs.existsSync(path.join(clientRoot, agentName)), 'agent downloaded');
        const version = JSON.parse(fs.readFileSync(path.join(game, 'versions', 'closedroom-fabric-1.21.1', 'closedroom-fabric-1.21.1.json'), 'utf8'));
        const fwdRoot = clientRoot.replace(/\\/g, '/');
        assert.ok(version.arguments.jvm.includes(`-Dfabric.modsFolder=${fwdRoot}/instances/fabric-1.21.1/mods`));
        assert.ok(version.arguments.jvm.includes(`-javaagent:${fwdRoot}/${agentName}=fabric-1.21.1`));
        const profiles = JSON.parse(fs.readFileSync(path.join(game, 'launcher_profiles.json'), 'utf8'));
        assert.equal(profiles.profiles.abc.name, 'Mine');
        assert.equal(profiles.profiles['closedroom-fabric-1.21.1'].name, 'Closed Room · Attack on Titan');
        assert.equal(profiles.profiles['closedroom-fabric-1.21.1'].lastVersionId, 'closedroom-fabric-1.21.1');
        const servers = fs.readFileSync(path.join(game, 'servers.dat'));
        assert.ok(servers.includes(Buffer.from('100.64.0.10:25565')));

        // Second run: nothing to download; a renamed world updates the profile name.
        ctx.state.update((draft) => { draft.worlds[0].name = 'Titans'; });
        ctx.clientSync.templates.clear();
        const second = await run();
        assert.doesNotMatch(second, /\+ /);
        const again = JSON.parse(fs.readFileSync(path.join(game, 'launcher_profiles.json'), 'utf8'));
        assert.equal(Object.keys(again.profiles).length, 2);
        assert.equal(again.profiles['closedroom-fabric-1.21.1'].name, 'Closed Room · Titans');
        assert.equal(fs.readFileSync(path.join(game, 'servers.dat')).length, servers.length, 'server entry not duplicated');

        // Manager unreachable: the game still starts with what it has.
        server.close();
        const offline = await run();
        assert.match(offline, /server unreachable/);
        assert.deepEqual(fs.readdirSync(path.join(clientRoot, 'instances', 'fabric-1.21.1', 'mods')).sort(), ['aot.jar', 'fabric-api.jar']);
    } finally {
        server.close();
    }
});

const { satisfies } = require('../lib/fabric-meta');
const { zipFiles } = require('../lib/archive');

test('Fabric version ranges', () => {
    assert.ok(satisfies('0.6.13+mc1.21.1', ['0.6.x']));
    assert.ok(!satisfies('0.8.13+mc1.21.1', ['0.6.x']));
    assert.ok(satisfies('0.9.2+mc26.3', '0.9.x'));
    assert.ok(satisfies('1.4.0', '>=1.2 <2'));
    assert.ok(!satisfies('2.0.0', '>=1.2 <2'));
    assert.ok(satisfies('1.2.9', '~1.2.3') && !satisfies('1.3.0', '~1.2.3'));
    assert.ok(satisfies('1.9.0', '^1.2') && !satisfies('2.0.0', '^1.2'));
    assert.ok(satisfies('anything', '*'));
    assert.ok(satisfies('0.15.0-beta.1', '<0.15.0') && !satisfies('0.15.0', '<0.15.0'));
});

test('a dependency is stepped back to the version its dependent requires (Iris 1.8 needs Sodium 0.6.x)', async () => {
    const ctx = setup();
    const jar = (id, version, depends = {}) => ({ id, version, depends });
    const files = {
        'https://cdn.modrinth.com/s.zip': null,
        'https://cdn.modrinth.com/iris.jar': jar('iris', '1.8.8+mc1.21.1', { sodium: ['0.6.x'] }),
        // The newest Sodium refuses this Iris; the older one is fine with it.
        'https://cdn.modrinth.com/sodium.jar': { id: 'sodium', version: '0.8.13+mc1.21.1', depends: {}, breaks: { iris: '<1.9' } },
        'https://cdn.modrinth.com/sodium-0.6.jar': jar('sodium', '0.6.13+mc1.21.1'),
    };
    ctx.clientSync.download = async (url, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (files[url]) {
            const json = path.join(path.dirname(dest), `${path.basename(dest)}.fabric.mod.json`);
            fs.writeFileSync(json, JSON.stringify(files[url]));
            await zipFiles([{ path: json, name: 'fabric.mod.json' }], dest);
            fs.rmSync(json);
        } else {
            fs.writeFileSync(dest, url);
        }
        const content = fs.readFileSync(dest);
        return { size: content.length, sha1: sha('sha1', content), sha512: sha('sha512', content) };
    };
    const modrinth = ctx.clientSync.addons.providers.modrinth;
    modrinth.listVersions = async (projectId) => (projectId === 'AANobbMI' ? [
        { id: 'sov', projectId, versionNumber: 'so1', published: '2026-09-01', file: { url: 'https://cdn.modrinth.com/sodium.jar', fileName: 'sodium.jar', hashes: {} }, dependencies: [] },
        { id: 'so6', projectId, versionNumber: 'mc1.21.1-0.6.13', published: '2025-01-01', file: { url: 'https://cdn.modrinth.com/sodium-0.6.jar', fileName: 'sodium-0.6.jar', hashes: {} }, dependencies: [] },
    ] : []);

    const job = await ctx.clientSync.install({ setupId: 'fabric-1.21.1', type: 'shader', projectId: 'shader1' });
    const done = await waitJob(ctx.operations, job);
    assert.equal(done.status, 'succeeded', done.error?.message);
    const extras = ctx.clientSync.extrasOf('fabric-1.21.1');
    const sodium = extras.find((e) => e.projectId === 'AANobbMI');
    assert.equal(sodium.versionNumber, 'mc1.21.1-0.6.13');
    assert.equal(sodium.fileName, 'sodium-0.6.jar');
    assert.ok(fs.existsSync(path.join(ctx.clientSync.extrasDir('fabric-1.21.1', 'mods'), 'sodium-0.6.jar')));
    assert.ok(!fs.existsSync(path.join(ctx.clientSync.extrasDir('fabric-1.21.1', 'mods'), 'sodium.jar')));
});
