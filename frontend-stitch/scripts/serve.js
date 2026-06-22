// Minimal static dev server for the Stitch SPA (no build step). Proxies /api/*
// to the QYRVIA backend so the SPA can call the real endpoints in development.
//
//   node scripts/serve.js            # serves on :5180, proxies /api -> :3001
//   PORT=8080 API=http://localhost:3001 node scripts/serve.js

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = Number(process.env.PORT) || 5180;
const API = process.env.API || 'http://localhost:3001';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const target = new URL(req.url, API);
    const proxied = await fetch(target, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req }).catch(() => null);
    if (!proxied) { res.writeHead(502).end('backend unreachable'); return; }
    res.writeHead(proxied.status, Object.fromEntries(proxied.headers));
    res.end(Buffer.from(await proxied.arrayBuffer()));
    return;
  }
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (_) {
    // SPA fallback to index.html for client routes
    try { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(await readFile(join(ROOT, 'index.html'))); }
    catch (e) { res.writeHead(404).end('not found'); }
  }
});

server.listen(PORT, () => console.log('[stitch] http://localhost:' + PORT + ' (api -> ' + API + ')'));
