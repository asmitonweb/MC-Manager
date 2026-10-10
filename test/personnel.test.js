const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { LogEvents } = require('../lib/log-events');
const { PlayerTracker } = require('../lib/players');
const { Roster } = require('../lib/roster');
const { offlineUuid } = require('../lib/offline-uuid');
const { parseTickQuery } = require('../lib/system-info');

const line = (message, thread = 'Server thread', level = 'INFO') => `[12:00:01] [${thread}/${level}]: ${message}`;

test('offline UUIDs match the server (Java UUID.nameUUIDFromBytes)', () => {
    assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('log lines become chat, join, leave, advancement, death and refused events', () => {
    const known = new Set(['Eren']);
    assert.deepEqual(LogEvents.parse(line('<Eren> hello there')), { type: 'chat', time: '12:00:01', name: 'Eren', message: 'hello there' });
    assert.deepEqual(LogEvents.parse(line('[Not Secure] <Mikasa> hi')), { type: 'chat', time: '12:00:01', name: 'Mikasa', message: 'hi' });
    assert.equal(LogEvents.parse(line('[Server] restarting soon')).name, 'Server');
    assert.equal(LogEvents.parse(line('Eren joined the game')).type, 'join');
    assert.equal(LogEvents.parse(line('Eren left the game')).type, 'leave');
    assert.deepEqual(LogEvents.parse(line('Eren has made the advancement [Stone Age]')), { type: 'advancement', time: '12:00:01', name: 'Eren', message: 'Stone Age' });
    assert.deepEqual(LogEvents.parse(line('Eren was slain by Zombie'), known), { type: 'death', time: '12:00:01', name: 'Eren', message: 'was slain by Zombie' });
    assert.equal(LogEvents.parse(line('Eren lost connection: Disconnected'), known).type, 'leave');
    assert.equal(LogEvents.parse(line('Eren[/100.64.0.5:5000] logged in with entity id 12 at (1, 2, 3)'), known).type, 'join');
    // Minecraft 26.x prefixes chat-channel lines.
    assert.deepEqual(LogEvents.parse(line('System chat: BurgerBandit joined the game')), { type: 'join', time: '12:00:01', name: 'BurgerBandit' });
    assert.equal(LogEvents.parse(line('System chat: BurgerBandit left the game')).type, 'leave');
    assert.equal(LogEvents.parse(line('System chat: Eren was slain by Zombie'), known).type, 'death');
    assert.equal(LogEvents.parse(line('Levi was slain by Zombie'), known), null, 'unknown names are not deaths');
    assert.equal(LogEvents.parse(line('<Eren> hi', 'Worker-1')), null);

    assert.deepEqual(LogEvents.parse(line('Disconnecting Armin (/100.64.0.7:51234): You are not white-listed on this server!')),
        { type: 'refused', time: '12:00:01', name: 'Armin', ip: '100.64.0.7' });
    assert.deepEqual(LogEvents.parse(line('Armin (/100.64.0.7:51234) lost connection: You are not white-listed on this server!')),
        { type: 'refused', time: '12:00:01', name: 'Armin', ip: '100.64.0.7' });
    assert.equal(LogEvents.parse(line('com.mojang.authlib.GameProfile@1f[id=<null>,name=Hange,properties={},legacy=false] (/100.64.0.8:1) lost connection: You are not white-listed on this server!')).name, 'Hange');
});

const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-roster-'));
    const server = path.join(root, 'server');
    fs.mkdirSync(server);
    fs.writeFileSync(path.join(server, 'server.properties'), 'online-mode=false\nwhite-list=false\n');
    const config = { SERVER_DIR: server, PROPERTIES_FILE: path.join(server, 'server.properties') };
    const minecraft = Object.assign(new EventEmitter(), { rcon: null, commands: [], appendLog() {} });
    minecraft.sendCommand = async (command) => {
        minecraft.commands.push(command);
        return 'ok';
    };
    const players = new PlayerTracker({ file: path.join(root, 'players.json') });
    const logEvents = new LogEvents({ minecraft, requestsFile: path.join(root, 'requests.json') });
    const roster = new Roster({ config, minecraft, players, logEvents });
    return { root, server, minecraft, players, logEvents, roster };
};

test('join and leave lines track sessions and playtime', async () => {
    const { players, minecraft, logEvents } = setup();
    logEvents.on('event', (event) => {
        if (event.type === 'join') players.join(event.name);
        if (event.type === 'leave') players.leave(event.name);
    });
    const comms = [];
    logEvents.on('event', (event) => comms.push(event.type));
    minecraft.emit('line', line('Eren[/100.64.0.5:5000] logged in with entity id 25 at (1, 2, 3)'));
    minecraft.emit('line', line('System chat: Eren joined the game'));
    assert.deepEqual(players.online, ['Eren']);
    assert.deepEqual(comms, ['join'], 'login and chat lines give one join');
    players.store.update((h) => { h.Eren.sessionStart -= 60000; });
    minecraft.emit('line', line('Eren left the game'));
    assert.deepEqual(players.online, []);
    assert.ok(players.all().Eren.playtimeMs >= 60000);
    assert.equal(players.all().Eren.joins, 1);
    assert.equal(players.update('There are 1 of a max of 20 players online: Mikasa'), true);
    assert.deepEqual(players.online, ['Mikasa']);
});

test('refused logins become join requests; approving whitelists with the offline UUID', async () => {
    const { roster, minecraft, server } = setup();
    minecraft.emit('line', line('Disconnecting Armin (/100.64.0.7:51234): You are not white-listed on this server!'));
    minecraft.emit('line', line('Disconnecting Armin (/100.64.0.7:51235): You are not white-listed on this server!'));
    let view = roster.view();
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0].count, 2);

    view = await roster.act({ action: 'approve', name: 'Armin' });
    const whitelist = JSON.parse(fs.readFileSync(path.join(server, 'whitelist.json'), 'utf8'));
    assert.deepEqual(whitelist, [{ uuid: offlineUuid('Armin'), name: 'Armin' }]);
    assert.equal(view.requests.length, 0);
    assert.ok(view.players.find((p) => p.name === 'Armin').whitelisted);

    // Offline: op and ban edit the files.
    await roster.act({ action: 'op', name: 'Armin' });
    await roster.act({ action: 'ban', name: 'Reiner' });
    view = roster.view();
    assert.ok(view.players.find((p) => p.name === 'Armin').op);
    assert.ok(view.players.find((p) => p.name === 'Reiner').banned);
    assert.match(JSON.parse(fs.readFileSync(path.join(server, 'banned-players.json'), 'utf8'))[0].created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    await assert.rejects(roster.act({ action: 'kick', name: 'Armin' }), { code: 'SERVER_NOT_RUNNING' });
    await assert.rejects(roster.act({ action: 'op', name: 'bad name!' }), { code: 'INVALID_REQUEST' });
});

test('while running, changes go through RCON (whitelist via file + reload in offline mode)', async () => {
    const { roster, minecraft } = setup();
    minecraft.rcon = {};
    await roster.act({ action: 'whitelist-add', name: 'Eren' });
    await roster.act({ action: 'op', name: 'Eren' });
    await roster.act({ action: 'kick', name: 'Eren' });
    const view = await roster.setWhitelist(true);
    assert.deepEqual(minecraft.commands, ['whitelist reload', 'op Eren', 'kick Eren', 'whitelist on']);
    assert.equal(view.whitelistEnabled, true);
    assert.equal(view.enforceWhitelist, true);
});

test('tick query output is parsed into MSPT and TPS', () => {
    assert.deepEqual(parseTickQuery('The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: 3.24ms (Target: 50.0ms)'), { mspt: 3.2, tps: 20, frozen: false });
    assert.deepEqual(parseTickQuery('Target tick rate: 20.0 per second.\nAverage time per tick: 80.0ms (Target: 50.0ms)'), { mspt: 80, tps: 12.5, frozen: false });
    assert.equal(parseTickQuery('Unknown command'), null);
});
