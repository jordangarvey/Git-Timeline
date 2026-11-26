// Runs every test/**/*.test.mjs with Node's built-in test runner (works on Node 18+,
// where `node --test <dir>` and glob arguments behave differently between versions).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = new URL('../test/', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'fixtures') walk(p);
    else if (e.name.endsWith('.test.mjs')) files.push(p);
  }
})(root);
files.sort();
const only = process.argv.slice(2);
const pick = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;
const r = spawnSync(process.execPath, ['--test', ...pick], { stdio: 'inherit', env: { ...process.env, TZ: process.env.TZ || 'Europe/London' } });
process.exit(r.status ?? 1);
