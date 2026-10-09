const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, installer }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/install/options', asyncHandler(async (req, res) => {
        res.json(await installer.options());
    }));

    router.get('/install/versions', asyncHandler(async (req, res) => {
        res.json(await installer.versions(String(req.query.loader || '')));
    }));

    router.get('/install/loaders', asyncHandler(async (req, res) => {
        res.json(await installer.loaderVersions(String(req.query.loader || ''), String(req.query.mc || '')));
    }));

    router.post('/install/preview', asyncHandler(async (req, res) => {
        res.json(await installer.preview(req.body));
    }));

    router.post('/install', asyncHandler(async (req, res) => {
        res.status(202).json(await installer.install(req.body, req.user.role));
    }));

    router.get('/profile', (req, res) => {
        res.json({ profile: installer.state.get().profile });
    });

    router.patch('/profile', asyncHandler(async (req, res) => {
        res.json({ profile: await installer.updateProfile(req.body) });
    }));

    return router;
};
