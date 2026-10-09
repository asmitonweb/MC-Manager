const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { downloadFile, fetchText } = require('../download');
const { detectJava, pickJava } = require('../java');
const { readPropertiesFile, updatePropertiesFile } = require('../properties');
const { writeFileAtomic } = require('../store');
const { OperationError } = require('../operations');
const { parseMemory } = require('../minecraft');
const mojang = require('./mojang');
const fabric = require('./fabric');
const forge = require('./forge');

const LOADERS = { fabric, forge };
const STAGING_DIRNAME = '.install-staging';
const FORGE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// Never moved or replaced by an install: user data and configuration.
const PROTECTED_ENTRIES = new Set([
    'worlds', 'world', 'world_nether', 'world_the_end', 'mods', 'config', 'defaultconfigs', 'logs', 'crash-reports',
    'server.properties', 'eula.txt', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json',
    'usercache.json', STAGING_DIRNAME,
]);
// Files and folders that belong to a loader install and are replaced on reinstall.
const isLoaderArtifact = (name) => /\.jar$/i.test(name)
    || ['libraries', 'versions', '.fabric', 'run.bat', 'run.sh', 'user_jvm_args.txt',
        'fabric-server-launcher.properties', 'README.txt'].includes(name);

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const invalid = (message) => new OperationError(message, { code: 'INVALID_INSTALL_REQUEST' });

class ServerInstaller {
    constructor({ config, state, minecraft, operations, worlds }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.operations = operations;
        this.worlds = worlds;
    }

    javaCandidates() {
        return [this.state.get().profile?.javaPath, this.config.fallback.javaBin].filter(Boolean);
    }

    hasExistingInstall() {
        if (this.state.get().profile) return true;
        try {
            return fs.readdirSync(this.config.SERVER_DIR).some((name) => isLoaderArtifact(name) && name !== 'README.txt');
        } catch {
            return false;
        }
    }

    async options() {
        return {
            loaders: [
                { id: 'fabric', name: 'Fabric' },
                { id: 'forge', name: 'Forge', note: 'Minecraft 1.17 and later' },
            ],
            java: await detectJava({ extraCandidates: this.javaCandidates() }),
            profile: this.state.get().profile,
            existingInstall: this.hasExistingInstall(),
            totalMemory: os.totalmem(),
            defaults: { memory: { min: this.config.fallback.minMemory, max: this.config.fallback.maxMemory } },
        };
    }

    loaderModule(loader) {
        const module = LOADERS[loader];
        if (!module) throw invalid(`Unsupported loader: ${loader}`);
        return module;
    }

    async versions(loader) {
        const available = new Set(await this.loaderModule(loader).listGameVersions());
        // Keep Mojang's ordering and only offer releases.
        return (await mojang.listReleases())
            .filter((release) => available.has(release.id))
            .map((release) => ({ id: release.id, releaseTime: release.releaseTime }));
    }

    async loaderVersions(loader, mc) {
        return this.loaderModule(loader).listLoaders(mc);
    }

    /** Validates an install request against live catalogs; returns a normalized plan. */
    async plan(input = {}) {
        const loader = String(input.loader || '');
        const mc = String(input.minecraftVersion || '');
        const loaderModule = this.loaderModule(loader);

        if (!(await this.versions(loader)).some((version) => version.id === mc)) {
            throw invalid(`${loader} does not support Minecraft ${mc}.`);
        }
        const loaders = await loaderModule.listLoaders(mc);
        const loaderVersion = String(input.loaderVersion || loaders.find((entry) => entry.recommended)?.version || '');
        if (!loaders.some((entry) => entry.version === loaderVersion)) {
            throw invalid(`Unknown ${loader} version ${loaderVersion} for Minecraft ${mc}.`);
        }

        const minMemory = String(input.memory?.min || this.config.fallback.minMemory).toUpperCase();
        const maxMemory = String(input.memory?.max || this.config.fallback.maxMemory).toUpperCase();
        if (!/^\d+[MG]$/.test(minMemory) || !/^\d+[MG]$/.test(maxMemory)) {
            throw invalid('Memory must look like 2G or 2048M.');
        }
        if (parseMemory(minMemory) > parseMemory(maxMemory)) throw invalid('Minimum memory cannot exceed maximum memory.');
        if (parseMemory(maxMemory) > os.totalmem() - 2 * 1024 ** 3) {
            throw invalid('Maximum memory must leave at least 2 GB for Windows.');
        }

        const { requiredJava, serverJar } = await mojang.getServerInfo(mc);
        const runtimes = await detectJava({ extraCandidates: this.javaCandidates() });
        const java = input.javaPath
            ? runtimes.find((runtime) => runtime.path.toLowerCase() === path.resolve(String(input.javaPath)).toLowerCase())
            : pickJava(runtimes, requiredJava);
        if (input.javaPath && !java) throw invalid('The selected Java runtime was not found.');

        const warnings = [];
        const javaOk = Boolean(java && java.major >= requiredJava);
        if (!java) {
            warnings.push(`Minecraft ${mc} needs Java ${requiredJava} or newer, and none is installed.`);
        } else if (!javaOk) {
            warnings.push(`Minecraft ${mc} needs Java ${requiredJava} or newer; the selected runtime is Java ${java.major}.`);
        }
        const javaRisk = Boolean(javaOk && loader === 'forge' && java.major - requiredJava >= 4);
        if (javaRisk) {
            warnings.push(`Forge for Minecraft ${mc} targets Java ${requiredJava}. It may fail on Java ${java.major}; installing Temurin ${requiredJava} is safer.`);
        }

        const existingInstall = this.hasExistingInstall();
        const worldName = String(input.worldName || 'World').trim();
        if (!this.worlds.list().length && (!worldName || worldName.length > 60)) throw invalid('World names must be 1-60 characters.');

        return {
            loader,
            minecraftVersion: mc,
            loaderVersion,
            installerVersion: loader === 'fabric' ? await fabric.latestStableInstaller() : null,
            requiredJava,
            java: java || null,
            javaOk,
            javaRisk,
            memory: { min: minMemory, max: maxMemory },
            serverJar,
            warnings,
            existingInstall,
            createsWorld: !this.worlds.list().length,
            worldName,
            targetDir: this.config.SERVER_DIR,
        };
    }

    async preview(input) {
        const plan = await this.plan(input);
        return { ...plan, serverJar: undefined };
    }

    async install(input = {}, user = 'admin') {
        if (input.acceptEula !== true) {
            throw invalid('You must accept the Minecraft EULA to install a server.');
        }
        const plan = await this.plan(input);
        if (!plan.javaOk) throw invalid(plan.warnings[0]);
        if (plan.javaRisk && input.acceptJavaRisk !== true) {
            throw invalid('Confirm the Java compatibility warning to continue.');
        }
        if (plan.existingInstall && input.reinstall !== true) {
            throw invalid('A server is already installed. Confirm the reinstall to replace it.');
        }
        if (this.minecraft.isRunning()) {
            throw new OperationError('Stop the Minecraft server before installing.', { code: 'SERVER_RUNNING', status: 409 });
        }

        return this.operations.startJob('install', (ctx) => this.run(ctx, plan, user), {
            loader: plan.loader,
            minecraftVersion: plan.minecraftVersion,
            loaderVersion: plan.loaderVersion,
        });
    }

    async run(ctx, plan, user) {
        const serverDir = this.config.SERVER_DIR;
        const stagingDir = path.join(serverDir, STAGING_DIRNAME, ctx.job.id);
        fs.mkdirSync(stagingDir, { recursive: true });

        try {
            const launch = plan.loader === 'fabric'
                ? await this.stageFabric(ctx, plan, stagingDir)
                : await this.stageForge(ctx, plan, stagingDir);

            ctx.progress(85, 'Installing files');
            const backupDir = path.join(this.config.BACKUP_DIR, 'server-install', timestamp());
            this.swapIn(ctx, stagingDir, serverDir, backupDir);

            ctx.progress(92, 'Writing configuration');
            this.writeConfiguration(plan);

            const profile = {
                loader: plan.loader,
                minecraftVersion: plan.minecraftVersion,
                loaderVersion: plan.loaderVersion,
                installerVersion: plan.installerVersion,
                javaPath: plan.java.path,
                javaMajor: plan.java.major,
                requiredJavaMajor: plan.requiredJava,
                launch,
                memory: plan.memory,
                installedAt: new Date().toISOString(),
                installedBy: user,
            };
            this.state.update((draft) => {
                draft.profile = profile;
            });

            if (plan.createsWorld) {
                const world = this.worlds.create({ name: plan.worldName });
                this.worlds.activate(world.id);
                ctx.log(`Created world "${world.name}" (${world.id}).`);
            }

            this.minecraft.refreshStatus();
            return { profile };
        } finally {
            fs.rmSync(path.join(serverDir, STAGING_DIRNAME), { recursive: true, force: true });
        }
    }

    async stageFabric(ctx, plan, stagingDir) {
        ctx.progress(5, `Downloading Fabric server launcher ${plan.loaderVersion}`);
        await downloadFile(
            fabric.serverLauncherUrl(plan.minecraftVersion, plan.loaderVersion, plan.installerVersion),
            path.join(stagingDir, 'fabric-server-launch.jar'),
            { maxBytes: 16 * 1024 * 1024 }
        );

        ctx.progress(15, `Downloading Minecraft ${plan.minecraftVersion} server`);
        await downloadFile(plan.serverJar.url, path.join(stagingDir, 'server.jar'), {
            hashes: { sha1: plan.serverJar.sha1 },
            onProgress: (received, total) => total && ctx.progress(15 + (65 * received) / total),
        });
        fs.writeFileSync(path.join(stagingDir, 'fabric-server-launcher.properties'), 'serverJar=server.jar\n');
        return { type: 'jar', jar: 'fabric-server-launch.jar' };
    }

    async stageForge(ctx, plan, stagingDir) {
        const { minecraftVersion: mc, loaderVersion } = plan;
        const tmpDir = path.join(this.config.DATA_DIR, 'tmp', ctx.job.id);
        const installer = path.join(tmpDir, `forge-${mc}-${loaderVersion}-installer.jar`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            ctx.progress(5, `Downloading Forge installer ${mc}-${loaderVersion}`);
            const url = forge.installerUrl(mc, loaderVersion);
            const sha1 = (await fetchText(`${url}.sha1`).catch(() => '')).trim().slice(0, 40);
            if (!/^[0-9a-f]{40}$/i.test(sha1)) ctx.log('No checksum published for this installer; continuing without one.');
            await downloadFile(url, installer, { hashes: /^[0-9a-f]{40}$/i.test(sha1) ? { sha1 } : {}, maxBytes: 64 * 1024 * 1024 });

            ctx.progress(20, 'Running the Forge installer (downloads libraries; this can take a few minutes)');
            await this.runProcess(ctx, plan.java.path, ['-jar', installer, '--installServer', stagingDir], tmpDir);

            const winArgs = forge.findWinArgs(stagingDir, mc, loaderVersion);
            if (!winArgs) throw new OperationError('The Forge installer did not produce win_args.txt.', { code: 'FORGE_LAYOUT' });
            if (!fs.existsSync(path.join(stagingDir, 'user_jvm_args.txt'))) {
                fs.writeFileSync(path.join(stagingDir, 'user_jvm_args.txt'), '# Memory is set by MC Manager.\n');
            }
            return { type: 'argsfile', argsFiles: ['user_jvm_args.txt', winArgs] };
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    runProcess(ctx, command, args, cwd) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
            let tail = '';
            let lines = 0;
            const onData = (chunk) => {
                const text = chunk.toString();
                tail = (tail + text).slice(-4000);
                for (const line of text.split(/\r?\n/)) {
                    if (!line.trim()) continue;
                    lines += 1;
                    // The installer prints thousands of patch lines; keep the job log readable.
                    if (!/^\s*Patching /.test(line)) ctx.log(line.trim());
                }
                ctx.progress(Math.min(80, 20 + lines / 40));
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);
            const timer = setTimeout(() => {
                child.kill();
                reject(new OperationError('The Forge installer timed out.', { code: 'FORGE_TIMEOUT' }));
            }, FORGE_INSTALL_TIMEOUT_MS);
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new OperationError(`The Forge installer failed (exit ${code}): ${tail.slice(-500)}`, { code: 'FORGE_FAILED' }));
            });
        });
    }

    /**
     * Moves the staged install into the server folder. Replaced files and stale
     * loader files go to backupDir. On failure everything is put back.
     */
    swapIn(ctx, stagingDir, serverDir, backupDir) {
        const staged = fs.readdirSync(stagingDir).filter((name) => !PROTECTED_ENTRIES.has(name));
        const existing = fs.readdirSync(serverDir);
        const toBackup = existing.filter((name) => !PROTECTED_ENTRIES.has(name)
            && (staged.includes(name) || isLoaderArtifact(name)));

        const backedUp = [];
        const movedIn = [];
        try {
            for (const name of toBackup) {
                fs.mkdirSync(backupDir, { recursive: true });
                fs.renameSync(path.join(serverDir, name), path.join(backupDir, name));
                backedUp.push(name);
            }
            for (const name of staged) {
                fs.renameSync(path.join(stagingDir, name), path.join(serverDir, name));
                movedIn.push(name);
            }
            if (backedUp.length) ctx.log(`Previous loader files moved to ${backupDir}`);
        } catch (error) {
            for (const name of movedIn) fs.rmSync(path.join(serverDir, name), { recursive: true, force: true });
            for (const name of backedUp) fs.renameSync(path.join(backupDir, name), path.join(serverDir, name));
            throw error;
        }
    }

    writeConfiguration(plan) {
        const serverDir = this.config.SERVER_DIR;
        writeFileAtomic(
            path.join(serverDir, 'eula.txt'),
            `# Accepted through MC Manager on ${new Date().toISOString()} (https://aka.ms/MinecraftEULA)\neula=true\n`
        );

        const current = readPropertiesFile(this.config.PROPERTIES_FILE) || {};
        const updates = {
            'enable-rcon': 'true',
            'rcon.port': current['rcon.port'] || '25575',
            'broadcast-rcon-to-ops': current['broadcast-rcon-to-ops'] || 'false',
        };
        if (!current['rcon.password'] || current['rcon.password'].length < 16) {
            updates['rcon.password'] = crypto.randomBytes(24).toString('hex');
        }
        if (!current.motd) updates.motd = `Minecraft ${plan.minecraftVersion} (${plan.loader})`;
        updatePropertiesFile(this.config.PROPERTIES_FILE, updates);
    }

    /** Updates memory or Java for the installed profile. */
    async updateProfile({ memory, javaPath } = {}) {
        const profile = this.state.get().profile;
        if (!profile) throw new OperationError('No server is installed.', { code: 'MINECRAFT_NOT_CONFIGURED', status: 404 });
        const next = { ...profile, memory: { ...profile.memory } };

        if (memory) {
            const min = String(memory.min || profile.memory.min).toUpperCase();
            const max = String(memory.max || profile.memory.max).toUpperCase();
            if (!/^\d+[MG]$/.test(min) || !/^\d+[MG]$/.test(max) || parseMemory(min) > parseMemory(max)) {
                throw invalid('Memory must look like 2G or 2048M, and the minimum cannot exceed the maximum.');
            }
            if (parseMemory(max) > os.totalmem() - 2 * 1024 ** 3) throw invalid('Maximum memory must leave at least 2 GB for Windows.');
            next.memory = { min, max };
        }

        if (javaPath) {
            const runtimes = await detectJava({ extraCandidates: [javaPath, ...this.javaCandidates()] });
            const java = runtimes.find((runtime) => runtime.path.toLowerCase() === path.resolve(String(javaPath)).toLowerCase());
            if (!java) throw invalid('The selected Java runtime was not found.');
            if (java.major < profile.requiredJavaMajor) {
                throw invalid(`Minecraft ${profile.minecraftVersion} needs Java ${profile.requiredJavaMajor} or newer.`);
            }
            next.javaPath = java.path;
            next.javaMajor = java.major;
        }

        this.state.update((draft) => {
            draft.profile = next;
        });
        return next;
    }
}

module.exports = { ServerInstaller, isLoaderArtifact, PROTECTED_ENTRIES };
