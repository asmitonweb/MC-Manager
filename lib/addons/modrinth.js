const { fetchJson } = require('../download');

const API = 'https://api.modrinth.com/v2';
const q = (value) => encodeURIComponent(JSON.stringify(value));

const DEPENDENCY_TYPES = { required: 'required', optional: 'optional', incompatible: 'incompatible', embedded: 'embedded' };

const normalizeProject = (project) => ({
    provider: 'modrinth',
    id: project.project_id || project.id,
    slug: project.slug,
    title: project.title,
    description: project.description,
    author: project.author || null,
    iconUrl: project.icon_url || null,
    downloads: project.downloads,
    categories: project.display_categories || project.categories || [],
    loaders: project.loaders || (project.categories || []).filter((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)),
    gameVersions: project.game_versions || project.versions || [],
    serverSide: project.server_side,
    clientSide: project.client_side,
    url: `https://modrinth.com/mod/${project.slug}`,
});

const normalizeVersion = (version) => {
    const file = version.files.find((entry) => entry.primary) || version.files[0];
    return {
        provider: 'modrinth',
        id: version.id,
        projectId: version.project_id,
        name: version.name,
        versionNumber: version.version_number,
        type: version.version_type,
        published: version.date_published,
        loaders: version.loaders,
        gameVersions: version.game_versions,
        file: file && {
            url: file.url,
            fileName: file.filename,
            size: file.size,
            hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
        },
        dependencies: (version.dependencies || [])
            .filter((dep) => dep.project_id || dep.version_id)
            .map((dep) => ({
                projectId: dep.project_id,
                versionId: dep.version_id,
                type: DEPENDENCY_TYPES[dep.dependency_type] || 'optional',
            })),
    };
};

// Prefers releases, then the newest.
const pickBest = (versions) => [...versions].sort((a, b) =>
    Number(b.type === 'release') - Number(a.type === 'release') || b.published.localeCompare(a.published))[0] || null;

class ModrinthProvider {
    constructor({ userAgent, fetchImpl } = {}) {
        this.id = 'modrinth';
        this.name = 'Modrinth';
        this.headers = { 'User-Agent': userAgent };
        this.fetchImpl = fetchImpl;
    }

    status() {
        return { id: this.id, name: this.name, enabled: true };
    }

    get(url, { headers, ...options } = {}) {
        return fetchJson(url, { ...options, headers: { ...this.headers, ...headers }, fetchImpl: this.fetchImpl });
    }

    async search({ query = '', mc, loader, offset = 0, sort = 'relevance', limit = 20 }) {
        const facets = [['project_type:mod'], [`categories:${loader}`], [`versions:${mc}`], ['server_side:required', 'server_side:optional']];
        const index = ['relevance', 'downloads', 'updated', 'newest'].includes(sort) ? sort : 'relevance';
        const data = await this.get(`${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&index=${index}&facets=${q(facets)}`);
        return { total: data.total_hits, offset: data.offset, hits: data.hits.map(normalizeProject) };
    }

    async getProjects(ids) {
        if (!ids.length) return [];
        return (await this.get(`${API}/projects?ids=${q(ids)}`)).map(normalizeProject);
    }

    async getVersions(ids) {
        if (!ids.length) return [];
        return (await this.get(`${API}/versions?ids=${q(ids)}`)).map(normalizeVersion);
    }

    async listVersions(projectId, { mc, loader }) {
        const versions = await this.get(`${API}/project/${encodeURIComponent(projectId)}/version?loaders=${q([loader])}&game_versions=${q([mc])}`);
        return versions.map(normalizeVersion);
    }

    async bestVersion(projectId, target) {
        return pickBest(await this.listVersions(projectId, target));
    }

    /** Looks up jar files by SHA-1. Returns { [sha1]: version }. */
    async identify(sha1s) {
        if (!sha1s.length) return {};
        const data = await this.get(`${API}/version_files`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' }),
        });
        return Object.fromEntries(Object.entries(data).map(([hash, version]) => [hash, normalizeVersion(version)]));
    }
}

module.exports = { ModrinthProvider, normalizeProject, normalizeVersion, pickBest };
