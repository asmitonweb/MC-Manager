const express = require('express');
const { asyncHandler } = require('../lib/auth');

module.exports = ({ auth, backups }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/', (req, res) => {
        res.json(backups.list({ worldId: req.query.worldId ? String(req.query.worldId) : undefined }));
    });

    router.post('/', (req, res) => {
        res.status(202).json(backups.backup({ worldId: req.body?.worldId, note: req.body?.note }));
    });

    router.post('/:id/restore', (req, res) => {
        res.status(202).json(backups.restore(req.params.id, { mode: req.body?.mode, newName: req.body?.newName }));
    });

    router.post('/:id/verify', asyncHandler(async (req, res) => {
        res.json(await backups.verify(req.params.id));
    }));

    router.delete('/:id', (req, res) => {
        res.json(backups.remove(req.params.id));
    });

    router.get('/:id/download', (req, res) => {
        const meta = backups.get(req.params.id);
        res.download(backups.fileFor(meta), `${meta.id}.zip`);
    });

    return router;
};
