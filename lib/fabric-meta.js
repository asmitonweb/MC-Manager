const yauzl = require('yauzl');

/** Reads fabric.mod.json from a mod jar: { id, version, depends, breaks } or null. */
const readFabricMod = (jarPath) => new Promise((resolve) => {
    yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
        if (openError) return resolve(null);
        let found = false;
        zip.on('entry', (entry) => {
            if (entry.fileName !== 'fabric.mod.json') return zip.readEntry();
            found = true;
            zip.openReadStream(entry, (streamError, stream) => {
                if (streamError) return resolve(null);
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', () => {
                    zip.close();
                    try {
                        // Some mods put raw newlines inside strings; JSON.parse would reject those.
                        const json = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/[\r\n\t]+/g, ' '));
                        resolve({ id: json.id, version: String(json.version || ''), depends: json.depends || {}, breaks: json.breaks || {} });
                    } catch {
                        resolve(null);
                    }
                });
                stream.on('error', () => resolve(null));
            });
            return undefined;
        });
        zip.on('end', () => { if (!found) resolve(null); });
        zip.on('error', () => resolve(null));
        zip.readEntry();
    });
});

// "0.6.13+mc1.21.1" -> { parts: [0, 6, 13], pre: '' }
const parseVersion = (text) => {
    const [core, pre = ''] = String(text).split('+')[0].split(/-(.*)/s);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10)).map((n) => (Number.isFinite(n) ? n : 0)), pre };
};

const compare = (a, b) => {
    const length = Math.max(a.parts.length, b.parts.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (a.parts[i] || 0) - (b.parts[i] || 0);
        if (diff) return Math.sign(diff);
    }
    if (a.pre === b.pre) return 0;
    if (!a.pre) return 1;
    if (!b.pre) return -1;
    return a.pre < b.pre ? -1 : 1;
};

/** One Fabric version predicate ("0.6.x", ">=0.6 <0.7", "~1.2", "^1.2", "1.2.3", "*"). */
const satisfiesOne = (version, predicate) => {
    const terms = String(predicate).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const v = parseVersion(version);
    return terms.every((term) => {
        if (term === '*') return true;
        const [, op = '', rest] = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(term);
        const wildcard = rest.split('.').findIndex((part) => /^[xX*]$/.test(part));
        if (wildcard !== -1) {
            const prefix = parseVersion(rest.split('.').slice(0, wildcard).join('.') || '0').parts.slice(0, wildcard);
            return prefix.every((n, i) => (v.parts[i] || 0) === n);
        }
        const target = parseVersion(rest);
        const c = compare(v, target);
        switch (op) {
            case '>=': return c >= 0;
            case '<=': return c <= 0;
            case '>': return c > 0;
            case '<': return c < 0;
            case '~': return c >= 0 && (v.parts[0] || 0) === (target.parts[0] || 0) && (v.parts[1] || 0) === (target.parts[1] || 0);
            case '^': return c >= 0 && (v.parts[0] || 0) === (target.parts[0] || 0);
            default: return c === 0;
        }
    });
};

/** A Fabric dependency range is a predicate or a list of alternatives. */
const satisfies = (version, range) => (Array.isArray(range) ? range.some((p) => satisfiesOne(version, p)) : satisfiesOne(version, range));

module.exports = { readFabricMod, satisfies, parseVersion };
