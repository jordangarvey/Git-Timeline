// Command-line options: parsed by hand (no dependencies) and validated strictly, so a
// typo is an error rather than a silently empty timeline.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Format = 'interactive' | 'ascii' | 'json';

export interface Options {
  repo: string;
  since?: string;
  until?: string;
  maxCount: number;
  branch?: string;
  format?: Format;
  view: 'world' | 'graph';
  width?: number;
  ascii: boolean;
  color: boolean;
  theme: 'auto' | 'dark' | 'light';
  motion: boolean;
  mouse: boolean;
  journey: boolean;
  help: boolean;
  version: boolean;
}

export const DEFAULT_MAX = 20000;

export const HELP = `Usage: git-timeline [options] [path]

Draws a repository's history as a timeline in your terminal: one scrolling world
that moves through Earth's history, a new age every 7 commits, with branches as
trails. Read-only: it never changes refs, the index, the working tree or config.

Options:
  -C, --repo <path>     repository to open (default: the current directory)
      --since <when>    only commits after a date or a duration ago:
                        2026-01-31, 2026-01-31T09:00, 12h, 30d, 6w, 3m, 1y
      --until <when>    only commits before a date or a duration ago
  -n, --max-count <n>   at most the n newest commits (default ${DEFAULT_MAX}; 0 = all)
  -b, --branch <ref>    start with this branch, tag or commit selected
      --format <f>      interactive (default in a terminal), ascii or json
      --view <v>        world (default), or graph: the plain timeline, time to scale
      --width <n>       ascii format: cut the snapshot into bands n columns wide
                        (default: the terminal's width, or one strip when piped)
      --ascii           ASCII characters only
      --no-color        no colour (also when NO_COLOR is set)
      --theme <t>       auto (default), dark or light
      --no-motion       no animation: no gliding camera, water, smoke or traffic
      --no-mouse        leave the mouse to the terminal (keeps text selection)
      --journey         start with the journey from the first commit to HEAD
  -h, --help            show this help
  -V, --version         show the version

Keys:  ←/→ commit   ↑/↓ trail   [ ] zoom   Enter open   Esc back   p journey
       v world/graph   / search   f branches   a authors   d dates   ? all keys   q quit

Exit status: 0 on success, 1 when the repository can't be read, 2 for bad options.
`;

const VALUE_OPTS: Record<string, keyof Options> = {
  '-C': 'repo', '--repo': 'repo', '--since': 'since', '--until': 'until', '-n': 'maxCount', '--max-count': 'maxCount',
  '-b': 'branch', '--branch': 'branch', '--format': 'format', '--view': 'view', '--width': 'width', '--theme': 'theme',
};
const FLAGS: Record<string, [keyof Options, boolean]> = {
  '--ascii': ['ascii', true], '--no-color': ['color', false], '--no-colour': ['color', false], '--no-motion': ['motion', false],
  '--no-mouse': ['mouse', false], '--journey': ['journey', true], '-h': ['help', true], '--help': ['help', true], '-V': ['version', true], '--version': ['version', true],
};

/** A date or a duration ago, as an ISO 8601 timestamp git understands. */
export function parseWhen(v: string, opt: string, now = Date.now()): string {
  const s = v.trim();
  const dur = /^(\d+)\s*(h|d|w|m|y)$/i.exec(s);
  let ms: number;
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const d = new Date(now);
    if (unit === 'h') d.setTime(now - n * 3600e3);
    else if (unit === 'd') d.setDate(d.getDate() - n);
    else if (unit === 'w') d.setDate(d.getDate() - 7 * n);
    else if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    ms = d.getTime();
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getMonth() !== m - 1 || date.getDate() !== d) throw new UsageError(opt + ': not a valid date: ' + v);
    ms = date.getTime();
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    ms = Date.parse(s.replace(' ', 'T'));
  } else {
    throw new UsageError(opt + ' expects a date like 2026-01-31 or a duration like 30d, 6w, 3m or 1y; got ' + JSON.stringify(v));
  }
  if (!Number.isFinite(ms)) throw new UsageError(opt + ': not a valid date: ' + v);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseArgs(argv: string[], now = Date.now()): Options {
  const o: Options = { repo: '.', maxCount: DEFAULT_MAX, view: 'world', ascii: false, color: true, theme: 'auto', motion: true, mouse: true, journey: false, help: false, version: false };
  const raw: Partial<Record<keyof Options, string>> = {};
  let positional: string | null = null;
  let onlyPaths = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!onlyPaths && a === '--') { onlyPaths = true; continue; }
    if (onlyPaths || !a.startsWith('-') || a === '-') {
      if (positional !== null) throw new UsageError('unexpected argument: ' + a);
      positional = a;
      continue;
    }
    let value: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { value = a.slice(eq + 1); a = a.slice(0, eq); }
    if (FLAGS[a]) {
      if (value !== undefined) throw new UsageError(a + ' does not take a value');
      const [key, v] = FLAGS[a];
      (o as unknown as Record<string, unknown>)[key] = v;
      continue;
    }
    const key = VALUE_OPTS[a];
    if (!key) throw new UsageError('unknown option: ' + a);
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(a + ' needs a value');
      value = argv[++i];
    }
    raw[key] = value;
  }
  if (positional !== null) {
    if (raw.repo !== undefined) throw new UsageError('give the repository either as a path or with --repo, not both');
    raw.repo = positional;
  }
  if (raw.repo !== undefined) { if (!raw.repo) throw new UsageError('--repo needs a path'); o.repo = raw.repo; }
  if (raw.since !== undefined) o.since = parseWhen(raw.since, '--since', now);
  if (raw.until !== undefined) o.until = parseWhen(raw.until, '--until', now);
  if (o.since && o.until && o.since >= o.until) throw new UsageError('--since must be earlier than --until');
  if (raw.maxCount !== undefined) {
    if (!/^\d+$/.test(raw.maxCount)) throw new UsageError('--max-count expects a whole number; got ' + JSON.stringify(raw.maxCount));
    o.maxCount = Number(raw.maxCount);
  }
  if (raw.branch !== undefined) {
    if (!raw.branch || raw.branch.startsWith('-')) throw new UsageError('--branch expects a branch, tag or commit');
    o.branch = raw.branch;
  }
  if (raw.format !== undefined) {
    if (!['interactive', 'ascii', 'json'].includes(raw.format)) throw new UsageError('--format expects interactive, ascii or json; got ' + JSON.stringify(raw.format));
    o.format = raw.format as Format;
  }
  if (raw.view !== undefined) {
    if (raw.view !== 'world' && raw.view !== 'graph') throw new UsageError('--view expects world or graph; got ' + JSON.stringify(raw.view));
    o.view = raw.view;
  }
  if (raw.width !== undefined) {
    if (!/^\d+$/.test(raw.width)) throw new UsageError('--width expects a whole number of columns');
    o.width = Number(raw.width);
    if (o.width > 0 && o.width < 20) throw new UsageError('--width must be at least 20 (or 0 for one strip)');
  }
  if (raw.theme !== undefined) {
    if (!['auto', 'dark', 'light'].includes(raw.theme)) throw new UsageError('--theme expects auto, dark or light; got ' + JSON.stringify(raw.theme));
    o.theme = raw.theme as Options['theme'];
  }
  return o;
}
