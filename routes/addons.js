const express = require('express');
const { asyncHandler } = require('../lib/auth');

// Every route works on the active setup, or on a parked one given ?setupId= / body.setupId.
module.exports = ({ auth, addons, setups }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);
    const pick = (req) => (setups ? setups.addonsFor(req.body?.setupId || req.query.setupId) : addons);

    router.get('/providers', (req, res) => res.json(addons.providerStatus()));

    router.get('/search', asyncHandler(async (req, res) => {
        res.json(await pick(req).search({
            provider: String(req.query.provider || 'modrinth'),
            query: req.query.q,
            offset: req.query.offset,
            sort: req.query.sort,
        }));
    }));

    router.get('/installed', (req, res) => res.json(pick(req).installed()));

    router.get('/updates', asyncHandler(async (req, res) => res.json(await pick(req).updates())));

    router.get('/:provider/:projectId/versions', asyncHandler(async (req, res) => {
        res.json(await pick(req).versions(req.params.provider, req.params.projectId));
    }));

    router.post('/install/preview', asyncHandler(async (req, res) => res.json(await pick(req).preview(req.body || {}))));

    router.post('/install', asyncHandler(async (req, res) => res.status(202).json(await pick(req).install(req.body || {}))));

    router.post('/update', asyncHandler(async (req, res) => res.status(202).json(await pick(req).update(req.body || {}))));

    router.post('/uninstall', (req, res) => res.status(202).json(pick(req).uninstall(req.body || {})));

    router.post('/identify', (req, res) => res.status(202).json(pick(req).identify()));

    return router;
};
