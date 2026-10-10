const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, roster }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/', (req, res) => res.json(roster.view()));
    router.post('/action', asyncHandler(async (req, res) => res.json(await roster.act(req.body || {}))));
    router.put('/whitelist', asyncHandler(async (req, res) => res.json(await roster.setWhitelist(Boolean(req.body?.enabled)))));

    return router;
};
