const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, addons }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/providers', (req, res) => res.json(addons.providerStatus()));

    router.get('/search', asyncHandler(async (req, res) => {
        res.json(await addons.search({
            provider: String(req.query.provider || 'modrinth'),
            query: req.query.q,
            offset: req.query.offset,
            sort: req.query.sort,
        }));
    }));

    router.get('/installed', (req, res) => res.json(addons.installed()));

    router.get('/updates', asyncHandler(async (req, res) => res.json(await addons.updates())));

    router.get('/:provider/:projectId/versions', asyncHandler(async (req, res) => {
        res.json(await addons.versions(req.params.provider, req.params.projectId));
    }));

    router.post('/install/preview', asyncHandler(async (req, res) => res.json(await addons.preview(req.body || {}))));

    router.post('/install', asyncHandler(async (req, res) => res.status(202).json(await addons.install(req.body || {}))));

    router.post('/update', asyncHandler(async (req, res) => res.status(202).json(await addons.update(req.body || {}))));

    router.post('/uninstall', (req, res) => res.status(202).json(addons.uninstall(req.body || {})));

    router.post('/identify', (req, res) => res.status(202).json(addons.identify()));

    return router;
};
