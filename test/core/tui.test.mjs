import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, T, history, app, graph, VIEWS } from './harness.mjs';

const text = (a, c, r) => a.frame(c, r).toText();
const find = (a, needle) => { a.s.search.input = needle; a.searchCommit(); return a.s.sel; };
const sel = (a) => a.m.commits.get(a.s.sel);

for (const view of VIEWS) test('the very first frame draws the timeline (' + view + ' view)', () => {
  const a = app('main', { view });
  const scr = a.frame(130, 40);
  assert.ok(scr.nd.some((d) => d && d.k === 'head'), 'HEAD node drawn on frame one');
  assert.ok(a.nodeHits.length > (view === 'world' ? 3 : 10));
});

test('renders every example at many sizes, in every display mode', () => {
  for (const v of ['main', 'detached', 'empty']) for (const [c, r] of [[30, 10], [40, 12], [56, 20], [56, 40], [80, 24], [130, 40], [220, 60]]) {
    for (const unicode of [true, false]) for (const color of [true, false]) for (const view of VIEWS) {
      const a = app(v, { unicode, color, view });
      const scr = a.frame(c, r);
      assert.equal(scr.ch.length, c * r);
      for (const k of ['ArrowLeft', 'ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'ArrowRight', 'Tab', '?', 'x', 'f', ' ', 'Escape', '[', ']', 'p', 'v', 'ArrowUp']) { a.key(k); a.frame(c, r); }
    }
  }
});

for (const view of VIEWS) test('ASCII mode draws without Unicode glyphs (' + view + ' view)', () => {
  const a = app('main', { unicode: false, view });
  const g = (a.frame(130, 40), a.geom());
  const rows = text(a, 130, 40).split('\n').slice(g.tl.y, g.tl.y + g.tl.h);
  for (const row of rows) assert.match(row, /^[\x20-\x7e]*$/, 'timeline and landscape are pure ASCII: ' + row);
  const s = T.renderStatic(a.m, { unicode: false, color: false, view }).toText();
  assert.match(s, /^[\x20-\x7e\n]+$/, 'static ASCII snapshot is pure ASCII');
});

for (const view of VIEWS) test('control characters in commit messages are shown, never emitted (' + view + ' view)', () => {
  const a = app('main', { view });
  find(a, 'sanitise');
  assert.match(sel(a).subject, /\x1b\[31m/, 'the fixture really contains ESC');
  const out = text(a, 130, 40);
  assert.ok(!out.includes('\x1b'));
  assert.match(out, /sanitise ␛\[31mcontrol␛\[0m sequences/);
  a.s.unicode = false;
  assert.match(text(a, 130, 40), /sanitise \^\[\[31mcontrol\^\[\[0m/);
  a.s.unicode = true;
  a.key('Enter'); a.key('Escape');
  find(a, 'unusual paths');
  a.key('Enter');
  const files = text(a, 130, 40);
  assert.match(files, /new␊line\.txt/, 'a newline in a path is visible');
  assert.match(files, /tab␉here\.txt/);
});

for (const view of VIEWS) test('no-colour mode keeps attributes and drops every colour class (' + view + ' view)', () => {
  const a = app('main', { color: false, view });
  const scr = a.frame(130, 40);
  for (const st of scr.st) assert.doesNotMatch(st, /\b(c\d|hd|ft|cur|ad|rm|hk|mt|wa|ac|mu|tg|sel|ln|ok|tt|tv|e\d+|ef|wk\w+|wg\w+|s[a-zA-Z]\d?|x[a-zA-Z]\d?)\b/);
  assert.ok(scr.st.some((st) => /\binv\b/.test(st)), 'selection still inverse');
  assert.ok(scr.st.some((st) => /\bb\b/.test(st)), 'bold still used');
});

for (const view of VIEWS) test('wide characters occupy two cells and keep rows aligned (' + view + ' view)', () => {
  const a = app('main', { view });
  find(a, '日本語');
  const scr = a.frame(100, 30);
  const y = scr.ch.findIndex((c, i) => c === '日' && scr.ch[i + 1] === '\0');
  assert.ok(y >= 0, 'continuation cell after a wide character');
  for (const line of scr.toText().split('\n')) assert.ok(E.width(line) <= 100);
});

for (const view of VIEWS) test('focus flow: timeline → files → diff → back (' + view + ' view)', () => {
  const a = app('main', { view });
  a.frame(130, 40);
  find(a, 'unusual paths');
  a.key('Enter'); assert.equal(a.s.focus, 'files');
  a.key('ArrowDown'); assert.equal(a.s.fileSel, 1);
  a.key('Enter'); assert.equal(a.s.focus, 'diff');
  assert.match(text(a, 130, 40), /fixture: a tab in the name/);
  a.key('Escape'); assert.equal(a.s.focus, 'files');
  a.key('Escape'); assert.equal(a.s.focus, 'timeline');
  a.key('Tab'); assert.equal(a.s.focus, 'files');
});

for (const view of VIEWS) test('big, binary and submodule patches are bounded and labelled (' + view + ' view)', () => {
  const a = app('main', { view });
  a.frame(130, 40);
  find(a, '2,000-commit');
  a.key('Enter'); a.key('Enter'); a.key('End');
  assert.match(text(a, 130, 40), /preview truncated: 400 of 2,008 lines shown/);
  a.key('Escape'); a.key('Escape');
  find(a, 'demo screenshot');
  a.key('Enter'); a.key('ArrowDown'); a.key('Enter');
  assert.match(text(a, 130, 40), /binary 0 B → 647 B/);
  a.key('Escape'); a.key('Escape');
  find(a, 'submodule');
  a.key('Enter'); a.key('ArrowDown'); a.key('Enter');
  assert.match(text(a, 130, 40), /Subproject commit 3b18e512/);
});

test('graph view: zoom keeps the selected commit at the same place on screen', () => {
  const a = graph('main');
  a.frame(130, 40);
  for (let i = 0; i < 20; i++) a.key('ArrowLeft');
  const before = a.L.xOf.get(a.s.sel) - a.s.scrollX;
  a.key(']'); a.frame(130, 40);
  assert.equal(a.L.xOf.get(a.s.sel) - a.s.scrollX, before);
  a.key('['); a.key('['); a.frame(130, 40);
  const g = a.geom(), n = a.L.nodes[a.L.idx.get(a.s.sel)];
  assert.ok(a.inView(n, g));
});

for (const view of VIEWS) test('resizing keeps the selection visible (' + view + ' view)', () => {
  const a = app('main', { view });
  a.frame(200, 50);
  for (let i = 0; i < 30; i++) a.key('ArrowLeft');
  const h = a.s.sel;
  for (const [c, r] of [[56, 40], [80, 24], [44, 30], [130, 40]]) {
    a.frame(c, r);
    assert.equal(a.s.sel, h);
    assert.ok(a.inView(a.L.nodes[a.L.idx.get(h)], a.geom()), c + 'x' + r);
  }
});

test('graph view: lane moves pick the nearest commit in the next lane', () => {
  const a = graph('main');
  a.frame(130, 40);
  a.key('ArrowDown');
  assert.equal(a.L.nodes[a.L.idx.get(a.s.sel)].lane, 1);
  a.key('ArrowUp');
  assert.equal(a.L.nodes[a.L.idx.get(a.s.sel)].lane, 0);
});

for (const view of VIEWS) test('branch filter and author filter (' + view + ' view)', () => {
  const a = app('main', { view });
  a.frame(130, 40);
  a.key('f');
  const first = a.ovItems().find((x) => !x.header);
  a.key(' ');
  assert.ok(a.s.hidden.has(first.ref.name));
  a.key('o'); a.key('Escape');
  assert.equal(a.L.reach.size < a.m.list.length, true, 'only history reachable from one ref');
  a.key('f'); a.key('a'); a.key('Escape');
  assert.equal(a.s.hidden.size, 0);
  a.key('a'); a.key('o'); a.key('Escape');
  const only = Array.from(a.s.authors)[0];
  for (let i = 0; i < 10; i++) { a.key('ArrowLeft'); assert.equal(sel(a).authorKey, only, 'navigation skips dimmed authors'); }
  assert.match(text(a, 130, 40), /·/, 'others are drawn dimmed');
});

for (const view of VIEWS) test('search: n goes back in time, N forward, both wrap (' + view + ' view)', () => {
  const a = app('main', { view });
  a.frame(130, 40);
  find(a, 'lane');
  const x = () => a.L.xOf.get(a.s.sel);
  const first = x();
  a.key('n'); assert.ok(x() < first);
  a.key('N'); assert.equal(x(), first);
  for (let i = 0; i < a.matches.length; i++) a.key('n');
  assert.equal(x(), first, 'wrapped all the way round');
  assert.ok(a.matches.every((h) => { const c = a.m.commits.get(h); return /lane/i.test(c.subject + c.body + c.authorName); }));
});

test('graph view: date range shows boundary stubs and counts', () => {
  const a = graph('main');
  a.frame(130, 40);
  a.key('d');
  const i = a.ovItems().findIndex((r) => r.range.id.startsWith('since-'));
  a.s.ovSel = i; a.key('Enter');
  const out = text(a, 130, 40);
  assert.match(out, /14 of 77 commits/, 'since the v0.2.0 commit itself (13 Oct 15:15)');
  assert.match(out, /‹┄┄/);
});

for (const view of VIEWS) test('detached HEAD, empty repository, quit and relaunch (' + view + ' view)', () => {
  assert.match(text(app('detached', { view }), 110, 30), /HEAD detached at b973ad8/);
  assert.match(text(app('detached', { view }), 110, 30), /HEAD \(detached\)/);
  assert.match(text(app('empty', { view }), 70, 20), /No commits yet\./);
  const a = app('main', { view });
  a.frame(80, 24);
  a.key('q');
  assert.match(text(a, 80, 24), /git-timeline exited/);
  a.key('x');
  assert.equal(a.s.exited, false);
  assert.match(text(a, 80, 24), /HEAD → main/);
});

test('non-interactive outputs are deterministic', () => {
  const m = E.buildModel(history('main'));
  const a1 = T.renderStatic(m, { unicode: true, color: false }).toText();
  const a2 = T.renderStatic(E.buildModel(history('main')), { unicode: true, color: false }).toText();
  assert.equal(a1, a2);
  const j = JSON.parse(T.renderJSON(m, {}));
  assert.equal(j.commits.length, 77);
  assert.equal(j.edges.length, m.list.reduce((n, c) => n + c.parents.length, 0));
  assert.ok(j.commits.every((c) => j.commits.find((p) => c.parents.includes(p.hash)) ? c.parents.every((p) => j.commits.find((q) => q.hash === p).x < c.x) : true));
});
