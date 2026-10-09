const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { OperationError } = require('./operations');

const ALLOWED_HOSTS = new Set([
    'piston-meta.mojang.com',
    'piston-data.mojang.com',
    'launchermeta.mojang.com',
    'meta.fabricmc.net',
    'maven.fabricmc.net',
    'files.minecraftforge.net',
    'maven.minecraftforge.net',
    'api.modrinth.com',
    'cdn.modrinth.com',
    'api.curseforge.com',
    'edge.forgecdn.net',
    'mediafilez.forgecdn.net',
]);

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const assertAllowedUrl = (rawUrl, allowedHosts = ALLOWED_HOSTS) => {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new OperationError(`Invalid download URL: ${rawUrl}`, { code: 'DOWNLOAD_BLOCKED' });
    }
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
        throw new OperationError(`Downloads from ${url.hostname} are not allowed.`, { code: 'DOWNLOAD_BLOCKED' });
    }
    return url;
};

// Follows redirects manually so every hop is checked against the allowlist.
const allowedFetch = async (rawUrl, {
    headers = {}, method = 'GET', body, allowedHosts = ALLOWED_HOSTS, fetchImpl = fetch, signal,
} = {}) => {
    let url = assertAllowedUrl(rawUrl, allowedHosts);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const res = await fetchImpl(url, { headers, method, body, redirect: 'manual', signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            url = assertAllowedUrl(new URL(res.headers.get('location'), url).toString(), allowedHosts);
            // Only 307/308 preserve the method and body.
            if (res.status !== 307 && res.status !== 308) {
                method = 'GET';
                body = undefined;
            }
            continue;
        }
        if (!res.ok) {
            throw new OperationError(`Request to ${url.hostname} failed with HTTP ${res.status}.`, {
                code: 'DOWNLOAD_FAILED',
                status: 502,
            });
        }
        return res;
    }
    throw new OperationError('Too many redirects.', { code: 'DOWNLOAD_FAILED', status: 502 });
};

const fetchJson = async (url, options) => (await allowedFetch(url, options)).json();
const fetchText = async (url, options) => (await allowedFetch(url, options)).text();

/**
 * Streams a download to `destination` (via a .part file), enforcing a size limit
 * and verifying any provided hashes ({ sha1, sha512 }). Returns { size, sha1, sha512 }.
 */
const downloadFile = async (rawUrl, destination, {
    hashes = {},
    maxBytes = DEFAULT_MAX_BYTES,
    onProgress,
    headers,
    allowedHosts,
    fetchImpl,
} = {}) => {
    const res = await allowedFetch(rawUrl, { headers, allowedHosts, fetchImpl });
    const total = Number.parseInt(res.headers.get('content-length') || '0', 10) || null;
    if (total && total > maxBytes) {
        throw new OperationError(`Download is too large (${total} bytes).`, { code: 'DOWNLOAD_TOO_LARGE' });
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.part`;
    const sha1 = crypto.createHash('sha1');
    const sha512 = crypto.createHash('sha512');
    let received = 0;

    const meter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) {
                callback(new OperationError('Download exceeded the size limit.', { code: 'DOWNLOAD_TOO_LARGE' }));
                return;
            }
            sha1.update(chunk);
            sha512.update(chunk);
            if (onProgress) onProgress(received, total);
            callback(null, chunk);
        },
    });

    try {
        await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(partial));
        const digest = { size: received, sha1: sha1.digest('hex'), sha512: sha512.digest('hex') };
        for (const algorithm of ['sha512', 'sha1']) {
            if (hashes[algorithm] && hashes[algorithm].toLowerCase() !== digest[algorithm]) {
                throw new OperationError(`Checksum mismatch for ${path.basename(destination)} (${algorithm}).`, {
                    code: 'CHECKSUM_MISMATCH',
                });
            }
        }
        fs.renameSync(partial, destination);
        return digest;
    } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
    }
};

// Keeps only safe characters and requires the given extension.
const sanitizeFileName = (name, extension = '.jar') => {
    const base = path.basename(String(name || '')).replace(/[^\w.\-+]/g, '_');
    if (!base || base.startsWith('.') || !base.toLowerCase().endsWith(extension)) {
        throw new OperationError(`Unsafe file name: ${name}`, { code: 'UNSAFE_FILE_NAME' });
    }
    return base;
};

// Resolves `name` inside `directory`, refusing anything that escapes it.
const resolveInside = (directory, name) => {
    const root = path.resolve(directory);
    const target = path.resolve(root, name);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new OperationError(`Path escapes ${root}: ${name}`, { code: 'UNSAFE_PATH' });
    }
    return target;
};

module.exports = {
    ALLOWED_HOSTS,
    assertAllowedUrl,
    allowedFetch,
    fetchJson,
    fetchText,
    downloadFile,
    sanitizeFileName,
    resolveInside,
};
