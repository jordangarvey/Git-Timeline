import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { E, T, history, app } from './harness.mjs';
const require = createRequire(import.meta.url);
const WD = require('../../src/core/world.js');

const model = () => E.buildModel(history('main'));
const byRank = (m) => E.timeTopo(m, new Set(m.commits.keys())).order;
const nodeAt = (a) => a.L.nodes[a.L.idx.get(a.s.sel)];

test('sprite library is consistent: rectangular, painted, with ASCII fallbacks', () => {
  assert.deepEqual(WD.selfCheck(), []);
});

test('seven commits per age: the first is in the sea, the 77th reaches the far future', () => {
  const m = model(), order = byRank(m);
  const era = (n) => WD.eraOf(m, order[n - 1]).era.name;
  assert.equal(era(1), 'Primordial Sea');
  assert.equal(era(7), 'Primordial Sea');
  assert.equal(era(8), 'First Shores');
  assert.equal(era(25), 'Age of Dinosaurs');
  assert.equal(era(50), 'Middle Ages');
  assert.equal(era(71), 'Far Future');
  assert.equal(era(77), 'Far Future');
  assert.equal(WD.eraOf(m, m.head.hash).era.name, 'Far Future');
  assert.equal(WD.eraOfRank(5000), 10, 'bigger histories stay in the far future');
});

test('the world is the default view and fills the screen, with a commit box below', () => {
  const a = app('main');
  const scr = a.frame(130, 40);
  const g = a.geom();
  assert.equal(a.s.view, 'world');
  assert.equal(g.gutter, 0);
  assert.ok(g.tl.h >= 30, 'the world takes most of the screen');
  const txt = scr.toText();
  assert.match(txt, /Far Future · commit 77 of 77/);
  assert.match(txt, /docs: architecture notes for lane allocation/);
  assert.match(txt, /▸ Far Future/);
  assert.match(txt, /unwritten/, 'fog past HEAD');
  for (let y = g.tl.y; y < g.tl.y + g.tl.h; y++) for (let x = 0; x < 130; x++) assert.match(scr.st[y * 130 + x], /\b(wk|wg|x)\w+/, 'every world cell has its sky or ground');
});

test('a screen shows about seven commits; zoom changes that and keeps the selection in place', () => {
  const a = app('main');
  a.frame(140, 40);
  for (let i = 0; i < 30; i++) a.key('ArrowLeft');
  a.frame(140, 40);
  const shown = () => E.nodesIn(a.L, a.s.scrollX, a.s.scrollX + 139).filter((n) => n.lane === 0 || true).length;
  const near = (n) => { const xs = a.L.nodes.map((k) => k.x); return xs.filter((x) => x >= n && x < n + 140).length; };
  assert.ok(Math.abs(near(a.s.scrollX) - 7) <= 1, 'about 7 commits per screen, got ' + near(a.s.scrollX));
  const off = nodeAt(a).x - a.s.scrollX;
  a.key('['); a.frame(140, 40);
  assert.ok(near(a.s.scrollX) >= 9, 'zoomed out: more commits per screen');
  assert.equal(nodeAt(a).x - a.s.scrollX, off, 'selection stays put');
  a.key(']'); a.key(']'); a.frame(140, 40);
  assert.ok(near(a.s.scrollX) <= 5, 'zoomed in: fewer commits per screen');
  assert.ok(shown() > 0);
});

test('branches are trails: main is the lowest, every commit sits on its trail', () => {
  const a = app('main');
  for (let i = 0; i < 25; i++) a.key('ArrowLeft');
  const scr = a.frame(130, 40);
  const g = a.geom();
  const x0 = a.s.scrollX;
  let upper = 0;
  for (const n of E.nodesIn(a.L, x0, x0 + 129)) {
    if (n.lane < a.s.scrollY || n.lane >= a.s.scrollY + g.visLanes) continue;
    const y = g.yGround - (n.lane - a.s.scrollY) * g.gap;
    const d = scr.nd[y * 130 + n.x - x0];
    assert.ok(d && ['commit', 'merge', 'head', 'dim'].includes(d.k), 'commit drawn on its trail row');
    if (n.lane > 0) upper++;
  }
  assert.ok(upper > 0, 'some commits on trails above main');
  const head = a.L.nodes.find((n) => n.h === a.m.head.hash);
  assert.equal(head.lane, 0);
});

test('hills rise under trails above main', () => {
  const a = app('main');
  for (let i = 0; i < 25; i++) a.key('ArrowLeft');
  const scr = a.frame(130, 40);
  const g = a.geom(), x0 = a.s.scrollX;
  const y = g.yGround - g.gap;
  const near = new Set();
  for (const n of a.L.nodes) for (let d = -2; d <= 2; d++) near.add(n.x + d);
  let cols = 0, hill = 0;
  for (const seg of E.segsIn(a.L, x0, x0 + 129)) {
    if (seg.t !== 'h' || seg.row !== 2) continue;
    for (let x = Math.max(seg.x1 + 2, x0); x <= Math.min(seg.x2 - 2, x0 + 129); x++) {
      if (near.has(x)) continue;
      cols++;
      const i = (y + 1) * 130 + x - x0;
      if (/[█▓◢◣▲]/.test(scr.ch[i]) && /\bs[A-Z]/.test(scr.st[i])) hill++;
    }
  }
  assert.ok(cols > 10, 'a trail on lane 1 in view');
  assert.ok(hill / cols > 0.7, 'hill under the trail: ' + hill + '/' + cols);
});

test('the scenery is anchored to history, so it scrolls with the timeline', () => {
  const a = app('main');
  a.frame(130, 40);
  for (let i = 0; i < 40; i++) a.key('ArrowLeft');
  const g = a.geom();
  const grab = () => { const scr = a.frame(130, 40); const rows = []; for (let y = g.tl.y + 2; y < g.tl.y + g.tl.h; y++) rows.push(scr.ch.slice(y * 130, y * 130 + 130).join('')); return rows; };
  const A = grab();
  assert.deepEqual(grab(), A, 'same frame twice');
  a.s.scrollX += 10;
  const B = grab();
  for (let r = 0; r < A.length; r++) assert.equal(B[r].slice(30, 120), A[r].slice(40, 130), 'row ' + r);
});

test('filters never move a commit to another age', () => {
  const a = app('main');
  a.frame(130, 40);
  a.key('d');
  a.s.ovSel = a.ovItems().findIndex((r) => r.range.id.startsWith('since-'));
  a.key('Enter');
  const L = a.layout();
  assert.ok(L.nodes.length < 20);
  const ctx = WD.context(L, a.m, L.spacing);
  assert.equal(ctx.era(L.xOf.get(a.m.head.hash)), 10);
  assert.equal(WD.eraOf(a.m, a.m.head.hash).era.name, 'Far Future');
});

test('up and down move between trails as they appear on screen', () => {
  const a = app('main');
  a.frame(130, 40);
  a.key('ArrowUp');
  assert.equal(nodeAt(a).lane, 1, 'up goes to the trail above main');
  a.key('ArrowDown');
  assert.equal(nodeAt(a).lane, 0);
  a.key('ArrowDown');
  assert.match(a.s.msg.text, /No trail below/);
});

test('the journey runs from the first commit to HEAD, never backwards, and any key stops it', () => {
  const a = app('main');
  a.frame(130, 40);
  a.key('p');
  const L = a.layout();
  assert.equal(a.s.sel, L.nodes[0].h);
  let last = -1, steps = 0, moves = 0;
  while (a.s.tour && steps < 2000) {
    const x = L.xOf.get(a.s.sel);
    assert.ok(x >= last);
    if (x > last) moves++;
    last = x;
    a.tourStep();
    a.frame(130, 40);
    steps++;
  }
  assert.equal(a.s.sel, a.m.head.hash);
  if (L.xOf.get(a.s.sel) > last) moves++;
  assert.equal(moves, L.idx.get(a.m.head.hash) + 1, 'visits every commit up to HEAD');
  assert.match(a.s.msg.text, /Arrived at HEAD, in the Far Future/);
  a.key('p');
  a.key('ArrowRight');
  assert.equal(a.s.tour, null);
});

test('with motion on, the camera glides to the selection instead of jumping', () => {
  const a = app('main', { smooth: true });
  a.frame(130, 40);
  const start = a.s.camX;
  a.key('G');
  assert.notEqual(a.s.scrollX, start);
  let n = 0;
  while (a.animate()) { n++; a.frame(130, 40); assert.ok(n < 200); }
  assert.ok(n > 3, 'took several frames');
  assert.equal(a.s.camX, a.s.scrollX);
});

test('Enter opens the commit (the world makes room), Esc goes back', () => {
  const a = app('main');
  a.frame(130, 40);
  const h0 = a.geom().tl.h;
  a.key('Enter');
  assert.equal(a.s.focus, 'files');
  assert.ok(a.geom().tl.h < h0);
  assert.match(a.frame(130, 40).toText(), /Files 2/);
  a.key('Escape');
  assert.equal(a.geom().tl.h, h0);
});

test('v switches between the world and the graph, keeping the selection', () => {
  const a = app('main');
  a.frame(130, 40);
  for (let i = 0; i < 9; i++) a.key('ArrowLeft');
  const h = a.s.sel;
  a.key('v');
  const scr = a.frame(130, 40);
  assert.equal(a.s.view, 'graph');
  assert.equal(a.s.sel, h);
  assert.ok(a.geom().gutter > 0);
  assert.match(scr.toText(), /zoom \d+\w+\/col/);
  a.key('v');
  a.frame(130, 40);
  assert.equal(a.s.view, 'world');
  assert.equal(a.s.sel, h);
});

test('phone size: the world still fits, with the commit box', () => {
  const a = app('main');
  const scr = a.frame(56, 40);
  const g = a.geom();
  assert.ok(g.panel.h >= 4);
  assert.ok(g.visLanes >= 1);
  assert.ok(a.inView(nodeAt(a), g));
  assert.match(scr.toText(), /Far Future/);
});

test('the static snapshot draws the whole journey, and JSON names each commit\'s age', () => {
  const m = model();
  const txt = T.renderStatic(m, { unicode: true, color: false }).toText();
  for (const name of ['Primordial Sea', 'First Shores', 'Age of Dinosaurs', 'Ice Age', 'Ancient World', 'Middle Ages', 'Modern City', 'Far Future']) assert.ok(txt.includes(name), name);
  assert.equal(txt, T.renderStatic(model(), { unicode: true, color: false }).toText(), 'deterministic');
  const ascii = T.renderStatic(m, { unicode: false, color: true }).toText();
  assert.match(ascii, /^[\x20-\x7e\n]+$/);
  assert.match(T.renderStatic(m, { view: 'graph', color: false }).toText(), /1 column = 1 day/);
  const j = JSON.parse(T.renderJSON(m, {}));
  assert.equal(j.commits[0].era, 'Primordial Sea');
  assert.equal(j.commits.find((c) => c.hash === m.head.hash).era, 'Far Future');
});
