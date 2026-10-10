const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, systemInfo }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/', asyncHandler(async (req, res) => res.json(await systemInfo.view())));
    router.post('/disk', asyncHandler(async (req, res) => res.json(await systemInfo.diskUsage(true))));

    return router;
};
