const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const { JsonStore } = require('../lib/store');
const { ModPack } = require('../lib/modpack');
const { DiscordSync, WEBHOOK_PATTERN } = require('../lib/discord');

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc-DEF_1';

const setup = ({ forum = false } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-discord-'));
    const config = { DATA_DIR: path.join(root, 'data'), PORT: 3000 };
    const modsDir = path.join(root, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const state = new JsonStore(path.join(root, 'state.json'), {
        profile: { loader: 'fabric', minecraftVersion: '1.21.1' },
        worlds: [{ id: 'aot', name: 'Attack on Titan' }],
        activeWorldId: 'aot',
    });
    const manifest = new JsonStore(path.join(root, 'manifest.json'), { mods: [] });
    const addMod = (projectId, title, versionNumber, clientSide) => {
        fs.writeFileSync(path.join(modsDir, `${projectId}.jar`), `${projectId}-${versionNumber}`);
        manifest.update((draft) => {
            draft.mods = draft.mods.filter((mod) => mod.projectId !== projectId);
            draft.mods.push({ provider: 'modrinth', projectId, title, versionNumber, fileName: `${projectId}.jar`, sha1: versionNumber, clientSide });
        });
    };
    const addons = { manifest, modsDir, providers: {} };
    const modpack = new ModPack({ config, state, addons });

    const requests = [];
    let nextId = 1;
    const deleted = new Set();
    const deletedThreads = new Set();
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    // Mimics a Discord webhook; in forum mode, posts need a thread_name or thread_id.
    const fetchImpl = async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : {};
        const threadId = new URL(url).searchParams.get('thread_id');
        requests.push({ method: options.method, url, body, threadId });
        if (options.method === 'DELETE') return new Response(null, { status: 204 });
        if (threadId && deletedThreads.has(threadId)) return json({ code: 10003, message: 'Unknown Channel' }, 404);
        const match = /\/messages\/(\d+)/.exec(url);
        if (match && deleted.has(match[1])) return json({ code: 10008, message: 'Unknown Message' }, 404);
        if (forum && !match && !threadId && !body.thread_name) {
            return json({ code: 220001, message: 'Webhooks posted to forum channels must have a thread_name or thread_id' }, 400);
        }
        const id = match ? match[1] : String(nextId++);
        const channelId = body.thread_name ? `thread-${id}` : threadId || 'channel';
        return json({ id, channel_id: channelId, guild_id: 'guild' });
    };
    const minecraft = { status: 'ONLINE' };
    const players = { count: () => 2 };
    const worlds = { activeId: () => state.get().activeWorldId, list: () => state.get().worlds };
    const discord = new DiscordSync({ config, state, minecraft, worlds, players, modpack, fetchImpl });
    return { root, state, modpack, discord, requests, addMod, deleted, deletedThreads, minecraft, manifest };
};

const zipEntries = (file) => new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        const names = [];
        zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
        zip.on('end', () => resolve(names.sort()));
        zip.readEntry();
    });
});

test('webhook URL validation', () => {
    assert.ok(WEBHOOK_PATTERN.test(WEBHOOK));
    assert.ok(WEBHOOK_PATTERN.test('https://canary.discord.com/api/webhooks/1/x'));
    assert.ok(!WEBHOOK_PATTERN.test('https://evil.com/api/webhooks/1/x'));
    assert.ok(!WEBHOOK_PATTERN.test('http://discord.com/api/webhooks/1/x'));
});

test('mod pack contains only mods players need and is rebuilt when mods change', async () => {
    const { modpack, addMod } = setup();
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    addMod('serveronly', 'Server Tool', '1.0', 'unsupported');
    addMod('lithium', 'Lithium', '0.1', 'optional');
    const first = await modpack.build();
    assert.deepEqual(await zipEntries(first.file), ['aot.jar', 'lithium.jar']);
    assert.equal(first.fileName, 'mods-fabric-1.21.1.zip');
    assert.equal((await modpack.build()).fingerprint, first.fingerprint);

    addMod('aot', "Danny's AOT", '2.6.0', 'required');
    assert.notEqual((await modpack.build()).fingerprint, first.fingerprint);
});

test('settings are validated and the webhook is never returned in full', async () => {
    const { discord } = setup();
    await assert.rejects(discord.update({ webhookUrl: 'https://example.com/hook' }), { code: 'INVALID_WEBHOOK' });
    await assert.rejects(discord.update({ baseUrl: 'not a url' }), { code: 'INVALID_SETTING' });
    const view = await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://100.64.0.10:3000', gameAddress: '100.64.0.10:25565' });
    assert.ok(!view.webhookUrl.includes('abc-DEF'));
    assert.match(view.packUrl, /^http:\/\/100.64.0.10:3000\/pack\/[0-9a-f]{32}\/mods-fabric-1\.21\.1\.zip$/);
    assert.equal(discord.isValidToken(view.packUrl.split('/')[4]), true);
    assert.equal(discord.isValidToken('0'.repeat(32)), false);
    const old = view.packUrl;
    assert.notEqual(discord.regenerateLink().packUrl, old);
});

test('sync posts the guide then the status card, edits in place, and skips unchanged content', async () => {
    const { discord, requests, addMod, minecraft } = setup();
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://100.64.0.10:3000', gameAddress: '100.64.0.10:25565', serverName: 'Closed Room' });

    await discord.sync();
    assert.deepEqual(requests.map((r) => r.method), ['POST', 'POST']);
    assert.match(requests[0].body.embeds[0].title, /How to join Closed Room/);
    assert.match(requests[0].body.embeds[0].description, /Fabric for Minecraft 1\.21\.1/);
    const card = requests[1].body.embeds[0];
    assert.match(card.title, /Online/);
    assert.match(card.description, /Download all mods/);
    assert.ok(card.fields.some((f) => f.name === 'World' && f.value === 'Attack on Titan'));
    assert.deepEqual(requests[1].body.allowed_mentions, { parse: [] });

    requests.length = 0;
    await discord.sync();
    assert.equal(requests.length, 0);

    minecraft.status = 'OFFLINE';
    await discord.sync();
    assert.deepEqual(requests.map((r) => [r.method, /messages\/2/.test(r.url)]), [['PATCH', true]]);
});

test('a mod change posts a notice with the differences', async () => {
    const { discord, requests, addMod } = setup();
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    addMod('old', 'Old Mod', '1.0', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000' });
    await discord.sync();
    requests.length = 0;

    addMod('aot', "Danny's AOT", '2.6.0', 'required');
    addMod('geckolib', 'GeckoLib', '4.9.3', 'required');
    fs.rmSync(path.join(discord.modpack.addons.modsDir, 'old.jar'));
    await discord.sync();
    const notice = requests.find((r) => r.method === 'POST' && r.body.content);
    assert.match(notice.body.content, /Mods updated/);
    assert.match(notice.body.content, /➕ GeckoLib/);
    assert.match(notice.body.content, /⬆️ Danny's AOT `2\.5\.1\.1` → `2\.6\.0`/);
    assert.match(notice.body.content, /➖ Old Mod/);
});

test('a deleted message is reposted', async () => {
    const { discord, requests, addMod, deleted, minecraft } = setup();
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000' });
    await discord.sync();
    deleted.add('2');
    minecraft.status = 'STARTING';
    requests.length = 0;
    await discord.sync();
    assert.deepEqual(requests.map((r) => r.method), ['PATCH', 'POST']);
    assert.equal(discord.settings().statusMessageId, '3');
});

test('forum channels: the guide opens a new post and everything else goes into it', async () => {
    const { discord, requests, addMod, minecraft } = setup({ forum: true });
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000', serverName: 'Closed Room' });
    await discord.sync();
    // A plain post is rejected (220001), so a titled post is created and the card goes into it.
    assert.deepEqual(requests.map((r) => [r.method, Boolean(r.body.thread_name), r.threadId]), [
        ['POST', false, null], ['POST', true, null], ['POST', false, 'thread-1'],
    ]);
    assert.equal(requests[1].body.thread_name, 'Minecraft — Closed Room');
    const view = discord.publicView();
    assert.equal(view.forum, true);
    assert.equal(view.threadId, 'thread-1');
    assert.equal(view.postUrl, 'https://discord.com/channels/guild/thread-1');

    requests.length = 0;
    minecraft.status = 'OFFLINE';
    await discord.sync();
    assert.deepEqual(requests.map((r) => [r.method, r.threadId]), [['PATCH', 'thread-1']]);

    requests.length = 0;
    addMod('geckolib', 'GeckoLib', '4.9.3', 'required');
    await discord.sync();
    const notice = requests.find((r) => r.body.content);
    assert.equal(notice.threadId, 'thread-1');
});

test('forum channels: a deleted post is recreated', async () => {
    const { discord, requests, addMod, deletedThreads } = setup({ forum: true });
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000' });
    await discord.sync();
    const oldThread = discord.publicView().threadId;
    deletedThreads.add(oldThread);
    requests.length = 0;
    await discord.sync({ force: true });
    assert.ok(requests.some((r) => r.body.thread_name), 'a new post was created');
    const newThread = discord.publicView().threadId;
    assert.notEqual(newThread, oldThread);
    assert.equal(requests.at(-1).threadId, newThread);
});

test('an existing forum post can be reused from its link', async () => {
    const { discord, requests, addMod } = setup({ forum: true });
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await assert.rejects(discord.update({ existingPost: 'not a link' }), { code: 'INVALID_SETTING' });
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000', existingPost: 'https://discord.com/channels/111111111111111111/222222222222222222' });
    await discord.sync();
    assert.deepEqual(requests.map((r) => [r.method, r.threadId, Boolean(r.body.thread_name)]), [
        ['POST', '222222222222222222', false], ['POST', '222222222222222222', false],
    ]);
    assert.equal(discord.publicView().postUrl, 'https://discord.com/channels/111111111111111111/222222222222222222');
});

test('with client sync, the guide links the one-click setup and notices name the launcher entry', async () => {
    const { discord, requests, addMod, state } = setup();
    state.update((draft) => {
        draft.profile.loaderVersion = '0.19.5';
        draft.activeSetupId = 'fabric-1.21.1';
    });
    discord.clientSync = {
        agentInfo: () => ({ fileName: 'agent-x.jar' }),
        brand: () => ({ setupFile: 'ClosedRoom-Setup.cmd' }),
        label: () => 'Closed Room · Attack on Titan',
        setupCommand: (base, token) => `powershell -c "iwr ${base}/client/${token}/ClosedRoom-Setup.cmd -OutFile x; & x"`,
    };
    addMod('aot', "Danny's AOT", '2.5.1.1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://100.64.0.10:3000' });
    await discord.sync();
    const token = discord.packToken();
    const guide = requests[0].body.embeds[0].description;
    assert.ok(guide.includes(`(http://100.64.0.10:3000/client/${token}/ClosedRoom-Setup.cmd)`));
    assert.ok(guide.includes(`iwr http://100.64.0.10:3000/client/${token}/ClosedRoom-Setup.cmd`));
    assert.match(guide, /pick \*\*Closed Room · Attack on Titan\*\*/);
    assert.ok(requests[1].body.embeds[0].description.startsWith('**Setup (once):** paste in Terminal'));
    assert.ok(guide.indexOf('Terminal') < guide.indexOf('[⬇️'), 'command comes before the file link');
    assert.ok(!guide.includes('Win + R'));

    requests.length = 0;
    addMod('geckolib', 'GeckoLib', '4.9.3', 'required');
    await discord.sync();
    const notice = requests.find((r) => r.method === 'POST' && r.body.content);
    assert.match(notice.body.content, /install automatically next time you press Play on \*\*Closed Room · Attack on Titan\*\*/);
    assert.doesNotMatch(notice.body.content, /replace your/);
});

test('a new change notice replaces the previous one', async () => {
    const { discord, requests, addMod } = setup();
    addMod('aot', "Danny's AOT", '1', 'required');
    await discord.update({ webhookUrl: WEBHOOK, baseUrl: 'http://h:3000' });
    await discord.sync();
    addMod('aot', "Danny's AOT", '2', 'required');
    await discord.sync();
    const first = discord.settings().noticeMessageId;
    assert.ok(first);
    requests.length = 0;
    addMod('aot', "Danny's AOT", '3', 'required');
    await discord.sync();
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.includes(`/messages/${first}`)), 'old notice deleted');
    assert.notEqual(discord.settings().noticeMessageId, first);
});
