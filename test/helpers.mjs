// Temporary repositories for tests. Never touches the developer's own repositories or
// configuration: every git call gets a private HOME and no system or global config.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CLI = path.join(ROOT, 'dist', 'cli', 'main.js');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-home-'));
export const ENV = {
  ...process.env,
  HOME, XDG_CONFIG_HOME: HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(HOME, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Ada Tester', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Tester', GIT_COMMITTER_EMAIL: 'ada@example.com',
  TZ: 'Europe/London', LANG: 'C.UTF-8',
};
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'NO_COLOR', 'FORCE_COLOR', 'COLORTERM']) delete ENV[k];

let clock = Date.UTC(2026, 0, 5, 9, 0, 0) / 1000;

/** A fresh repository with a small helper API. */
export function makeRepo(name = 'repo') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-' + name + '-'));
  const run = (args, extra = {}) => execFileSync('git', args, { cwd: dir, env: { ...ENV, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run(['init', '-q']);
  const r = {
    dir,
    git: run,
    write(file, content) { const p = path.join(dir, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return r; },
    commit(message, opts = {}) {
      clock += opts.gap ?? 3600;
      const date = '@' + (opts.time ?? clock) + ' +0000';
      if (!opts.noAdd) run(['add', '-A']);
      run(['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...(opts.author ? { GIT_AUTHOR_NAME: opts.author } : {}) });
      return run(['rev-parse', 'HEAD']);
    },
    files() { return fs.readdirSync(dir); },
  };
  return r;
}

/** Runs the built CLI and returns { code, stdout, stderr }. */
export function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd || ROOT, env: { ...ENV, ...(opts.env || {}) }, encoding: 'utf8', input: opts.input ?? '' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file under .git with its size and modification time, to prove nothing changed. */
export function fingerprint(gitDir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const st = fs.statSync(p); out.push(path.relative(gitDir, p) + ' ' + st.size + ' ' + st.mtimeMs); }
    }
  })(gitDir);
  return out.sort().join('\n');
}
