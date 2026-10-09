const fs = require('fs');
const path = require('path');
const { fetchJson, fetchText } = require('../download');
const { cached, HOUR } = require('./cache');

const MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const PROMOTIONS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

const getPromotions = cached(HOUR, () => fetchJson(PROMOTIONS_URL));
const getMetadata = cached(HOUR, () => fetchText(`${MAVEN}/maven-metadata.xml`));

// v1 supports the modern installer layout only (Minecraft 1.17 and later,
// including the 26.x scheme).
const isSupportedMinecraft = (mc) => {
    const parts = mc.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.some((part) => !Number.isFinite(part))) return false;
    return parts[0] === 1 ? parts[1] >= 17 : parts[0] >= 2;
};

const compareVersions = (a, b) => {
    const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
};

/** Parses maven-metadata.xml into { [mc]: [forgeVersion, ...] } for supported versions. */
const parseMetadata = (xml) => {
    const byMinecraft = {};
    for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
        const full = match[1];
        const dash = full.indexOf('-');
        if (dash === -1) continue;
        const mc = full.slice(0, dash);
        const forge = full.slice(dash + 1);
        if (!isSupportedMinecraft(mc) || !/^[\d.]+$/.test(forge)) continue;
        (byMinecraft[mc] ||= []).push(forge);
    }
    for (const versions of Object.values(byMinecraft)) versions.sort((a, b) => compareVersions(b, a));
    return byMinecraft;
};

/** Supported Minecraft versions that have Forge builds, newest first. */
const listGameVersions = async () => Object.keys(parseMetadata(await getMetadata())).sort((a, b) => compareVersions(b, a));

/** Forge versions for a Minecraft version, newest first, with the recommended build flagged. */
const listLoaders = async (mc) => {
    const versions = parseMetadata(await getMetadata())[mc] || [];
    const promos = (await getPromotions()).promos || {};
    const recommended = promos[`${mc}-recommended`] || promos[`${mc}-latest`] || versions[0];
    return versions.map((version) => ({
        version,
        stable: version === promos[`${mc}-recommended`],
        recommended: version === recommended,
    }));
};

const installerUrl = (mc, forge) => `${MAVEN}/${mc}-${forge}/forge-${mc}-${forge}-installer.jar`;

/**
 * Finds the argument file the Forge installer generated for Windows. Reads
 * run.bat first (it names the exact file) and falls back to the usual path.
 */
const findWinArgs = (installDir, mc, forge) => {
    const runBat = path.join(installDir, 'run.bat');
    if (fs.existsSync(runBat)) {
        const match = /@(libraries[\\/][^\s"]+win_args\.txt)/.exec(fs.readFileSync(runBat, 'utf8'));
        if (match && fs.existsSync(path.join(installDir, match[1]))) return match[1].replace(/\\/g, '/');
    }
    const conventional = `libraries/net/minecraftforge/forge/${mc}-${forge}/win_args.txt`;
    return fs.existsSync(path.join(installDir, conventional)) ? conventional : null;
};

module.exports = {
    listGameVersions,
    listLoaders,
    installerUrl,
    findWinArgs,
    parseMetadata,
    isSupportedMinecraft,
    compareVersions,
};
