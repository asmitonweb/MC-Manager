const { fetchJson } = require('../download');
const { OperationError } = require('../operations');
const { cached, HOUR } = require('./cache');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const getManifest = cached(HOUR, () => fetchJson(MANIFEST_URL));

const getVersionJson = cached(24 * HOUR, async (id) => {
    const manifest = await getManifest();
    const entry = manifest.versions.find((version) => version.id === id);
    if (!entry) throw new OperationError(`Unknown Minecraft version: ${id}`, { code: 'UNKNOWN_VERSION' });
    return fetchJson(entry.url);
});

/** Release versions, newest first: [{ id, releaseTime }]. */
const listReleases = async () => {
    const manifest = await getManifest();
    return manifest.versions
        .filter((version) => version.type === 'release')
        .map((version) => ({ id: version.id, releaseTime: version.releaseTime }));
};

/** { requiredJava, serverJar: { url, sha1, size } } for a release. */
const getServerInfo = async (id) => {
    const json = await getVersionJson(id);
    if (!json.downloads || !json.downloads.server) {
        throw new OperationError(`Minecraft ${id} has no server download.`, { code: 'NO_SERVER_DOWNLOAD' });
    }
    return {
        requiredJava: json.javaVersion ? json.javaVersion.majorVersion : 8,
        serverJar: json.downloads.server,
    };
};

module.exports = { listReleases, getServerInfo };
