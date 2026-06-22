'use strict';

const express = require('express');
const router  = express.Router();

const startedAt = Date.now();

// Health probes don't need tenant context.
router.use((req, _res, next) => { req._skipTenant = true; next(); });

router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptimeSec: Math.round((Date.now() - startedAt) / 100) / 10
  });
});

router.get('/ready', async (req, res) => {
  const db = req.app.get('db'); // app.set('db', dbClient) in app.js
  if (!db || typeof db.ping !== 'function') {
    return res.status(503).json({ db: 'down', error: 'db_client_unavailable' });
  }
  try {
    const ok = await db.ping();
    if (ok) return res.status(200).json({ db: 'ok' });
    return res.status(503).json({ db: 'down', error: 'ping_returned_false' });
  } catch (err) {
    return res.status(503).json({ db: 'down', error: err.message });
  }
});

module.exports = router;
