const express = require('express');
const { asyncHandler } = require('../lib/auth');
const { ClientSync } = require('../lib/client-sync');
const { OperationError } = require('../lib/operations');

const baseUrlOf = (discord, req) => (discord.settings().baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** Player-facing files, gated by the same unguessable token as the mod pack link. */
const publicRouter = ({ discord, clientSync }) => {
    const router = express.Router({ mergeParams: true });
    router.use((req, res, next) => {
        if (!discord.isValidToken(req.params.token)) return res.status(404).send('Not found');
        res.set('Cache-Control', 'no-store');
        next();
    });

    router.get('/manifest.json', asyncHandler(async (req, res) => res.json(await clientSync.manifest())));

    router.get('/sync.txt', asyncHandler(async (req, res) => {
        clientSync.recordClient(req.ip, req.get('x-mcm-agent'));
        res.type('text/plain; charset=utf-8').send(ClientSync.syncText(await clientSync.manifest()));
    }));

    router.get('/file/:setupId/:kind/:name', (req, res) => {
        const file = clientSync.resolveFile(req.params.setupId, req.params.kind, req.params.name);
        if (!file) return res.status(404).send('Not found');
        res.download(file, req.params.name);
    });

    router.get('/version/:setupId.json', asyncHandler(async (req, res) => {
        res.type('application/json; charset=utf-8').send((await clientSync.versionJson(req.params.setupId)).text);
    }));

    router.get('/agent/:fileName', (req, res) => {
        const agent = clientSync.agentInfo();
        if (!agent || req.params.fileName !== agent.fileName) return res.status(404).send('Not found');
        res.download(agent.file, agent.fileName);
    });

    router.get('/setup.ps1', (req, res) => {
        clientSync.recordClient(req.ip, 'setup');
        res.type('text/plain; charset=utf-8').send(clientSync.setupScript(baseUrlOf(discord, req), req.params.token));
    });

    router.get('/:name([\\w.-]+\\.cmd)', (req, res) => {
        res.set('Content-Disposition', `attachment; filename="${clientSync.brand().setupFile}"`);
        res.type('application/octet-stream').send(clientSync.setupCmd(baseUrlOf(discord, req), req.params.token));
    });

    return router;
};

/** Admin API for client extras and the players' setup link. */
const adminRouter = ({ auth, discord, clientSync }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    const view = async (req) => {
        const base = baseUrlOf(discord, req);
        const token = discord.packToken();
        const manifest = await clientSync.manifest();
        return {
            brand: manifest.brand,
            clientName: discord.settings().clientName || '',
            agentReady: Boolean(manifest.agent),
            setupUrl: `${base}/client/${token}/${manifest.brand.setupFile}`,
            setupCommand: clientSync.setupCommand(base, token),
            clients: clientSync.recentClients(),
            setups: manifest.setups.map((setup) => ({ ...setup, extras: clientSync.extrasOf(setup.id) })),
        };
    };

    router.get('/', asyncHandler(async (req, res) => res.json(await view(req))));

    router.put('/', asyncHandler(async (req, res) => {
        const name = String(req.body?.clientName ?? '').trim();
        if (name.length > 40 || /[\r\n]/.test(name)) throw new OperationError('Invalid launcher name.', { code: 'INVALID_SETTING' });
        discord.saveSettings({ clientName: name });
        discord.schedule();
        res.json(await view(req));
    }));

    router.get('/search', asyncHandler(async (req, res) => {
        res.json(await clientSync.search({
            setupId: String(req.query.setupId || ''),
            type: String(req.query.type || 'mod'),
            query: req.query.q,
            offset: req.query.offset,
        }));
    }));

    router.post('/preview', asyncHandler(async (req, res) => res.json(await clientSync.preview(req.body || {}))));
    router.post('/install', asyncHandler(async (req, res) => res.status(202).json(await clientSync.install(req.body || {}))));
    router.post('/remove', (req, res) => {
        res.json(clientSync.remove(req.body || {}));
        discord.schedule();
    });

    return router;
};

module.exports = { publicRouter, adminRouter };
