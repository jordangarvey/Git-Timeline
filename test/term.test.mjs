// Options, terminal input decoding and the ANSI renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require } from './helpers.mjs';

const { parseArgs, parseWhen, UsageError, DEFAULT_MAX } = require('../dist/cli/options.js');
const { InputDecoder } = require('../dist/term/input.js');
const { AnsiRenderer, detectDepth, themeFromEnv, themeFromOsc11, plainRow } = require('../dist/term/ansi.js');
const { LIGHT, DARK } = require('../dist/term/palette.js');
const E = require('../dist/core/engine.js');
const T = require('../dist/core/tui.js');
const history = require('./fixtures/history-main.json');

test('options: defaults, values, flags and a path', () => {
  const d = parseArgs([]);
  assert.equal(d.repo, '.');
  assert.equal(d.maxCount, DEFAULT_MAX);
  assert.equal(d.view, 'world');
  assert.equal(d.format, undefined);
  const o = parseArgs(['../proj', '--view=graph', '-n', '50', '--no-color', '--ascii', '--branch', 'main', '--no-motion', '--journey']);
  assert.equal(o.repo, '../proj');
  assert.equal(o.view, 'graph');
  assert.equal(o.maxCount, 50);
  assert.equal(o.color, false);
  assert.equal(o.ascii, true);
  assert.equal(o.branch, 'main');
  assert.equal(o.motion, false);
  assert.equal(o.journey, true);
  assert.equal(parseArgs(['--', '-weird-dir']).repo, '-weird-dir');
  assert.throws(() => parseArgs(['x', '--repo', 'y']), UsageError);
  assert.throws(() => parseArgs(['--branch', '--all']), /--branch/);
});

test('dates and durations become timestamps git understands', () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0);
  assert.equal(parseWhen('12h', '--since', now), '2026-11-21T00:00:00Z');
  // calendar days in local time, so a clock change in between moves the hour
  const days = (v, n) => Math.abs(now - Date.parse(parseWhen(v, '--since', now)) - n * 864e5) <= 3600e3;
  assert.ok(days('30d', 30));
  assert.ok(days('2w', 14));
  assert.ok(days('1y', 365));
  assert.match(parseWhen('2026-01-31', '--since', now), /^2026-01-31T00:00:00Z$/);
  assert.equal(parseWhen('2026-01-31T09:30Z', '--since', now), '2026-01-31T09:30:00Z');
  assert.throws(() => parseWhen('yesterday-ish', '--since', now), /expects a date/);
  assert.throws(() => parseWhen('2026-02-30', '--since', now), /not a valid date/);
  assert.throws(() => parseArgs(['--since', '2026-02-01', '--until', '2026-01-01']), /earlier than --until/);
});

test('keys: arrows with modifiers, editing keys, Ctrl+C and Unicode', () => {
  const d = new InputDecoder();
  const keys = (s) => d.feed(s).map((e) => (e.type === 'key' ? (e.ctrl ? 'C-' : '') + (e.alt ? 'M-' : '') + (e.shift ? 'S-' : '') + e.key : 'mouse'));
  assert.deepEqual(keys('\x1b[A\x1b[B\x1b[C\x1b[D'), ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft']);
  assert.deepEqual(keys('\x1b[1;2C\x1b[1;5D\x1bOA'), ['S-ArrowRight', 'C-ArrowLeft', 'ArrowUp']);
  assert.deepEqual(keys('\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[1~\x1b[4~'), ['PageUp', 'PageDown', 'Home', 'End', 'Home', 'End']);
  assert.deepEqual(keys('\r\t\x1b[Z\x7f'), ['Enter', 'Tab', 'S-Tab', 'Backspace']);
  assert.deepEqual(keys('\x03\x1a'), ['C-c', 'C-z']);
  assert.deepEqual(keys('q?[]/é日😀'), ['q', '?', '[', ']', '/', 'é', '日', '😀']);
  assert.deepEqual(keys('\x1b'), ['Escape']);
  assert.deepEqual(keys('\x1bv'), ['M-v']);
  assert.deepEqual(keys('\x1b]11;rgb:0000/0000/0000\x07x'), ['x'], 'a colour reply is swallowed');
  // a sequence split across two reads
  assert.deepEqual(keys('\x1b[1;'), []);
  assert.deepEqual(keys('2D'), ['S-ArrowLeft']);
});

test('mouse: wheel and clicks in SGR mode, in cell coordinates', () => {
  const d = new InputDecoder();
  const [down, up, click, release, side] = d.feed('\x1b[<65;10;5M\x1b[<64;10;5M\x1b[<0;3;7M\x1b[<0;3;7m\x1b[<66;1;1M');
  assert.deepEqual([down.action, down.dy, down.x, down.y], ['wheel', 1, 9, 4]);
  assert.equal(up.dy, -1);
  assert.deepEqual([click.action, click.button, click.x, click.y], ['press', 0, 2, 6]);
  assert.equal(release.action, 'release');
  assert.equal(side.dx, -1);
});

test('colour depth and light or dark terminals', () => {
  assert.equal(detectDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true), 'none');
  assert.equal(detectDepth({ COLORTERM: 'truecolor', TERM: 'xterm' }, true), 'truecolor');
  assert.equal(detectDepth({ TERM: 'xterm-256color' }, true), '256');
  assert.equal(detectDepth({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, true), '256');
  assert.equal(detectDepth({ TERM: 'dumb' }, true), 'none');
  assert.equal(detectDepth({ TERM: 'xterm-256color' }, false), 'none', 'pipes get no colour');
  assert.equal(detectDepth({ FORCE_COLOR: '3' }, false), 'truecolor');
  assert.equal(themeFromEnv({ COLORFGBG: '0;15' }), 'light');
  assert.equal(themeFromEnv({ COLORFGBG: '15;0' }), 'dark');
  assert.equal(themeFromEnv({}), null);
  assert.equal(themeFromOsc11('\x1b]11;rgb:ffff/ffff/f0f0\x1b\\'), 'light');
  assert.equal(themeFromOsc11('\x1b]11;rgb:1e1e/1e1e/2e2e\x07'), 'dark');
});

test('renderer: every row resets, colours in each depth, wide characters and plain text', () => {
  const app = new T.App(E.buildModel(history), { now: () => 1795222100000, files: () => ({ status: 'loading' }), patch: () => ({ status: 'loading' }) });
  const scr = app.frame(100, 30);
  for (const depth of ['truecolor', '256', '16', 'none']) {
    app.s.color = depth !== 'none';
    const s = app.frame(100, 30);
    const R = new AnsiRenderer(depth, 'dark');
    for (let y = 0; y < s.rows; y++) {
      const row = R.row(s, y);
      assert.ok(row.endsWith('\x1b[0m'), 'row ' + y + ' resets');
      const visible = row.replace(/\x1b\[[0-9;]*m/g, '');
      assert.equal([...visible].length, 100, depth + ': row ' + y + ' is exactly the screen width');
      assert.ok(!/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/.test(visible), 'no control characters');
    }
    const all = Array.from({ length: s.rows }, (_, y) => R.row(s, y)).join('');
    if (depth === 'truecolor') assert.match(all, /38;2;/);
    if (depth === '256') { assert.match(all, /38;5;/); assert.ok(!all.includes('38;2;')); }
    if (depth === '16') assert.ok(!/38;[25];|48;[25];/.test(all), 'only the basic colours');
    if (depth === 'none') assert.ok(!/\x1b\[[0-9;]*3[0-9]/.test(all.replace(/\x1b\[0m/g, '')), 'no colour codes at all');
  }
  assert.equal(plainRow(scr, 0).startsWith(' git-timeline'), true);
  const wide = { cols: 4, rows: 1, ch: ['日', '\0', 'a', 'b'], st: ['', '', '', ''] };
  assert.equal(new AnsiRenderer('none', 'dark').row(wide, 0).replace(/\x1b\[[0-9;]*m/g, ''), '日ab');
  assert.equal(plainRow(wide, 0, 1, 4), ' ab', 'a band that cuts a wide character prints a space');
});

test('the palette has every colour the UI and the world ask for, in both themes', () => {
  for (const P of [LIGHT, DARK]) {
    for (const k of ['t-bg', 't-fg', 't-mu', 't-ac', 't-hd', 't-ft', 't-sel', 't-cur', 't-bx', 'ad', 'rm', 'adb', 'rmb', 'tg', 'wa', 'mt']) assert.ok(P[k], k);
    for (let i = 0; i < 8; i++) assert.ok(P['c' + i]);
    for (let e = 0; e <= 10; e++) { assert.ok(P['wk' + e], 'sky ' + e); assert.ok(P['wg' + e], 'ground ' + e); }
    for (const k of 'gGbwirRldkmncpuyofzBHDKVIPNOXCZYWUJTALMQESF') assert.ok(P['s' + k], 'scenery colour ' + k);
  }
  assert.notDeepEqual(LIGHT['t-bg'], DARK['t-bg']);
});
