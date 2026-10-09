const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMemory } = require('../lib/minecraft');
const { parseOnlinePlayers, PlayerTracker } = require('../lib/players');
const { parseCookieHeader } = require('../lib/auth');

test('parseMemory understands JVM memory sizes', () => {
    assert.equal(parseMemory('6G'), 6 * 1024 ** 3);
    assert.equal(parseMemory('512M'), 512 * 1024 ** 2);
    assert.equal(parseMemory('2048'), 2048 * 1024 ** 2);
    assert.equal(parseMemory('lots'), null);
});

test('parseOnlinePlayers reads the RCON list response', () => {
    assert.deepEqual(parseOnlinePlayers('There are 2 of a max of 20 players online: Steve, Alex'), ['Steve', 'Alex']);
    assert.deepEqual(parseOnlinePlayers('There are 0 of a max of 20 players online: '), []);
});

test('PlayerTracker reports changes and keeps history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-players-'));
    const tracker = new PlayerTracker({ file: path.join(dir, 'players.json') });
    assert.equal(tracker.update('online: Steve'), true);
    assert.equal(tracker.update('online: Steve'), false);
    assert.equal(tracker.update('online: '), true);
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.active.length, 0);
    assert.equal(snapshot.history[0].name, 'Steve');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('parseCookieHeader tolerates malformed cookies', () => {
    assert.deepEqual(parseCookieHeader('foo; auth_token=abc%3D; =x; bar=1=2'), { auth_token: 'abc=', bar: '1=2' });
    assert.deepEqual(parseCookieHeader(undefined), {});
});
