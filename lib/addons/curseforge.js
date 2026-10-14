const { fetchJson } = require('../download');
const { OperationError } = require('../operations');
const { pickBest } = require('./modrinth');

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MODS_CLASS_ID = 6;
const LOADER_TYPES = { forge: 1, fabric: 4 };
const RELEASE_TYPES = { 1: 'release', 2: 'beta', 3: 'alpha' };
const RELATION_TYPES = { 1: 'embedded', 2: 'optional', 3: 'required', 4: 'optional', 5: 'incompatible', 6: 'embedded' };
const SORT_FIELDS = { relevance: 1, downloads: 6, updated: 3, newest: 11 };

const normalizeProject = (mod) => ({
    provider: 'curseforge',
    id: String(mod.id),
    slug: mod.slug,
    title: mod.name,
    description: mod.summary,
    author: mod.authors?.[0]?.name || null,
    iconUrl: mod.logo?.thumbnailUrl || null,
    downloads: mod.downloadCount,
    categories: (mod.categories || []).map((category) => category.name),
    loaders: [],
    gameVersions: [],
    serverSide: 'unknown',
    clientSide: 'unknown',
    url: mod.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
});

const normalizeFile = (file) => ({
    provider: 'curseforge',
    id: String(file.id),
    projectId: String(file.modId),
    name: file.displayName,
    versionNumber: file.displayName,
    type: RELEASE_TYPES[file.releaseType] || 'release',
    published: file.fileDate,
    loaders: (file.gameVersions || []).map((v) => v.toLowerCase()).filter((v) => v in LOADER_TYPES),
    gameVersions: (file.gameVersions || []).filter((v) => /^\d/.test(v)),
    // downloadUrl is null when the author disabled third-party distribution.
    file: {
        url: file.downloadUrl || null,
        fileName: file.fileName,
        size: file.fileLength,
        hashes: { sha1: (file.hashes || []).find((hash) => hash.algo === 1)?.value || null },
    },
    dependencies: (file.dependencies || []).map((dep) => ({
        projectId: String(dep.modId),
        versionId: null,
        type: RELATION_TYPES[dep.relationType] || 'optional',
    })),
});

class CurseForgeProvider {
    constructor({ apiKey, fetchImpl } = {}) {
        this.id = 'curseforge';
        this.name = 'CurseForge';
        this.apiKey = apiKey;
        this.fetchImpl = fetchImpl;
    }

    status() {
        return this.apiKey
            ? { id: this.id, name: this.name, enabled: true }
            : { id: this.id, name: this.name, enabled: false, reason: 'CurseForge is unavailable until an API key is configured (CURSEFORGE_API_KEY in .env).' };
    }

    request(url, { headers, ...options } = {}) {
        if (!this.apiKey) throw new OperationError(this.status().reason, { code: 'PROVIDER_DISABLED', status: 400 });
        return fetchJson(url, {
            ...options,
            headers: { 'x-api-key': this.apiKey, accept: 'application/json', ...headers },
            fetchImpl: this.fetchImpl,
        });
    }

    async search({ query = '', mc, loader, offset = 0, sort = 'relevance', limit = 20 }) {
        const params = new URLSearchParams({
            gameId: MINECRAFT_GAME_ID,
            classId: MODS_CLASS_ID,
            gameVersion: mc,
            modLoaderType: LOADER_TYPES[loader],
            searchFilter: query,
            sortField: SORT_FIELDS[sort] || 1,
            sortOrder: 'desc',
            pageSize: limit,
            index: offset,
        });
        const data = await this.request(`${API}/mods/search?${params}`);
        return { total: data.pagination?.totalCount ?? data.data.length, offset, hits: data.data.map(normalizeProject) };
    }

    async getProjects(ids) {
        if (!ids.length) return [];
        const data = await this.request(`${API}/mods`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modIds: ids.map(Number) }),
        });
        return data.data.map(normalizeProject);
    }

    async getVersions(ids) {
        if (!ids.length) return [];
        const data = await this.request(`${API}/mods/files`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fileIds: ids.map(Number) }),
        });
        return data.data.map(normalizeFile);
    }

    async listVersions(projectId, { mc, loader }) {
        const params = new URLSearchParams({ gameVersion: mc, modLoaderType: LOADER_TYPES[loader], pageSize: 50 });
        const data = await this.request(`${API}/mods/${encodeURIComponent(projectId)}/files?${params}`);
        return data.data.map(normalizeFile);
    }

    async bestVersion(projectId, target) {
        return pickBest(await this.listVersions(projectId, target));
    }

    async identify() {
        return {};
    }
}

module.exports = { CurseForgeProvider, normalizeFile, normalizeProject };
