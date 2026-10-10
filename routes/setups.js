const express = require('express');

module.exports = ({ auth, setups }) => {
    const router = express.Router();
    router.use(auth.requireAuth, auth.requireAdmin);

    router.get('/', (req, res) => {
        res.json({ activeSetupId: setups.activeId(), setups: setups.list() });
    });

    router.delete('/:id', (req, res) => {
        setups.remove(req.params.id);
        res.json({ removed: req.params.id });
    });

    return router;
};
