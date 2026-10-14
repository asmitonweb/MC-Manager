const { fetchJson } = require('../download');
const { cached, HOUR } = require('./cache');

const META = 'https://meta.fabricmc.net/v2';

const getGameVersions = cached(HOUR, () => fetchJson(`${META}/versions/game`));
const getInstallers = cached(HOUR, () => fetchJson(`${META}/versions/installer`));
const getLoaders = cached(HOUR, (mc) => fetchJson(`${META}/versions/loader/${encodeURIComponent(mc)}`));

/** Stable Minecraft versions Fabric supports, newest first. */
const listGameVersions = async () => (await getGameVersions())
    .filter((version) => version.stable)
    .map((version) => version.version);

/** Loader versions for a Minecraft version, newest first; the newest stable one is recommended. */
const listLoaders = async (mc) => {
    const loaders = (await getLoaders(mc)).map((entry) => entry.loader);
    const recommended = loaders.find((loader) => loader.stable) || loaders[0];
    return loaders.map((loader) => ({
        version: loader.version,
        stable: loader.stable,
        recommended: Boolean(recommended && loader.version === recommended.version),
    }));
};

const latestStableInstaller = async () => {
    const installers = await getInstallers();
    return (installers.find((installer) => installer.stable) || installers[0]).version;
};

const serverLauncherUrl = (mc, loader, installer) =>
    `${META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;

module.exports = { listGameVersions, listLoaders, latestStableInstaller, serverLauncherUrl };
