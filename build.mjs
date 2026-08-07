/**
 * Builds the deployable client into ./public by minifying the readable sources
 * in ./client. Minifying does not make the code secret - a determined person
 * can still recover it - but it strips comments and names so the served files
 * are not casually readable, and it keeps the maintainable source out of what
 * ships. The real protections are server-side: every rule is enforced by the
 * Worker, and no secret ever reaches the browser.
 */

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

// Clean known outputs rather than the whole directory - on Windows the folder
// can be held open by a running `wrangler dev`, and removing it would fail.
mkdirSync('public', { recursive: true });
for (const f of ['index.html', 'admin.html', 'app.js', 'admin.js', 'style.css']) {
  rmSync(`public/${f}`, { force: true });
}

// HTML is copied as-is; it references /app.js, /admin.js and /style.css by name.
for (const file of ['index.html', 'admin.html']) {
  cpSync(`client/${file}`, `public/${file}`);
}

await build({
  entryPoints: ['client/app.js', 'client/admin.js'],
  outdir: 'public',
  minify: true,
  bundle: false,
  legalComments: 'none',
  target: 'es2020',
});

await build({
  entryPoints: ['client/style.css'],
  outdir: 'public',
  minify: true,
  loader: { '.css': 'css' },
});

console.log('Built minified client -> public/');
