// The git layer, against real temporary repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, require, ENV, fingerprint } from './helpers.mjs';

const { openRepository, loadHistory, resolveRef } = require('../dist/git/repository.js');
const { ObjectStore, MAX_PATCH_LINES } = require('../dist/git/objects.js');
const E = require('../dist/core/engine.js');

// the CLI's git calls must not see the developer's config either
Object.assign(process.env, { HOME: ENV.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: ENV.GIT_CONFIG_GLOBAL });

async function model(dir, o) {
  const repo = await openRepository(dir);
  return { repo, m: E.buildModel(await loadHistory(repo, o)) };
}

test('linear history: every commit with its parent, author and time', async () => {
  const r = makeRepo('linear');
  const hashes = [];
  for (let i = 1; i <= 5; i++) { r.write('f.txt', 'v' + i + '\n'); hashes.push(r.commit('step ' + i)); }
  const { repo, m } = await model(r.dir);
  assert.equal(repo.name, path.basename(r.dir));
  assert.equal(m.list.length, 5);
  for (let i = 1; i < 5; i++) assert.deepEqual(m.commits.get(hashes[i]).parents, [hashes[i - 1]]);
  assert.equal(m.commits.get(hashes[0]).parents.length, 0);
  assert.equal(m.head.hash, hashes[4]);
  assert.equal(m.headBranch, 'main');
  assert.equal(m.commits.get(hashes[2]).authorName, 'Ada Tester');
  assert.ok(m.commits.get(hashes[3]).committerTime > m.commits.get(hashes[2]).committerTime);
});

test('branches, a merge and tags (annotated and lightweight)', async () => {
  const r = makeRepo('merge');
  r.write('a', '1'); const base = r.commit('base');
  r.git(['switch', '-q', '-c', 'feature/x']);
  r.write('b', '1'); const f1 = r.commit('feature one');
  r.git(['switch', '-q', 'main']);
  r.write('c', '1'); const m1 = r.commit('main moves on');
  r.git(['merge', '-q', '--no-ff', '-m', 'Merge branch feature/x', 'feature/x'], { GIT_AUTHOR_DATE: '@1767700000 +0000', GIT_COMMITTER_DATE: '@1767700000 +0000' });
  r.git(['tag', 'v1.0']);
  r.git(['tag', '-a', 'v1.1', '-m', 'release one point one', base]);
  const { m } = await model(r.dir);
  const merge = m.commits.get(m.head.hash);
  assert.deepEqual(merge.parents, [m1, f1]);
  const names = m.refs.map((x) => x.name).sort();
  assert.deepEqual(names, ['refs/heads/feature/x', 'refs/heads/main', 'refs/tags/v1.0', 'refs/tags/v1.1']);
  const v11 = m.refs.find((x) => x.name === 'refs/tags/v1.1');
  assert.equal(v11.target, base, 'annotated tags point at the peeled commit');
  assert.equal(v11.annotated, true);
  const L = E.layout(m, {});
  assert.equal(L.lanes, 2);
  assert.equal(await resolveRef((await openRepository(r.dir)), 'feature/x'), f1);
  assert.equal(await resolveRef((await openRepository(r.dir)), 'no-such-branch'), null);
  assert.equal(await resolveRef((await openRepository(r.dir)), '--all'), null, 'never passes an option through');
});

test('detached HEAD and an empty repository', async () => {
  const r = makeRepo('detached');
  r.write('a', '1'); const first = r.commit('one');
  r.write('a', '2'); r.commit('two');
  r.git(['checkout', '-q', first]);
  const { m } = await model(r.dir);
  assert.equal(m.head.detached, true);
  assert.equal(m.head.hash, first);
  assert.ok(m.refs.some((x) => x.kind === 'head'));
  const empty = makeRepo('empty');
  const { m: e } = await model(empty.dir);
  assert.equal(e.head.unborn, true);
  assert.equal(e.list.length, 0);
});

test('working tree status: staged, modified, untracked', async () => {
  const r = makeRepo('status');
  r.write('a', '1').write('b', '1'); r.commit('init');
  r.write('a', 'changed');
  r.write('b', 'staged'); r.git(['add', 'b']);
  r.write('new.txt', 'x');
  const { m } = await model(r.dir);
  assert.equal(m.status.branch, 'main');
  assert.equal(m.status.modified, 1);
  assert.equal(m.status.staged, 1);
  assert.equal(m.status.untracked, 1);
});

test('unusual paths, multiline messages, non-ASCII authors and escape codes in subjects', async () => {
  const r = makeRepo('odd');
  r.write('space name.txt', '1').write('ünïcödé/日本語.md', '1').write('tab\there.txt', '1');
  const h = r.commit('Zoë: fix ünïcode \x1b[31mred\x1b[0m\n\nfirst body line\nsecond body line', { author: 'Zoë Lindqvist' });
  const { repo, m } = await model(r.dir);
  const c = m.commits.get(h);
  assert.equal(c.authorName, 'Zoë Lindqvist');
  assert.equal(c.subject, 'Zoë: fix ünïcode \x1b[31mred\x1b[0m', 'stored as git has it');
  assert.equal(c.body, 'first body line\nsecond body line');
  assert.ok(!/\x1b/.test(E.sanitize(c.subject)), 'shown sanitised');
  const store = new ObjectStore(repo, () => null, () => {});
  const files = await store.loadFiles(h);
  assert.deepEqual(files.map((f) => f.path).sort(), ['space name.txt', 'tab\there.txt', 'ünïcödé/日本語.md']);
});

test('changed files and patches load on demand: renames, binaries, big patches cut short', async () => {
  const r = makeRepo('objects');
  r.write('old-name.txt', 'line\n'.repeat(20)).write('big.txt', 'x\n');
  const first = r.commit('first');
  fs.renameSync(path.join(r.dir, 'old-name.txt'), path.join(r.dir, 'new-name.txt'));
  r.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 255]));
  r.write('big.txt', Array.from({ length: 2000 }, (_, i) => 'line ' + i).join('\n') + '\n');
  const second = r.commit('second');
  const { repo, m } = await model(r.dir);
  let changes = 0;
  const store = new ObjectStore(repo, (h) => (m.commits.get(h).parents[0] || null), () => changes++, 5);
  assert.equal(store.filesFor(second).status, 'loading');
  await new Promise((res) => { const t = setInterval(() => { if (changes) { clearInterval(t); res(); } }, 5); });
  const got = store.filesFor(second);
  assert.equal(got.status, 'ready');
  const byPath = Object.fromEntries(got.files.map((f) => [f.path, f]));
  assert.equal(byPath['new-name.txt'].st, 'R');
  assert.equal(byPath['new-name.txt'].old, 'old-name.txt');
  assert.equal(byPath['logo.png'].bin, true);
  assert.equal(byPath['logo.png'].newSize, 11);
  assert.equal(byPath['big.txt'].ins, 2000);
  assert.equal(byPath['big.txt'].del, 1);
  const patch = await store.loadPatch(second, 'big.txt');
  assert.equal(patch.truncated, true);
  assert.ok(patch.text.split('\n').length <= MAX_PATCH_LINES);
  const root = await store.loadFiles(first);
  assert.deepEqual(root.map((f) => f.st), ['A', 'A'], 'the first commit is compared with nothing');
  store.dispose();
});

test('a shallow clone loads, with its boundary marked', async () => {
  const r = makeRepo('deep');
  for (let i = 0; i < 5; i++) { r.write('f', String(i)); r.commit('c' + i); }
  const clone = r.dir + '-shallow';
  r.git(['clone', '-q', '--depth', '2', 'file://' + r.dir, clone]);
  const { repo, m } = await model(clone);
  assert.equal(repo.shallow, true);
  assert.equal(m.list.length, 2);
  assert.ok(m.list.some((c) => c.shallow));
  const L = E.layout(m, {});
  assert.equal(L.nodes.length, 2);
});

test('limits: --max-count, --since and --until', async () => {
  const r = makeRepo('limits');
  const times = [];
  for (let i = 0; i < 10; i++) { r.write('f', String(i)); r.commit('c' + i); times.push(Number(r.git(['log', '-1', '--format=%ct']))); }
  const iso = (t) => new Date(t * 1000).toISOString();
  assert.equal((await model(r.dir, { maxCount: 4 })).m.list.length, 4);
  assert.equal((await model(r.dir, { maxCount: 4 })).m.meta.truncated, true);
  assert.equal((await model(r.dir, { since: iso(times[6]) })).m.list.length, 4);
  assert.equal((await model(r.dir, { until: iso(times[2]) })).m.list.length, 3);
});

test('reading a repository never changes it', async () => {
  const r = makeRepo('readonly');
  r.write('a', '1'); r.commit('one');
  r.write('a', '2'); const h = r.commit('two');
  r.write('a', 'dirty'); r.write('untracked', 'u');
  const gitDir = path.join(r.dir, '.git');
  const before = fingerprint(gitDir);
  const { repo, m } = await model(r.dir);
  const store = new ObjectStore(repo, (x) => (m.commits.get(x).parents[0] || null), () => {});
  await store.loadFiles(h);
  await store.loadPatch(h, 'a');
  assert.equal(fingerprint(gitDir), before);
});

test('errors: not a repository, a missing directory, a missing git', async () => {
  const notRepo = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'gt-plain-'));
  await assert.rejects(openRepository(notRepo), /not a git repository/);
  await assert.rejects(openRepository(notRepo + '-nope'), /no such directory/);
  const saved = process.env.GIT_TIMELINE_GIT;
  process.env.GIT_TIMELINE_GIT = path.join(notRepo, 'no-git-here');
  try {
    await assert.rejects(openRepository(notRepo), /git is not installed/);
  } finally {
    if (saved === undefined) delete process.env.GIT_TIMELINE_GIT; else process.env.GIT_TIMELINE_GIT = saved;
  }
});
