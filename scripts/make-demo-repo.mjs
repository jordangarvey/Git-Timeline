#!/usr/bin/env node
// Builds the example repository used by the git-timeline prototype.
// Everything is deterministic: names, contents, author and committer dates.
// Usage: node scripts/make-demo-repo.mjs <repo-dir>   (builds the 77-commit example repository used for demos)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const REPO = path.resolve(process.argv[2] ?? 'work/git-timeline');
const ENV0 = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C.UTF-8' };

function git(args, { env = {}, input } = {}) {
  return execFileSync('git', args, { cwd: REPO, env: { ...ENV0, ...env }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ---------------------------------------------------------------- time zones
function zoneOffset(zone, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms) / 60000);
}
// Wall-clock time in a zone -> instant. fold=1 picks the second occurrence of a repeated hour.
function local(wall, zone, fold = 0) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/.exec(wall);
  if (!m) throw new Error('bad time ' + wall);
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const offs = new Set([-14, -6, -2, 0, 2, 6, 14].map((h) => zoneOffset(zone, asUTC + h * 3600e3)));
  const sols = [...offs].map((o) => asUTC - o * 60e3).filter((u) => zoneOffset(zone, u) === (asUTC - u) / 60e3).sort((a, b) => a - b);
  if (!sols.length) throw new Error(wall + ' does not exist in ' + zone);
  return { ms: fold ? sols[sols.length - 1] : sols[0], zone };
}
function gitDate({ ms, zone }) {
  const o = zoneOffset(zone, ms);
  const a = Math.abs(o);
  return Math.floor(ms / 1000) + ' ' + (o < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + String(a % 60).padStart(2, '0');
}

// ---------------------------------------------------------------- people
const P = {
  priya: { name: 'Priya Raman', email: 'priya@example.com', zone: 'Asia/Kolkata' },
  mateo: { name: 'Mateo García', email: 'mateo@example.com', zone: 'Europe/Madrid' },
  zoe: { name: 'Zoe\u0308 Lindqvist', email: 'zoe@example.com', zone: 'Europe/Stockholm' }, // decomposed ë on purpose
  kenji: { name: 'Kenji Watanabe', email: 'kenji@example.com', zone: 'Asia/Tokyo' },
  amara: { name: 'Amara Okafor', email: 'amara@example.com', zone: 'America/New_York' },
  sam: { name: 'Sam Carter', email: 'sam@example.com', zone: 'Europe/London' },
};
const envFor = (a, at, c, ct) => ({
  GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: gitDate(at),
  GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: gitDate(ct),
});

// ---------------------------------------------------------------- file ops
function apply(ops) {
  for (const [kind, p, a, b] of ops) {
    const abs = path.join(REPO, p);
    if (kind === 'w' || kind === 'bin') { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, a); }
    else if (kind === 'a') fs.appendFileSync(abs, a);
    else if (kind === 'r') {
      const t = fs.readFileSync(abs, 'utf8');
      if (!t.includes(a)) throw new Error('replace target missing in ' + p + ': ' + a.slice(0, 40));
      fs.writeFileSync(abs, t.replace(a, b));
    } else if (kind === 'd') fs.rmSync(abs);
    else if (kind === 'mv') { fs.mkdirSync(path.dirname(path.join(REPO, a)), { recursive: true }); fs.renameSync(abs, path.join(REPO, a)); }
    else if (kind === 'chmod') fs.chmodSync(abs, a);
    else if (kind === 'gitlink') { fs.mkdirSync(abs, { recursive: true }); git(['update-index', '--add', '--cacheinfo', '160000,' + a + ',' + p]); }
    else throw new Error('unknown op ' + kind);
  }
}

const H = {};
function commit(id, who, when, msg, ops = [], o = {}) {
  const a = P[who];
  const c = o.committer ? P[o.committer] : a;
  const at = local(when, a.zone, o.fold ?? 0);
  const ct = o.cwhen ? local(o.cwhen, c.zone, o.cfold ?? 0) : { ms: at.ms, zone: c.zone };
  apply(ops);
  // The gitlink is staged with update-index; keep add -A from touching it.
  git(['add', '-A', '--', '.', ':(exclude)vendor/sample-repo']);
  git(['commit', '-q', '--allow-empty', '--no-verify', '-F', '-'], { env: envFor(a, at, c, ct), input: msg });
  H[id] = git(['rev-parse', 'HEAD']);
}
function merge(id, who, when, msg, branches) {
  const a = P[who];
  const at = local(when, a.zone);
  git(['merge', '-q', '--no-ff', '--no-edit', '-m', msg, ...branches], { env: envFor(a, at, a, at) });
  H[id] = git(['rev-parse', 'HEAD']);
}
const sw = (b) => git(['switch', '-q', b]);
const nb = (b, start) => git(['switch', '-q', '-c', b, ...(start ? [start] : [])]);
const del = (b) => git(['branch', '-q', '-D', b]);
function tag(name, target, who, when, msg) {
  if (!msg) return git(['tag', name, target]);
  const a = P[who];
  const t = local(when, a.zone);
  git(['tag', '-a', name, '-F', '-', target], { env: envFor(a, t, a, t), input: msg });
}

// ---------------------------------------------------------------- binary + generated content
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * (w * 3 + 1) + 1 + x * 3;
    const lane = Math.floor(y / 8);
    raw[i] = 20 + lane * 60; raw[i + 1] = 40 + ((x * 3) % 160); raw[i + 2] = 120 + lane * 30;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function largeDag(n) {
  const sha = (i) => crypto.createHash('sha1').update('commit ' + i).digest('hex');
  const lines = ['['];
  let t = 1751328000;
  for (let i = 0; i < n; i++) {
    const parents = i === 0 ? [] : i % 17 === 0 && i > 20 ? [sha(i - 1), sha(i - 9)] : [sha(i - 1)];
    t += 300 + ((i * 7919) % 5400);
    lines.push('  {"h":"' + sha(i) + '","p":' + JSON.stringify(parents) + ',"t":' + t + '}' + (i < n - 1 ? ',' : ''));
  }
  lines.push(']');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- contents
const MIT = 'MIT License\n\nCopyright (c) 2026 The git-timeline authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n';

const README = `# git-timeline

Explore your Git history through time.

git-timeline draws a repository's commit graph on a horizontal time
axis in the terminal, so you can see the shape of a project before you
read a single commit message.

## Status

Early prototype. Nothing works yet.
`;

const PKG = `{
  "name": "git-timeline",
  "version": "0.0.0",
  "description": "Explore your Git history through time.",
  "type": "module",
  "bin": {
    "git-timeline": "dist/cli/index.js"
  },
  "engines": {
    "node": ">=18.17"
  },
  "license": "MIT"
}
`;

const CLI_INDEX = `#!/usr/bin/env node
import { parseOptions, HELP } from './options.js';
import { version } from '../version.js';

async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write('git-timeline ' + version + '\\n');
    return 0;
  }
  process.stderr.write('git-timeline: the timeline view is not implemented yet\\n');
  return 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
`;

const CLI_OPTIONS = `export interface Options {
  repo: string;
  since?: string;
  maxCount?: number;
  format: 'interactive' | 'ascii' | 'json';
  ascii: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
}

export const HELP = [
  'Usage: git-timeline [options]',
  '',
  '  --repo <path>        repository to open (default: .)',
  '  --since <when>       only commits after a date or duration (30d)',
  '  --max-count <n>      limit the number of commits read',
  '  --format <mode>      interactive | ascii | json',
  '  --ascii              ASCII instead of Unicode glyphs',
  '  --no-color           no colour (NO_COLOR is honoured too)',
  '  -h, --help           show this help',
  '  -v, --version        show the version',
  '',
].join('\\n');

export function parseOptions(argv: string[]): Options {
  const o: Options = { repo: '.', format: 'interactive', ascii: false, color: !process.env.NO_COLOR, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--ascii') o.ascii = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--max-count') o.maxCount = Number(argv[++i]);
    else if (a === '--format') o.format = argv[++i] as Options['format'];
    else throw new Error('unknown option: ' + a);
  }
  return o;
}
`;

const LEGACY = `// Temporary list view: one commit per line until the timeline exists.
import type { Commit } from '../git/history.js';

export function renderList(commits: Commit[], width: number): string[] {
  return commits.map((c) => (c.hash.slice(0, 7) + ' ' + c.subject).slice(0, width));
}
`;

const RUNNER = `import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(readonly args: string[], readonly code: number | null, readonly stderr: string) {
    super('git ' + args[0] + ' failed' + (code === null ? '' : ' (exit ' + code + ')') + ': ' + stderr.trim());
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
}

// No prompts, no lazy fetches from promisor remotes, no index refresh.
const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };

export function git(args: string[], opts: RunOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotePath=false', ...args],
      { cwd: opts.cwd, env: { ...process.env, ...ENV }, encoding: 'buffer', timeout: opts.timeoutMs ?? 15000, maxBuffer: opts.maxBytes ?? 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git-timeline needs git on PATH'));
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
        reject(new GitError(args, code, stderr.toString('utf8')));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
`;

const REPOSITORY = `import { git } from './runner.js';

export interface RepoInfo {
  root: string;
  shallow: boolean;
  head: { hash: string | null; ref: string | null; detached: boolean; unborn: boolean };
}

export async function openRepository(cwd: string): Promise<RepoInfo> {
  const out = (await git(['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--is-shallow-repository'], { cwd })).toString('utf8').split('\\n');
  if (out[0] !== 'true') throw new Error('not inside a git work tree: ' + cwd);
  const root = out[1];
  const ref = await git(['symbolic-ref', '-q', 'HEAD'], { cwd: root }).then((b) => b.toString('utf8').trim(), () => null);
  const hash = await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: root }).then((b) => b.toString('utf8').trim(), () => null);
  return { root, shallow: out[2] === 'true', head: { hash, ref, detached: ref === null && hash !== null, unborn: hash === null } };
}
`;

const HISTORY = `import { git } from './runner.js';

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerTime: number;
  subject: string;
  body: string;
}

const FIELDS = ['%H', '%P', '%aN', '%aE', '%at', '%ct', '%s', '%b'];
const FORMAT = FIELDS.join('%x00');

export async function readHistory(root: string, tips: string[], maxCount?: number): Promise<Commit[]> {
  const args = ['log', '-z', '--no-color', '--format=' + FORMAT, '--stdin'];
  if (maxCount) args.push('--max-count=' + maxCount);
  const raw = (await git(args, { cwd: root, input: tips.join('\\n') + '\\n' })).toString('utf8');
  const parts = raw.split('\\0');
  if (parts[parts.length - 1] === '') parts.pop();
  if (parts.length % FIELDS.length !== 0) throw new Error('unexpected git log output: ' + parts.length + ' fields');
  const commits: Commit[] = [];
  for (let i = 0; i < parts.length; i += FIELDS.length) {
    const f = parts.slice(i, i + FIELDS.length);
    commits.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2],
      authorEmail: f[3],
      authorTime: Number(f[4]),
      committerTime: Number(f[5]),
      subject: f[6],
      body: f[7].replace(/\\n+$/, ''),
    });
  }
  return commits;
}
`;

const MODEL = `import type { Commit } from '../git/history.js';

export interface Graph {
  commits: Map<string, Commit>;
  children: Map<string, string[]>;
  roots: string[];
}

export function buildGraph(list: Commit[]): Graph {
  const commits = new Map(list.map((c) => [c.hash, c] as const));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const c of list) {
    const parents = c.parents.filter((p) => commits.has(p));
    if (parents.length === 0) roots.push(c.hash);
    for (const p of parents) {
      const kids = children.get(p);
      if (kids) kids.push(c.hash);
      else children.set(p, [c.hash]);
    }
  }
  return { commits, children, roots };
}
`;

const LAYOUT0 = `// Combines lane allocation with the time axis. Filled in by later work.
import type { Graph } from './graph/model.js';

export interface Layout {
  x: Map<string, number>;
  lane: Map<string, number>;
  width: number;
  lanes: number;
}

export function layout(graph: Graph): Layout {
  return { x: new Map(), lane: new Map(), width: 0, lanes: graph.roots.length };
}
`;

const TRAVERSAL = `import type { Graph } from './model.js';

export interface Chain {
  name: string | null;
  commits: string[]; // oldest first
}

/** Walk first parents from each tip until reaching a commit another chain owns. */
export function firstParentChains(graph: Graph, tips: { name: string; hash: string }[]): Chain[] {
  const owner = new Set<string>();
  const chains: Chain[] = [];
  for (const tip of tips) {
    const commits: string[] = [];
    let h: string | undefined = tip.hash;
    while (h && graph.commits.has(h) && !owner.has(h)) {
      owner.add(h);
      commits.push(h);
      h = graph.commits.get(h)!.parents[0];
    }
    if (commits.length) chains.push({ name: tip.name, commits: commits.reverse() });
  }
  return chains;
}
`;

const BRAILLE = `// Experiment: plot commits as braille dots (2x4 pixels per cell).
const BASE = 0x2800;
const BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export function plot(points: Array<[number, number]>, cols: number, rows: number): string[] {
  const cells = new Uint8Array(cols * rows);
  for (const [x, y] of points) {
    const cx = Math.floor(x / 2), cy = Math.floor(y / 4);
    if (cx < cols && cy < rows) cells[cy * cols + cx] |= BIT[y % 4][x % 2];
  }
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) line += String.fromCharCode(BASE + cells[r * cols + c]);
    out.push(line);
  }
  return out;
}
`;

const REFS = `import { git } from './runner.js';

export type RefKind = 'branch' | 'remote' | 'tag';

export interface Ref {
  name: string;
  kind: RefKind;
  target: string; // peeled commit
}

const FORMAT = '%(refname)%00%(objectname)%00%(*objectname)%00%(symref)';

export async function readRefs(root: string): Promise<Ref[]> {
  const out = (await git(['for-each-ref', '--format=' + FORMAT, 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd: root })).toString('utf8');
  const refs: Ref[] = [];
  for (const line of out.split('\\n')) {
    if (!line) continue;
    const [name, object, peeled, symref] = line.split('\\0');
    if (symref) continue; // refs/remotes/origin/HEAD
    const kind: RefKind = name.startsWith('refs/heads/') ? 'branch' : name.startsWith('refs/tags/') ? 'tag' : 'remote';
    refs.push({ name, kind, target: peeled || object });
  }
  return refs;
}
`;

const LANES = `export interface Interval {
  id: number;
  start: number;
  end: number;
  parentLane?: number;
}

const GAP = 2;

/**
 * Greedy interval colouring. Intervals are processed by start column; each
 * takes a free lane, so the lane count equals the maximum overlap.
 */
export function allocateLanes(intervals: Interval[], pinned?: number): Map<number, number> {
  const lane = new Map<number, number>();
  const ends: number[] = [];
  if (pinned !== undefined) {
    lane.set(pinned, 0);
    ends[0] = Infinity;
  }
  const order = intervals.filter((i) => i.id !== pinned).sort((a, b) => a.start - b.start || a.id - b.id);
  for (const iv of order) {
    let chosen = ends.findIndex((end) => end + GAP <= iv.start);
    if (chosen === -1) chosen = ends.length;
    lane.set(iv.id, chosen);
    ends[chosen] = iv.end;
  }
  return lane;
}
`;

const TIME_SCALE = `export interface TimeScale {
  origin: number; // unix seconds at column 0
  secondsPerColumn: number;
}

export const ZOOM_LEVELS = [7 * 86400, 3 * 86400, 86400, 43200, 21600, 10800, 3600, 1200];

export function toColumn(scale: TimeScale, t: number): number {
  return Math.floor((t - scale.origin) / scale.secondsPerColumn);
}

export function toTime(scale: TimeScale, column: number): number {
  return scale.origin + column * scale.secondsPerColumn;
}
`;

const AXIS = `import type { TimeScale } from './time-scale.js';

export type Unit = 'year' | 'quarter' | 'month' | 'week' | 'day' | '6h' | '3h' | 'hour';

const SECONDS: Record<Unit, number> = { year: 31536000, quarter: 7884000, month: 2628000, week: 604800, day: 86400, '6h': 21600, '3h': 10800, hour: 3600 };
const ORDER: Unit[] = ['hour', '3h', '6h', 'day', 'week', 'month', 'quarter', 'year'];

/** The finest unit whose labels are at least minColumns apart. */
export function pickUnit(scale: TimeScale, minColumns = 9): Unit {
  for (const unit of ORDER) if (SECONDS[unit] / scale.secondsPerColumn >= minColumns) return unit;
  return 'year';
}
`;

const LANES_TEST = `import { describe, expect, it } from 'vitest';
import { allocateLanes } from '../../src/graph/lanes.js';

describe('allocateLanes', () => {
  it('reuses a lane once a branch has merged', () => {
    const lanes = allocateLanes([
      { id: 0, start: 0, end: 100 },
      { id: 1, start: 10, end: 20, parentLane: 0 },
      { id: 2, start: 30, end: 40, parentLane: 0 },
    ], 0);
    expect(lanes.get(1)).toBe(1);
    expect(lanes.get(2)).toBe(1);
  });

  it('opens a new lane for overlapping branches', () => {
    const lanes = allocateLanes([
      { id: 0, start: 0, end: 100 },
      { id: 1, start: 10, end: 50, parentLane: 0 },
      { id: 2, start: 20, end: 60, parentLane: 0 },
    ], 0);
    expect(new Set([lanes.get(1), lanes.get(2)]).size).toBe(2);
  });
});
`;

const CHANGELOG = `# Changelog

## 0.1.0 (2026-07-06)

- Static timeline snapshot with --format ascii.
- Lane allocation with lane reuse after merges.
- Read-only git layer built on execFile and NUL-delimited output.
`;

const APP = `import { Box, useApp, useInput } from 'ink';
import { Header } from './Header.js';
import { Footer } from './Footer.js';

export function App({ repo }: { repo: string }) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
  });
  return (
    <Box flexDirection="column" height="100%">
      <Header repo={repo} />
      <Box flexGrow={1} />
      <Footer hints={['q quit', '? help']} />
    </Box>
  );
}
`;

const HEADER = `import { Box, Text } from 'ink';

export function Header({ repo }: { repo: string }) {
  return (
    <Box>
      <Text bold>{repo}</Text>
    </Box>
  );
}
`;

const FOOTER = `import { Text } from 'ink';

export function Footer({ hints }: { hints: string[] }) {
  return <Text dimColor>{hints.join('  ')}</Text>;
}
`;

const KEYBOARD = `export type Action =
  | { type: 'move'; by: -1 | 1 }
  | { type: 'lane'; by: -1 | 1 }
  | { type: 'zoom'; by: -1 | 1 }
  | { type: 'head' }
  | { type: 'oldest' }
  | { type: 'focus'; next: boolean }
  | { type: 'quit' };

interface Key { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; tab?: boolean; shift?: boolean }

export function keyToAction(input: string, key: Key): Action | null {
  if (key.leftArrow) return { type: 'move', by: -1 };
  if (key.rightArrow) return { type: 'move', by: 1 };
  if (key.upArrow) return { type: 'lane', by: -1 };
  if (key.downArrow) return { type: 'lane', by: 1 };
  if (key.tab) return { type: 'focus', next: !key.shift };
  if (input === '[') return { type: 'zoom', by: -1 };
  if (input === ']') return { type: 'zoom', by: 1 };
  if (input === 'g') return { type: 'head' };
  if (input === 'G') return { type: 'oldest' };
  if (input === 'q') return { type: 'quit' };
  return null;
}
`;

const ACTIONS = `import type { Action } from './keyboard.js';

export type Focus = 'timeline' | 'files' | 'diff';

export interface UiState {
  selected: string | null;
  zoom: number;
  focus: Focus;
}

const FOCUS_ORDER: Focus[] = ['timeline', 'files', 'diff'];

export function reduce(state: UiState, action: Action, zoomLevels: number): UiState {
  switch (action.type) {
    case 'zoom':
      return { ...state, zoom: Math.min(zoomLevels - 1, Math.max(0, state.zoom + action.by)) };
    case 'focus': {
      const i = FOCUS_ORDER.indexOf(state.focus);
      const next = (i + (action.next ? 1 : FOCUS_ORDER.length - 1)) % FOCUS_ORDER.length;
      return { ...state, focus: FOCUS_ORDER[next] };
    }
    default:
      return state;
  }
}
`;

const KEYDOC = `# Keyboard

| key        | action                                  |
| ---------- | --------------------------------------- |
| left/right | previous / next commit in time          |
| up/down    | nearest commit in the lane above/below  |
| [ / ]      | zoom out / in                           |
| g / G      | jump to HEAD / oldest commit            |
| enter      | open commit details                     |
| tab        | move focus between panels               |
| q          | quit                                    |
`;

const CI = `#!/bin/sh
set -eu
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
`;

const SANITIZE = `/** Replace C0/C1 control characters with visible symbols before drawing. */
export function sanitize(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20) out += String.fromCodePoint(0x2400 + cp); // control pictures
    else if (cp === 0x7f) out += '\\u2421';
    else if (cp >= 0x80 && cp < 0xa0) out += '\\ufffd';
    else out += ch;
  }
  return out;
}
`;

const CHANGED_FILES = `import { git } from './runner.js';

export interface ChangedFile {
  status: string; // A, M, D, R, C, T
  path: string;
  oldPath?: string;
  insertions: number | null; // null for binary files
  deletions: number | null;
  submodule: boolean;
}

/** Lazily list the files a commit changed, relative to its first parent. */
export async function changedFiles(root: string, hash: string, parent: string | null): Promise<ChangedFile[]> {
  const range = parent ? [parent, hash] : ['--root', hash];
  const out = (await git(['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--raw', '--numstat', ...range], { cwd: root })).toString('utf8');
  return parseDiffTree(out.split('\\0'));
}

export function parseDiffTree(tokens: string[]): ChangedFile[] {
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith(':')) {
    const [, newMode, , , status] = tokens[i].slice(1).split(' ');
    const renamed = status[0] === 'R' || status[0] === 'C';
    const file: ChangedFile = { status: status[0], path: renamed ? tokens[i + 2] : tokens[i + 1], insertions: null, deletions: null, submodule: newMode === '160000' };
    if (renamed) file.oldPath = tokens[i + 1];
    files.push(file);
    i += renamed ? 3 : 2;
  }
  return files;
}
`;

const DIFF = `import { spawn } from 'node:child_process';

export interface PatchPreview {
  lines: string[];
  truncated: boolean;
}

export const MAX_LINES = 400;
export const MAX_BYTES = 64 * 1024;

/** Read at most MAX_LINES / MAX_BYTES of a patch, then stop the git process. */
export function patchPreview(root: string, parent: string | null, hash: string, paths: string[]): Promise<PatchPreview> {
  const range = parent ? [parent, hash] : ['--root', hash];
  const args = ['--no-optional-locks', '--literal-pathspecs', 'diff-tree', '-p', '-M', '--no-color', '--no-ext-diff', '--no-commit-id', ...range, '--', ...paths];
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0;
    let text = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      text += chunk;
      if (bytes > MAX_BYTES || text.split('\\n').length > MAX_LINES) {
        truncated = true;
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve({ lines: text.split('\\n').slice(0, MAX_LINES), truncated }));
  });
}
`;

const DIFF_PREVIEW = `import { Box, Text } from 'ink';
import type { PatchPreview } from '../git/diff.js';

export function DiffPreview({ patch, offset, height }: { patch: PatchPreview; offset: number; height: number }) {
  const visible = patch.lines.slice(offset, offset + height);
  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Text key={offset + i} color={line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined}>
          {line}
        </Text>
      ))}
      {patch.truncated && <Text dimColor>-- preview truncated --</Text>}
    </Box>
  );
}
`;

const README_JA = `# git-timeline

ターミナルで Git の履歴を時間軸に沿って探索するツールです。

- 読み取り専用：リポジトリを変更しません。
- ネットワーク不要：ローカルのリポジトリだけを読みます。
- ←/→ でコミットを移動、[ と ] でズーム。
`;

const WIDTH = `/** Display width of one code point in a terminal (0, 1 or 2 cells). */
export function charWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}
`;

const SEARCH = `import type { Commit } from './git/history.js';

export function findMatches(commits: Commit[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return commits.filter((c) => c.subject.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)).map((c) => c.hash);
}
`;

const VIEWPORT = `export interface Segment {
  x1: number;
  x2: number;
}

const BUCKET = 64;

/** Index segments by 64-column bucket so a frame only touches what it draws. */
export class SegmentIndex<T extends Segment> {
  private buckets = new Map<number, T[]>();

  add(seg: T): void {
    for (let b = Math.floor(seg.x1 / BUCKET); b <= Math.floor(seg.x2 / BUCKET); b++) {
      const list = this.buckets.get(b);
      if (list) list.push(seg);
      else this.buckets.set(b, [seg]);
    }
  }

  query(x1: number, x2: number): Set<T> {
    const out = new Set<T>();
    for (let b = Math.floor(x1 / BUCKET); b <= Math.floor(x2 / BUCKET); b++) for (const s of this.buckets.get(b) ?? []) out.add(s);
    return out;
  }
}
`;

const ZOOM = `import { ZOOM_LEVELS } from './time-scale.js';

/** Change zoom while keeping the selected commit at the same screen column. */
export function zoomAround(level: number, by: -1 | 1, selectedX: number, scrollX: number, newSelectedX: number) {
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, level + by));
  const screenOffset = selectedX - scrollX;
  return { level: next, scrollX: Math.max(0, newSelectedX - screenOffset) };
}
`;

const FILTERS = `import type { Commit } from './git/history.js';

export interface AuthorFilter {
  include: Set<string>; // author emails; empty means everyone
}

/** Commits by excluded authors stay in the graph but are drawn dimmed. */
export function isDimmed(filter: AuthorFilter, commit: Commit): boolean {
  return filter.include.size > 0 && !filter.include.has(commit.authorEmail);
}
`;

const AUTHOR_PICKER = `import { Box, Text } from 'ink';

interface Props {
  authors: Array<{ email: string; name: string; count: number }>;
  include: Set<string>;
  cursor: number;
}

export function AuthorPicker({ authors, include, cursor }: Props) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {authors.map((a, i) => (
        <Text key={a.email} inverse={i === cursor}>
          {include.size === 0 || include.has(a.email) ? '[x] ' : '[ ] '}
          {a.name} ({a.count})
        </Text>
      ))}
    </Box>
  );
}
`;

const CLI_TEST = `import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function run(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('node', [join(__dirname, '../dist/cli/index.js'), ...args], { cwd }, (err) => resolve(err ? Number(err.code) : 0));
  });
}

describe('cli', () => {
  it('exits with 2 outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-'));
    expect(await run(['--format', 'ascii'], dir)).toBe(2);
  });
});
`;

const GLYPHS = `export interface Glyphs {
  commit: string;
  merge: string;
  head: string;
  corners: { upRight: string; upLeft: string; downRight: string; downLeft: string };
}

export const UNICODE: Glyphs = { commit: '●', merge: '◆', head: '◉', corners: { upRight: '╰', upLeft: '╯', downRight: '╭', downLeft: '╮' } };

// Rounded corners have no ASCII equivalent; quote marks read as curves.
export const ASCII: Glyphs = { commit: '*', merge: 'M', head: '@', corners: { upRight: '\`', upLeft: "'", downRight: '.', downLeft: '.' } };
`;

const THEME = `export const LANE_COLORS = ['blue', 'magenta', 'cyan', 'yellow', 'green', 'red', 'blueBright', 'magentaBright'] as const;

/** NO_COLOR (https://no-color.org) and --no-color turn every lane colour off. */
export function useColor(flag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag && !('NO_COLOR' in env && env.NO_COLOR !== '');
}
`;

const HELP_TSX = `import { Box, Text } from 'ink';

const BINDINGS: Array<[string, string]> = [
  ['←/→', 'previous / next commit'],
  ['↑/↓', 'lane above / below'],
  ['[ ]', 'zoom out / in'],
  ['g G', 'HEAD / oldest commit'],
  ['f', 'filter branches'],
  ['/', 'search'],
  ['q', 'quit'],
];

export function Help() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {BINDINGS.map(([key, what]) => (
        <Text key={key}>
          <Text bold>{key.padEnd(6)}</Text>
          {what}
        </Text>
      ))}
    </Box>
  );
}
`;

const BOUNDARY = `import type { Graph } from '../graph/model.js';

/**
 * For a commit inside the date range whose parent is outside it, find the
 * nearest ancestors that are inside, so the connector is drawn as an
 * abbreviated (dashed) edge instead of silently disappearing.
 */
export function nearestVisibleAncestors(graph: Graph, start: string, visible: Set<string>, limit = 10000): string[] {
  const found = new Set<string>();
  const stack = [...graph.commits.get(start)!.parents];
  const seen = new Set<string>();
  while (stack.length && seen.size < limit) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    if (visible.has(h)) found.add(h);
    else stack.push(...(graph.commits.get(h)?.parents ?? []));
  }
  return [...found];
}
`;

const ARCH = `# Architecture

    git (execFile, NUL-delimited) -> graph model -> layout -> renderer -> terminal

The layout engine never calls git, never reads the terminal size and
never renders text. It takes a graph and a zoom level and returns
columns, lanes and connector segments.

## Lanes

1. Every ref tip claims its first-parent chain, main first.
2. Commits reachable only through merges form anonymous chains, named
   from the merge message when one matches ("Merge branch 'x'").
3. Chains are sorted by start column and each takes the free lane
   closest to its parent's lane; main is pinned to lane 0.

## Columns

Commits are placed in time-respecting topological order. A commit's
column is its time column, pushed right until it is past every parent
and past the previous commit. Timestamps are never rewritten.
`;

const SITE_INDEX = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>git-timeline</title>
<link rel="stylesheet" href="style.css">
<h1>git-timeline</h1>
<p>Explore your Git history through time.</p>
<pre>npm install -g git-timeline</pre>
`;

const SITE_CSS = `body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
pre { background: #f4f4f4; padding: 1rem; }
`;

// ---------------------------------------------------------------- history
fs.rmSync(REPO, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
git(['init', '-q', '-b', 'main']);
for (const [k, v] of [['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['merge.ff', 'false']]) git(['config', k, v]);

// June: bootstrapping
commit('c01', 'priya', '2026-06-08 10:05', 'Initial commit\n', [['w', 'README.md', README], ['w', 'LICENSE', MIT], ['w', 'package.json', PKG], ['w', '.gitignore', 'node_modules/\ndist/\ncoverage/\n*.log\n']]);
commit('c02', 'priya', '2026-06-08 16:40', 'Add TypeScript build and Vitest\n', [
  ['w', 'tsconfig.json', '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "NodeNext",\n    "moduleResolution": "NodeNext",\n    "strict": true,\n    "jsx": "react-jsx",\n    "outDir": "dist",\n    "rootDir": "src",\n    "sourceMap": true\n  },\n  "include": ["src"]\n}\n'],
  ['w', 'vitest.config.ts', "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    include: ['tests/**/*.test.ts'],\n    testTimeout: 20000,\n  },\n});\n"],
  ['r', 'package.json', '  "license": "MIT"\n}', '  "scripts": {\n    "build": "tsc -p tsconfig.json",\n    "test": "vitest run",\n    "typecheck": "tsc --noEmit"\n  },\n  "devDependencies": {\n    "typescript": "^5.5.4",\n    "vitest": "^2.0.5"\n  },\n  "license": "MIT"\n}'],
]);
commit('c03', 'sam', '2026-06-09 11:20', 'Add CLI entry point with --help and --version\n', [['w', 'src/cli/index.ts', CLI_INDEX], ['w', 'src/cli/options.ts', CLI_OPTIONS], ['w', 'src/ui/legacy-list-view.ts', LEGACY], ['w', 'src/version.ts', "export const version = '0.0.0';\n"]]);

nb('feature/git-runner');
commit('c04', 'priya', '2026-06-10 09:30', 'git: add execFile runner with timeouts\n\nEvery git invocation goes through one function that:\n\n- uses execFile with an argument array, never a shell string,\n- passes --no-optional-locks so status never rewrites the index,\n- sets GIT_TERMINAL_PROMPT=0 and GIT_NO_LAZY_FETCH=1,\n- enforces a timeout and a maximum output size.\n', [['w', 'src/git/runner.ts', RUNNER]]);
commit('c05', 'priya', '2026-06-11 14:10', 'git: detect worktree, root and HEAD state\n', [['w', 'src/git/repository.ts', REPOSITORY]]);
sw('main');
commit('c06', 'sam', '2026-06-12 10:45', 'docs: describe read-only guarantees\n', [['a', 'README.md', '\n## Read-only by design\n\ngit-timeline never writes to your repository: no refs, no index, no\nconfig, no working tree. It runs git with --no-optional-locks so even\ngit status cannot refresh the index behind your back, and it never\ntouches the network.\n']]);
sw('feature/git-runner');
commit('c07', 'priya', '2026-06-13 13:00', 'git: parse NUL-delimited log records\n\nFields are separated by NUL and records are terminated by NUL (-z),\nso subjects, bodies and names can contain any other byte. The field\ncount is fixed, which makes a truncated stream detectable.\n', [['w', 'src/git/history.ts', HISTORY]]);
sw('main');
merge('c08', 'priya', '2026-06-15 09:00', "Merge branch 'feature/git-runner'", ['feature/git-runner']);
del('feature/git-runner');

nb('feature/dag-model');
commit('c09', 'mateo', '2026-06-16 18:20', 'graph: commit DAG model with children index\n', [['w', 'src/graph/model.ts', MODEL], ['w', 'src/layout.ts', LAYOUT0]]);
commit('c10', 'mateo', '2026-06-18 11:05', 'graph: first-parent chain extraction\n', [['w', 'src/graph/traversal.ts', TRAVERSAL]]);
nb('experiment/canvas-renderer', 'main');
commit('c11', 'zoe', '2026-06-19 15:30', 'experiment: draw the graph with braille dots\n', [['w', 'src/render/braille.ts', BRAILLE], ['w', 'notes/braille.md', '# Braille renderer notes\n\nBraille cells give 2x4 dots per character, so a dense history fits in a\nquarter of the width. Edges are hard to read below 3 lanes per cell.\n']]);
sw('main');
merge('c12', 'mateo', '2026-06-22 10:00', "Merge branch 'feature/dag-model'", ['feature/dag-model']);
del('feature/dag-model');
commit('c13', 'sam', '2026-06-23 09:15', 'refs: read branches, tags and remotes\n', [['w', 'src/git/refs.ts', REFS]]);

nb('feature/lane-allocator');
commit('c14', 'priya', '2026-06-24 10:30', 'lanes: greedy interval allocation\n\nEach branch path (a first-parent chain) occupies a lane from its fork\ncolumn to its merge column. Paths are processed by start column and\ntake the first free lane, which is optimal for interval graphs: the\nnumber of lanes equals the largest number of paths alive at once.\n\nThe main branch is pinned to lane 0.\n', [['w', 'src/graph/lanes.ts', LANES]]);
nb('feature/time-scale', 'main');
commit('c16', 'zoe', '2026-06-25 14:00', 'timeline: time-to-column scale\n', [['w', 'src/timeline/time-scale.ts', TIME_SCALE]]);
sw('feature/lane-allocator');
commit('c15', 'priya', '2026-06-26 12:00', 'lanes: prefer the lane next to the parent path\n', [['r', 'src/graph/lanes.ts', '    let chosen = ends.findIndex((end) => end + GAP <= iv.start);\n    if (chosen === -1) chosen = ends.length;\n', '    let chosen = -1;\n    let best = Infinity;\n    const parent = iv.parentLane ?? 0;\n    for (let l = 0; l < ends.length; l++) {\n      if (ends[l] + GAP > iv.start) continue;\n      const d = l > parent ? l - parent : parent - l + 0.5; // prefer the lane below\n      if (d < best) {\n        best = d;\n        chosen = l;\n      }\n    }\n    if (chosen === -1) chosen = ends.length;\n']]);
sw('feature/time-scale');
commit('c17', 'zoe', '2026-06-29 10:20', 'timeline: adaptive axis labels\n', [['w', 'src/timeline/axis.ts', AXIS], ['a', 'src/timeline/time-scale.ts', "\n/** Local midnight before t, so day labels line up with the viewer's calendar. */\nexport function startOfLocalDay(t: number): number {\n  const d = new Date(t * 1000);\n  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;\n}\n"]]);
sw('main');
merge('c18', 'sam', '2026-06-30 09:00', "Merge branch 'feature/time-scale'", ['feature/time-scale']);
del('feature/time-scale');
merge('c19', 'priya', '2026-07-01 11:00', "Merge branch 'feature/lane-allocator'", ['feature/lane-allocator']);
commit('c20', 'amara', '2026-07-02 16:00', 'test: synthetic DAG fixtures for layout\n', [['w', 'tests/graph/lanes.test.ts', LANES_TEST]]);
commit('c21', 'sam', '2026-07-06 10:00', 'chore(release): v0.1.0\n', [['r', 'package.json', '"version": "0.0.0"', '"version": "0.1.0"'], ['w', 'src/version.ts', "export const version = '0.1.0';\n"], ['w', 'CHANGELOG.md', CHANGELOG]]);
tag('v0.1.0', H.c21, 'sam', '2026-07-06 10:05', 'git-timeline 0.1.0\n\nFirst preview: static timeline snapshot (--format ascii).\n');

// July: TUI shell, hotfix branch, octopus merge
nb('feature/tui-shell');
commit('c23', 'kenji', '2026-07-08 10:30', 'ui: full-screen shell with header and footer\n', [['w', 'src/ui/App.tsx', APP], ['w', 'src/ui/Header.tsx', HEADER], ['w', 'src/ui/Footer.tsx', FOOTER]]);
nb('release/0.1', 'v0.1.0');
commit('c22', 'sam', '2026-07-09 15:45', 'fix: restore the terminal on SIGINT\n\nCtrl+C during the first frame left the terminal in the alternate\nscreen with the cursor hidden.\n', [['r', 'src/cli/index.ts', 'main(process.argv.slice(2)).then((code) => process.exit(code));\n', "const restore = () => process.stdout.write('\\x1b[?1049l\\x1b[?25h');\nprocess.on('SIGINT', () => {\n  restore();\n  process.exit(130);\n});\n\nmain(process.argv.slice(2)).then((code) => process.exit(code));\n"], ['w', 'src/version.ts', "export const version = '0.1.1';\n"]]);
tag('v0.1.1', H.c22);
sw('main');
merge('c24', 'amara', '2026-07-10 13:00', "Merge branch 'release/0.1'", ['release/0.1']);
sw('feature/tui-shell');
merge('c25', 'kenji', '2026-07-13 11:40', "Merge branch 'main' into feature/tui-shell", ['main']);
commit('c26', 'kenji', '2026-07-14 09:50', 'ui: keyboard actions and focus model\n', [['w', 'src/input/keyboard.ts', KEYBOARD], ['w', 'src/input/actions.ts', ACTIONS]]);
sw('experiment/canvas-renderer');
commit('c27', 'zoe', '2026-07-15 17:20', 'experiment: compare braille and box-drawing density\n', [['a', 'notes/braille.md', '\n## Density (15 Jul)\n\n| renderer    | commits per 80 cols | readable edges |\n| ----------- | ------------------- | -------------- |\n| box drawing | 40                  | yes            |\n| braille     | 160                 | straight only  |\n'], ['a', 'src/render/braille.ts', '\nexport const DOTS_PER_CELL = 8;\n']]);
sw('main');
commit('c28', 'mateo', '2026-07-16 10:10', 'refactor: move layout into src/timeline\n', [['mv', 'src/layout.ts', 'src/timeline/layout.ts'], ['r', 'src/timeline/layout.ts', "import type { Graph } from './graph/model.js';", "import type { Graph } from '../graph/model.js';"]]);
merge('c29', 'kenji', '2026-07-20 12:30', "Merge branch 'feature/tui-shell'", ['feature/tui-shell']);
del('feature/tui-shell');

nb('docs/keyboard');
commit('c30', 'amara', '2026-07-21 10:00', 'docs: document keyboard shortcuts\n', [['w', 'docs/keyboard.md', KEYDOC]]);
nb('chore/ci', 'main');
commit('c31', 'sam', '2026-07-21 14:30', 'chore: add CI script\n', [['w', 'scripts/ci.sh', CI], ['chmod', 'scripts/ci.sh', 0o755]]);
nb('test/fixtures', 'main');
commit('c32', 'mateo', '2026-07-22 09:20', 'test: add fixtures with unusual paths\n\nSpaces, quotes, a tab, a newline and non-ASCII names. diff-tree -z\nmust round-trip all of them.\n', [
  ['w', 'tests/fixtures/paths/with spaces and "quotes".txt', 'fixture: spaces and quotes\n'],
  ['w', 'tests/fixtures/paths/tab\there.txt', 'fixture: a tab in the name\n'],
  ['w', 'tests/fixtures/paths/new\nline.txt', 'fixture: a newline in the name\n'],
  ['w', 'tests/fixtures/paths/ünïcödé-名前.txt', 'fixture: non-ASCII name\n'],
]);
sw('main');
merge('c33', 'sam', '2026-07-22 11:30', "Merge branches 'docs/keyboard', 'chore/ci' and 'test/fixtures'", ['docs/keyboard', 'chore/ci', 'test/fixtures']);
for (const b of ['docs/keyboard', 'chore/ci', 'test/fixtures']) del(b);
commit('c34', 'zoe', '2026-07-24 16:00', 'fix(render): sanitise \x1b[31mcontrol\x1b[0m sequences\n\nThis subject deliberately contains raw ESC bytes, pasted from a\ncoloured terminal. A viewer has to show them, never execute them.\n', [['w', 'src/render/sanitize.ts', SANITIZE]]);
commit('c35', 'priya', '2026-07-27 10:00', 'docs: add demo screenshot\n', [['bin', 'docs/demo.png', png(64, 32)], ['a', 'README.md', '\n![git-timeline demo](docs/demo.png)\n']]);
commit('c36', 'amara', '2026-07-30 15:00', 'chore: vendor the sample repository as a submodule\n', [['w', '.gitmodules', '[submodule "vendor/sample-repo"]\n\tpath = vendor/sample-repo\n\turl = https://example.com/sample-repo.git\n'], ['gitlink', 'vendor/sample-repo', '3b18e512dba79e4c8300dd08aeb37f8e728b8dad']]);

// August: summer, one experiment commit, then the column fix
sw('experiment/canvas-renderer');
commit('c37', 'zoe', '2026-08-12 21:45', 'experiment: braille renderer at 4x density\n', [
  ['r', 'src/render/braille.ts', 'export function plot(points: Array<[number, number]>, cols: number, rows: number): string[] {', 'export function plot(points: Array<[number, number]>, cols: number, rows: number, scale = 4): string[] {'],
  ['r', 'src/render/braille.ts', '  for (const [x, y] of points) {\n', '  for (const [px, py] of points) {\n    const x = Math.round(px * scale), y = Math.round(py * scale);\n'],
]);
sw('main');
commit('c38', 'priya', '2026-08-24 09:30', 'timeline: give every commit its own column\n\nTwo commits in different lanes could share a column, which let a\nvertical connector run straight through an unrelated node. Placing\ncommits in time-respecting topological order with strictly increasing\ncolumns makes that impossible: every vertical belongs to one commit.\n', [['r', 'src/timeline/layout.ts', 'export function layout(graph: Graph): Layout {\n  return { x: new Map(), lane: new Map(), width: 0, lanes: graph.roots.length };\n}\n', '/**\n * Columns increase strictly in time-respecting topological order, so no two\n * commits share a column and every vertical connector belongs to one commit.\n */\nexport function layout(graph: Graph, secondsPerColumn: number, order: string[]): Layout {\n  const x = new Map<string, number>();\n  let last = -1;\n  const origin = order.length ? graph.commits.get(order[0])!.committerTime : 0;\n  for (const hash of order) {\n    const c = graph.commits.get(hash)!;\n    let col = Math.max(Math.floor((c.committerTime - origin) / secondsPerColumn), last + 1);\n    for (const p of c.parents) if (x.has(p)) col = Math.max(col, x.get(p)! + 2);\n    x.set(hash, col);\n    last = col;\n  }\n  return { x, lane: new Map(), width: last + 1, lanes: graph.roots.length };\n}\n']]);
commit('c39', 'sam', '2026-08-28 11:00', 'deps: bump typescript to 5.9\n', [['r', 'package.json', '"typescript": "^5.5.4"', '"typescript": "^5.9.2"']]);

// diff preview: authored over a week, rebased in one go (identical committer dates)
nb('feature/diff-preview');
commit('c40', 'mateo', '2026-08-25 17:30', 'diff: lazy changed-file list via diff-tree -z\n', [['w', 'src/git/changed-files.ts', CHANGED_FILES]], { cwhen: '2026-09-01 18:00' });
commit('c41', 'mateo', '2026-08-27 12:10', 'diff: bounded patch preview with truncation marker\n', [['w', 'src/git/diff.ts', DIFF]], { cwhen: '2026-09-01 18:00' });
commit('c42', 'mateo', '2026-08-31 19:45', 'ui: diff preview panel\n', [['w', 'src/ui/DiffPreview.tsx', DIFF_PREVIEW]], { cwhen: '2026-09-01 18:00' });
sw('main');
merge('c43', 'priya', '2026-09-02 10:00', "Merge branch 'feature/diff-preview'", ['feature/diff-preview']);
del('feature/diff-preview');
commit('c44', 'kenji', '2026-09-04 14:20', 'docs: 日本語のREADMEを追加\n', [['w', 'README.ja.md', README_JA]]);

nb('fix/unicode-paths');
commit('c45', 'zoe', '2026-09-08 10:30', 'fix: measure East Asian wide characters\n', [['w', 'src/utils/width.ts', WIDTH]]);
commit('c46', 'zoe', '2026-09-09 09:00', '🐛 fix: keep newlines in paths from diff-tree -z\n', [['r', 'src/git/changed-files.ts', "  return parseDiffTree(out.split('\\0'));\n", "  // Paths may contain newlines and tabs; only NUL is a safe separator.\n  const tokens = out.split('\\0');\n  if (tokens[tokens.length - 1] === '') tokens.pop();\n  return parseDiffTree(tokens);\n"]]);
sw('main');
merge('c47', 'amara', '2026-09-10 16:00', "Merge branch 'fix/unicode-paths'", ['fix/unicode-paths']);
del('fix/unicode-paths');

nb('feature/search');
commit('c48', 'amara', '2026-09-14 10:00', 'search: match subjects and bodies\n', [['w', 'src/search.ts', SEARCH]]);
commit('c49', 'amara', '2026-09-16 15:30', 'search: n/N cycle through matches\n', [['a', 'src/search.ts', "\n/** Next match in a direction, wrapping around. n goes back in time, N forward. */\nexport function nextMatch(matches: string[], current: string | null, dir: 1 | -1): string | null {\n  if (!matches.length) return null;\n  const i = current ? matches.indexOf(current) : -1;\n  return matches[(i + dir + matches.length) % matches.length];\n}\n"]]);
sw('main');
commit('c50', 'mateo', '2026-09-21 11:00', 'perf: bucket index for visible segments\n', [['w', 'src/timeline/viewport.ts', VIEWPORT]]);

// site: an orphan branch with its own root commit
git(['switch', '-q', '--orphan', 'site']);
commit('s01', 'priya', '2026-09-25 12:00', 'site: landing page\n', [['w', 'index.html', SITE_INDEX], ['w', 'style.css', SITE_CSS]]);
sw('main');

// Two commits on different branches with the exact same committer timestamp
commit('c51', 'mateo', '2026-09-30 16:00', 'timeline: zoom keeps the selection anchored\n', [['w', 'src/timeline/zoom.ts', ZOOM]]);
sw('experiment/canvas-renderer');
commit('c52', 'zoe', '2026-09-30 16:00', 'experiment: port the notes to the new layout API\n', [['a', 'notes/braille.md', '\n## Layout API (30 Sep)\n\nThe renderer now reads columns from layout.x and lanes from\nlayout.lane instead of recomputing them.\n']]);
sw('main');

// Author filter: one commit made on a laptop whose clock was two days behind
nb('feature/author-filter');
commit('c53', 'kenji', '2026-10-05 10:00', 'filter: dim commits by author\n', [['w', 'src/filters.ts', FILTERS]]);
commit('c54', 'kenji', '2026-10-03 11:00', 'filter: author picker overlay\n\nCommitted from a laptop whose clock was two days behind. The dates on\nthis commit are wrong; its parent link is not.\n', [['w', 'src/ui/AuthorPicker.tsx', AUTHOR_PICKER], ['a', 'src/filters.ts', '\nexport function toggleAuthor(filter: AuthorFilter, email: string, all: string[]): AuthorFilter {\n  const include = new Set(filter.include.size ? filter.include : all);\n  if (include.has(email)) include.delete(email);\n  else include.add(email);\n  return { include: include.size === all.length ? new Set() : include };\n}\n']]);
commit('c55', 'kenji', '2026-10-08 09:00', 'filter: keep the author selection across zoom\n', [['a', 'src/filters.ts', "\n/** Filters are keyed by email, not by layout position, so zooming keeps them. */\nexport const filterKey = (filter: AuthorFilter): string => [...filter.include].sort().join(',');\n"]]);
sw('main');

// Release week: a dense burst of commits
commit('c56', 'sam', '2026-10-12 09:10', 'chore(release): v0.2.0-rc.1\n', [['r', 'package.json', '"version": "0.1.0"', '"version": "0.2.0-rc.1"'], ['w', 'src/version.ts', "export const version = '0.2.0-rc.1';\n"]]);
tag('v0.2.0-rc.1', H.c56);
commit('c57', 'priya', '2026-10-12 14:55', 'fix: keep the selection visible after a resize\n', [['a', 'src/timeline/viewport.ts', '\nexport function ensureVisible(scrollX: number, x: number, width: number, margin = 4): number {\n  if (x < scrollX + margin) return Math.max(0, x - margin);\n  if (x > scrollX + width - 1 - margin) return x - width + 1 + margin;\n  return scrollX;\n}\n']]);
commit('c58', 'amara', '2026-10-12 06:02', 'test: exit codes for invalid repositories\n', [['w', 'tests/cli.test.ts', CLI_TEST]]);
commit('c59', 'sam', '2026-10-12 14:47', 'fix: ASCII fallback for rounded corners\n', [['w', 'src/render/glyphs.ts', GLYPHS]]);
commit('c60', 'priya', '2026-10-12 21:00', 'test: add a synthetic 2,000-commit fixture\n', [['w', 'tests/fixtures/large-dag.json', largeDag(2000)]]);
commit('c61', 'sam', '2026-10-13 08:55', 'docs: visual legend and limitations\n', [['a', 'README.md', '\n## Visual legend\n\n    ●  commit        ◆  merge commit     ◉  HEAD\n    ⚑  tag           ~name  branch name inferred from a merge message\n    ┄  abbreviated history (outside the date range or a shallow clone)\n\n## Limitations\n\n- Commits are placed by committer date, but never before their parents.\n  When clocks disagree with ancestry, ancestry wins and the commit is flagged.\n- Merge commits are diffed against their first parent.\n']]);
commit('c62', 'amara', '2026-10-13 05:40', 'fix: NO_COLOR turns lane colours off\n', [['w', 'src/render/theme.ts', THEME]]);
commit('c63', 'sam', '2026-10-13 15:15', 'chore(release): v0.2.0\n', [['r', 'package.json', '"version": "0.2.0-rc.1"', '"version": "0.2.0"'], ['w', 'src/version.ts', "export const version = '0.2.0';\n"], ['r', 'CHANGELOG.md', '# Changelog\n', '# Changelog\n\n## 0.2.0 (2026-10-13)\n\n- Interactive full-screen timeline with zoom and horizontal scrolling.\n- Lazy changed-file lists and bounded diff previews.\n- Branch filter, search, ASCII fallback and NO_COLOR support.\n']]);
tag('v0.2.0', H.c63, 'sam', '2026-10-13 15:20', 'git-timeline 0.2.0\n\nInteractive timeline, lazy diffs, branch filter.\n');
git(['branch', 'release/0.2', H.c63]);

git(['switch', '-q', 'site']);
commit('s02', 'priya', '2026-10-14 13:00', 'site: publish the 0.2.0 release notes\n', [['w', 'notes-0.2.0.html', '<!doctype html>\n<meta charset="utf-8">\n<title>git-timeline 0.2.0</title>\n<h1>0.2.0</h1>\n<ul>\n  <li>Interactive timeline with zoom</li>\n  <li>Lazy diff previews</li>\n  <li>Branch filter and search</li>\n</ul>\n'], ['a', 'index.html', '<p><a href="notes-0.2.0.html">0.2.0 release notes</a></p>\n']]);
sw('main');

commit('c64', 'mateo', '2026-10-19 10:00', 'refactor: remove the legacy list view\n', [['d', 'src/ui/legacy-list-view.ts']]);
// Clocks go back in London at 02:00 BST on 25 Oct: 01:30 happens twice.
commit('c65', 'sam', '2026-10-25 01:30', 'chore: nightly audit, no advisories\n', [['w', 'reports/audit.txt', 'audit 2026-10-25 01:30 BST: 0 advisories\n']], { fold: 0 });
commit('c66', 'sam', '2026-10-25 01:30', 'chore: nightly audit (the second 01:30 of the night)\n\nClocks went back at 02:00 BST, so both audits ran at 01:30 local\ntime, one hour apart.\n', [['a', 'reports/audit.txt', 'audit 2026-10-25 01:30 GMT: 0 advisories\n']], { fold: 1 });
commit('c67', 'amara', '2026-11-02 11:00', 'ui: help overlay lists every binding\n', [['w', 'src/ui/Help.tsx', HELP_TSX]]);
merge('c68', 'priya', '2026-11-04 09:30', "Merge branch 'feature/search'", ['feature/search']);

sw('feature/search');
commit('c69', 'amara', '2026-11-06 14:00', 'search: match hashes and authors too\n', [['r', 'src/search.ts', '  return commits.filter((c) => c.subject.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)).map((c) => c.hash);\n', '  return commits\n    .filter((c) => c.hash.startsWith(q) || c.subject.toLowerCase().includes(q) || c.body.toLowerCase().includes(q) || c.authorName.toLowerCase().includes(q))\n    .map((c) => c.hash);\n']]);
sw('feature/author-filter');
commit('c70', 'kenji', '2026-11-09 10:15', 'filter: combine the author filter with search\n', [['a', 'src/filters.ts', '\nexport function visibleMatches(matches: string[], commits: Map<string, Commit>, filter: AuthorFilter): string[] {\n  return matches.filter((h) => !isDimmed(filter, commits.get(h)!));\n}\n']]);
sw('experiment/canvas-renderer');
commit('c71', 'zoe', '2026-11-12 16:45', 'experiment: wip sixel probe\n', [['w', 'src/render/sixel.ts', "// WIP: detect sixel support with a device attributes query (DA1).\n// Not wired up; the probe must never block when the terminal stays silent.\nexport const DA1 = '\\x1b[c';\n\nexport function supportsSixel(reply: string): boolean {\n  return /\\?(\\d+;)*4(;\\d+)*c/.test(reply);\n}\n"]]);
git(['switch', '-q', 'site']);
commit('s03', 'priya', '2026-11-15 10:30', 'site: add a terminal demo\n', [['w', 'demo.txt', "main  *--*--*-----M--*--@  HEAD -> main\n         `--*--*--'\n"], ['a', 'index.html', '<pre id="demo"></pre>\n']]);
sw('main');
commit('c75', 'priya', '2026-11-17 09:40', 'timeline: boundary markers for date ranges\n', [['w', 'src/timeline/boundary.ts', BOUNDARY]]);
commit('c76', 'mateo', '2026-11-18 15:20', 'fix: preserve the viewport on resize\n', [['r', 'src/ui/App.tsx', "import { Footer } from './Footer.js';\n", "import { Footer } from './Footer.js';\nimport { useTerminalSize } from './useTerminalSize.js';\n"], ['r', 'src/ui/App.tsx', '  const { exit } = useApp();\n', '  const { exit } = useApp();\n  const { columns, rows } = useTerminalSize(); // re-layout without moving the selection\n']]);
commit('c77', 'sam', '2026-11-19 11:05', 'docs: architecture notes for lane allocation\n', [['w', 'docs/architecture.md', ARCH], ['a', 'README.md', '\nSee docs/architecture.md for how lanes and columns are allocated.\n']]);

// Remote-tracking refs and upstream config (no network: plain local refs)
git(['remote', 'add', 'origin', 'https://example.com/git-timeline.git']);
git(['update-ref', 'refs/remotes/origin/main', H.c68]);
git(['update-ref', 'refs/remotes/origin/feature/search', H.c69]);
git(['update-ref', 'refs/remotes/origin/release/0.2', H.c63]);
git(['update-ref', 'refs/remotes/origin/experiment/canvas-renderer', H.c52]);
git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
for (const b of ['main', 'feature/search', 'experiment/canvas-renderer']) {
  git(['config', 'branch.' + b + '.remote', 'origin']);
  git(['config', 'branch.' + b + '.merge', 'refs/heads/' + b]);
}

console.log(JSON.stringify({ repo: REPO, commits: Object.keys(H).length, head: git(['rev-parse', '--short', 'HEAD']) }));
