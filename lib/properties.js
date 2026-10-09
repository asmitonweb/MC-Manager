const fs = require('fs');
const { writeFileAtomic } = require('./store');

const keyOf = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;
    const index = trimmed.indexOf('=');
    return (index === -1 ? trimmed : trimmed.slice(0, index)).trim() || null;
};

const parseProperties = (content) => {
    const properties = {};
    for (const line of content.split(/\r?\n/)) {
        const key = keyOf(line);
        if (!key) continue;
        const trimmed = line.trim();
        const index = trimmed.indexOf('=');
        properties[key] = index === -1 ? '' : trimmed.slice(index + 1).trim();
    }
    return properties;
};

// Updates keys in place, keeping comments, ordering and line endings.
// A value of null removes the key.
const mergeProperties = (content, updates) => {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.length ? content.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    const seen = new Set();
    const output = [];
    for (const line of lines) {
        const key = keyOf(line);
        if (key && Object.prototype.hasOwnProperty.call(updates, key)) {
            seen.add(key);
            if (updates[key] !== null && updates[key] !== undefined) output.push(`${key}=${updates[key]}`);
        } else {
            output.push(line);
        }
    }
    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key) && value !== null && value !== undefined) output.push(`${key}=${value}`);
    }
    return output.join(eol) + eol;
};

const readPropertiesFile = (file) => {
    if (!fs.existsSync(file)) return null;
    return parseProperties(fs.readFileSync(file, 'utf8'));
};

const updatePropertiesFile = (file, updates) => {
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    writeFileAtomic(file, mergeProperties(content, updates));
};

module.exports = { parseProperties, mergeProperties, readPropertiesFile, updatePropertiesFile };
