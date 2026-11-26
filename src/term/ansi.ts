// Turns the UI's screen buffer (a grid of characters, each with a list of style
// classes) into terminal escape sequences, in truecolor, 256 colours, 16 colours or
// none. Characters in the buffer were sanitised when they were drawn, so commit
// messages and paths can never smuggle escape sequences through here.
import { DARK, LIGHT, Palette, RGB } from './palette';

export type Depth = 'truecolor' | '256' | '16' | 'none';
export type Theme = 'dark' | 'light';

export interface ScreenLike {
  cols: number;
  rows: number;
  ch: string[];
  st: string[];
}

/** Picks a colour depth from the environment, the way most terminal tools do. */
export function detectDepth(env: NodeJS.ProcessEnv, isTTY: boolean): Depth {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 'none';
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return 'none';
  if (force === '3') return 'truecolor';
  if (force === '2') return '256';
  if (force === '1' || force === 'true') return '16';
  if (!isTTY) return 'none';
  const term = (env.TERM || '').toLowerCase();
  if (term === 'dumb') return 'none';
  const ct = (env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const prog = env.TERM_PROGRAM || '';
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby', 'rio'].includes(prog)) return 'truecolor';
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.ALACRITTY_WINDOW_ID || env.KONSOLE_VERSION) return 'truecolor';
  if (/kitty|alacritty|foot|wezterm|ghostty|direct/.test(term)) return 'truecolor';
  if (term.includes('256') || prog === 'Apple_Terminal' || env.TERM_PROGRAM === 'tmux') return '256';
  if (process.platform === 'win32') return 'truecolor'; // Windows 10+ consoles understand 24-bit colour
  return '16';
}

/** A light or dark terminal, from COLORFGBG when the terminal sets it. */
export function themeFromEnv(env: NodeJS.ProcessEnv): Theme | null {
  const v = env.COLORFGBG;
  if (!v) return null;
  const bg = Number(v.split(';').pop());
  if (!Number.isFinite(bg)) return null;
  return bg === 7 || bg === 15 || (bg >= 9 && bg <= 14 && bg !== 8) ? 'light' : 'dark';
}

/** Parses a reply to the OSC 11 background-colour query. */
export function themeFromOsc11(reply: string): Theme | null {
  const m = /\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!m) return null;
  const ch = (h: string) => parseInt(h, 16) / (Math.pow(16, h.length) - 1);
  const lum = 0.2126 * ch(m[1]) + 0.7152 * ch(m[2]) + 0.0722 * ch(m[3]);
  return lum > 0.5 ? 'light' : 'dark';
}

const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] * t + b[0] * (1 - t)), Math.round(a[1] * t + b[1] * (1 - t)), Math.round(a[2] * t + b[2] * (1 - t))];

const CUBE = [0, 95, 135, 175, 215, 255];
function to256(c: RGB): number {
  const near = (v: number) => { let best = 0; for (let i = 1; i < 6; i++) if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i; return best; };
  const [r, g, b] = c.map(near);
  const cube: RGB = [CUBE[r], CUBE[g], CUBE[b]];
  const avg = (c[0] + c[1] + c[2]) / 3;
  const gi = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gray: RGB = [8 + gi * 10, 8 + gi * 10, 8 + gi * 10];
  const d = (x: RGB) => (x[0] - c[0]) ** 2 + (x[1] - c[1]) ** 2 + (x[2] - c[2]) ** 2;
  return d(gray) < d(cube) ? 232 + gi : 16 + 36 * r + 6 * g + b;
}

const BASIC: Array<[number, RGB]> = [
  [30, [0, 0, 0]], [31, [205, 49, 49]], [32, [13, 188, 121]], [33, [229, 229, 16]], [34, [36, 114, 200]], [35, [188, 63, 188]], [36, [17, 168, 205]], [37, [229, 229, 229]],
  [90, [118, 118, 118]], [91, [241, 76, 76]], [92, [35, 209, 139]], [93, [245, 245, 67]], [94, [59, 142, 234]], [95, [214, 112, 214]], [96, [41, 184, 219]], [97, [255, 255, 255]],
];
function to16(c: RGB): number {
  // match on hue rather than raw distance, so muted greens stay green
  const max = Math.max(...c), min = Math.min(...c);
  if (max - min < 28) return max < 70 ? 30 : max < 150 ? 90 : max < 215 ? 37 : 97;
  let best = BASIC[1], bd = Infinity;
  for (const e of BASIC.slice(1, 7).concat(BASIC.slice(9, 15))) {
    const d = (e[1][0] - c[0]) ** 2 + (e[1][1] - c[1]) ** 2 + (e[1][2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  return best[0];
}

// Foreground and background classes in stylesheet order: a later class wins.
const FG: Record<string, [string, number?]> = {
  c0: ['c0'], c1: ['c1'], c2: ['c2'], c3: ['c3'], c4: ['c4'], c5: ['c5'], c6: ['c6'], c7: ['c7'],
  mu: ['t-mu'], ac: ['t-ac'], wa: ['wa'], ok: ['ok'], tg: ['tg'], ad: ['ad'], rm: ['rm'], hk: ['hk'], bx: ['t-bx'],
  tt: ['t-fg', 0.72], tv: ['t-ac'], sel: ['t-fg'], cr: ['t-fg'], mt: ['mt'],
};
const FG_ORDER = ['c', 'mu', 'ac', 'wa', 'ok', 'tg', 'ad', 'rm', 'hk', 'bx', 's', 'tt', 'tv', 'sel', 'cr', 'mt'];
const BG: Record<string, string> = { hd: 't-hd', ft: 't-ft', ov: 't-ov', adb: 'adb', rmb: 'rmb', cur: 't-cur', sel: 't-sel', cr: 't-sel' };
const BG_ORDER = ['w', 'x', 'hd', 'ft', 'ov', 'adb', 'rmb', 'cur', 'sel', 'cr'];

interface Parts { attrs: string; fg: string; bg: string }
interface Resolved { fg?: RGB; bg?: RGB; bold: boolean; italic: boolean; under: boolean; dim: boolean; inverse: boolean }

export class AnsiRenderer {
  private cache = new Map<string, Parts>();
  readonly palette: Palette;
  constructor(readonly depth: Depth, readonly theme: Theme) {
    this.palette = theme === 'light' ? LIGHT : DARK;
  }

  private resolve(st: string): Resolved {
    const P = this.palette;
    const r: Resolved = { bold: false, italic: false, under: false, dim: false, inverse: false };
    let fgRank = -1, bgRank = -1, alpha = 1, lane: RGB | undefined;
    let fgAlpha = 1;
    for (const k of st.split(' ')) {
      if (!k) continue;
      if (k === 'b') r.bold = true;
      else if (k === 'it') r.italic = true;
      else if (k === 'u') r.under = true;
      else if (k === 'd') alpha = 0.5;
      else if (k === 'inv') r.inverse = true;
      if (k === 'tv') r.bold = true;
      // foreground
      let fg: RGB | undefined, rank = -1, a = 1;
      const sm = /^s([a-zA-Z])([23])?$/.exec(k);
      if (sm) { fg = P['s' + sm[1]]; rank = FG_ORDER.indexOf('s'); a = sm[2] === '2' ? 0.62 : sm[2] === '3' ? 0.38 : 1; }
      else if (FG[k]) { fg = P[FG[k][0]]; a = FG[k][1] ?? 1; rank = FG_ORDER.indexOf(/^c\d$/.test(k) ? 'c' : k); }
      if (/^c\d$/.test(k)) lane = P[k];
      if (fg && rank >= fgRank) { r.fg = fg; fgRank = rank; fgAlpha = a; }
      // background
      let bg: RGB | undefined, br = -1;
      const wm = /^w([kg])(\d+|f)$/.exec(k);
      const xm = /^x([a-zA-Z])([23])?$/.exec(k);
      if (wm) { bg = P['w' + wm[1] + wm[2]]; br = BG_ORDER.indexOf('w'); }
      else if (xm) {
        const base = P['s' + xm[1]];
        if (base) bg = xm[2] ? mix(base, P['t-bg'], xm[2] === '2' ? 0.62 : 0.38) : base;
        br = BG_ORDER.indexOf('x');
      } else if (BG[k]) { bg = P[BG[k]]; br = BG_ORDER.indexOf(k); }
      if (bg && br >= bgRank) { r.bg = bg; bgRank = br; }
    }
    if (r.inverse && this.depth !== 'none' && this.depth !== '16') {
      r.bg = lane || P['t-fg'];
      r.fg = P['t-bg'];
      r.inverse = false;
      fgAlpha = 1;
    }
    const behind = r.bg || P['t-bg'];
    if (r.fg && fgAlpha < 1) r.fg = mix(r.fg, behind, fgAlpha);
    if (alpha < 1) {
      if (r.fg && this.depth !== '16' && this.depth !== 'none') r.fg = mix(r.fg, behind, alpha);
      else r.dim = true;
    }
    return r;
  }

  /** Attribute, foreground and background parts of a style, cached by class list. */
  private parts(st: string): Parts {
    let p = this.cache.get(st);
    if (p) return p;
    const r = this.resolve(st);
    const attrs: number[] = [];
    if (r.bold) attrs.push(1);
    if (r.dim) attrs.push(2);
    if (r.italic) attrs.push(3);
    if (r.under) attrs.push(4);
    let fg = '', bg = '';
    if (this.depth === 'truecolor') {
      if (r.fg) fg = '38;2;' + r.fg.join(';');
      if (r.bg) bg = '48;2;' + r.bg.join(';');
    } else if (this.depth === '256') {
      if (r.fg) fg = '38;5;' + to256(r.fg);
      if (r.bg) bg = '48;5;' + to256(r.bg);
    } else if (this.depth === '16') {
      // no room for tints: keep foreground colours and show selections as inverse
      if (r.fg) fg = String(to16(r.fg));
      if (/\b(sel|cr|inv)\b/.test(st)) r.inverse = true;
    }
    if (r.inverse) attrs.push(7);
    p = { attrs: attrs.join(';'), fg, bg };
    this.cache.set(st, p);
    return p;
  }

  /** A complete SGR sequence for a style (resets first). */
  sgr(st: string): string {
    const p = this.parts(st);
    return '\x1b[' + ['0', p.attrs, p.fg, p.bg].filter(Boolean).join(';') + 'm';
  }

  /** The shortest SGR sequence that changes style a into style b. */
  private change(a: Parts | null, b: Parts): string {
    if (!a || a.attrs !== b.attrs) return '\x1b[' + ['0', b.attrs, b.fg, b.bg].filter(Boolean).join(';') + 'm';
    const codes: string[] = [];
    if (a.fg !== b.fg) codes.push(b.fg || '39');
    if (a.bg !== b.bg) codes.push(b.bg || '49');
    return codes.length ? '\x1b[' + codes.join(';') + 'm' : '';
  }

  /** One screen row as a string, from column x0 up to (not including) x1. */
  row(scr: ScreenLike, y: number, x0 = 0, x1 = scr.cols): string {
    let out = '';
    let cur: Parts | null = null;
    let curSt: string | null = null;
    for (let x = x0; x < x1; x++) {
      const ch = cell(scr, y, x, x0, x1);
      if (ch === null) continue;
      const st = scr.st[y * scr.cols + x] || '';
      if (st !== curSt) {
        const next = this.parts(st);
        out += this.change(cur, next);
        cur = next;
        curSt = st;
      }
      out += ch;
    }
    return out + '\x1b[0m';
  }
}

// The character to print at a cell, or null for the hidden half of a wide character.
// A range that cuts a wide character in two prints a space instead.
function cell(scr: ScreenLike, y: number, x: number, x0: number, x1: number): string | null {
  const i = y * scr.cols + x;
  const ch = scr.ch[i];
  if (ch === '\0') return x === x0 ? ' ' : null;
  if (x === x1 - 1 && x + 1 < scr.cols && scr.ch[i + 1] === '\0') return ' ';
  return ch;
}

/** Plain text of a row range: no escape sequences at all. */
export function plainRow(scr: ScreenLike, y: number, x0 = 0, x1 = scr.cols): string {
  let out = '';
  for (let x = x0; x < x1; x++) {
    const ch = cell(scr, y, x, x0, x1);
    if (ch !== null) out += ch;
  }
  return out.replace(/\s+$/, '');
}
