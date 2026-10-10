const { OperationError } = require('./operations');

/**
 * Activates worlds across setups. A world may run on its own version or a
 * newer one (Minecraft upgrades it; a backup is taken first), never an older one.
 */
class WorldSwitcher {
    constructor({ worlds, setups, backups, operations, minecraft, listReleases }) {
        this.worlds = worlds;
        this.setups = setups;
        this.backups = backups;
        this.operations = operations;
        this.minecraft = minecraft;
        this.listReleases = listReleases;
    }

    /** -1 if a is older than b, 0 if equal, 1 if newer, null if unknown. */
    async compareVersions(a, b) {
        if (!a || !b) return null;
        if (a === b) return 0;
        let releases;
        try {
            releases = (await this.listReleases()).map((release) => release.id);
        } catch {
            return null;
        }
        // Mojang lists newest first.
        const ia = releases.indexOf(a);
        const ib = releases.indexOf(b);
        if (ia === -1 || ib === -1) return null;
        return ia > ib ? -1 : 1;
    }

    worldVersion(world) {
        return this.worlds.levelInfo(world.id)?.versionName || world.minecraftVersion || null;
    }

    /** Describes what running `world` on `setupId` would mean. */
    async check(world, setupId) {
        const setup = this.setups.get(setupId);
        const from = this.worlds.levelInfo(world.id) ? this.worldVersion(world) : null;
        const to = setup.minecraftVersion;
        const order = await this.compareVersions(from, to);
        return {
            from,
            to,
            needsUpgrade: order === -1,
            blocked: order === 1,
            unknown: Boolean(from) && order === null,
        };
    }

    assertAllowed(world, result, confirmUpgrade) {
        if (result.blocked) {
            throw new OperationError(
                `"${world.name}" was last saved on Minecraft ${result.from}, which is newer than ${result.to}. Minecraft cannot downgrade worlds.`,
                { code: 'WORLD_TOO_NEW', status: 409 }
            );
        }
        if (result.needsUpgrade && confirmUpgrade !== true) {
            const error = new OperationError(
                `"${world.name}" will be upgraded from Minecraft ${result.from} to ${result.to}. This cannot be undone; a backup is taken first.`,
                { code: 'UPGRADE_CONFIRMATION_REQUIRED', status: 409 }
            );
            error.details = result;
            throw error;
        }
    }

    /** Moves a world to another setup (it is upgraded the next time it runs). */
    async moveToSetup(id, setupId, { confirmUpgrade } = {}) {
        const world = this.worlds.get(id);
        if (this.minecraft.isRunning() && this.worlds.activeId() === id) {
            throw new OperationError('Stop the server before changing the version of the active world.', { code: 'SERVER_RUNNING', status: 409 });
        }
        const result = await this.check(world, setupId);
        this.assertAllowed(world, result, confirmUpgrade);
        if (this.worlds.activeId() === id && setupId !== this.setups.activeId()) {
            // The active world's setup changes: switch now so the server matches.
            return this.activate(id, { confirmUpgrade, setupId });
        }
        this.worlds.setSetup(id, setupId);
        return { world: this.worlds.get(id) };
    }

    /**
     * Makes a world active, switching setups if needed. Returns { world } when
     * done immediately, or { job } for a switch that runs in the background.
     */
    async activate(id, { confirmUpgrade, setupId } = {}) {
        const world = this.worlds.get(id);
        const targetSetup = setupId || world.setupId || this.setups.activeId();
        this.worlds.assertStopped('switch worlds');
        const result = targetSetup ? await this.check(world, targetSetup) : { needsUpgrade: false, blocked: false };
        this.assertAllowed(world, result, confirmUpgrade);

        const switching = targetSetup && targetSetup !== this.setups.activeId();
        if (!switching && !result.needsUpgrade) {
            return { world: await this.operations.runExclusive('world.switch', async () => this.worlds.activate(id)) };
        }

        const job = this.operations.startJob('world.switch', async (ctx) => {
            if (result.needsUpgrade) {
                ctx.progress(5, `Backing up "${world.name}" before upgrading it to ${result.to}`);
                await this.backups.createBackup({ ...ctx, progress: (p, step) => ctx.progress(5 + p * 0.8, step) }, world, 'pre-upgrade');
            }
            if (switching) {
                const setup = this.setups.get(targetSetup);
                ctx.progress(90, `Switching the server to ${setup.loader} ${setup.minecraftVersion}`);
                this.setups.switchTo(targetSetup);
            }
            this.worlds.setSetup(id, targetSetup);
            this.worlds.activate(id);
            return { worldId: id, setupId: targetSetup };
        }, { worldId: id, setupId: targetSetup });
        return { job };
    }
}

module.exports = { WorldSwitcher };
