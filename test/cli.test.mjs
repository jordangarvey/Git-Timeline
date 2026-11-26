// The command line, run as a separate process like a user would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, cli, require, CLI, ROOT, ENV } from './helpers.mjs';

const pkg = require('../package.json');

function sampleRepo() {
  const r = makeRepo('cli');
  for (let i = 0; i < 9; i++) { r.write('f.txt', String(i)); r.commit('commit number ' + i); }
  r.git(['switch', '-q', '-c', 'feature/long-branch-name-that-keeps-going-and-going']);
  r.write('g.txt', 'x'); r.commit('feature work');
  r.git(['switch', '-q', 'main']);
  r.write('h.txt', 'y'); r.commit('evil subject \x1b]0;pwned\x07 \x1b[2J here');
  r.git(['tag', 'v0.1.0']);
  return r;
}
const R = sampleRepo();

test('--help and --version', () => {
  const h = cli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /^Usage: git-timeline \[options\] \[path\]/);
  for (const flag of ['--repo', '--since', '--until', '--max-count', '--branch', '--format', '--view', '--ascii', '--no-color', '--help', '--version']) assert.ok(h.stdout.includes(flag), flag);
  assert.equal(cli(['-h']).code, 0);
  const v = cli(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
});

test('bad options exit with status 2 and say why', () => {
  for (const [args, msg] of [
    [['--frobnicate'], /unknown option: --frobnicate/],
    [['--format', 'xml'], /--format expects interactive, ascii or json/],
    [['--since', 'banana'], /--since expects a date/],
    [['--max-count', '-3'], /--max-count needs a value|expects a whole number/],
    [['--view'], /--view needs a value/],
    [['--width', '5'], /at least 20/],
    [['a', 'b'], /unexpected argument: b/],
    [['--ascii=yes'], /does not take a value/],
  ]) {
    const r = cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, msg);
    assert.match(r.stderr, /Try 'git-timeline --help'/);
    assert.equal(r.stdout, '');
  }
});

test('a directory that is not a repository exits with status 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-norepo-'));
  const r = cli(['--format', 'ascii'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /git-timeline: not a git repository/);
  assert.equal(cli(['-C', path.join(dir, 'missing'), '--format', 'ascii']).code, 1);
  assert.match(cli(['--format', 'ascii', '--branch', 'nope', R.dir]).stderr, /no branch, tag or commit named "nope"/);
});

test('without a terminal it prints a snapshot instead of starting the interactive UI', () => {
  const r = cli([], { cwd: R.dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /snapshot, not interactive/);
  assert.ok(!r.stdout.includes('\x1b[?1049h'), 'no alternate screen');
  const i = cli(['--format', 'interactive'], { cwd: R.dir });
  assert.equal(i.code, 2);
  assert.match(i.stderr, /needs a terminal/);
});

test('the ascii snapshot: deterministic, sanitised, ages named, plain when piped', () => {
  const a = cli(['--format', 'ascii', '--width', '0', R.dir]);
  const b = cli(['--format', 'ascii', '--width', '0', R.dir]);
  assert.equal(a.code, 0);
  assert.equal(a.stdout.replace(/\d+ commits/, ''), b.stdout.replace(/\d+ commits/, ''), 'same output twice');
  assert.match(a.stdout, /11 commits/);
  assert.match(a.stdout, /Primordial Sea/);
  assert.match(a.stdout, /First Shores/);
  assert.ok(!a.stdout.includes('\x1b'), 'no escape sequences at all, including the ones in the commit subject');
  assert.ok(!a.stdout.includes('\x07'));
  const ascii = cli(['--format', 'ascii', '--ascii', '--width', '0', R.dir]);
  assert.match(ascii.stdout, /^[\x20-\x7e\n]+$/, 'pure ASCII');
  const graph = cli(['--format', 'ascii', '--view', 'graph', '--width', '0', R.dir]);
  assert.match(graph.stdout, /1 column = 1 day/);
  assert.match(graph.stdout, /feature\/long-branch/);
});

test('--width cuts the snapshot into bands; colour only when asked for', () => {
  const r = cli(['--format', 'ascii', '--width', '60', R.dir]);
  const lines = r.stdout.split('\n');
  assert.ok(lines.every((l) => [...l].length <= 60), 'every line fits');
  assert.ok(lines.filter((l) => l === '').length >= 2, 'bands separated by blank lines');
  const colour = cli(['--format', 'ascii', '--width', '80', R.dir], { env: { FORCE_COLOR: '3' } });
  assert.match(colour.stdout, /\x1b\[[0-9;]*38;2;\d+;\d+;\d+m/, '24-bit colour');
  assert.ok(!/\x1b\]/.test(colour.stdout), 'still nothing from the commit subject');
  const c256 = cli(['--format', 'ascii', '--width', '80', R.dir], { env: { FORCE_COLOR: '2' } });
  assert.match(c256.stdout, /\x1b\[[0-9;]*38;5;\d+m/);
  const none = cli(['--format', 'ascii', '--width', '80', R.dir], { env: { FORCE_COLOR: '3', NO_COLOR: '1' } });
  assert.ok(!none.stdout.includes('\x1b'), 'NO_COLOR wins');
  assert.ok(!cli(['--format', 'ascii', '--no-color', R.dir], { env: { FORCE_COLOR: '3' } }).stdout.includes('\x1b'));
});

test('json: every commit with its age, parents and layout', () => {
  const r = cli(['--format', 'json', R.dir]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.format, 'git-timeline/snapshot@1');
  assert.equal(j.commits.length, 11);
  assert.equal(j.commits[0].era, 'Primordial Sea');
  assert.equal(j.commits.find((c) => c.subject === 'feature work').era, 'First Shores');
  for (const c of j.commits) for (const p of c.parents) assert.ok(j.commits.some((x) => x.hash === p));
  assert.equal(JSON.parse(cli(['--format', 'json', '--max-count', '3', R.dir]).stdout).commits.length, 3);
});

test('history limits from the command line', () => {
  assert.match(cli(['--format', 'ascii', '--max-count', '4', R.dir]).stdout, /Showing the newest 4 commits/);
  const future = cli(['--format', 'ascii', '--since', '2099-01-01', R.dir]);
  assert.equal(future.code, 0);
  assert.match(future.stdout, /0 commits/);
});

test('the package has an executable entry with a shebang', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(src.startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.ok(fs.statSync(CLI).mode & 0o111);
  assert.equal(pkg.bin['git-timeline'], 'dist/cli/main.js');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin['git-timeline'])));
});

// Interactive mode in a real pseudo-terminal, where util-linux `script` is available.
const hasScript = process.platform === 'linux' && spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
function inTerminal(keys, args = []) {
  const cmd = [process.execPath, CLI, '--no-motion', ...args].map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
  // a shell feeds the keys after a pause, the way a person types
  const feeder = keys.map((k) => 'sleep 0.6; printf ' + "'" + k.replace(/'/g, "'\\''") + "'").join('; ');
  return spawnSync('sh', ['-c', '(' + feeder + ') | script -qfec "$0" /dev/null', cmd], { cwd: R.dir, env: { ...ENV, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, encoding: 'utf8', timeout: 20000 });
}

test('interactive: opens on the alternate screen and puts the terminal back on q', { skip: !hasScript && 'needs util-linux script' }, () => {
  const r = inTerminal(['l', 'q']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.includes('\x1b[?1049h'), 'entered the alternate screen');
  assert.ok(out.includes('\x1b[?25l'), 'hid the cursor');
  const tail = out.slice(out.lastIndexOf('\x1b[?1049l') - 40);
  assert.ok(out.lastIndexOf('\x1b[?1049l') > out.lastIndexOf('\x1b[?1049h'), 'left it');
  assert.ok(tail.includes('\x1b[?25h'), 'cursor back');
  assert.ok(tail.includes('\x1b[?1000l') && tail.includes('\x1b[?1006l'), 'mouse reporting off');
  assert.match(out, /commit 11 of 11/);
  assert.ok(!out.includes('\x1b]0;pwned'), 'the escape sequence in the commit subject never reached the terminal');
  assert.ok(!out.includes('\x07'), 'no bell either');
  assert.match(out, /pwned/, 'it is shown as text instead');
});

test('interactive: Ctrl+C quits cleanly too', { skip: !hasScript && 'needs util-linux script' }, () => {
  const r = inTerminal(['\x03']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.lastIndexOf('\x1b[?1049l') > r.stdout.lastIndexOf('\x1b[?1049h'));
});
