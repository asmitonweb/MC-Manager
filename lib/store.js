const fs = require('fs');
const path = require('path');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Writes via a temp file and rename so a crash never leaves a half-written file.
// Antivirus or indexers can briefly lock the target on Windows, hence the retries.
const writeFileAtomic = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents);
    for (let attempt = 0; ; attempt += 1) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch (error) {
            if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
                fs.rmSync(tmp, { force: true });
                throw error;
            }
            sleepSync(50 * (attempt + 1));
        }
    }
};

const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

const readJson = (file, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
};

class JsonStore {
    constructor(file, defaults) {
        this.file = file;
        this.defaults = defaults;
        this.cache = null;
    }

    get() {
        if (!this.cache) {
            this.cache = { ...structuredClone(this.defaults), ...readJson(this.file, {}) };
        }
        return this.cache;
    }

    /** Drops the cache so the next read comes from disk (after the file was moved). */
    reload() {
        this.cache = null;
    }

    // Mutations are synchronous, so they cannot interleave within one process.
    update(mutator) {
        const draft = structuredClone(this.get());
        const result = mutator(draft);
        const next = result === undefined ? draft : result;
        writeJsonAtomic(this.file, next);
        this.cache = next;
        return next;
    }
}

module.exports = { JsonStore, writeFileAtomic, writeJsonAtomic, readJson };
