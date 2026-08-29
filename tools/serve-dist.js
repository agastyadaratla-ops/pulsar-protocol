'use strict';
/*
 * Serve dist/ the way GitHub Pages will, so you can check a build before you
 * push it: a different origin from the game server, under a project subpath.
 *
 *   node tools/serve-dist.js            -> http://localhost:4181/pulsar-protocol/
 *   node tools/serve-dist.js 5000 demo  -> http://localhost:5000/demo/
 *
 * Point it at a running game server with ?server=ws://localhost:4180
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 4181;
const BASE = '/' + (process.argv[3] || 'pulsar-protocol').replace(/^\/|\/$/g, '') + '/';
const ROOT = path.join(__dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};

if (!fs.existsSync(ROOT)) {
  console.error('dist/ does not exist — run: npm run build:pages');
  process.exit(1);
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(BASE)) {
    res.writeHead(302, { Location: BASE });
    res.end();
    return;
  }
  let rel = url.slice(BASE.length) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found: ' + rel); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`\n  static build (Pages simulation)`);
  console.log(`  http://localhost:${PORT}${BASE}`);
  console.log(`  with a server:  http://localhost:${PORT}${BASE}?server=ws://localhost:4180\n`);
});
