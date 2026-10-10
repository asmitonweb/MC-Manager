const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./store');
const { downloadFile, fetchJson, sanitizeFileName, resolveInside } = require('./download');
const { OperationError } = require('./operations');
const { readFabricMod, satisfies } = require('./fabric-meta');

const KINDS = ['mods', 'shaderpacks', 'resourcepacks'];
const TYPE_TO_KIND = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' };
const IRIS = 'YL57xq9U';
const MAX_EXTRA_BYTES = 512 * 1024 * 1024;
const CLIENT_SEEN_MS = 7 * 24 * 60 * 60 * 1000;
// Replaced on the player's PC with the client folder and the game folder (forward slashes).
const CLIENT_DIR = '@@CLIENT@@';
const GAME_DIR = '@@GAME@@';
const SETUP_TEMPLATE = path.join(__dirname, '..', 'client-agent', 'setup.ps1');
const DEFAULT_AGENT = path.join(__dirname, '..', 'client-agent', 'dist', 'agent.jar');

const isClientMod = (mod) => mod.clientSide !== 'unsupported';
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
const tsv = (value) => String(value ?? '').replace(/[\t\r\n]/g, ' ');

const cdnUrl = (mod) => {
    if (mod.downloadUrl && /^https:\/\/cdn\.modrinth\.com\//.test(mod.downloadUrl)) return mod.downloadUrl;
    if (mod.provider === 'modrinth' && mod.projectId && mod.versionId && mod.fileName) {
        return `https://cdn.modrinth.com/data/${mod.projectId}/versions/${mod.versionId}/${encodeURIComponent(mod.fileName)}`;
    }
    return null;
};

/**
 * Keeps players' games in step with the server. Builds the manifest the
 * player-side agent syncs from (per setup: client mods, shader packs and
 * resource packs) and manages "client extras": files players need that the
 * server does not run (Iris, Sodium, shaders, resource packs).
 */
class ClientSync {
    constructor({ config, state, setups, addons, worlds, discord, modpack, agentFile = DEFAULT_AGENT, download = downloadFile, getJson = fetchJson }) {
        this.config = config;
        this.state = state;
        this.setups = setups;
        this.addons = addons;
        this.worlds = worlds;
        this.discord = discord;
        this.modpack = modpack;
        this.agentFile = agentFile;
        this.download = download;
        this.getJson = getJson;
        this.root = path.join(config.DATA_DIR, 'client');
        this.extras = new JsonStore(path.join(this.root, 'extras.json'), { setups: {} });
        this.agentCache = null;
        this.templates = new Map();
        this.seen = new Map();
    }

    // ---------- naming ----------

    brand() {
        const s = this.discord.settings();
        const name = (s.clientName || (s.serverName || '').split(/\s+[—–-]\s+/)[0] || 'Minecraft').trim();
        const words = name.normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const slug = words.join('').toLowerCase().slice(0, 24) || 'mcmanager';
        const fileBase = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('').slice(0, 32) || 'Minecraft';
        return { name, slug, setupFile: `${fileBase}-Setup.cmd` };
    }

    versionId(setupId) {
        return `${this.brand().slug}-${setupId}`;
    }

    label(setupId, profile) {
        const names = this.state.get().worlds.filter((world) => world.setupId === setupId).map((world) => world.name);
        const loader = profile.loader === 'forge' ? 'Forge' : 'Fabric';
        // The loader is in the name so nobody mistakes the entry for plain vanilla.
        return `${this.brand().name} · ${names.length ? `${names.join(' / ')} · ` : ''}${loader} ${profile.minecraftVersion}`;
    }

    // ---------- files ----------

    extrasDir(setupId, kind) {
        if (!KINDS.includes(kind)) throw new OperationError(`Unknown kind: ${kind}`, { code: 'INVALID_REQUEST' });
        return path.join(this.root, setupId, kind);
    }

    serverModsDir(setupId) {
        return setupId === this.setups.activeId()
            ? this.addons.modsDir
            : path.join(this.setups.root, setupId, 'files', 'mods');
    }

    extrasOf(setupId) {
        return this.extras.get().setups[setupId]?.files || [];
    }

    /** Every file a player needs for one setup: [{ kind, name, hash, size, urls, title, source }]. */
    filesFor(setupId) {
        const files = [];
        const serverDir = this.serverModsDir(setupId);
        for (const mod of this.setups.modsOf(setupId).filter(isClientMod)) {
            const file = path.join(serverDir, mod.fileName);
            if (!fs.existsSync(file)) continue;
            files.push(this.describe(setupId, 'mods', mod, file, 'server'));
        }
        for (const extra of this.extrasOf(setupId)) {
            const file = path.join(this.extrasDir(setupId, extra.kind), extra.fileName);
            if (!fs.existsSync(file)) continue;
            if (files.some((entry) => entry.kind === extra.kind && entry.name.toLowerCase() === extra.fileName.toLowerCase())) continue;
            files.push(this.describe(setupId, extra.kind, extra, file, 'client'));
        }
        return files.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    }

    describe(setupId, kind, entry, file, source) {
        const urls = [cdnUrl(entry), `file/${encodeURIComponent(setupId)}/${kind}/${encodeURIComponent(entry.fileName)}`].filter(Boolean);
        return {
            kind,
            name: entry.fileName,
            title: entry.title || entry.fileName,
            versionNumber: entry.versionNumber || null,
            hash: entry.sha512 ? `sha512:${entry.sha512}` : entry.sha1 ? `sha1:${entry.sha1}` : null,
            size: fs.statSync(file).size,
            urls,
            source,
        };
    }

    /** Absolute path of a file a player may download, or null. */
    resolveFile(setupId, kind, name) {
        if (!this.setups.profileOf(setupId) || !KINDS.includes(kind)) return null;
        const entry = this.filesFor(setupId).find((file) => file.kind === kind && file.name === name);
        if (!entry) return null;
        const dir = entry.source === 'server' ? this.serverModsDir(setupId) : this.extrasDir(setupId, kind);
        return resolveInside(dir, name);
    }

    // ---------- agent and launcher files ----------

    agentInfo() {
        let stat;
        try {
            stat = fs.statSync(this.agentFile);
        } catch {
            return null;
        }
        if (!this.agentCache || this.agentCache.mtimeMs !== stat.mtimeMs) {
            const sha256 = crypto.createHash('sha256').update(fs.readFileSync(this.agentFile)).digest('hex');
            this.agentCache = { mtimeMs: stat.mtimeMs, sha256, fileName: `agent-${sha256.slice(0, 12)}.jar` };
        }
        return { fileName: this.agentCache.fileName, sha256: this.agentCache.sha256, file: this.agentFile };
    }

    async fabricProfile(mc, loaderVersion) {
        const file = path.join(this.root, 'fabric', `${mc}-${loaderVersion}.json`.replace(/[^\w.-]/g, '_'));
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            const profile = await this.getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(profile));
            return profile;
        }
    }

    /**
     * The launcher version JSON for a Fabric setup, with the client and game
     * folders left as placeholders. Fabric loads mods from the setup's own
     * folder, so the player's .minecraft/mods is never used for it.
     */
    async versionJson(setupId) {
        const profile = this.setups.get(setupId);
        if (profile.loader !== 'fabric' || !profile.loaderVersion) {
            throw new OperationError('Only Fabric setups can be synced automatically.', { code: 'UNSUPPORTED_LOADER', status: 404 });
        }
        const agent = this.agentInfo();
        const key = `${setupId}|${profile.minecraftVersion}|${profile.loaderVersion}|${agent?.fileName || ''}|${this.brand().slug}`;
        if (this.templates.has(key)) return this.templates.get(key);
        const base = await this.fabricProfile(profile.minecraftVersion, profile.loaderVersion);
        const instance = `${CLIENT_DIR}/instances/${setupId}`;
        const json = {
            ...base,
            id: this.versionId(setupId),
            arguments: {
                ...(base.arguments || {}),
                jvm: [
                    ...(base.arguments?.jvm || []),
                    ...(agent ? [`-javaagent:${CLIENT_DIR}/${agent.fileName}=${setupId}`] : []),
                    `-Dmcmanager.gameDir=${GAME_DIR}`,
                    `-Dfabric.modsFolder=${instance}/mods`,
                    `-Dfabric.addMods=${instance}/extra-mods`,
                ],
            },
        };
        const text = `${JSON.stringify(json, null, 2)}\n`;
        const value = { text, hash: sha1(text).slice(0, 16) };
        this.templates.set(key, value);
        return value;
    }

    async ensureClientSide() {
        try {
            await this.modpack?.ensureClientSide();
        } catch (error) {
            console.error('Client-side lookup failed:', error.message);
        }
    }

    async manifest() {
        await this.ensureClientSide();
        const s = this.discord.settings();
        const agent = this.agentInfo();
        const activeId = this.setups.activeId();
        const setups = [];
        for (const { id } of this.setups.list()) {
            const profile = this.setups.profileOf(id);
            let versionHash = null;
            let versionError = null;
            if (profile.loader === 'fabric') {
                try {
                    versionHash = (await this.versionJson(id)).hash;
                } catch (error) {
                    versionError = error.message;
                }
            }
            setups.push({
                id,
                versionId: this.versionId(id),
                label: this.label(id, profile),
                minecraftVersion: profile.minecraftVersion,
                loader: profile.loader,
                loaderVersion: profile.loaderVersion || null,
                active: id === activeId,
                autoSync: profile.loader === 'fabric' && Boolean(versionHash),
                versionHash,
                versionError,
                files: this.filesFor(id),
            });
        }
        return {
            server: { name: s.serverName || 'Minecraft server', address: s.gameAddress || '' },
            brand: this.brand(),
            agent: agent && { fileName: agent.fileName, sha256: agent.sha256 },
            activeSetupId: activeId,
            setups,
        };
    }

    /** Line-based manifest for the agent and the setup script (no JSON parser needed). */
    static syncText(manifest) {
        const lines = [
            'v\t1',
            `server\t${tsv(manifest.server.name)}\t${tsv(manifest.server.address)}`,
            `brand\t${tsv(manifest.brand.name)}\t${manifest.brand.slug}`,
        ];
        if (manifest.agent) lines.push(`agent\t${manifest.agent.fileName}\t${manifest.agent.sha256}`);
        for (const setup of manifest.setups) {
            if (!setup.autoSync) continue;
            lines.push(['setup', setup.id, setup.versionId, tsv(setup.label), setup.minecraftVersion, setup.loader,
                setup.loaderVersion, setup.active ? 1 : 0, setup.versionHash].join('\t'));
            for (const file of setup.files) {
                if (!file.hash) continue;
                lines.push(['file', setup.id, file.kind, file.name, file.hash, file.size, ...file.urls].join('\t'));
            }
        }
        return `${lines.join('\n')}\n`;
    }

    setupScript(baseUrl, token) {
        const brand = this.brand();
        const ascii = (value) => value.normalize('NFKD').replace(/[^\x20-\x7e]/g, '-').replace(/'/g, "''");
        return fs.readFileSync(SETUP_TEMPLATE, 'utf8')
            .replace(/__BASE__/g, ascii(baseUrl))
            .replace(/__TOKEN__/g, token)
            .replace(/__SLUG__/g, brand.slug)
            .replace(/__NAME__/g, ascii(brand.name))
            .replace(/\r?\n/g, '\r\n');
    }

    /**
     * The setup file players run. It carries the whole PowerShell script after
     * a marker, writes it to %TEMP% and runs it as a local file. Download-and-
     * execute one-liners (irm | iex) are flagged by Windows Defender, so the
     * script is never fetched and evaluated on the fly.
     */
    setupCmd(baseUrl, token) {
        const { name, slug } = this.brand();
        const title = name.normalize('NFKD').replace(/[^A-Za-z0-9 ._-]/g, '');
        return [
            '@echo off',
            `title ${title} setup`,
            'set "MCM_ARGS=%*"',
            'set "MCM_SELF=%~f0"',
            `set "MCM_PS1=%TEMP%\\${slug}-setup.ps1"`,
            'powershell -NoProfile -Command "$t = [IO.File]::ReadAllText($env:MCM_SELF); $m = \'#\' + \'#MCM-SCRIPT\'; [IO.File]::WriteAllText($env:MCM_PS1, $t.Substring($t.IndexOf($m)), (New-Object Text.UTF8Encoding $true))"',
            'powershell -NoProfile -ExecutionPolicy Bypass -File "%MCM_PS1%"',
            'del "%MCM_PS1%" >nul 2>&1',
            'echo.',
            'pause',
            'exit /b',
            '##MCM-SCRIPT',
            this.setupScript(baseUrl, token),
        ].join('\r\n');
    }

    /** One line to paste into Terminal (PowerShell): downloads the setup file and runs it. */
    setupCommand(baseUrl, token) {
        const file = this.brand().setupFile;
        return `$f="$env:TEMP\\${file}"; iwr ${baseUrl}/client/${token}/${file} -UseBasicParsing -OutFile $f; & $f`;
    }

    recordClient(ip, agent) {
        const now = Date.now();
        this.seen.set(ip, { at: now, agent: String(agent || 'setup').slice(0, 40) });
        for (const [key, value] of this.seen) if (now - value.at > CLIENT_SEEN_MS) this.seen.delete(key);
    }

    recentClients() {
        const day = Date.now() - 24 * 60 * 60 * 1000;
        const values = [...this.seen.values()];
        return { last24h: values.filter((v) => v.at > day).length, last7d: values.length };
    }

    // ---------- client extras ----------

    profileFor(setupId) {
        const profile = this.setups.get(setupId);
        return { mc: profile.minecraftVersion, loader: profile.loader };
    }

    loadersFor(type, target) {
        if (type === 'shader') return ['iris', 'optifine'];
        if (type === 'resourcepack') return ['minecraft'];
        return [target.loader];
    }

    modrinth() {
        const provider = this.addons.providers.modrinth;
        if (!provider) throw new OperationError('Modrinth is not available.', { code: 'PROVIDER_DISABLED' });
        return provider;
    }

    async search({ setupId, type = 'mod', query = '', offset = 0 }) {
        if (!TYPE_TO_KIND[type]) throw new OperationError('Unknown type.', { code: 'INVALID_REQUEST' });
        const target = this.profileFor(setupId);
        const result = await this.modrinth().search({
            query: String(query).slice(0, 100),
            offset: Math.max(0, Number.parseInt(offset, 10) || 0),
            projectType: type,
            side: 'client',
            ...target,
        });
        const have = new Set([
            ...this.extrasOf(setupId).map((entry) => entry.projectId),
            ...this.setups.modsOf(setupId).map((mod) => mod.projectId),
        ]);
        return { ...result, target, hits: result.hits.map((hit) => ({ ...hit, installed: have.has(hit.id) })) };
    }

    /** Plans a client extra and its required dependencies. Shaders bring Iris along. */
    async resolve(setupId, type, projectId) {
        const kind = TYPE_TO_KIND[type];
        if (!kind) throw new OperationError('Unknown type.', { code: 'INVALID_REQUEST' });
        const provider = this.modrinth();
        const target = this.profileFor(setupId);
        const have = new Set([
            ...this.extrasOf(setupId).map((entry) => entry.projectId),
            ...this.setups.modsOf(setupId).map((mod) => mod.projectId),
        ]);
        const planned = new Map();
        const unavailable = [];
        const queue = [{ projectId: String(projectId), type, requiredBy: null }];
        if (type === 'shader' && !have.has(IRIS)) queue.push({ projectId: IRIS, type: 'mod', requiredBy: projectId, implied: true });

        while (queue.length) {
            const item = queue.shift();
            if (planned.has(item.projectId)) {
                if (item.requiredBy) planned.get(item.projectId).requiredBy.add(item.requiredBy);
                continue;
            }
            if (item.requiredBy && have.has(item.projectId)) continue;
            const version = await provider.bestVersion(item.projectId, { ...target, loaders: this.loadersFor(item.type, target) });
            if (!version?.file?.url) {
                unavailable.push({ projectId: item.projectId, requiredBy: item.requiredBy });
                continue;
            }
            planned.set(item.projectId, { version, type: item.type, explicit: !item.requiredBy, requiredBy: new Set(item.requiredBy ? [item.requiredBy] : []) });
            if (item.type !== 'mod') continue;
            for (const dep of version.dependencies) {
                if (dep.type === 'required' && dep.projectId) queue.push({ projectId: dep.projectId, type: 'mod', requiredBy: item.projectId });
            }
        }
        const ids = [...new Set([...planned.keys(), ...unavailable.map((entry) => entry.projectId)])];
        const projects = Object.fromEntries((await provider.getProjects(ids)).map((project) => [project.id, project]));
        const titleOf = (id) => projects[id]?.title || id;
        return {
            setupId,
            target,
            planned,
            projects,
            items: [...planned.entries()].map(([id, entry]) => ({
                projectId: id,
                title: titleOf(id),
                kind: TYPE_TO_KIND[entry.type],
                versionNumber: entry.version.versionNumber,
                size: entry.version.file.size,
                requiredBy: [...entry.requiredBy].map(titleOf),
            })),
            unavailable: unavailable.map((entry) => ({ ...entry, title: titleOf(entry.projectId), requiredBy: entry.requiredBy && titleOf(entry.requiredBy) })),
        };
    }

    async preview({ setupId, type, projectId }) {
        const { planned, projects, ...plan } = await this.resolve(setupId, type, projectId);
        return plan;
    }

    async install({ setupId, type, projectId }) {
        const plan = await this.resolve(setupId, type, projectId);
        if (plan.unavailable.length) {
            throw new OperationError(`No compatible version for Minecraft ${plan.target.mc}: ${plan.unavailable.map((e) => e.title).join(', ')}`, { code: 'INSTALL_BLOCKED' });
        }
        return this.addons.operations.startJob('client.install', async (ctx) => {
            const tmpDir = path.join(this.config.DATA_DIR, 'tmp', ctx.job.id);
            const added = [];
            try {
                const staged = [];
                const entries = [...plan.planned.entries()];
                for (const [index, [id, entry]] of entries.entries()) {
                    const kind = TYPE_TO_KIND[entry.type];
                    const fileName = sanitizeFileName(entry.version.file.fileName, kind === 'mods' ? '.jar' : '.zip');
                    ctx.progress(5 + (80 * index) / entries.length, `Downloading ${plan.projects[id]?.title || id} ${entry.version.versionNumber}`);
                    const digest = await this.download(entry.version.file.url, path.join(tmpDir, fileName), {
                        hashes: entry.version.file.hashes,
                        maxBytes: MAX_EXTRA_BYTES,
                    });
                    staged.push({ id, entry, kind, fileName, digest });
                }
                ctx.progress(85, 'Checking mod versions fit together');
                await this.fitVersions(ctx, setupId, plan, staged, tmpDir);
                ctx.progress(90, 'Saving');
                const previous = this.extrasOf(setupId);
                for (const item of staged) {
                    const dir = this.extrasDir(setupId, item.kind);
                    fs.mkdirSync(dir, { recursive: true });
                    const old = previous.find((entry) => entry.projectId === item.id);
                    if (old && old.fileName !== item.fileName) fs.rmSync(path.join(this.extrasDir(setupId, old.kind), old.fileName), { force: true });
                    fs.renameSync(path.join(tmpDir, item.fileName), resolveInside(dir, item.fileName));
                    added.push(plan.projects[item.id]?.title || item.id);
                }
                const now = new Date().toISOString();
                this.extras.update((draft) => {
                    const files = draft.setups[setupId]?.files || [];
                    for (const item of staged) {
                        const existing = files.find((entry) => entry.projectId === item.id);
                        const record = {
                            kind: item.kind,
                            provider: 'modrinth',
                            projectId: item.id,
                            versionId: item.entry.version.id,
                            versionNumber: item.entry.version.versionNumber,
                            title: plan.projects[item.id]?.title || item.id,
                            fileName: item.fileName,
                            sha1: item.digest.sha1,
                            sha512: item.digest.sha512,
                            downloadUrl: item.entry.version.file.url,
                            explicit: Boolean(existing?.explicit || item.entry.explicit),
                            requiredBy: [...new Set([...(existing?.requiredBy || []), ...item.entry.requiredBy])],
                            installedAt: existing?.installedAt || now,
                        };
                        if (existing) Object.assign(existing, record);
                        else files.push(record);
                    }
                    draft.setups[setupId] = { files };
                });
                return { added };
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        }, { setupId, projectId });
    }

    /**
     * Modrinth lists dependencies without versions, but mods pin them in
     * fabric.mod.json (Iris 1.8 needs Sodium 0.6.x, not the newest Sodium).
     * Reads every downloaded jar and, when a dependency we are adding doesn't
     * fit, steps back through its older versions until one does. Conflicts with
     * mods already in the setup stop the install.
     */
    async fitVersions(ctx, setupId, plan, staged, tmpDir) {
        const present = new Map(); // fabric mod id -> { version, title, item? }
        const replacing = new Set(staged.map((item) => item.id));
        const serverDir = this.serverModsDir(setupId);
        const existing = [
            ...this.setups.modsOf(setupId).filter(isClientMod).map((mod) => ({ projectId: mod.projectId, title: mod.title, file: path.join(serverDir, mod.fileName) })),
            ...this.extrasOf(setupId).filter((e) => e.kind === 'mods').map((e) => ({ projectId: e.projectId, title: e.title, file: path.join(this.extrasDir(setupId, 'mods'), e.fileName) })),
        ].filter((mod) => !replacing.has(mod.projectId) && fs.existsSync(mod.file));
        for (const mod of existing) {
            const meta = await readFabricMod(mod.file);
            if (meta?.id) present.set(meta.id, { version: meta.version, title: mod.title });
        }
        const metas = new Map();
        for (const item of staged.filter((s) => s.kind === 'mods')) {
            const meta = await readFabricMod(path.join(tmpDir, item.fileName));
            if (!meta?.id) continue;
            metas.set(item, meta);
            present.set(meta.id, { version: meta.version, title: plan.projects[item.id]?.title || item.id, item });
        }
        const provider = this.modrinth();
        for (const [item, meta] of metas) {
            for (const [depId, range] of Object.entries(meta.depends)) {
                const dep = present.get(depId);
                if (!dep || satisfies(dep.version, range)) continue;
                const title = plan.projects[item.id]?.title || item.id;
                if (!dep.item) {
                    throw new OperationError(`${title} needs ${dep.title} ${JSON.stringify(range)}, but this setup has ${dep.version}.`, { code: 'VERSION_CONFLICT' });
                }
                const candidates = (await provider.listVersions(dep.item.id, { ...plan.target, loaders: [plan.target.loader] }))
                    .filter((v) => v.id !== dep.item.entry.version.id && v.file?.url)
                    .sort((a, b) => b.published.localeCompare(a.published))
                    .slice(0, 15);
                let fixed = false;
                for (const candidate of candidates) {
                    const fileName = sanitizeFileName(candidate.file.fileName);
                    const digest = await this.download(candidate.file.url, path.join(tmpDir, fileName), { hashes: candidate.file.hashes, maxBytes: MAX_EXTRA_BYTES });
                    const candidateMeta = await readFabricMod(path.join(tmpDir, fileName));
                    if (candidateMeta && satisfies(candidateMeta.version, range)) {
                        if (fileName !== dep.item.fileName) fs.rmSync(path.join(tmpDir, dep.item.fileName), { force: true });
                        ctx.log(`${title} needs ${dep.title} ${JSON.stringify(range)}; using ${candidate.versionNumber}`);
                        Object.assign(dep.item, { fileName, digest, entry: { ...dep.item.entry, version: candidate } });
                        dep.version = candidateMeta.version;
                        // Later checks must use the replacement's own depends/breaks.
                        metas.set(dep.item, candidateMeta);
                        fixed = true;
                        break;
                    }
                    if (fileName !== dep.item.fileName) fs.rmSync(path.join(tmpDir, fileName), { force: true });
                }
                if (!fixed) throw new OperationError(`No ${dep.title} version for Minecraft ${plan.target.mc} fits ${title} (needs ${JSON.stringify(range)}).`, { code: 'VERSION_CONFLICT' });
            }
            for (const [otherId, range] of Object.entries(meta.breaks)) {
                const other = present.get(otherId);
                if (other && satisfies(other.version, range)) {
                    throw new OperationError(`${plan.projects[item.id]?.title || item.id} is incompatible with ${other.title} ${other.version}.`, { code: 'VERSION_CONFLICT' });
                }
            }
        }
    }

    /** Removes a client extra and any dependencies nothing else needs. */
    remove({ setupId, projectId }) {
        const files = this.extrasOf(setupId);
        if (!files.some((entry) => entry.projectId === projectId)) throw new OperationError('Not a client extra of this setup.', { code: 'NOT_MANAGED', status: 404 });
        const removing = new Set([projectId]);
        for (let changed = true; changed;) {
            changed = false;
            for (const entry of files) {
                if (removing.has(entry.projectId) || entry.explicit) continue;
                if ((entry.requiredBy || []).every((parent) => removing.has(parent))) {
                    removing.add(entry.projectId);
                    changed = true;
                }
            }
        }
        const removed = [];
        for (const entry of files.filter((file) => removing.has(file.projectId))) {
            fs.rmSync(path.join(this.extrasDir(setupId, entry.kind), entry.fileName), { force: true });
            removed.push(entry.title);
        }
        this.extras.update((draft) => {
            draft.setups[setupId].files = files
                .filter((entry) => !removing.has(entry.projectId))
                .map((entry) => ({ ...entry, requiredBy: (entry.requiredBy || []).filter((parent) => !removing.has(parent)) }));
        });
        return { removed };
    }

    /** Forgets extras of setups that no longer exist. */
    prune() {
        const known = new Set(this.setups.list().map((setup) => setup.id));
        const stale = Object.keys(this.extras.get().setups).filter((id) => !known.has(id));
        if (!stale.length) return;
        for (const id of stale) fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
        this.extras.update((draft) => {
            for (const id of stale) delete draft.setups[id];
        });
    }
}

module.exports = { ClientSync, KINDS, cdnUrl, isClientMod, CLIENT_DIR, GAME_DIR };
