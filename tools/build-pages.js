'use strict';
/*
 * Build a static bundle for GitHub Pages into dist/.
 *
 * Two things the Express server does at runtime have to be baked in here:
 *   - it mounts shared/ at /shared and three's build dir at /vendor
 *   - it serves from the domain root, so absolute paths work
 *
 * Pages serves a project site from https://user.github.io/<repo>/, so every
 * absolute path in index.html would resolve above the site root and 404. This
 * copies the two mounted directories in and rewrites those paths to relative.
 *
 *   node tools/build-pages.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });

// 1. the client itself
copyDir(path.join(ROOT, 'public'), OUT);

// 2. the shared tables, normally mounted at /shared
fs.mkdirSync(path.join(OUT, 'shared'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'shared', 'weapons.js'), path.join(OUT, 'shared', 'weapons.js'));

// 3. three.js, normally mounted at /vendor from node_modules
const threeBuild = path.join(ROOT, 'node_modules', 'three', 'build');
if (!fs.existsSync(threeBuild)) {
  console.error('three is not installed — run: npm install');
  process.exit(1);
}
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
for (const f of ['three.module.min.js', 'three.core.min.js']) {
  fs.copyFileSync(path.join(threeBuild, f), path.join(OUT, 'vendor', f));
}

// 4. absolute -> relative, so a project subpath works
const indexPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const before = html;
html = html
  .replace(/"\/vendor\//g, '"./vendor/')
  .replace(/src="\/shared\//g, 'src="shared/');
if (html === before) console.warn('warning: no absolute paths were rewritten — check index.html');
fs.writeFileSync(indexPath, html);

// 5. tell Pages not to run Jekyll over it
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// 6. bake in a default server if one was supplied
const server = process.env.PP_SERVER || '';
if (server) {
  const cfg = path.join(OUT, 'js', 'config.js');
  fs.writeFileSync(cfg,
    fs.readFileSync(cfg, 'utf8').replace(/server:\s*''/, `server: ${JSON.stringify(server)}`));
  console.log(`baked in server: ${server}`);
}

// --- report -------------------------------------------------------------
let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(OUT);

const leftover = fs.readFileSync(indexPath, 'utf8').match(/(?:src|href)="\/[^"]*"/g);
if (leftover) {
  console.error('absolute paths remain, these will 404 on a project site:', leftover);
  process.exit(1);
}

console.log(`\ndist/ built — ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
if (!server) {
  console.log('\nNo server baked in. Players can enter one on the deploy screen,');
  console.log('or you can set it at build time:');
  console.log('  PP_SERVER=wss://your-server.onrender.com node tools/build-pages.js');
}
console.log();
