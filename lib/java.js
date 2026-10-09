const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VENDOR_DIRS = [
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\BellSoft',
];
const CACHE_MS = 5 * 60 * 1000;

// Parses the stderr of `java -XshowSettings:properties -version`.
const parseJavaSettings = (output) => {
    const prop = (name) => {
        const match = new RegExp(`^\\s*${name.replace(/\./g, '\\.')} = (.*)$`, 'm').exec(output);
        return match ? match[1].trim() : null;
    };
    const spec = prop('java.specification.version');
    if (!spec) return null;
    const major = Number.parseInt(spec.startsWith('1.') ? spec.slice(2) : spec, 10);
    return {
        major,
        version: prop('java.runtime.version') || prop('java.version'),
        vendor: prop('java.vendor.version') || prop('java.vendor'),
    };
};

const probeJava = (javaPath) => new Promise((resolve) => {
    execFile(javaPath, ['-XshowSettings:properties', '-version'], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
        const info = parseJavaSettings(`${stderr}\n${stdout}`);
        resolve(info && Number.isFinite(info.major) ? { path: javaPath, ...info } : null);
    });
});

const whereJava = () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('where.exe', ['java'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
});

const vendorInstalls = () => {
    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    const found = [];
    for (const dir of VENDOR_DIRS) {
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const candidate = path.join(dir, entry.name, 'bin', executable);
            if (entry.isDirectory() && fs.existsSync(candidate)) found.push(candidate);
        }
    }
    return found;
};

let cache = null;

/** Lists installed Java runtimes: [{ path, major, version, vendor, shim }]. */
const detectJava = async ({ extraCandidates = [], refresh = false } = {}) => {
    if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list;

    const candidates = [...extraCandidates, ...vendorInstalls(), ...(await whereJava())].filter(Boolean);
    const seen = new Set();
    const unique = candidates.filter((candidate) => {
        const key = path.resolve(candidate).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const results = (await Promise.all(unique.map(probeJava))).filter(Boolean);
    // Oracle's javapath shim just forwards to some other install; list it last.
    const list = results
        .map((info) => ({ ...info, path: path.resolve(info.path), shim: /javapath/i.test(info.path) }))
        .sort((a, b) => Number(a.shim) - Number(b.shim) || b.major - a.major);

    cache = { at: Date.now(), list };
    return list;
};

/** Lowest suitable runtime, preferring Temurin and non-shim installs. */
const isTemurin = (runtime) => /temurin|adoptium/i.test(`${runtime.vendor} ${runtime.path}`);
const pickJava = (runtimes, requiredMajor) => runtimes
    .filter((runtime) => runtime.major >= requiredMajor)
    .sort((a, b) => Number(a.shim) - Number(b.shim)
        || a.major - b.major
        || Number(!isTemurin(a)) - Number(!isTemurin(b)))[0] || null;

module.exports = { detectJava, pickJava, parseJavaSettings, probeJava };
