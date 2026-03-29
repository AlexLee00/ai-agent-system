'use strict';

const env = require('../../../packages/core/lib/env');

function authMiddleware(req, res, next) {
  const configured = String(env.HUB_AUTH_TOKEN || '').trim();
  if (!configured) {
    return res.status(503).json({ error: 'hub_auth_not_configured' });
  }

  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token || token !== configured) {
    return res.status(401).json({ error: 'invalid_bearer_token' });
  }

  return next();
}

module.exports = {
  authMiddleware,
};
