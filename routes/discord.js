const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, discord }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/', asyncHandler(async (req, res) => {
        res.json({ ...discord.publicView(), suggested: await discord.defaults() });
    }));

    router.put('/', asyncHandler(async (req, res) => {
        res.json(await discord.update(req.body || {}));
    }));

    router.post('/sync', asyncHandler(async (req, res) => {
        await discord.sync({ force: Boolean(req.body?.force) });
        res.json(discord.publicView());
    }));

    router.post('/regenerate-link', (req, res) => {
        res.json(discord.regenerateLink());
    });

    return router;
};
