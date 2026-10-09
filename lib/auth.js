const jwt = require('jsonwebtoken');

const parseCookieHeader = (header) => {
    const cookies = {};
    for (const part of (header || '').split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const name = part.slice(0, index).trim();
        if (!name) continue;
        try {
            cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
        } catch {
            cookies[name] = part.slice(index + 1).trim();
        }
    }
    return cookies;
};

const createAuth = (secret) => {
    const verify = (token) => {
        if (!token) return null;
        try {
            return jwt.verify(token, secret);
        } catch {
            return null;
        }
    };

    const requireAuth = (req, res, next) => {
        const token = req.cookies.auth_token;
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const user = verify(token);
        if (!user) return res.status(401).json({ error: 'Invalid token' });
        req.user = user;
        next();
    };

    const requireAdmin = (req, res, next) => {
        if (req.user && req.user.role === 'admin') return next();
        res.status(403).json({ error: 'Forbidden' });
    };

    const sign = (role) => jwt.sign({ role }, secret, { expiresIn: '24h' });

    return { verify, sign, requireAuth, requireAdmin };
};

// Wraps an async route handler so rejected promises reach the error middleware.
const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

module.exports = { createAuth, parseCookieHeader, asyncHandler };
