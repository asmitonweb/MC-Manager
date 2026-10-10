const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, mapControl }) => {
    const router = express.Router();
    router.use(auth.requireAuth);

    router.get('/', (req, res) => res.json(mapControl.view()));
    router.post('/enable', auth.requireAdmin, asyncHandler(async (req, res) => res.status(202).json(await mapControl.enable())));
    router.post('/disable', auth.requireAdmin, (req, res) => res.status(202).json(mapControl.disable()));
    router.post('/render', auth.requireAdmin, asyncHandler(async (req, res) => res.json(await mapControl.renderNow())));

    return router;
};
