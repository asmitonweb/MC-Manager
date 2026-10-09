const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { JsonStore } = require('../store');
const { downloadFile, sanitizeFileName, resolveInside } = require('../download');
const { OperationError } = require('../operations');

const MOD_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MOD_BYTES = 256 * 1024 * 1024;

const sha1File = async (file) => {
    const hash = crypto.createHash('sha1');
    await pipeline(fs.createReadStream(file), hash);
    return hash.digest('hex');
};

const keyOf = (provider, projectId) => `${provider}:${projectId}`;

class AddonManager {
    constructor({ config, state, minecraft, operations, providers, download = downloadFile }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.operations = operations;
        this.providers = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
        this.manifest = new JsonStore(path.join(config.DATA_DIR, 'addons-manifest.json'), { mods: [] });
        this.modsDir = path.join(config.SERVER_DIR, 'mods');
        this.download = download;
    }

    providerStatus() {
        return Object.values(this.providers).map((provider) => provider.status());
    }

    provider(id) {
        const provider = this.providers[id];
        if (!provider) throw new OperationError(`Unknown provider: ${id}`, { code: 'UNKNOWN_PROVIDER' });
        const status = provider.status();
        if (!status.enabled) throw new OperationError(status.reason, { code: 'PROVIDER_DISABLED' });
        return provider;
    }

    target() {
        const profile = this.state.get().profile;
        if (!profile) {
            throw new OperationError('Install the server first; mods are matched to its Minecraft version and loader.', {
                code: 'MINECRAFT_NOT_CONFIGURED',
                status: 409,
            });
        }
        return { mc: profile.minecraftVersion, loader: profile.loader };
    }

    assertStopped() {
        if (this.minecraft.isRunning()) {
            throw new OperationError('Stop the Minecraft server before changing mods.', { code: 'SERVER_RUNNING', status: 409 });
        }
    }

    async search({ provider = 'modrinth', query, offset, sort }) {
        const target = this.target();
        const result = await this.provider(provider).search({
            query: String(query || '').slice(0, 100),
            offset: Math.max(0, Number.parseInt(offset, 10) || 0),
            sort,
            ...target,
        });
        const installed = new Set(this.manifest.get().mods.map((mod) => keyOf(mod.provider, mod.projectId)));
        return { ...result, target, hits: result.hits.map((hit) => ({ ...hit, installed: installed.has(keyOf(hit.provider, hit.id)) })) };
    }

    async versions(providerId, projectId) {
        return this.provider(providerId).listVersions(projectId, this.target());
    }

    /** Managed mods (with file presence) plus jar files in mods/ that the manager did not install. */
    installed() {
        const mods = this.manifest.get().mods.map((mod) => ({
            ...mod,
            present: fs.existsSync(path.join(this.modsDir, mod.fileName)),
        }));
        const managedFiles = new Set(mods.map((mod) => mod.fileName.toLowerCase()));
        let unmanaged = [];
        try {
            unmanaged = fs.readdirSync(this.modsDir)
                .filter((name) => name.toLowerCase().endsWith('.jar') && !managedFiles.has(name.toLowerCase()))
                .map((name) => ({ fileName: name, sizeBytes: fs.statSync(path.join(this.modsDir, name)).size }));
        } catch {
            unmanaged = [];
        }
        let target = null;
        try {
            target = this.target();
        } catch {
            target = null;
        }
        return {
            target,
            mods: mods.map((mod) => ({
                ...mod,
                compatible: !target || (mod.loader === target.loader && mod.minecraftVersion === target.mc),
            })),
            unmanaged,
        };
    }

    /**
     * Resolves the requested projects and their required dependencies into an
     * install plan, flagging conflicts and anything that cannot be installed.
     */
    async resolve(providerId, items, { forUpdate = false } = {}) {
        const provider = this.provider(providerId);
        const target = this.target();
        const installed = new Map(this.manifest.get().mods.map((mod) => [keyOf(mod.provider, mod.projectId), mod]));

        const planned = new Map();
        const optional = new Map();
        const alreadyInstalled = new Map();
        const conflicts = [];
        const incompatible = [];
        const unavailable = [];
        const queue = items.map((item) => ({ projectId: String(item.projectId), versionId: item.versionId || null, explicit: !forUpdate, requiredBy: null }));
        const incompatibilities = [];

        while (queue.length) {
            const item = queue.shift();
            if (!item.projectId && item.versionId) {
                const [version] = await provider.getVersions([item.versionId]);
                if (!version) {
                    unavailable.push({ projectId: null, versionId: item.versionId, requiredBy: item.requiredBy });
                    continue;
                }
                item.projectId = version.projectId;
            }

            const existing = planned.get(item.projectId);
            if (existing) {
                if (item.requiredBy) existing.requiredBy.add(item.requiredBy);
                continue;
            }
            const installedEntry = installed.get(keyOf(providerId, item.projectId));
            if (item.requiredBy && installedEntry) {
                const entry = alreadyInstalled.get(item.projectId) || { projectId: item.projectId, title: installedEntry.title, requiredBy: new Set() };
                entry.requiredBy.add(item.requiredBy);
                alreadyInstalled.set(item.projectId, entry);
                continue;
            }

            const version = item.versionId
                ? (await provider.getVersions([item.versionId]))[0]
                : await provider.bestVersion(item.projectId, target);
            if (!version || version.projectId !== item.projectId) {
                (item.requiredBy ? unavailable : incompatible).push({ projectId: item.projectId, requiredBy: item.requiredBy });
                continue;
            }
            if (!version.loaders.includes(target.loader) || !version.gameVersions.includes(target.mc)) {
                incompatible.push({ projectId: item.projectId, versionId: version.id });
            }

            planned.set(item.projectId, {
                version,
                explicit: item.explicit,
                requiredBy: new Set(item.requiredBy ? [item.requiredBy] : []),
            });

            for (const dep of version.dependencies) {
                if (dep.type === 'required') {
                    queue.push({ projectId: dep.projectId || null, versionId: dep.versionId, explicit: false, requiredBy: item.projectId });
                } else if (dep.type === 'optional' && dep.projectId && !installed.has(keyOf(providerId, dep.projectId))) {
                    optional.set(dep.projectId, { projectId: dep.projectId, suggestedBy: item.projectId });
                } else if (dep.type === 'incompatible' && dep.projectId) {
                    incompatibilities.push({ projectId: item.projectId, with: dep.projectId });
                }
            }
        }

        for (const rule of incompatibilities) {
            if (planned.has(rule.with) || installed.has(keyOf(providerId, rule.with))) conflicts.push(rule);
        }
        for (const projectId of planned.keys()) optional.delete(projectId);

        // Titles and server-side support for everything mentioned.
        const ids = [...new Set([
            ...planned.keys(), ...optional.keys(), ...alreadyInstalled.keys(),
            ...conflicts.flatMap((rule) => [rule.projectId, rule.with]),
            ...incompatible.map((entry) => entry.projectId), ...unavailable.map((entry) => entry.projectId).filter(Boolean),
        ])];
        const projects = Object.fromEntries((await provider.getProjects(ids)).map((project) => [project.id, project]));
        const titleOf = (id) => projects[id]?.title || installed.get(keyOf(providerId, id))?.title || id;

        const clientOnly = [...planned.keys()].filter((id) => projects[id]?.serverSide === 'unsupported');
        const manualDownload = [...planned.values()].filter((entry) => !entry.version.file?.url).map((entry) => entry.version.projectId);
        const describe = ([projectId, entry]) => ({
            projectId,
            title: titleOf(projectId),
            versionId: entry.version.id,
            versionNumber: entry.version.versionNumber,
            fileName: entry.version.file?.fileName,
            size: entry.version.file?.size,
            requiredBy: [...entry.requiredBy].map(titleOf),
            replaces: installed.get(keyOf(providerId, projectId))?.versionNumber || null,
            url: projects[projectId]?.url,
        });

        return {
            provider: providerId,
            target,
            planned,
            projects,
            install: [...planned.entries()].filter(([, entry]) => entry.explicit || forUpdate && !entry.requiredBy.size).map(describe),
            dependencies: [...planned.entries()].filter(([, entry]) => !(entry.explicit || forUpdate && !entry.requiredBy.size)).map(describe),
            optional: [...optional.values()].map((entry) => ({ ...entry, title: titleOf(entry.projectId), suggestedBy: titleOf(entry.suggestedBy) })),
            alreadyInstalled: [...alreadyInstalled.values()].map((entry) => ({ ...entry, requiredBy: [...entry.requiredBy].map(titleOf) })),
            conflicts: conflicts.map((rule) => ({ ...rule, title: titleOf(rule.projectId), withTitle: titleOf(rule.with) })),
            incompatible: incompatible.map((entry) => ({ ...entry, title: titleOf(entry.projectId) })),
            unavailable: unavailable.map((entry) => ({ ...entry, title: entry.projectId ? titleOf(entry.projectId) : entry.versionId, requiredBy: entry.requiredBy && titleOf(entry.requiredBy) })),
            clientOnly: clientOnly.map((id) => ({ projectId: id, title: titleOf(id) })),
            manualDownload: manualDownload.map((id) => ({ projectId: id, title: titleOf(id), url: projects[id]?.url })),
        };
    }

    static blockers(plan) {
        const problems = [];
        if (plan.conflicts.length) problems.push(`Conflicts: ${plan.conflicts.map((c) => `${c.title} ↔ ${c.withTitle}`).join(', ')}`);
        if (plan.incompatible.length) problems.push(`No compatible version: ${plan.incompatible.map((e) => e.title).join(', ')}`);
        if (plan.unavailable.length) problems.push(`Missing required dependencies: ${plan.unavailable.map((e) => e.title).join(', ')}`);
        if (plan.clientOnly.length) problems.push(`Client-only mods cannot run on a server: ${plan.clientOnly.map((e) => e.title).join(', ')}`);
        if (plan.manualDownload.length) problems.push(`Manual download required (the author disabled third-party downloads): ${plan.manualDownload.map((e) => e.title).join(', ')}`);
        return problems;
    }

    async preview({ provider = 'modrinth', items = [] }) {
        if (!Array.isArray(items) || !items.length) throw new OperationError('Choose at least one mod.', { code: 'INVALID_REQUEST' });
        const plan = await this.resolve(provider, items);
        const { planned, projects, ...summary } = plan;
        return { ...summary, blockers: AddonManager.blockers(plan) };
    }

    async install({ provider = 'modrinth', items = [] }) {
        this.assertStopped();
        if (!Array.isArray(items) || !items.length) throw new OperationError('Choose at least one mod.', { code: 'INVALID_REQUEST' });
        const plan = await this.resolve(provider, items);
        const problems = AddonManager.blockers(plan);
        if (problems.length) throw new OperationError(problems.join(' '), { code: 'INSTALL_BLOCKED' });
        return this.operations.startJob('addon.install', (ctx) => this.applyPlan(ctx, plan), {
            provider,
            projects: plan.install.map((entry) => entry.title),
        });
    }

    /** Checks managed mods for newer compatible versions. */
    async updates() {
        const target = this.target();
        const results = [];
        for (const mod of this.manifest.get().mods) {
            const provider = this.providers[mod.provider];
            if (!provider || !provider.status().enabled) continue;
            try {
                const best = await provider.bestVersion(mod.projectId, target);
                if (best && best.id !== mod.versionId && (!mod.published || best.published > mod.published)) {
                    results.push({ provider: mod.provider, projectId: mod.projectId, title: mod.title, from: mod.versionNumber, to: best.versionNumber, versionId: best.id });
                }
            } catch (error) {
                results.push({ provider: mod.provider, projectId: mod.projectId, title: mod.title, error: error.message });
            }
        }
        return results;
    }

    async update({ provider = 'modrinth', projectIds = [] }) {
        this.assertStopped();
        const managed = this.manifest.get().mods.filter((mod) => mod.provider === provider && projectIds.includes(mod.projectId));
        if (!managed.length) throw new OperationError('Nothing to update.', { code: 'INVALID_REQUEST' });
        const plan = await this.resolve(provider, managed.map((mod) => ({ projectId: mod.projectId })), { forUpdate: true });
        const problems = AddonManager.blockers(plan);
        if (problems.length) throw new OperationError(problems.join(' '), { code: 'INSTALL_BLOCKED' });
        return this.operations.startJob('addon.update', (ctx) => this.applyPlan(ctx, plan), { provider, projects: managed.map((mod) => mod.title) });
    }

    /**
     * Downloads and verifies every file first, then swaps them into mods/.
     * Replaced files are moved to manager-data/mod-backups. Any failure undoes
     * the file moves; the manifest is only written after everything succeeded.
     */
    async applyPlan(ctx, plan) {
        this.assertStopped();
        this.pruneModBackups();
        const tmpDir = path.join(this.config.DATA_DIR, 'tmp', ctx.job.id);
        const backupDir = path.join(this.config.DATA_DIR, 'mod-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}_${ctx.job.id.slice(0, 8)}`);
        const provider = plan.provider;
        const entries = [...plan.planned.entries()];
        const installedNow = new Map(this.manifest.get().mods.map((mod) => [keyOf(mod.provider, mod.projectId), mod]));

        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(this.modsDir, { recursive: true });
        const movedIn = [];
        const backedUp = [];

        try {
            const staged = [];
            for (const [index, [projectId, entry]] of entries.entries()) {
                const { version } = entry;
                const fileName = sanitizeFileName(version.file.fileName);
                const title = plan.projects[projectId]?.title || projectId;
                ctx.progress(5 + (70 * index) / entries.length, `Downloading ${title} ${version.versionNumber}`);
                const digest = await this.download(version.file.url, path.join(tmpDir, fileName), {
                    hashes: version.file.hashes,
                    maxBytes: MAX_MOD_BYTES,
                });
                staged.push({ projectId, entry, fileName, digest, title });
            }

            ctx.progress(80, 'Installing files');
            for (const item of staged) {
                const previous = installedNow.get(keyOf(provider, item.projectId));
                const toReplace = new Set([previous?.fileName, item.fileName].filter(Boolean));
                for (const name of toReplace) {
                    const existing = resolveInside(this.modsDir, name);
                    if (!fs.existsSync(existing)) continue;
                    fs.mkdirSync(backupDir, { recursive: true });
                    fs.renameSync(existing, path.join(backupDir, name));
                    backedUp.push(name);
                    ctx.log(`Moved previous ${name} to ${backupDir}`);
                }
                fs.renameSync(path.join(tmpDir, item.fileName), resolveInside(this.modsDir, item.fileName));
                movedIn.push(item.fileName);
            }

            ctx.progress(95, 'Updating manifest');
            const now = new Date().toISOString();
            this.manifest.update((draft) => {
                for (const item of staged) {
                    const { version } = item.entry;
                    const existing = draft.mods.find((mod) => mod.provider === provider && mod.projectId === item.projectId);
                    const requiredBy = [...item.entry.requiredBy];
                    const record = {
                        provider,
                        projectId: item.projectId,
                        versionId: version.id,
                        versionNumber: version.versionNumber,
                        published: version.published,
                        slug: plan.projects[item.projectId]?.slug || null,
                        title: item.title,
                        fileName: item.fileName,
                        sha1: item.digest.sha1,
                        sha512: item.digest.sha512,
                        minecraftVersion: plan.target.mc,
                        loader: plan.target.loader,
                        explicit: Boolean(existing?.explicit || item.entry.explicit),
                        dependencyOf: [...new Set([...(existing?.dependencyOf || []), ...requiredBy])],
                        installedAt: existing?.installedAt || now,
                        updatedAt: now,
                    };
                    if (existing) Object.assign(existing, record);
                    else draft.mods.push(record);
                }
                for (const dep of plan.alreadyInstalled) {
                    const existing = draft.mods.find((mod) => mod.provider === provider && mod.projectId === dep.projectId);
                    if (!existing) continue;
                    const requiredByIds = [...plan.planned.entries()]
                        .filter(([, entry]) => entry.version.dependencies.some((d) => d.type === 'required' && d.projectId === dep.projectId))
                        .map(([id]) => id);
                    existing.dependencyOf = [...new Set([...(existing.dependencyOf || []), ...requiredByIds])];
                }
            });

            return { installed: staged.map((item) => ({ title: item.title, fileName: item.fileName })) };
        } catch (error) {
            for (const name of movedIn) fs.rmSync(path.join(this.modsDir, name), { force: true });
            for (const name of backedUp) {
                if (fs.existsSync(path.join(backupDir, name))) fs.renameSync(path.join(backupDir, name), path.join(this.modsDir, name));
            }
            throw error;
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    uninstall({ provider = 'modrinth', projectId, removeOrphanDeps = true }) {
        this.assertStopped();
        const target = this.manifest.get().mods.find((mod) => mod.provider === provider && mod.projectId === projectId);
        if (!target) throw new OperationError('That mod is not managed by MC Manager.', { code: 'NOT_MANAGED', status: 404 });

        return this.operations.startJob('addon.uninstall', async (ctx) => {
            this.assertStopped();
            const mods = this.manifest.get().mods;
            const removing = new Set([keyOf(provider, projectId)]);
            if (removeOrphanDeps) {
                // Repeatedly drop auto-installed dependencies nothing else needs.
                for (let changed = true; changed;) {
                    changed = false;
                    for (const mod of mods) {
                        const key = keyOf(mod.provider, mod.projectId);
                        if (removing.has(key) || mod.explicit) continue;
                        const stillNeeded = (mod.dependencyOf || []).some((parent) => {
                            const parentKey = keyOf(mod.provider, parent);
                            return !removing.has(parentKey) && mods.some((other) => keyOf(other.provider, other.projectId) === parentKey);
                        });
                        if (!stillNeeded) {
                            removing.add(key);
                            changed = true;
                        }
                    }
                }
            }

            const backupDir = path.join(this.config.DATA_DIR, 'mod-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}_${ctx.job.id.slice(0, 8)}`);
            const removed = [];
            for (const mod of mods.filter((entry) => removing.has(keyOf(entry.provider, entry.projectId)))) {
                const file = resolveInside(this.modsDir, mod.fileName);
                if (fs.existsSync(file)) {
                    fs.mkdirSync(backupDir, { recursive: true });
                    fs.renameSync(file, path.join(backupDir, mod.fileName));
                }
                removed.push(mod.title);
                ctx.log(`Removed ${mod.title} (${mod.fileName})`);
            }
            this.manifest.update((draft) => {
                draft.mods = draft.mods.filter((mod) => !removing.has(keyOf(mod.provider, mod.projectId)));
                for (const mod of draft.mods) {
                    mod.dependencyOf = (mod.dependencyOf || []).filter((parent) => !removing.has(keyOf(mod.provider, parent)));
                }
            });
            return { removed };
        }, { provider, projectId });
    }

    /** Hashes unmanaged jars and adopts the ones Modrinth recognises. */
    identify() {
        const provider = this.provider('modrinth');
        const target = this.target();
        return this.operations.startJob('addon.identify', async (ctx) => {
            const { unmanaged } = this.installed();
            const hashes = {};
            for (const file of unmanaged) hashes[await sha1File(path.join(this.modsDir, file.fileName))] = file.fileName;
            ctx.progress(40, `Looking up ${unmanaged.length} file(s) on Modrinth`);
            const found = await provider.identify(Object.keys(hashes));
            const projects = Object.fromEntries((await provider.getProjects([...new Set(Object.values(found).map((v) => v.projectId))])).map((p) => [p.id, p]));
            const adopted = [];
            this.manifest.update((draft) => {
                for (const [sha1, version] of Object.entries(found)) {
                    if (draft.mods.some((mod) => mod.provider === 'modrinth' && mod.projectId === version.projectId)) continue;
                    draft.mods.push({
                        provider: 'modrinth',
                        projectId: version.projectId,
                        versionId: version.id,
                        versionNumber: version.versionNumber,
                        published: version.published,
                        slug: projects[version.projectId]?.slug || null,
                        title: projects[version.projectId]?.title || hashes[sha1],
                        fileName: hashes[sha1],
                        sha1,
                        sha512: version.file?.hashes.sha512 || null,
                        minecraftVersion: target.mc,
                        loader: target.loader,
                        explicit: true,
                        dependencyOf: [],
                        installedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    adopted.push(hashes[sha1]);
                }
            });
            return { adopted, unknown: unmanaged.length - adopted.length };
        });
    }

    pruneModBackups() {
        const dir = path.join(this.config.DATA_DIR, 'mod-backups');
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (Date.now() - fs.statSync(full).mtimeMs > MOD_BACKUP_RETENTION_MS) fs.rmSync(full, { recursive: true, force: true });
        }
    }
}

module.exports = { AddonManager };
