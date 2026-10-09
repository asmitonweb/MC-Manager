const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const yauzl = require('yauzl');
const { OperationError } = require('./operations');

// Files Minecraft holds an exclusive lock on while running.
const SKIP_FILES = ['session.lock'];

/**
 * Zips the contents of `sourceDir` (entries relative to it) into `destination`,
 * via a .partial file. Returns { size, sha256 }.
 */
const zipDirectory = async (sourceDir, destination, { onProgress } = {}) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = `${destination}.partial`;
    const archive = archiver('zip', { zlib: { level: 6 } });
    const hash = crypto.createHash('sha256');
    let size = 0;

    archive.on('warning', (error) => {
        if (error.code !== 'ENOENT') throw error;
    });
    if (onProgress) {
        archive.on('progress', ({ fs: bytes }) => onProgress(bytes.processedBytes, bytes.totalBytes));
    }
    archive.glob('**/*', { cwd: sourceDir, dot: true, ignore: SKIP_FILES });
    const finalize = archive.finalize();

    const hasher = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            size += chunk.length;
            callback(null, chunk);
        },
    });

    try {
        await Promise.all([pipeline(archive, hasher, fs.createWriteStream(partial)), finalize]);
        fs.renameSync(partial, destination);
        return { size, sha256: hash.digest('hex') };
    } catch (error) {
        archive.abort();
        fs.rmSync(partial, { force: true });
        throw error;
    }
};

/** Streams a zip of `sourceDir` to a writable (e.g. an HTTP response). */
const streamZip = (sourceDir, writable) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', () => {});
    archive.glob('**/*', { cwd: sourceDir, dot: true, ignore: SKIP_FILES });
    archive.pipe(writable);
    return archive.finalize();
};

const sha256File = async (file) => {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
};

const openZip = (file) => new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zip) => (error ? reject(error) : resolve(zip)));
});

const readEntries = (zip) => new Promise((resolve, reject) => {
    const entries = [];
    zip.on('entry', (entry) => {
        entries.push(entry);
        zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
});

const openEntryStream = (zip, entry) => new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
});

const isSymlink = (entry) => ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;

// Normalizes an entry name and rejects anything absolute or escaping upwards.
const safeEntryPath = (name) => {
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
        throw new OperationError(`Unsafe path in archive: ${name}`, { code: 'UNSAFE_ARCHIVE' });
    }
    return normalized;
};

/**
 * Extracts a world archive into `destDir`. The world root is the folder that
 * contains level.dat (exactly one is required); entries outside it are ignored.
 */
const extractWorld = async (zipFile, destDir, { onProgress, freeBytes } = {}) => {
    const zip = await openZip(zipFile);
    try {
        const entries = await readEntries(zip);
        const levelDats = entries
            .map((entry) => safeEntryPath(entry.fileName))
            .filter((name) => name === 'level.dat' || name.endsWith('/level.dat'));
        if (levelDats.length !== 1) {
            throw new OperationError(
                levelDats.length ? 'The archive contains more than one world.' : 'The archive does not contain a Minecraft world (no level.dat).',
                { code: 'INVALID_WORLD_ARCHIVE' }
            );
        }
        const prefix = levelDats[0].slice(0, -'level.dat'.length);

        const files = entries.filter((entry) => {
            const name = safeEntryPath(entry.fileName);
            return name.startsWith(prefix) && !name.endsWith('/') && name.length > prefix.length;
        });
        if (files.some(isSymlink)) throw new OperationError('Archives with symbolic links are not supported.', { code: 'UNSAFE_ARCHIVE' });

        const total = files.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
        if (freeBytes !== undefined && total > freeBytes) {
            throw new OperationError('Not enough free disk space to extract this world.', { code: 'INSUFFICIENT_DISK' });
        }

        const root = path.resolve(destDir);
        let written = 0;
        for (const entry of files) {
            const relative = safeEntryPath(entry.fileName).slice(prefix.length);
            const target = path.resolve(root, relative);
            if (!target.startsWith(root + path.sep)) throw new OperationError(`Unsafe path in archive: ${entry.fileName}`, { code: 'UNSAFE_ARCHIVE' });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            await pipeline(await openEntryStream(zip, entry), fs.createWriteStream(target));
            written += entry.uncompressedSize;
            if (onProgress) onProgress(written, total);
        }
        return { files: files.length, bytes: total };
    } finally {
        zip.close();
    }
};

const freeDiskBytes = async (dir) => {
    try {
        const stats = await fs.promises.statfs(dir);
        return stats.bavail * stats.bsize;
    } catch {
        return undefined;
    }
};

module.exports = { zipDirectory, streamZip, sha256File, extractWorld, freeDiskBytes, safeEntryPath };
