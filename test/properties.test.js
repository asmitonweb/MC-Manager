const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProperties, mergeProperties } = require('../lib/properties');

test('parseProperties reads keys and ignores comments', () => {
    const props = parseProperties('#Minecraft server properties\r\nmotd=Hello=World\r\nlevel-name=worlds/main\r\n\r\npvp=true\r\n');
    assert.deepEqual(props, { motd: 'Hello=World', 'level-name': 'worlds/main', pvp: 'true' });
});

test('mergeProperties keeps comments, order and CRLF line endings', () => {
    const content = '#comment\r\nmotd=old\r\npvp=true\r\n';
    const merged = mergeProperties(content, { motd: 'new', 'enable-rcon': 'true' });
    assert.equal(merged, '#comment\r\nmotd=new\r\npvp=true\r\nenable-rcon=true\r\n');
});

test('mergeProperties removes keys set to null', () => {
    assert.equal(mergeProperties('a=1\nb=2\n', { a: null }), 'b=2\n');
});

test('mergeProperties creates a file from nothing', () => {
    assert.equal(mergeProperties('', { a: '1' }), 'a=1\n');
});
