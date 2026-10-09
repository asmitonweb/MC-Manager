// Tiny TTL cache for catalog lookups. Failed lookups are not cached.
const cached = (ttlMs, load) => {
    const entries = new Map();
    return async (key = '') => {
        const hit = entries.get(key);
        if (hit && Date.now() - hit.at < ttlMs) return hit.value;
        const value = await load(key);
        entries.set(key, { at: Date.now(), value });
        return value;
    };
};

const HOUR = 60 * 60 * 1000;

module.exports = { cached, HOUR };
