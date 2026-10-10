const fs = require('fs');
const path = require('path');
const { readPropertiesFile } = require('./properties');
const { OperationError } = require('./operations');

const BLUEMAP = 'swbUV1cr';
const IDLE_GRACE_MS = 60 * 1000;
const STATUS_INTERVAL_MS = 10 * 1000;

const stripColors = (text) => String(text || '').replace(/§./g, '').trim();

/**
 * BlueMap without idle cost: render threads run only while someone has the
 * map open, and stop a minute after the last viewer leaves. BlueMap's own web
 * server stays off; the manager serves its files. Each world gets its own map
 * folder, so switching worlds never mixes tiles.
 */
class MapControl {
    constructor({ config, state, minecraft, addons, timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.addons = addons;
        this.timers = timers;
        this.viewers = 0;
        this.rendering = false;
        this.idleTimer = null;
        this.statusTimer = null;
        this.lastStatus = '';
        this.onStatus = () => {};
        minecraft.on('rcon', () => this.prepare().catch((error) => console.error('BlueMap setup failed:', error.message)));
        minecraft.on('exit', () => this.reset());
    }

    installed() {
        return this.addons.manifest.get().mods.some((mod) => mod.projectId === BLUEMAP && fs.existsSync(path.join(this.addons.modsDir, mod.fileName)));
    }

    worldId() {
        return this.state.get().activeWorldId;
    }

    webRoot() {
        const id = this.worldId();
        return id ? path.join(this.config.SERVER_DIR, 'bluemap', id, 'web') : null;
    }

    view() {
        const root = this.webRoot();
        return {
            installed: this.installed(),
            ready: Boolean(root && fs.existsSync(path.join(root, 'index.html'))),
            running: Boolean(this.minecraft.rcon),
            rendering: this.rendering,
            viewers: this.viewers,
            status: this.lastStatus,
        };
    }

    enable() {
        if (this.installed()) throw new OperationError('BlueMap is already installed for this setup.', { code: 'ALREADY_INSTALLED' });
        return this.addons.install({ provider: 'modrinth', items: [{ projectId: BLUEMAP }] });
    }

    disable() {
        return this.addons.uninstall({ provider: 'modrinth', projectId: BLUEMAP });
    }

    /** Edits BlueMap's generated configs in place. Returns true if anything changed. */
    patchConfigs() {
        const dir = path.join(this.config.SERVER_DIR, 'config', 'bluemap');
        const id = this.worldId();
        if (!id || !fs.existsSync(dir)) return false;
        const level = (readPropertiesFile(this.config.PROPERTIES_FILE) || {})['level-name'] || 'world';
        const base = `bluemap/${id}/web`;
        let changed = false;
        const patch = (file, replacements) => {
            const full = path.join(dir, file);
            if (!fs.existsSync(full)) return;
            const before = fs.readFileSync(full, 'utf8');
            let after = before;
            for (const [pattern, value] of replacements) after = after.replace(pattern, value);
            if (after !== before) {
                fs.writeFileSync(full, after);
                changed = true;
            }
        };
        patch('core.conf', [
            [/^(\s*accept-download\s*:\s*)false/m, '$1true'],
            [/^(\s*render-thread-count\s*:\s*)-?\d+/m, '$11'],
            [/^(\s*metrics\s*:\s*)true/m, '$1false'],
        ]);
        patch('webserver.conf', [[/^(\s*enabled\s*:\s*)true/m, '$1false']]);
        patch('webapp.conf', [[/^(\s*webroot\s*:\s*)"[^"]*"/m, `$1"${base}"`]]);
        patch(path.join('storages', 'file.conf'), [[/^(\s*root\s*:\s*)"[^"]*"/m, `$1"${base}/maps"`]]);
        const maps = path.join(dir, 'maps');
        if (fs.existsSync(maps)) {
            for (const name of fs.readdirSync(maps).filter((file) => file.endsWith('.conf'))) {
                // Point every map at the active world (keeping a DIM-1/DIM1 suffix from older formats).
                patch(path.join('maps', name), [[/^(\s*world\s*:\s*)"[^"]*?((?:[\\/]DIM-?1)?)"/m, (m, key, dim) => `${key}"${level.replace(/\\/g, '/')}${dim}"`]]);
            }
        }
        return changed;
    }

    async command(text) {
        if (!this.minecraft.rcon) return null;
        try {
            return stripColors(await this.minecraft.sendCommand(text));
        } catch (error) {
            console.error(`BlueMap command "${text}" failed:`, error.message);
            return null;
        }
    }

    /** On every server start: fix configs, then pause rendering unless someone is watching. */
    async prepare() {
        if (!this.installed()) return;
        if (this.patchConfigs()) {
            await this.command('bluemap reload');
            // A reload restarts the render threads once it finishes.
            this.timers.setTimeout(() => this.applyViewers(), 15000);
        }
        await this.applyViewers();
    }

    reset() {
        this.rendering = false;
        this.timers.clearTimeout(this.idleTimer);
        this.timers.clearInterval(this.statusTimer);
        this.idleTimer = null;
        this.statusTimer = null;
    }

    async applyViewers() {
        if (!this.installed() || !this.minecraft.rcon) return;
        if (this.viewers > 0) {
            await this.command('bluemap start');
            this.rendering = true;
        } else {
            await this.command('bluemap stop');
            this.rendering = false;
        }
        this.onStatus(this.view());
    }

    /** Called with the map room's size whenever someone opens or closes the map. */
    setViewers(count) {
        const previous = this.viewers;
        this.viewers = count;
        if (count > 0) {
            this.timers.clearTimeout(this.idleTimer);
            this.idleTimer = null;
            if (!this.rendering) this.applyViewers();
            if (!this.statusTimer) {
                this.statusTimer = this.timers.setInterval(() => this.refreshStatus(), STATUS_INTERVAL_MS);
                this.refreshStatus();
            }
        } else if (previous > 0) {
            this.timers.clearInterval(this.statusTimer);
            this.statusTimer = null;
            this.idleTimer = this.timers.setTimeout(() => {
                this.idleTimer = null;
                if (this.viewers === 0) this.applyViewers();
            }, IDLE_GRACE_MS);
        }
    }

    async refreshStatus() {
        if (!this.installed() || !this.minecraft.rcon) return;
        const text = await this.command('bluemap');
        if (text !== null) this.lastStatus = text;
        this.onStatus(this.view());
    }

    async renderNow() {
        if (!this.minecraft.rcon) throw new OperationError('Start the server first.', { code: 'SERVER_NOT_RUNNING', status: 409 });
        const text = await this.command('bluemap update');
        this.refreshStatus();
        return { message: text };
    }

    /**
     * Serves the map files. Tiles and JSON are stored gzipped (name.gz) and sent
     * as-is with Content-Encoding: gzip; missing tiles answer 204 like BlueMap's
     * own web server.
     */
    serve(req, res) {
        const root = this.webRoot();
        if (!root || !fs.existsSync(root)) return res.status(404).send('The map is not ready yet.');
        let relative;
        try {
            relative = decodeURIComponent(req.path).replace(/^\/+/, '') || 'index.html';
        } catch {
            return res.status(400).end();
        }
        const file = path.resolve(root, relative);
        if (file !== root && !file.startsWith(root + path.sep)) return res.status(403).end();
        const send = (target, gzipped) => {
            res.set('Cache-Control', /\/live\/|settings\.json$/.test(relative) ? 'no-cache' : 'public, max-age=60');
            if (gzipped) {
                res.set('Content-Encoding', 'gzip');
                res.type(path.extname(file) || '.bin');
            }
            res.sendFile(target, { dotfiles: 'deny', headers: gzipped ? { 'Content-Encoding': 'gzip' } : {} }, (error) => {
                if (error && !res.headersSent) res.status(404).end();
            });
        };
        const stat = (target) => fs.promises.stat(target).then((s) => s.isFile(), () => false);
        stat(file).then((exists) => {
            if (exists) return send(file, false);
            return stat(`${file}.gz`).then((gz) => {
                if (gz) return send(`${file}.gz`, true);
                if (/^maps\/[^/]+\/tiles\//.test(relative)) return res.status(204).end();
                return res.status(404).end();
            });
        });
        return undefined;
    }
}

module.exports = { MapControl, BLUEMAP };
