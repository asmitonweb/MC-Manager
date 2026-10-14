const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadFile, assertAllowedUrl, sanitizeFileName, resolveInside } = require('../lib/download');

const body = Buffer.from('hello minecraft');
const sha1 = crypto.createHash('sha1').update(body).digest('hex');
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-dl-')), 'file.jar');

const fakeFetch = (routes) => async (url) => {
    const handler = routes[url.toString()];
    if (!handler) return new Response('missing', { status: 404 });
    return handler();
};

test('only HTTPS downloads from allowlisted hosts are permitted', () => {
    assert.ok(assertAllowedUrl('https://cdn.modrinth.com/data/x.jar'));
    assert.throws(() => assertAllowedUrl('http://cdn.modrinth.com/x.jar'), { code: 'DOWNLOAD_BLOCKED' });
    assert.throws(() => assertAllowedUrl('https://evil.example.com/x.jar'), { code: 'DOWNLOAD_BLOCKED' });
});

test('downloadFile verifies hashes and writes the file', async () => {
    const dest = tmpFile();
    const fetchImpl = fakeFetch({ 'https://cdn.modrinth.com/a.jar': () => new Response(body) });
    const result = await downloadFile('https://cdn.modrinth.com/a.jar', dest, { hashes: { sha1 }, fetchImpl });
    assert.equal(result.sha1, sha1);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'hello minecraft');
});

test('downloadFile rejects checksum mismatches and leaves no file behind', async () => {
    const dest = tmpFile();
    const fetchImpl = fakeFetch({ 'https://cdn.modrinth.com/a.jar': () => new Response(body) });
    await assert.rejects(
        downloadFile('https://cdn.modrinth.com/a.jar', dest, { hashes: { sha1: '0'.repeat(40) }, fetchImpl }),
        { code: 'CHECKSUM_MISMATCH' }
    );
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
});

test('downloadFile refuses redirects to hosts outside the allowlist', async () => {
    const fetchImpl = fakeFetch({
        'https://cdn.modrinth.com/a.jar': () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/a.jar' } }),
    });
    await assert.rejects(downloadFile('https://cdn.modrinth.com/a.jar', tmpFile(), { fetchImpl }), { code: 'DOWNLOAD_BLOCKED' });
});

test('downloadFile follows allowed redirects and enforces the size limit', async () => {
    const fetchImpl = fakeFetch({
        'https://cdn.modrinth.com/a.jar': () => new Response(null, { status: 302, headers: { location: '/b.jar' } }),
        'https://cdn.modrinth.com/b.jar': () => new Response(body),
    });
    await assert.rejects(
        downloadFile('https://cdn.modrinth.com/a.jar', tmpFile(), { fetchImpl, maxBytes: 5 }),
        { code: 'DOWNLOAD_TOO_LARGE' }
    );
    const ok = await downloadFile('https://cdn.modrinth.com/a.jar', tmpFile(), { fetchImpl });
    assert.equal(ok.size, body.length);
});

test('file names and paths cannot escape their directory', () => {
    assert.equal(sanitizeFileName('../../evil name.jar'), 'evil_name.jar');
    assert.throws(() => sanitizeFileName('mod.exe'), { code: 'UNSAFE_FILE_NAME' });
    assert.throws(() => sanitizeFileName('.jar'), { code: 'UNSAFE_FILE_NAME' });
    assert.throws(() => resolveInside(os.tmpdir(), '../x.jar'), { code: 'UNSAFE_PATH' });
    assert.ok(resolveInside(os.tmpdir(), 'ok.jar').endsWith('ok.jar'));
});
