const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../lib/store');
const { Operations } = require('../lib/operations');
const { AddonManager } = require('../lib/addons');
const { normalizeVersion, pickBest } = require('../lib/addons/modrinth');
const { CurseForgeProvider, normalizeFile } = require('../lib/addons/curseforge');

const target = { mc: '26.3', loader: 'fabric' };

// In-memory provider: projects { id: { title, serverSide, versions: [version] } }
const fakeProvider = (projects) => {
    const version = (projectId, n, deps = [], extra = {}) => ({
        provider: 'modrinth',
        id: `${projectId}-v${n}`,
        projectId,
        versionNumber: `${n}.0`,
        type: 'release',
        published: `2026-0${n}-01T00:00:00Z`,
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        file: { url: `https://cdn.modrinth.com/${projectId}-${n}.jar`, fileName: `${projectId}-${n}.jar`, size: 10, hashes: {} },
        dependencies: deps,
        ...extra,
    });
    const allVersions = () => Object.values(projects).flatMap((p) => p.versions);
    return {
        id: 'modrinth',
        version,
        status: () => ({ id: 'modrinth', name: 'Modrinth', enabled: true }),
        async getProjects(ids) {
            return ids.filter((id) => projects[id]).map((id) => ({ id, title: projects[id].title, slug: id, serverSide: projects[id].serverSide || 'required' }));
        },
        async getVersions(ids) {
            return allVersions().filter((v) => ids.includes(v.id));
        },
        async listVersions(projectId) {
            return projects[projectId]?.versions || [];
        },
        async bestVersion(projectId) {
            return pickBest(projects[projectId]?.versions || []);
        },
        async identify() {
            return {};
        },
    };
};

const setup = (projects, { running = false } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-addons-'));
    const config = { SERVER_DIR: path.join(root, 'server'), DATA_DIR: path.join(root, 'data') };
    fs.mkdirSync(path.join(config.SERVER_DIR, 'mods'), { recursive: true });
    const state = new JsonStore(path.join(root, 'state.json'), { profile: { minecraftVersion: '26.3', loader: 'fabric' }, worlds: [] });
    const operations = new Operations();
    const provider = fakeProvider(projects);
    const downloads = [];
    const download = async (url, destination) => {
        downloads.push(url);
        if (url.includes('broken')) throw Object.assign(new Error('checksum mismatch'), { code: 'CHECKSUM_MISMATCH' });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, url);
        return { size: url.length, sha1: crypto.createHash('sha1').update(url).digest('hex'), sha512: 'x' };
    };
    const addons = new AddonManager({ config, state, minecraft: { isRunning: () => running }, operations, providers: [provider], download });
    return { root, config, addons, operations, provider, downloads, modsDir: path.join(config.SERVER_DIR, 'mods') };
};

const waitJob = async (operations, job) => {
    for (let i = 0; i < 200; i += 1) {
        const current = operations.getJob(job.id);
        if (current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('job timeout');
};

const catalog = () => {
    const p = fakeProvider({});
    return {
        api: { title: 'Fabric API', versions: [p.version('api', 1), p.version('api', 2)] },
        sodium: { title: 'Sodium', versions: [p.version('sodium', 1, [{ projectId: 'api', type: 'required' }, { projectId: 'extras', type: 'optional' }])] },
        lithium: { title: 'Lithium', versions: [p.version('lithium', 1, [{ projectId: 'api', type: 'required' }])] },
        extras: { title: 'Extras', versions: [p.version('extras', 1)] },
        clientonly: { title: 'Shaders', serverSide: 'unsupported', versions: [p.version('clientonly', 1)] },
        hater: { title: 'Hater', versions: [p.version('hater', 1, [{ projectId: 'sodium', type: 'incompatible' }])] },
        cyclic: { title: 'Cyclic', versions: [p.version('cyclic', 1, [{ projectId: 'cyclic2', type: 'required' }])] },
        cyclic2: { title: 'Cyclic 2', versions: [p.version('cyclic2', 1, [{ projectId: 'cyclic', type: 'required' }])] },
        needsmissing: { title: 'Needs Missing', versions: [p.version('needsmissing', 1, [{ projectId: 'ghost', type: 'required' }])] },
        oldmod: { title: 'Old', versions: [p.version('oldmod', 1, [], { gameVersions: ['1.20.1'] })] },
        broken: { title: 'Broken', versions: [p.version('broken', 1, [{ projectId: 'api', type: 'required' }])] },
    };
};

test('preview resolves required dependencies and lists optional ones', async () => {
    const { addons } = setup(catalog());
    const preview = await addons.preview({ items: [{ projectId: 'sodium' }] });
    assert.deepEqual(preview.install.map((e) => e.title), ['Sodium']);
    assert.deepEqual(preview.dependencies.map((e) => [e.title, e.versionNumber, e.requiredBy]), [['Fabric API', '2.0', ['Sodium']]]);
    assert.deepEqual(preview.optional.map((e) => e.title), ['Extras']);
    assert.deepEqual(preview.blockers, []);
});

test('preview reports conflicts, client-only, incompatible and missing dependencies', async () => {
    const { addons } = setup(catalog());
    assert.match((await addons.preview({ items: [{ projectId: 'sodium' }, { projectId: 'hater' }] })).blockers.join(), /Conflicts: Hater/);
    assert.match((await addons.preview({ items: [{ projectId: 'clientonly' }] })).blockers.join(), /Client-only/);
    assert.match((await addons.preview({ items: [{ projectId: 'oldmod' }] })).blockers.join(), /No compatible version: Old/);
    assert.match((await addons.preview({ items: [{ projectId: 'needsmissing' }] })).blockers.join(), /Missing required dependencies/);
});

test('dependency cycles terminate', async () => {
    const { addons } = setup(catalog());
    const preview = await addons.preview({ items: [{ projectId: 'cyclic' }] });
    assert.deepEqual([...preview.install, ...preview.dependencies].map((e) => e.title).sort(), ['Cyclic', 'Cyclic 2']);
});

test('install writes files and manifest; a second mod reuses the installed dependency', async () => {
    const { addons, operations, modsDir, downloads } = setup(catalog());
    const job = await waitJob(operations, await addons.install({ items: [{ projectId: 'sodium' }] }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    assert.deepEqual(fs.readdirSync(modsDir).sort(), ['api-2.jar', 'sodium-1.jar']);
    const { mods } = addons.installed();
    assert.equal(mods.find((m) => m.projectId === 'api').explicit, false);
    assert.deepEqual(mods.find((m) => m.projectId === 'api').dependencyOf, ['sodium']);

    downloads.length = 0;
    await waitJob(operations, await addons.install({ items: [{ projectId: 'lithium' }] }));
    assert.deepEqual(downloads, ['https://cdn.modrinth.com/lithium-1.jar']);
    assert.deepEqual(addons.installed().mods.find((m) => m.projectId === 'api').dependencyOf.sort(), ['lithium', 'sodium']);
});

test('a failed download leaves mods/ and the manifest untouched', async () => {
    const { addons, operations, modsDir } = setup(catalog());
    fs.writeFileSync(path.join(modsDir, 'mine.jar'), 'user file');
    const job = await waitJob(operations, await addons.install({ items: [{ projectId: 'broken' }] }));
    assert.equal(job.status, 'failed');
    assert.deepEqual(fs.readdirSync(modsDir), ['mine.jar']);
    assert.deepEqual(addons.installed().mods, []);
});

test('uninstall removes orphaned dependencies only and never touches unmanaged files', async () => {
    const { addons, operations, modsDir } = setup(catalog());
    fs.writeFileSync(path.join(modsDir, 'mine.jar'), 'user file');
    await waitJob(operations, await addons.install({ items: [{ projectId: 'sodium' }] }));
    await waitJob(operations, await addons.install({ items: [{ projectId: 'lithium' }] }));

    await waitJob(operations, addons.uninstall({ projectId: 'sodium' }));
    assert.deepEqual(fs.readdirSync(modsDir).sort(), ['api-2.jar', 'lithium-1.jar', 'mine.jar']);

    await waitJob(operations, addons.uninstall({ projectId: 'lithium' }));
    assert.deepEqual(fs.readdirSync(modsDir), ['mine.jar']);
    assert.deepEqual(addons.installed().unmanaged.map((u) => u.fileName), ['mine.jar']);
    assert.throws(() => addons.uninstall({ projectId: 'nope' }), { code: 'NOT_MANAGED' });
});

test('updates detects newer versions and update replaces the file, keeping a backup', async () => {
    const projects = catalog();
    const { addons, operations, modsDir, provider, config } = setup(projects);
    await waitJob(operations, await addons.install({ items: [{ projectId: 'lithium' }] }));
    projects.lithium.versions.push(provider.version('lithium', 3, [{ projectId: 'api', type: 'required' }]));

    const updates = await addons.updates();
    assert.deepEqual(updates.map((u) => [u.projectId, u.from, u.to]), [['lithium', '1.0', '3.0']]);

    const job = await waitJob(operations, await addons.update({ projectIds: ['lithium'] }));
    assert.equal(job.status, 'succeeded', job.error?.message);
    assert.deepEqual(fs.readdirSync(modsDir).sort(), ['api-2.jar', 'lithium-3.jar']);
    const lithium = addons.installed().mods.find((m) => m.projectId === 'lithium');
    assert.equal(lithium.versionNumber, '3.0');
    assert.equal(lithium.explicit, true);
    const backups = fs.readdirSync(path.join(config.DATA_DIR, 'mod-backups'));
    assert.equal(backups.length, 1);
});

test('changes are refused while the server runs or without a profile', async () => {
    const running = setup(catalog(), { running: true });
    await assert.rejects(running.addons.install({ items: [{ projectId: 'sodium' }] }), { code: 'SERVER_RUNNING' });

    const noProfile = setup(catalog());
    noProfile.addons.state.update((draft) => { draft.profile = null; });
    await assert.rejects(noProfile.addons.preview({ items: [{ projectId: 'sodium' }] }), { code: 'MINECRAFT_NOT_CONFIGURED' });
});

test('Modrinth versions normalize with primary file and dependency types', () => {
    const version = normalizeVersion({
        id: 'v1', project_id: 'p1', name: 'n', version_number: '1', version_type: 'release', date_published: 'd',
        loaders: ['fabric'], game_versions: ['26.3'],
        files: [{ primary: false, url: 'a', filename: 'a.jar', size: 1, hashes: { sha1: 's', sha512: 'S' } },
            { primary: true, url: 'b', filename: 'b.jar', size: 2, hashes: { sha1: 't', sha512: 'T' } }],
        dependencies: [{ project_id: 'dep', version_id: null, dependency_type: 'required' }, { project_id: null, version_id: null, dependency_type: 'optional' }],
    });
    assert.equal(version.file.fileName, 'b.jar');
    assert.deepEqual(version.dependencies, [{ projectId: 'dep', versionId: null, type: 'required' }]);
});

test('CurseForge is disabled without a key and handles disabled distribution', async () => {
    const disabled = new CurseForgeProvider({ apiKey: '' });
    assert.equal(disabled.status().enabled, false);
    await assert.rejects(async () => disabled.search({ mc: '26.3', loader: 'fabric' }), { code: 'PROVIDER_DISABLED' });

    const file = normalizeFile({
        id: 5, modId: 7, displayName: 'Mod 1.0', fileName: 'mod.jar', fileLength: 3, releaseType: 1, fileDate: 'd', downloadUrl: null,
        gameVersions: ['26.3', 'Fabric'], hashes: [{ algo: 1, value: 'abc' }], dependencies: [{ modId: 9, relationType: 3 }],
    });
    assert.equal(file.file.url, null);
    assert.deepEqual(file.loaders, ['fabric']);
    assert.deepEqual(file.dependencies, [{ projectId: '9', versionId: null, type: 'required' }]);
});

test('CurseForge provider sends the API key and normalizes search results', async () => {
    let seen;
    const fetchImpl = async (url, options) => {
        seen = { url: url.toString(), headers: options.headers };
        return new Response(JSON.stringify({ data: [{ id: 1, slug: 'jei', name: 'JEI', summary: 's', downloadCount: 5, authors: [{ name: 'mezz' }] }], pagination: { totalCount: 1 } }), {
            headers: { 'content-type': 'application/json' },
        });
    };
    const provider = new CurseForgeProvider({ apiKey: 'k', fetchImpl });
    const result = await provider.search({ query: 'jei', ...target });
    assert.equal(seen.headers['x-api-key'], 'k');
    assert.match(seen.url, /modLoaderType=4/);
    assert.equal(result.hits[0].title, 'JEI');
});
