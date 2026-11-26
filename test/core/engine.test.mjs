import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('../../src/core/engine.js');

const DAY = 86400;
const T0 = 1780000000;

// ---------------------------------------------------------------- helpers
function mk({ commits, refs = {}, head, def = 'main', tags = {} }) {
  const recs = [{ kind: 'meta', defaultBranch: def }];
  const mainTarget = refs.main;
  recs.push(head ? { kind: 'head', ...head } : { kind: 'head', hash: mainTarget ?? null, ref: mainTarget ? 'refs/heads/main' : 'refs/heads/main', detached: false, unborn: !mainTarget });
  for (const [n, t] of Object.entries(refs)) recs.push({ kind: 'ref', name: n.startsWith('refs/') ? n : 'refs/heads/' + n, target: t, targetType: 'commit' });
  for (const [n, t] of Object.entries(tags)) recs.push({ kind: 'ref', name: 'refs/tags/' + n, target: t, targetType: 'commit' });
  for (const [h, p, t, s, b] of commits) recs.push({ kind: 'commit', h, p, an: 'A', ae: 'a@example.com', at: t, ai: '', cn: 'A', ce: 'a@example.com', ct: t, ci: '', s: s || h, b: b || '' });
  return E.buildModel(recs);
}

// Structural guarantees every layout must satisfy.
function invariants(m, L) {
  for (let i = 1; i < L.nodes.length; i++) assert.ok(L.nodes[i].x > L.nodes[i - 1].x, 'columns strictly increase');
  for (const n of L.nodes) {
    for (const p of m.commits.get(n.h).parents) if (L.vis.has(p)) assert.ok(L.xOf.get(p) < n.x, 'parent left of child');
  }
  for (let l = 0; l < L.lanes; l++) {
    const ms = (L.members[l] || []).slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < ms.length; i++) assert.ok(ms[i - 1].end + 2 <= ms[i].start, 'paths sharing lane ' + l + ' do not overlap');
  }
  const nodeAt = new Map(L.nodes.map((n) => [n.x, n]));
  for (const s of L.segs) {
    if (s.t === 'v') {
      const n = nodeAt.get(s.col);
      assert.ok(n, 'every vertical sits in a commit column');
      for (let r = s.r1 + 1; r < s.r2; r++) assert.notEqual(2 * n.lane, r, 'vertical does not run through its own node');
    } else {
      for (const n of E.nodesIn(L, s.x1 + 1, s.x2 - 1)) {
        if (2 * n.lane !== s.row) continue;
        const segChain = L.chains.find((c) => c.lane * 2 === s.row && c.start <= s.x1 && s.x2 <= c.end);
        assert.ok(segChain && L.chainOf.get(n.h) === segChain.id, 'horizontal connector only passes nodes of its own path');
      }
    }
  }
  let links = 0;
  for (const n of L.nodes) for (const p of m.commits.get(n.h).parents) if (L.vis.has(p)) links++;
  for (const arr of L.virt.values()) links += arr.length;
  assert.equal(L.edges.length, links, 'one edge per parent link');
}

function lin(prefix, n, t, step = DAY, first = []) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([prefix + i, i === 0 ? first : [prefix + (i - 1)], t + i * step]);
  return out;
}

// ---------------------------------------------------------------- tests
test('linear history uses one lane and real time spacing', () => {
  const m = mk({ commits: lin('a', 5, T0), refs: { main: 'a4' } });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.lanes, 1);
  assert.deepEqual(L.nodes.map((n) => n.x), [4, 5, 6, 7, 8].map((x, i) => E.PAD_LEFT + i * 2 > x ? E.PAD_LEFT + i * 2 : x));
  assert.ok(L.edges.every((e) => e.kind === 'chain'));
  const sparse = mk({ commits: [['a0', [], T0], ['a1', ['a0'], T0 + 30 * DAY]], refs: { main: 'a1' } });
  const L2 = E.layout(sparse, { sec: DAY });
  assert.equal(L2.xOf.get('a1') - L2.xOf.get('a0'), 30, 'a 30-day gap is 30 columns at 1 day per column');
});

test('commit-indexed layout (world view): every commit gets an equal slot, same order and lanes', () => {
  const m = E.buildModel(require('../fixtures/history-main.json'));
  const T0 = E.layout(m, {});
  const L = E.layout(m, { spacing: 12, pad: 12 });
  assert.equal(L.nodes.length, 77);
  L.nodes.forEach((n, i) => assert.equal(n.x, 12 + 12 * i));
  assert.deepEqual(L.order, T0.order, 'same time-respecting order as the graph');
  for (const e of L.edges) assert.ok(L.xOf.get(e.to) < L.xOf.get(e.from), 'parents before children');
  assert.equal(L.chains.find((c) => c.primary).lane, 0);
});

test('split and merge: fork goes down, merge comes back up', () => {
  const m = mk({
    commits: [['a', [], T0], ['b', ['a'], T0 + DAY], ['f1', ['b'], T0 + 2 * DAY], ['c', ['b'], T0 + 3 * DAY], ['f2', ['f1'], T0 + 4 * DAY], ['M', ['c', 'f2'], T0 + 5 * DAY, "Merge branch 'feature/x'"]],
    refs: { main: 'M' },
  });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.lanes, 2);
  const feat = L.chains[L.chainOf.get('f1')];
  assert.equal(feat.name, 'feature/x');
  assert.equal(feat.inferred, true, 'deleted branch name is inferred from the merge subject');
  const kinds = L.edges.map((e) => e.from + '>' + e.to + ':' + e.kind).sort();
  assert.ok(kinds.includes('f1>b:fork'));
  assert.ok(kinds.includes('M>f2:merge'));
  assert.ok(kinds.includes('M>c:chain'));
  const v = L.segs.filter((s) => s.t === 'v').map((s) => s.col).sort((a, b) => a - b);
  assert.deepEqual(v, [L.xOf.get('b'), L.xOf.get('M')], 'verticals at the fork parent and the merge commit');
});

test('parallel feature branches reuse lanes once merged', () => {
  const commits = lin('m', 40, T0);
  const refs = { main: 'm39' };
  // three concurrent branches, then two later branches that start after the first three merged
  const add = (name, from, startDay, len, mergeAt) => {
    for (let i = 0; i < len; i++) commits.push([name + i, [i === 0 ? 'm' + from : name + (i - 1)], T0 + (startDay + i) * DAY + 3600]);
    const mi = commits.findIndex((c) => c[0] === 'm' + mergeAt);
    commits[mi] = ['m' + mergeAt, ['m' + (mergeAt - 1), name + (len - 1)], commits[mi][2], "Merge branch '" + name + "'"];
  };
  add('p', 2, 3, 4, 9); add('q', 3, 4, 4, 10); add('r', 4, 5, 4, 11);
  add('s', 20, 21, 3, 26); add('t', 28, 29, 3, 34);
  const m = mk({ commits, refs });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.lanes, 4, 'main + three concurrent branches');
  const lane = (h) => L.nodes[L.idx.get(h)].lane;
  assert.equal(lane('s0'), 1, 'later branch reuses the lane next to main');
  assert.equal(lane('t0'), 1);
});

test('octopus merge has one incoming connector per parent', () => {
  const m = mk({
    commits: [['a', [], T0], ['x1', ['a'], T0 + DAY], ['y1', ['a'], T0 + DAY + 60], ['z1', ['a'], T0 + DAY + 120], ['O', ['a', 'x1', 'y1', 'z1'], T0 + 2 * DAY, "Merge branches 'x', 'y' and 'z'"]],
    refs: { main: 'O' },
  });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.edges.filter((e) => e.from === 'O' && e.kind === 'merge').length, 3);
  assert.deepEqual(['x1', 'y1', 'z1'].map((h) => L.chains[L.chainOf.get(h)].name), ['x', 'y', 'z'], 'names mapped by parent position');
  assert.equal(L.lanes, 4);
});

test('several refs on one commit share one path and one label', () => {
  const m = mk({ commits: lin('a', 3, T0), refs: { main: 'a2', 'refs/remotes/origin/main': 'a2', 'release/1': 'a2' }, tags: { v1: 'a2' } });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.shown.length, 1);
  assert.match(L.shown[0].label, /^HEAD → main, /);
  assert.match(L.shown[0].label, /origin\/main/);
  assert.match(L.shown[0].label, /release\/1/);
  assert.doesNotMatch(L.shown[0].label, /v1/, 'tags go on the tag rail, not in the label');
});

test('detached HEAD on a commit no branch contains gets its own path', () => {
  const m = mk({
    commits: [...lin('a', 3, T0), ['d1', ['a1'], T0 + 5 * DAY]],
    refs: { main: 'a2' },
    head: { hash: 'd1', ref: null, detached: true, unborn: false },
  });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  const ch = L.chains[L.chainOf.get('d1')];
  assert.equal(ch.kind, 'head');
  assert.equal(ch.label, 'HEAD (detached)');
  assert.equal(L.primary.name, 'main');
});

test('equal timestamps never share a column and order is deterministic', () => {
  const commits = [['r', [], T0]];
  for (let i = 0; i < 9; i++) commits.push(['e' + i, ['r'], T0 + DAY]);
  commits.push(['M', ['r', 'e0', 'e1', 'e2'], T0 + DAY]);
  const refs = { main: 'M' };
  for (let i = 3; i < 9; i++) refs['b' + i] = 'e' + i;
  const m1 = mk({ commits, refs });
  const m2 = mk({ commits: commits.slice().reverse(), refs });
  const L1 = E.layout(m1, { sec: DAY });
  const L2 = E.layout(m2, { sec: DAY });
  invariants(m1, L1);
  assert.equal(new Set(L1.nodes.map((n) => n.x)).size, L1.nodes.length);
  assert.deepEqual(L1.nodes.map((n) => [n.h, n.x, n.lane]), L2.nodes.map((n) => [n.h, n.x, n.lane]), 'input order does not matter');
});

test('a child dated before its parent is drawn after it and flagged', () => {
  const m = mk({ commits: [['a', [], T0], ['b', ['a'], T0 + 5 * DAY], ['c', ['b'], T0 + 2 * DAY], ['d', ['c'], T0 + 6 * DAY]], refs: { main: 'd' } });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.ok(L.xOf.get('c') > L.xOf.get('b'));
  assert.ok(L.skew.has('c') && !L.skew.has('d'));
  assert.equal(m.commits.get('c').committerTime, T0 + 2 * DAY, 'timestamps are not rewritten');
});

test('empty repository', () => {
  const m = E.buildModel([{ kind: 'meta' }, { kind: 'head', hash: null, ref: 'refs/heads/main', detached: false, unborn: true }, { kind: 'status', branch: 'main' }]);
  const L = E.layout(m, { sec: DAY, now: T0 });
  assert.equal(L.nodes.length, 0);
  assert.equal(L.lanes, 0);
  assert.ok(Number.isFinite(E.colAt(L, T0)));
});

test('disconnected roots get separate lanes and no connecting edges', () => {
  const m = mk({ commits: [...lin('a', 4, T0), ...lin('s', 3, T0 + DAY / 2)], refs: { main: 'a3', site: 's2' } });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  assert.equal(L.lanes, 2);
  assert.ok(!L.edges.some((e) => (e.from[0] === 's') !== (e.to[0] === 's')));
  assert.equal(L.chains[L.chainOf.get('s0')].leftStub, false, 'a real root has no continuation stub');
});

test('a long-running branch keeps one lane while short branches come and go', () => {
  const commits = lin('m', 60, T0);
  for (let i = 0; i < 6; i++) commits.push(['x' + i, [i === 0 ? 'm1' : 'x' + (i - 1)], T0 + (2 + i * 10) * DAY + 7200]);
  const refs = { main: 'm59', 'experiment/long': 'x5' };
  for (let k = 0; k < 5; k++) {
    const s = 5 + k * 10;
    commits.push(['f' + k, ['m' + s], T0 + (s + 1) * DAY + 3600]);
    const mi = commits.findIndex((c) => c[0] === 'm' + (s + 3));
    commits[mi] = ['m' + (s + 3), ['m' + (s + 2), 'f' + k], commits[mi][2], "Merge branch 'f" + k + "'"];
  }
  const m = mk({ commits, refs });
  const L = E.layout(m, { sec: DAY });
  invariants(m, L);
  const lanes = new Set(['x0', 'x1', 'x2', 'x3', 'x4', 'x5'].map((h) => L.nodes[L.idx.get(h)].lane));
  assert.equal(lanes.size, 1);
  assert.equal(L.lanes, 3);
});

test('date range: stubs at the boundary, dashed edges through hidden commits', () => {
  const m = mk({ commits: [['a', [], T0], ['b', ['a'], T0 + 10 * DAY], ['c', ['b'], T0 + 20 * DAY], ['d', ['c'], T0 + 1 * DAY], ['e', ['d'], T0 + 21 * DAY]], refs: { main: 'e' } });
  const L = E.layout(m, { sec: DAY, since: T0 + 5 * DAY });
  invariants(m, L);
  assert.deepEqual(L.nodes.map((n) => n.h), ['b', 'c', 'e']);
  assert.ok(L.chains[L.chainOf.get('b')].leftStub, 'b continues into hidden history');
  const dashed = L.edges.filter((e) => e.dash).map((e) => e.from + '>' + e.to);
  assert.deepEqual(dashed, ['e>c'], 'e reaches c through the hidden, clock-skewed d');
});

test('branch filter: hiding a merged branch keeps its commits, named from the merge', () => {
  const m = mk({
    commits: [['a', [], T0], ['f1', ['a'], T0 + DAY], ['b', ['a'], T0 + 2 * DAY], ['M', ['b', 'f1'], T0 + 3 * DAY, "Merge branch 'feat'"]],
    refs: { main: 'M', feat: 'f1' },
  });
  const shownRef = E.layout(m, { sec: DAY });
  assert.equal(shownRef.chains[shownRef.chainOf.get('f1')].inferred, false);
  const L = E.layout(m, { sec: DAY, hidden: new Set(['refs/heads/feat']) });
  invariants(m, L);
  assert.equal(L.nodes.length, 4);
  assert.equal(L.chains[L.chainOf.get('f1')].name, 'feat');
  assert.equal(L.chains[L.chainOf.get('f1')].inferred, true);
  const onlyFeat = E.layout(m, { sec: DAY, hidden: new Set(['refs/heads/main']) });
  assert.deepEqual(onlyFeat.nodes.map((n) => n.h), ['a', 'f1'], 'hiding main shows only what feat reaches');
});

test('shallow boundary and missing parents get continuation stubs', () => {
  const recs = [{ kind: 'meta', defaultBranch: 'main', shallow: true }, { kind: 'head', hash: 'c', ref: 'refs/heads/main' }, { kind: 'ref', name: 'refs/heads/main', target: 'c' },
    { kind: 'commit', h: 'b', p: [], at: T0, ct: T0, s: 'b', shallow: true }, { kind: 'commit', h: 'c', p: ['b', 'gone'], at: T0 + DAY, ct: T0 + DAY, s: 'c' }];
  const m = E.buildModel(recs);
  const L = E.layout(m, { sec: DAY });
  assert.ok(L.chains[L.chainOf.get('b')].leftStub);
  assert.ok(L.markers.some((mk2) => mk2.kind === 'hidden-parent' && mk2.hash === 'c'));
  assert.deepEqual(m.commits.get('c').missing, ['gone']);
});

test('time axis: anchors map both ways, labels follow the local calendar across DST', () => {
  const m = mk({ commits: lin('a', 40, Date.UTC(2026, 9, 10) / 1000, DAY), refs: { main: 'a39' } });
  const L = E.layout(m, { sec: DAY });
  for (const n of L.nodes) {
    const t = m.commits.get(n.h).committerTime;
    assert.equal(E.colAt(L, t), n.x);
    assert.equal(E.timeAt(L, n.x), t);
  }
  const days = E.boundaries('day', Date.UTC(2026, 9, 24) / 1000, Date.UTC(2026, 9, 27) / 1000);
  if (process.env.TZ === 'Europe/London') {
    // first local midnight after 24 Oct 00:00 UTC is 25 Oct 00:00 BST; that day lasts 25 hours
    assert.deepEqual(days.map((t) => (t - days[0]) / 3600), [0, 25, 49], '25 Oct 2026 is a 25-hour day in London');
  }
  for (let i = 1; i < days.length; i++) {
    const d = new Date(days[i] * 1000);
    assert.equal(d.getHours() + d.getMinutes(), 0, 'local midnight');
  }
});

test('untrusted text is neutralised and measured in terminal cells', () => {
  assert.equal(E.sanitize('a\x1b[31mred\x1b[0m'), 'a␛[31mred␛[0m');
  assert.equal(E.sanitize('csi\x9b2J'), 'csi�2J');
  assert.equal(E.sanitize('rlo' + String.fromCharCode(0x202e) + 'evil'), 'rlo�evil');
  assert.equal(E.sanitize('new\nline\ttab'), 'new␊line␉tab');
  assert.equal(E.sanitize('keep\nlines', { newlines: 'keep', tabs: 2 }), 'keep\nlines');
  assert.equal(E.sanitize('Zoë'), 'Zoë');
  assert.equal(E.width('名前'), 4);
  assert.equal(E.width('🐛 fix'), 6);
  assert.equal(E.width('é'), 1);
  assert.equal(E.truncate('feature/very-long-name', 10), 'feature/v…');
  assert.equal(E.truncate('日本語のREADME', 7), '日本語…');
  assert.equal(E.truncateLeft('src/timeline/layout.ts', 12), '…e/layout.ts');
  assert.deepEqual(E.wrap('one two three four', 9), ['one two', 'three', 'four']);
});

test('merge subject parsing', () => {
  assert.equal(E.inferBranchName("Merge branch 'feature/x'", 1), 'feature/x');
  assert.equal(E.inferBranchName("Merge branch 'main' into feature/x", 1), 'main');
  assert.equal(E.inferBranchName("Merge branches 'a', 'b' and 'c'", 3), 'c');
  assert.equal(E.inferBranchName('Merge pull request #12 from someone/fix-thing', 1), 'fix-thing');
  assert.equal(E.inferBranchName('Fix the thing', 1), null);
});

test('large synthetic history: layout is fast, deterministic and valid', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const N = 50000;
  const commits = [];
  const open = [];
  let t = T0;
  let mainTip = null;
  const refs = {};
  for (let i = 0; i < N; i++) {
    t += Math.floor(rnd() * 4 * 3600);
    const h = 'c' + i;
    const r = rnd();
    if (!mainTip) { commits.push([h, [], t]); mainTip = h; continue; }
    if (r < 0.08 && open.length < 12) { commits.push([h, [mainTip], t]); open.push(h); continue; }
    if (r < 0.45 && open.length) { const k = Math.floor(rnd() * open.length); commits.push([h, [open[k]], t]); open[k] = h; continue; }
    if (r < 0.52 && open.length) { const k = Math.floor(rnd() * open.length); commits.push([h, [mainTip, open[k]], t, "Merge branch 'b" + i + "'"]); open.splice(k, 1); mainTip = h; continue; }
    commits.push([h, [mainTip], t]); mainTip = h;
  }
  refs.main = mainTip;
  open.forEach((h, k) => { refs['open/' + k] = h; });
  const m = mk({ commits, refs });
  const t1 = performance.now();
  const L = E.layout(m, { sec: 3600 });
  const ms = performance.now() - t1;
  const L2 = E.layout(m, { sec: 3600 });
  invariants(m, L);
  assert.equal(L.nodes.length, N);
  assert.deepEqual(L.nodes.map((n) => n.x + ':' + n.lane), L2.nodes.map((n) => n.x + ':' + n.lane));
  const t2 = performance.now();
  for (let x = 0; x < L.width; x += 2000) { E.segsIn(L, x, x + 160); E.nodesIn(L, x, x + 160); }
  const qms = (performance.now() - t2) / Math.ceil(L.width / 2000);
  console.log('# bench: ' + N + ' commits, ' + L.edges.length + ' edges, ' + L.lanes + ' lanes, width ' + L.width + ' cols: layout ' + ms.toFixed(0) + ' ms, viewport query ' + qms.toFixed(3) + ' ms');
  assert.ok(ms < 5000, 'layout of 50k commits under 5 s (took ' + ms.toFixed(0) + ' ms)');
});
