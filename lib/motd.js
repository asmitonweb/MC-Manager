// The server description players see in their Multiplayer list. The admin's
// first line is kept; the second line names the world that is running now,
// so a player on an old launcher entry sees what changed.

const { readPropertiesFile, updatePropertiesFile } = require('./properties');

const SECTION = '\\u00A7';

// server.properties is Latin-1 with \uXXXX escapes; keep the file pure ASCII.
const escape = (text) => text.replace(/[\\]/g, '\\\\').replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`);

/** The raw motd value with line 2 set to the current world and version. */
const motdFor = (current, { worldName, loader, minecraftVersion }) => {
    const first = String(current || '').split('\\n')[0] || 'A Minecraft Server';
    const version = minecraftVersion ? ` ${SECTION}7\\u00B7 ${loader === 'forge' ? 'Forge' : 'Fabric'} ${escape(minecraftVersion)}` : '';
    return `${first}\\n${SECTION}7Now playing: ${SECTION}a${escape(worldName)}${version}`;
};

const updateMotd = (propertiesFile, info) => {
    if (!info.worldName) return null;
    const current = (readPropertiesFile(propertiesFile) || {}).motd;
    const next = motdFor(current, info);
    if (next !== current) updatePropertiesFile(propertiesFile, { motd: next });
    return next;
};

module.exports = { motdFor, updateMotd };
