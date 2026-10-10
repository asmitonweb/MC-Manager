const express = require('express');
const fs = require('fs');
const { readPropertiesFile, updatePropertiesFile } = require('../lib/properties');
const { OperationError } = require('../lib/operations');

module.exports = ({ config, auth, state, minecraft, operations, players, shutdownManager }) => {
    const router = express.Router();
    const { requireAuth, requireAdmin } = auth;

    router.post('/login', (req, res) => {
        if (!config.AUTH_CONFIGURED) {
            return res.status(503).json({ error: 'Manager authentication is not configured' });
        }

        const { password } = req.body || {};
        const role = password === config.ADMIN_PASSWORD ? 'admin' : password === config.USER_PASSWORD ? 'user' : null;
        if (!role) return res.status(401).json({ error: 'Invalid password' });

        res.cookie('auth_token', auth.sign(role), { httpOnly: true, sameSite: 'strict' });
        res.json({ success: true, role });
    });

    router.post('/logout', (req, res) => {
        res.clearCookie('auth_token');
        res.json({ success: true });
    });

    router.get('/check-auth', requireAuth, (req, res) => {
        res.json({ authenticated: true, role: req.user.role });
    });

    router.get('/properties', requireAuth, requireAdmin, (req, res) => {
        const properties = readPropertiesFile(config.PROPERTIES_FILE);
        if (!properties) {
            return res.status(404).json({
                error: 'Minecraft server properties are not configured',
                code: 'MINECRAFT_NOT_CONFIGURED',
            });
        }
        res.json(properties);
    });

    router.post('/properties', requireAuth, requireAdmin, (req, res) => {
        if (!fs.existsSync(config.PROPERTIES_FILE)) {
            return res.status(404).json({
                error: 'Minecraft server properties are not configured',
                code: 'MINECRAFT_NOT_CONFIGURED',
            });
        }

        const updates = {};
        for (const [key, value] of Object.entries(req.body || {})) {
            const text = String(value ?? '');
            if (!/^[\w.-]+$/.test(key) || /[\r\n]/.test(text)) {
                throw new OperationError(`Invalid property: ${key}`, { code: 'INVALID_PROPERTY' });
            }
            updates[key] = text;
        }
        updatePropertiesFile(config.PROPERTIES_FILE, updates);
        res.json({ success: true });
    });

    const statusPayload = () => ({
        status: minecraft.refreshStatus(),
        minecraftConfigured: minecraft.isConfigured(),
        propertiesConfigured: fs.existsSync(config.PROPERTIES_FILE),
        operation: operations.snapshot(),
    });

    // Active world and version for the dashboard header.
    const summary = () => {
        const s = state.get();
        const world = s.worlds.find((entry) => entry.id === s.activeWorldId);
        return {
            world: world ? world.name : null,
            version: s.profile ? `${s.profile.loader === 'forge' ? 'Forge' : 'Fabric'} ${s.profile.minecraftVersion}` : null,
        };
    };

    router.get('/status', (req, res) => {
        res.json({
            ...statusPayload(),
            service: 'RUNNING',
            manager: 'RUNNING',
            players: players.count(),
            ...summary(),
        });
    });

    router.get('/health', (req, res) => {
        const status = statusPayload();
        res.json({
            ok: true,
            manager: 'RUNNING',
            minecraft: status.status,
            minecraftConfigured: status.minecraftConfigured,
            propertiesConfigured: status.propertiesConfigured,
        });
    });

    router.get('/ping', (req, res) => res.send('pong'));

    router.get('/jobs', requireAuth, requireAdmin, (req, res) => {
        res.json(operations.listJobs({ active: req.query.active === '1' }));
    });

    router.get('/jobs/:id', requireAuth, requireAdmin, (req, res) => {
        const job = operations.getJob(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    });

    router.post('/supervisor/shutdown', (req, res) => {
        if (!config.SUPERVISOR_CONFIGURED || req.get('x-manager-supervisor-token') !== config.SUPERVISOR_TOKEN) {
            return res.status(401).json({ error: 'Supervisor authentication failed' });
        }
        res.json({ accepted: true });
        shutdownManager();
    });

    return router;
};
