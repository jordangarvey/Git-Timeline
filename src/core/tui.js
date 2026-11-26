/* git-timeline prototype · terminal UI
 *
 * Draws into a character-cell screen buffer and handles keys. No DOM here:
 * the browser shell turns the buffer into HTML; the tests read it as text.
 * Keyboard actions are separate from drawing: key() changes state, frame()
 * draws it.
 */
(function (root) {
  'use strict';
  const E = root.GTEngine || require('./engine.js');
  const WD = root.GTWorld || require('./world.js');
  const WZ = [14, 10, 7, 5, 4]; // world view zoom levels: commits per screen

  // ---------------------------------------------------------------- glyphs
  const UP = 1, DN = 2, LT = 4, RT = 8;
  const MASK_U = [' ', '╵', '╷', '│', '╴', '╯', '╮', '┤', '╶', '╰', '╭', '├', '─', '┴', '┬', '┼'];
  const MASK_A = [' ', '|', '|', '|', '-', "'", '.', '+', '-', '`', '.', '+', '-', '+', '+', '+'];
  const GU = {
    commit: '●', merge: '◆', head: '◉', dim: '·', lstub: '‹', rstub: '›', dashH: '┄', dashV: '┆', tag: '⚑', ell: '…',
    left: '◀', right: '▶', up: '▲', down: '▼', arrow: '→', branch: '•', ahead: '↑', behind: '↓', mod: '±', staged: '+', untracked: '?',
    clean: '✓', warn: '!', sep: '·', hline: '─', vline: '│', tick: '┬', box: ['╭', '╮', '╰', '╯', '─', '│'], on: '[x]', off: '[ ]', radioOn: '(•)', radioOff: '( )',
    enter: '⏎', minus: '−', cursor: '█', more: '›',
  };
  const GA = {
    commit: '*', merge: 'M', head: '@', dim: '.', lstub: '<', rstub: '>', dashH: '~', dashV: ':', tag: '#', ell: '~',
    left: '<', right: '>', up: '^', down: 'v', arrow: '->', branch: 'on', ahead: '+', behind: '-', mod: '*', staged: '+', untracked: '?',
    clean: 'clean', warn: '!', sep: '|', hline: '-', vline: '|', tick: '+', box: ['+', '+', '+', '+', '-', '|'], on: '[x]', off: '[ ]', radioOn: '(*)', radioOff: '( )',
    enter: 'enter', minus: '-', cursor: '_', more: '>',
  };
  // Colour classes are dropped (or turned into attributes) when colour is off.
  const NOCOLOR = { tt: 'b it', tv: 'b', sel: 'inv', mt: 'u b', hd: 'b', wa: 'b', mu: 'd', hk: 'd', tg: 'b', ac: 'b', cr: 'inv', ok: '', ad: '', rm: '', ln: '', cur: '', ft: '', ov: '', bx: '', key: 'b', adb: '', rmb: '' };

  function asciiPics(s) {
    let o = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x2400 && cp <= 0x241f) o += '^' + String.fromCharCode(cp - 0x2400 + 64);
      else if (cp === 0x2421) o += '^?';
      else if (cp === 0xfffd) o += '?';
      else o += ch;
    }
    return o;
  }

  // ---------------------------------------------------------------- screen buffer
  class Screen {
    constructor(cols, rows, ascii) {
      this.cols = cols; this.rows = rows; this.ascii = !!ascii;
      const n = cols * rows;
      this.ch = new Array(n).fill(' ');
      this.st = new Array(n).fill('');
      this.nd = new Array(n).fill(null);
      this.hits = [];
      this.next = Infinity; // time of the next scheduled change (message expiry)
    }
    clearAt(i, x) {
      if (this.ch[i] === '\0' && x > 0) this.ch[i - 1] = ' ';
      if (x + 1 < this.cols && this.ch[i + 1] === '\0') this.ch[i + 1] = ' ';
    }
    put(x, y, ch, st, nd) {
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
      const i = y * this.cols + x;
      this.clearAt(i, x);
      this.ch[i] = ch; this.st[i] = st || ''; this.nd[i] = nd || null;
    }
    putWide(x, y, ch, st) {
      if (y < 0 || y >= this.rows || x < 0) return 1;
      if (x + 1 >= this.cols) { this.put(x, y, ' ', st); return 1; }
      const i = y * this.cols + x;
      this.clearAt(i, x); this.clearAt(i + 1, x + 1);
      this.ch[i] = ch; this.st[i] = st || ''; this.nd[i] = null;
      this.ch[i + 1] = '\0'; this.st[i + 1] = st || ''; this.nd[i + 1] = null;
      return 2;
    }
    prep(s, raw) {
      let str = raw ? String(s) : E.sanitize(s);
      if (this.ascii) str = asciiPics(str);
      return str;
    }
    // Writes untrusted text safely; returns the width written.
    text(x, y, s, st, max, raw) {
      if (y < 0 || y >= this.rows) return 0;
      if (max == null) max = this.cols - x;
      if (max <= 0) return 0;
      let str = this.prep(s, raw);
      if (E.width(str) > max) str = E.truncate(str, max, this.ascii ? '~' : '…');
      let cx = x;
      for (const c of E.cells(str)) {
        if (cx - x + c.w > max) break;
        if (c.w === 2) cx += this.putWide(cx, y, c.ch, st);
        else { this.put(cx, y, c.ch, st); cx++; }
      }
      return cx - x;
    }
    fill(x, y, w, h, st) {
      for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) this.put(c, r, ' ', st);
    }
    get(x, y) { return this.ch[y * this.cols + x]; }
    addClass(x, y, cls) {
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows || !cls) return;
      const i = y * this.cols + x;
      this.st[i] = this.st[i] ? this.st[i] + ' ' + cls : cls;
    }
    toText() {
      const out = [];
      for (let y = 0; y < this.rows; y++) {
        let line = '';
        for (let x = 0; x < this.cols; x++) { const c = this.ch[y * this.cols + x]; if (c !== '\0') line += c; }
        out.push(line.replace(/\s+$/, ''));
      }
      return out.join('\n');
    }
  }

  // ---------------------------------------------------------------- dates
  const fmts = {};
  function dtf(o) { const k = JSON.stringify(o); return fmts[k] || (fmts[k] = new Intl.DateTimeFormat(undefined, o)); }
  const pad2 = (n) => String(n).padStart(2, '0');
  const D = (t) => new Date(t * 1000);
  function fmtLong(t) { return dtf({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(D(t)); }
  function fmtDay(t) { return dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(D(t)); }
  function fmtShort(t) { return dtf({ day: 'numeric', month: 'short' }).format(D(t)) + ' ' + pad2(D(t).getHours()) + ':' + pad2(D(t).getMinutes()); }
  function origZone(t, iso) {
    const mt = /([+-])(\d\d):?(\d\d)$/.exec(iso || '');
    if (!mt) return '';
    const off = (mt[1] === '-' ? -1 : 1) * (+mt[2] * 60 + +mt[3]);
    if (off === -D(t).getTimezoneOffset()) return '';
    const d = new Date((t + off * 60) * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' ' + mt[1] + mt[2] + ':' + mt[3];
  }
  function axisText(t, unit, first) {
    const d = D(t);
    if (unit === 'year') return String(d.getFullYear());
    if (unit === 'quarter') return 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ' + d.getFullYear();
    if (unit === 'month') return dtf({ month: 'short' }).format(d) + (first || d.getMonth() === 0 ? ' ' + d.getFullYear() : '');
    if (unit === 'week' || unit === 'day') return dtf({ day: 'numeric', month: 'short' }).format(d) + (first ? ' ' + d.getFullYear() : '');
    if (d.getHours() === 0 && d.getMinutes() === 0) return dtf({ weekday: 'short', day: 'numeric', month: 'short' }).format(d);
    return (first ? dtf({ day: 'numeric', month: 'short' }).format(d) + ' ' : '') + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  const bytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  // ---------------------------------------------------------------- patch parsing
  function parsePatch(text) {
    const out = [];
    let o = 0, n = 0, inHunk = false;
    for (const line of text.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { o = +h[1]; n = +h[2]; inHunk = true; out.push({ t: 'hunk', s: line }); continue; }
      if (!inHunk || line.startsWith('diff --git')) { inHunk = false; out.push({ t: 'meta', s: line }); continue; }
      if (line.startsWith('+')) out.push({ t: 'add', s: line, n: n++ });
      else if (line.startsWith('-')) out.push({ t: 'del', s: line, o: o++ });
      else if (line.startsWith('\\')) out.push({ t: 'meta', s: line });
      else out.push({ t: 'ctx', s: line, o: o++, n: n++ });
    }
    return out;
  }

  // ---------------------------------------------------------------- app
  class App {
    constructor(model, env) {
      this.m = model;
      this.env = env || {};
      this.s = {
        cols: 0, rows: 0, unicode: true, color: true, zoom: 2, scrollX: 0, scrollY: 0, sel: null,
        focus: 'timeline', detailOpen: false, fileSel: 0, fileScroll: 0, diffPath: null, diffScroll: 0, diffX: 0,
        overlay: null, ovSel: 0, ovScroll: 0, hidden: new Set(), authors: null, range: null,
        search: { prompt: false, input: '', query: '' }, msg: null, exited: false, inited: false,
        view: 'world', wzoom: 2, camX: null, smooth: false, phase: 0, tour: null,
      };
      this.s.range = this.ranges()[0];
      this.L = null; this.lkey = ''; this.mkey = ''; this.matches = []; this.matchSet = new Set();
      this.nc = {}; this.patches = new Map(); this.G = GU; this.lastHits = []; this.nodeHits = [];
    }

    now() { return this.env.now ? this.env.now() : Date.now(); }
    S(cls) {
      if (this.s.color || !cls) return cls;
      let c = this.nc[cls];
      if (c === undefined) {
        c = cls.split(' ').map((k) => (/^c\d$/.test(k) || /^(e|wk|wg)(\d+|f)$/.test(k) || /^x[a-zA-Z]\d?$/.test(k) ? '' : k === 'sf' || k === 'sz' ? 'd' : /^s[a-zA-Z]\d?$/.test(k) ? '' : k in NOCOLOR ? NOCOLOR[k] : k)).filter(Boolean).join(' ');
        this.nc[cls] = c;
      }
      return c;
    }
    short(h) { return h ? h.slice(0, this.m.shortLen) : ''; }

    // ------------------------------------------------------------ derived data
    world() { return this.s.view === 'world'; }
    // World view: every commit gets an equal slot, sized so a screen shows a few commits.
    spacing() { return Math.max(5, Math.floor(Math.max(20, this.s.cols || 80) / WZ[this.s.wzoom])); }
    layout() {
      const s = this.s;
      const sp = this.world() ? this.spacing() : 0;
      const key = [s.view, sp, s.zoom, s.unicode ? 'u' : 'a', Array.from(s.hidden).sort().join(','), s.range.since, s.range.until].join('|');
      if (key !== this.lkey) {
        const old = this.L;
        this.L = E.layout(this.m, { sec: E.ZOOMS[s.zoom].sec, spacing: sp, pad: sp, hidden: s.hidden, since: s.range.since, until: s.range.until, ascii: !s.unicode, now: this.m.meta.capturedAt });
        this.L.spacing = sp;
        // world view resized: keep the selected commit at the same place on screen
        if (sp && old && old.spacing && old.spacing !== sp && s.sel && old.idx.has(s.sel) && this.L.idx.has(s.sel)) {
          s.scrollX = this.L.xOf.get(s.sel) - Math.round((old.xOf.get(s.sel) - s.scrollX) * sp / old.spacing);
          s.camX = s.scrollX;
        }
        this.lkey = key;
        this.mkey = '';
        this.captions(this.L);
      }
      return this.L;
    }
    captions(L) {
      for (let l = 0; l < L.lanes; l++) {
        const ms = (L.members[l] || []).slice().sort((a, b) => a.start - b.start);
        ms.forEach((ch, i) => { ch.captionMax = i + 1 < ms.length ? ms[i + 1].start - ch.start - 1 : 40; });
      }
    }
    ranges() {
      const m = this.m;
      const now = (m.meta && m.meta.capturedAt) || Math.floor(Date.now() / 1000);
      const out = [{ id: 'all', label: 'All history', since: null, until: null }];
      for (const d of [7, 30, 90]) out.push({ id: d + 'd', label: 'Last ' + d + ' days', since: now - d * 86400, until: null });
      const tags = m.refs.filter((r) => r.kind === 'tag').map((r) => ({ r, t: m.commits.get(r.target).committerTime })).sort((a, b) => a.t - b.t);
      if (tags.length) {
        const last = tags[tags.length - 1], first = tags[0];
        out.push({ id: 'since-' + last.r.short, label: 'Since ' + last.r.short + ' (' + fmtDay(last.t) + ')', since: last.t, until: null });
        if (first !== last) out.push({ id: 'until-' + first.r.short, label: 'Up to ' + first.r.short + ' (' + fmtDay(first.t) + ')', since: null, until: first.t });
      }
      return out;
    }
    files(h) { if (!h) return { status: 'none' }; return this.env.files ? this.env.files(h) : { status: 'unavailable' }; }
    patch(h, path) {
      if (!this.env.patch) return { status: 'unavailable' };
      const p = this.env.patch(h, path);
      if (p.status !== 'ready') return p;
      const k = h + '\0' + path;
      let parsed = this.patches.get(k);
      if (!parsed) { parsed = parsePatch(p.patch.text); this.patches.set(k, parsed); }
      return { status: 'ready', patch: p.patch, lines: parsed };
    }
    navOk(h) { return !this.s.authors || this.s.authors.has(this.m.commits.get(h).authorKey); }
    filtersActive() { return this.s.hidden.size > 0 || !!this.s.authors || this.s.range.id !== 'all'; }

    // ------------------------------------------------------------ geometry
    geom() {
      const { cols, rows } = this.s;
      const g = { cols, rows };
      const avail = Math.max(0, rows - 2);
      g.compact = avail < 21 || cols < 44;
      if (this.world()) return this.worldGeom(g, avail);
      // the timeline gets the rows its lanes need (at least 40%); the panel gets the rest
      g.band = 1;
      const need = 2 + g.band + 2 * Math.max(1, this.L ? this.L.lanes : 4) + 1;
      let ph;
      if (g.compact) ph = avail >= 12 ? 3 : 0;
      else if (this.s.focus === 'diff') ph = Math.max(Math.floor(avail * 0.62), Math.min(avail - 9, 14));
      else ph = avail - Math.max(Math.min(avail - 9, need), Math.ceil(avail * 0.4));
      g.tl = { x: 0, y: 1, w: cols, h: avail - ph };
      g.panel = { x: 0, y: 1 + avail - ph, w: cols, h: ph };
      g.full = g.compact && this.s.detailOpen ? { x: 0, y: 1, w: cols, h: avail } : null;
      g.gutter = cols >= 50 ? Math.max(9, Math.min(18, Math.round(cols * 0.14))) : 0;
      g.tw = Math.max(1, cols - g.gutter);
      g.laneRows = Math.max(0, g.tl.h - 2 - g.band);
      g.visLanes = Math.max(1, Math.ceil(g.laneRows / 2));
      return g;
    }
    // World view: date row, sky, the trails (main path lowest), ground; a commit box below.
    worldGeom(g, avail) {
      const s = this.s, { cols } = g;
      g.world = true;
      const hud = avail >= 30 ? 5 : avail >= 14 ? 4 : 0;
      let ph = hud;
      if (!g.compact && s.focus === 'diff') ph = Math.max(Math.floor(avail * 0.62), Math.min(avail - 9, 14));
      else if (!g.compact && s.focus === 'files') ph = Math.max(hud, Math.floor(avail * 0.45));
      g.tl = { x: 0, y: 1, w: cols, h: avail - ph };
      g.panel = { x: 0, y: 1 + avail - ph, w: cols, h: ph };
      g.full = g.compact && s.detailOpen ? { x: 0, y: 1, w: cols, h: avail } : null;
      g.gutter = 0;
      g.tw = Math.max(1, cols);
      const H = g.tl.h;
      g.groundRows = H >= 30 ? 4 : H >= 20 ? 3 : 2;
      g.yGround = g.tl.y + H - g.groundRows - 1;
      const lanes = Math.max(1, this.L ? this.L.lanes : 1);
      const room = Math.max(0, g.yGround - g.tl.y - 6); // keep the date row and some sky above the top trail
      g.gap = (lanes - 1) * 4 <= room - 3 ? 4 : (lanes - 1) * 3 <= room ? 3 : 2;
      g.visLanes = Math.max(1, Math.min(lanes, Math.floor(room / g.gap) + 1));
      g.band = 1;
      g.laneRows = g.visLanes * 2;
      return g;
    }
    clamp(g) {
      const L = this.L, s = this.s;
      if (g.world) {
        const lo = -Math.floor(g.tw * 0.45), hi = Math.max(lo, L.width + Math.floor(g.tw * 0.25) - g.tw);
        s.scrollX = Math.max(lo, Math.min(Math.round(s.scrollX), hi));
        s.scrollY = Math.max(0, Math.min(Math.round(s.scrollY), Math.max(0, L.lanes - g.visLanes)));
        return;
      }
      s.scrollX = Math.max(0, Math.min(Math.round(s.scrollX), Math.max(0, L.width - g.tw)));
      s.scrollY = Math.max(0, Math.min(Math.round(s.scrollY), Math.max(0, L.lanes - g.visLanes)));
    }
    init(g) {
      const s = this.s;
      s.inited = true;
      if (g.world) {
        const L = this.layout();
        g = this.geom();
        const head = this.m.head && this.m.head.hash;
        if (!s.sel || !L.idx.has(s.sel)) s.sel = head && L.idx.has(head) ? head : L.nodes.length ? L.nodes[L.nodes.length - 1].h : null;
        if (s.sel) s.scrollX = L.xOf.get(s.sel) - Math.floor(g.tw * 0.6);
        this.clamp(g);
        this.follow(g);
        s.camX = s.scrollX;
        return;
      }
      const target = (60 * 86400) / Math.max(20, g.tw); // about two months of history per screen
      let best = 2, bd = Infinity;
      E.ZOOMS.forEach((z, i) => { const d = Math.abs(Math.log(z.sec / target)); if (d < bd) { bd = d; best = i; } });
      s.zoom = best;
      const L = this.layout();
      g = this.geom();
      const head = this.m.head && this.m.head.hash;
      if (!s.sel || !L.idx.has(s.sel)) s.sel = head && L.idx.has(head) ? head : L.nodes.length ? L.nodes[L.nodes.length - 1].h : null;
      s.scrollX = L.width; // open on the most recent history
      this.clamp(g);
      this.follow(g);
    }
    follow(g) {
      g = g || this.geom();
      const L = this.L, s = this.s;
      const i = L.idx.get(s.sel);
      if (i === undefined) return;
      const n = L.nodes[i];
      const margin = g.world ? Math.floor(g.tw * 0.25) : Math.min(10, Math.floor(g.tw / 5));
      if (n.x < s.scrollX + margin) s.scrollX = n.x - margin;
      else if (n.x > s.scrollX + g.tw - 1 - margin) s.scrollX = n.x - (g.tw - 1 - margin);
      if (n.lane < s.scrollY) s.scrollY = n.lane;
      else if (n.lane >= s.scrollY + g.visLanes) s.scrollY = n.lane - g.visLanes + 1;
      this.clamp(g);
    }
    lanesFit() { const L = this.layout(); return L.lanes <= this.geom().visLanes; }
    hitAt(x, y) { for (let i = this.lastHits.length - 1; i >= 0; i--) { const h = this.lastHits[i]; if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h; } return null; }
    inView(n, g) { const s = this.s; return n.x >= s.scrollX && n.x < s.scrollX + g.tw && n.lane >= s.scrollY && n.lane < s.scrollY + g.visLanes; }

    // ------------------------------------------------------------ actions
    flash(text, kind) { this.s.msg = { text, kind: kind || 'info', until: this.now() + 2800 }; }
    select(h) {
      const s = this.s;
      if (!h) return;
      if (s.sel !== h) {
        s.sel = h; s.fileSel = 0; s.fileScroll = 0; s.diffPath = null; s.diffScroll = 0; s.diffX = 0;
        if (s.focus === 'diff') s.focus = 'files';
      }
      this.follow();
    }
    step(dir) {
      const L = this.layout(), s = this.s, g = this.geom();
      if (!L.nodes.length) return;
      let i = L.idx.get(s.sel);
      if (i === undefined || !this.inView(L.nodes[i], g)) {
        const mid = s.scrollX + g.tw / 2;
        let best = null, bd = Infinity;
        for (const n of E.nodesIn(L, s.scrollX, s.scrollX + g.tw - 1)) {
          if (n.lane < s.scrollY || n.lane >= s.scrollY + g.visLanes || !this.navOk(n.h)) continue;
          const d = Math.abs(n.x - mid);
          if (d < bd) { bd = d; best = n; }
        }
        if (best) { this.select(best.h); return; }
        if (i === undefined) i = dir > 0 ? -1 : L.nodes.length;
      }
      for (let j = i + dir; j >= 0 && j < L.nodes.length; j += dir) if (this.navOk(L.nodes[j].h)) { this.select(L.nodes[j].h); return; }
      this.flash(dir < 0 ? 'That is the oldest commit shown.' : 'That is the newest commit shown.');
    }
    laneMove(dir) {
      const L = this.layout(), s = this.s;
      const i = L.idx.get(s.sel);
      if (i === undefined) { this.step(dir); return; }
      const cur = L.nodes[i];
      for (let l = cur.lane + dir; l >= 0 && l < L.lanes; l += dir) {
        const n = E.nearestInLane(L, l, cur.x, (h) => this.navOk(h));
        if (n) { this.select(n.h); return; }
      }
      this.flash((this.world() ? dir > 0 : dir < 0) ? 'No ' + (this.world() ? 'trail' : 'lane') + ' above.' : 'No ' + (this.world() ? 'trail' : 'lane') + ' below.');
    }
    pan(frac) { const g = this.geom(); this.s.scrollX += Math.round(g.tw * frac) || (frac < 0 ? -1 : 1); this.clamp(g); }
    panBy(dx, dy) { const g = this.geom(); this.s.scrollX += dx; this.s.scrollY += dy; this.clamp(g); }
    panLanes(d) { const g = this.geom(); this.s.scrollY += d; this.clamp(g); }
    zoomBy(dir) {
      const s = this.s, g = this.geom();
      if (g.world) {
        const nz = Math.max(0, Math.min(WZ.length - 1, s.wzoom + dir));
        if (nz === s.wzoom) { this.flash(dir > 0 ? 'Already at the closest zoom.' : 'Already at the widest zoom.'); return; }
        const L0 = this.layout();
        const n0 = L0.idx.has(s.sel) ? L0.nodes[L0.idx.get(s.sel)] : null;
        const off = n0 ? n0.x - s.scrollX : Math.floor(g.tw / 2);
        const rank = n0 ? L0.idx.get(s.sel) : Math.max(0, Math.round((s.scrollX + g.tw / 2 - (L0.spacing || 1)) / (L0.spacing || 1)));
        s.wzoom = nz;
        const L1 = this.layout();
        const n1 = n0 && L1.idx.has(s.sel) ? L1.nodes[L1.idx.get(s.sel)] : L1.nodes[Math.min(L1.nodes.length - 1, rank)];
        if (n1) s.scrollX = n1.x - off;
        this.clamp(this.geom());
        s.camX = s.scrollX;
        this.flash('Zoom: about ' + WZ[nz] + ' commits per screen.');
        return;
      }
      const nz = Math.max(0, Math.min(E.ZOOMS.length - 1, s.zoom + dir));
      if (nz === s.zoom) { this.flash(dir > 0 ? 'Already at the closest zoom.' : 'Already at the widest zoom.'); return; }
      const L0 = this.layout();
      const n0 = L0.idx.has(s.sel) ? L0.nodes[L0.idx.get(s.sel)] : null;
      const anchor = n0 && this.inView(n0, g) ? { off: n0.x - s.scrollX } : { t: E.timeAt(L0, s.scrollX + g.tw / 2) };
      s.zoom = nz;
      const L1 = this.layout();
      if (anchor.off != null && L1.idx.has(s.sel)) s.scrollX = L1.xOf.get(s.sel) - anchor.off;
      else s.scrollX = Math.round(E.colAt(L1, anchor.t) - g.tw / 2);
      this.clamp(g);
      this.flash('Zoom: 1 column = ' + E.ZOOMS[nz].long + '.');
    }
    selectHead() {
      const L = this.layout(), h = this.m.head && this.m.head.hash;
      if (!h) { this.flash('HEAD has no commit yet.'); return; }
      if (!L.idx.has(h)) { this.flash('HEAD is hidden by the current filters.', 'warn'); return; }
      this.select(h);
    }
    selectEdge(dir) {
      const L = this.layout();
      const arr = dir < 0 ? L.nodes : L.nodes.slice().reverse();
      const n = arr.find((x) => this.navOk(x.h));
      if (n) this.select(n.h);
    }
    openFiles() {
      if (!this.s.sel) return;
      const g = this.geom();
      this.s.focus = 'files';
      if (g.compact) this.s.detailOpen = true;
    }
    backToTimeline() { this.s.focus = 'timeline'; this.s.detailOpen = false; }
    fileMove(d) {
      const f = this.files(this.s.sel);
      if (f.status !== 'ready' || !f.files.length) return;
      this.s.fileSel = Math.max(0, Math.min(f.files.length - 1, this.s.fileSel + d));
    }
    openDiff(i) {
      const f = this.files(this.s.sel);
      if (f.status !== 'ready' || !f.files.length) { this.flash(f.status === 'loading' ? 'Still loading changed files…' : 'No files to show.'); return; }
      if (i != null) this.s.fileSel = Math.max(0, Math.min(f.files.length - 1, i));
      this.s.diffPath = f.files[this.s.fileSel].path;
      this.s.diffScroll = 0; this.s.diffX = 0;
      this.s.focus = 'diff';
      if (this.geom().compact) this.s.detailOpen = true;
    }
    diffBy(d) {
      const p = this.s.diffPath ? this.patch(this.s.sel, this.s.diffPath) : null;
      const total = p && p.status === 'ready' ? p.lines.length + (p.patch.truncated ? 1 : 0) : 0;
      this.s.diffScroll = Math.max(0, Math.min(Math.max(0, total - 3), this.s.diffScroll + d));
    }
    cycleFocus(dir) {
      const order = ['timeline', 'files'].concat(this.s.diffPath ? ['diff'] : []);
      const i = order.indexOf(this.s.focus);
      const next = order[(i + dir + order.length) % order.length];
      if (next === 'timeline') this.backToTimeline();
      else if (next === 'files') this.openFiles();
      else { this.s.focus = 'diff'; if (this.geom().compact) this.s.detailOpen = true; }
    }
    toggleView() {
      const s = this.s;
      s.view = this.world() ? 'graph' : 'world';
      s.inited = false;
      this.flash(this.world() ? 'World view: every ' + WD.PER_ERA + ' commits, a new age of Earth. v for the graph.' : 'Graph view: the plain timeline, time to scale. v for the world.');
    }
    // The journey: fly from the first commit to HEAD, camera ahead of the traveller.
    tourStart() {
      const L = this.layout();
      if (!L.nodes.length) return;
      const head = this.m.head && this.m.head.hash;
      const end = head && L.idx.has(head) ? L.idx.get(head) : L.nodes.length - 1;
      Object.assign(this.s, { focus: 'timeline', detailOpen: false, overlay: null });
      this.s.tour = { i: 0, end, step: this.world() ? 1 : Math.max(1, Math.ceil(L.nodes.length / 110)), wait: 0 };
      this.tourGo(0);
      this.s.msg = { text: 'Travelling through time. Any key stops.', kind: 'info', until: this.now() + 600000 };
    }
    tourGo(i) {
      const L = this.layout(), g = this.geom();
      const n = L.nodes[i];
      this.select(n.h);
      this.s.scrollX = n.x - Math.floor(g.tw * 0.45);
      this.clamp(g);
    }
    tourStep() {
      const t = this.s.tour;
      if (!t) return false;
      if (this.world() && ++t.wait < 2) return true; // the camera glides; a new commit every other tick
      t.wait = 0;
      t.i = Math.min(t.end, t.i + t.step);
      this.tourGo(t.i);
      if (t.i < t.end) return true;
      this.s.tour = null;
      this.follow();
      this.flash('Arrived at HEAD, in the ' + WD.eraOf(this.m, this.s.sel).era.name + '. ' + (this.s.unicode ? '←' : 'Left') + ' goes back in time.');
      return false;
    }
    tourStop() { if (this.s.tour) { this.s.tour = null; this.s.msg = null; } }
    quit() { this.s.exited = true; this.s.overlay = null; this.s.search.prompt = false; }
    relaunch() {
      const keep = { unicode: this.s.unicode, color: this.s.color, cols: this.s.cols, rows: this.s.rows, view: this.s.view, smooth: this.s.smooth };
      const fresh = new App(this.m, this.env);
      Object.assign(this.s, fresh.s, keep);
      this.lkey = ''; this.mkey = '';
    }
    afterFilter() {
      const L = this.layout(), s = this.s;
      if (!L.idx.has(s.sel) || !this.navOk(s.sel)) {
        const c = this.m.commits.get(s.sel);
        const t = c ? c.committerTime : Infinity;
        let best = null, bd = Infinity;
        for (const n of L.nodes) {
          if (!this.navOk(n.h)) continue;
          const d = Math.abs(this.m.commits.get(n.h).committerTime - t);
          if (d < bd) { bd = d; best = n; }
        }
        if (best) this.select(best.h);
        else { s.sel = L.nodes.length ? s.sel : null; }
      }
      this.follow();
    }

    // ------------------------------------------------------------ search
    searchStart() { this.s.search.prompt = true; this.s.search.input = ''; if (this.env.onPrompt) this.env.onPrompt(true); }
    searchInput(v) { this.s.search.input = String(v); }
    searchCancel() { this.s.search.prompt = false; if (this.env.onPrompt) this.env.onPrompt(false); }
    searchCommit() {
      const q = this.s.search.input.trim();
      this.s.search.prompt = false;
      if (this.env.onPrompt) this.env.onPrompt(false);
      this.s.search.query = q;
      this.mkey = '';
      this.computeMatches();
      if (!q) { this.flash('Search cleared.'); return; }
      if (!this.matches.length) { this.flash('No commits match “' + q + '”.', 'warn'); return; }
      if (this.matchSet.has(this.s.sel)) this.flash(this.matches.length + ' matches. n: older, N: newer.');
      else this.searchNext(1);
    }
    clearSearch() { this.s.search.query = ''; this.mkey = ''; this.computeMatches(); this.flash('Search cleared.'); }
    findMatches(q) {
      const L = this.layout();
      q = q.trim().toLowerCase();
      if (!q) return [];
      const hex = /^[0-9a-f]{4,40}$/.test(q);
      return L.nodes.filter((n) => {
        const c = this.m.commits.get(n.h);
        return (hex && c.hash.startsWith(q)) || c.subject.toLowerCase().includes(q) || c.body.toLowerCase().includes(q) || c.authorName.normalize('NFC').toLowerCase().includes(q);
      }).map((n) => n.h);
    }
    computeMatches() {
      const key = this.lkey + '|' + this.s.search.query;
      if (key === this.mkey) return;
      this.mkey = key;
      this.matches = this.findMatches(this.s.search.query);
      this.matchSet = new Set(this.matches);
    }
    searchNext(dir) {
      this.layout();
      this.computeMatches();
      if (!this.s.search.query) { this.flash('Nothing to search for yet. Press / first.'); return; }
      if (!this.matches.length) { this.flash('No matches.', 'warn'); return; }
      const L = this.L;
      const cur = L.idx.has(this.s.sel) ? L.xOf.get(this.s.sel) : Infinity;
      let target = null, wrapped = false;
      if (dir > 0) {
        for (let i = this.matches.length - 1; i >= 0; i--) if (L.xOf.get(this.matches[i]) < cur) { target = this.matches[i]; break; }
        if (!target) { target = this.matches[this.matches.length - 1]; wrapped = true; }
      } else {
        for (const h of this.matches) if (L.xOf.get(h) > cur) { target = h; break; }
        if (!target) { target = this.matches[0]; wrapped = true; }
      }
      this.select(target);
      const k = this.matches.length - this.matches.indexOf(target);
      this.flash('Match ' + k + ' of ' + this.matches.length + (wrapped ? ' (wrapped around)' : '') + '. n: older, N: newer.');
    }

    // ------------------------------------------------------------ overlays
    openOverlay(name) {
      const s = this.s;
      s.overlay = name; s.ovSel = 0; s.ovScroll = 0;
      if (name === 'dates') s.ovSel = Math.max(0, this.ranges().findIndex((r) => r.id === s.range.id));
    }
    ovItems() {
      const s = this.s, m = this.m;
      if (s.overlay === 'branches') {
        const groups = [['Local branches', 'branch'], ['Remote-tracking', 'remote'], ['Tags', 'tag'], ['Detached', 'head']];
        const items = [];
        for (const [title, kind] of groups) {
          const refs = m.refs.filter((r) => r.kind === kind);
          if (!refs.length) continue;
          items.push({ header: title });
          for (const r of refs) items.push({ ref: r, on: !s.hidden.has(r.name), label: r.short, hint: this.short(r.target) + '  ' + fmtDay(m.commits.get(r.target).committerTime).padStart(12) });
        }
        return items;
      }
      if (s.overlay === 'authors') return m.authors.map((a) => ({ author: a, on: !s.authors || s.authors.has(a.key), label: a.name, hint: a.count + (a.count === 1 ? ' commit' : ' commits') }));
      if (s.overlay === 'dates') return this.ranges().map((r) => ({ range: r, on: r.id === s.range.id, label: r.label, radio: true }));
      return [];
    }
    ovToggle(item) {
      const s = this.s, m = this.m;
      if (!item || item.header) return;
      if (item.ref) {
        if (s.hidden.has(item.ref.name)) s.hidden.delete(item.ref.name); else s.hidden.add(item.ref.name);
        this.afterFilter();
      } else if (item.author) {
        const all = m.authors.map((a) => a.key);
        const set = new Set(s.authors || all);
        if (set.has(item.author.key)) set.delete(item.author.key); else set.add(item.author.key);
        s.authors = set.size === all.length ? null : set;
        this.afterFilter();
      } else if (item.range) {
        s.range = item.range;
        this.afterFilter();
        s.overlay = null;
        this.flash(item.range.id === 'all' ? 'Showing all history.' : 'Date range: ' + item.range.label + '.');
      }
    }
    ovBulk(mode) {
      const s = this.s, m = this.m, items = this.ovItems().filter((x) => !x.header);
      const cur = items[s.ovSel];
      if (s.overlay === 'branches') {
        if (mode === 'all') s.hidden.clear();
        else if (mode === 'none') s.hidden = new Set(m.refs.map((r) => r.name));
        else if (mode === 'only' && cur) s.hidden = new Set(m.refs.filter((r) => r !== cur.ref).map((r) => r.name));
      } else if (s.overlay === 'authors') {
        if (mode === 'all') s.authors = null;
        else if (mode === 'none') s.authors = new Set();
        else if (mode === 'only' && cur) s.authors = new Set([cur.author.key]);
      } else return;
      this.afterFilter();
    }
    overlayKey(k) {
      const s = this.s;
      if (s.overlay === 'help') { if (k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta') s.overlay = null; return true; }
      const items = this.ovItems().filter((x) => !x.header);
      switch (k) {
        case 'ArrowUp': case 'k': s.ovSel = Math.max(0, s.ovSel - 1); return true;
        case 'ArrowDown': case 'j': s.ovSel = Math.min(items.length - 1, s.ovSel + 1); return true;
        case 'Home': s.ovSel = 0; return true;
        case 'End': s.ovSel = items.length - 1; return true;
        case ' ': this.ovToggle(items[s.ovSel]); return true;
        case 'Enter': if (s.overlay === 'dates') this.ovToggle(items[s.ovSel]); else s.overlay = null; return true;
        case 'Escape': case 'q': case 'f': case 'a': case 'd':
          if (k === 'a' && s.overlay !== 'dates') { this.ovBulk('all'); return true; }
          s.overlay = null; return true;
        case 'n': this.ovBulk('none'); return true;
        case 'o': this.ovBulk('only'); return true;
      }
      return true;
    }

    // ------------------------------------------------------------ input
    key(k, mods) {
      mods = mods || {};
      const s = this.s;
      if (s.exited) { this.relaunch(); return true; }
      if (s.tour && k !== 'p') this.tourStop();
      if (s.search.prompt) {
        if (k === 'Enter') this.searchCommit();
        else if (k === 'Escape') this.searchCancel();
        return true;
      }
      if (mods.ctrl && (k === 'c' || k === 'C')) { this.quit(); return true; }
      if (mods.ctrl || mods.meta || mods.alt) return false;
      if (s.overlay) return this.overlayKey(k);
      switch (k) {
        case '?': this.openOverlay('help'); return true;
        case 'q': this.quit(); return true;
        case 'f': this.openOverlay('branches'); return true;
        case 'a': this.openOverlay('authors'); return true;
        case 'd': this.openOverlay('dates'); return true;
        case '/': this.searchStart(); return true;
        case 'n': this.searchNext(1); return true;
        case 'N': this.searchNext(-1); return true;
        case '[': case '-': this.zoomBy(-1); return true;
        case ']': case '+': case '=': this.zoomBy(1); return true;
        case 'g': this.selectHead(); return true;
        case 'G': this.selectEdge(-1); return true;
        case 'v': this.toggleView(); return true;
        case 'p': if (s.tour) this.tourStop(); else this.tourStart(); return true;
        case 'Tab': this.cycleFocus(mods.shift ? -1 : 1); return true;
      }
      if (s.focus === 'files') return this.filesKey(k);
      if (s.focus === 'diff') return this.diffKey(k);
      return this.timelineKey(k, mods);
    }
    up() { return this.world() ? -1 : 1; } // lane index step for 'down' on screen
    timelineKey(k, mods) {
      const s = this.s;
      switch (k) {
        case 'ArrowLeft': case 'h': if (mods.shift) this.pan(-0.5); else this.step(-1); return true;
        case 'ArrowRight': case 'l': if (mods.shift) this.pan(0.5); else this.step(1); return true;
        case 'H': this.pan(-0.5); return true;
        case 'L': this.pan(0.5); return true;
        case 'ArrowUp': case 'k': if (mods.shift) this.panLanes(-this.up()); else this.laneMove(-this.up()); return true;
        case 'ArrowDown': case 'j': if (mods.shift) this.panLanes(this.up()); else this.laneMove(this.up()); return true;
        case 'K': this.panLanes(-this.up()); return true;
        case 'J': this.panLanes(this.up()); return true;
        case 'PageUp': this.panLanes(-this.geom().visLanes); return true;
        case 'PageDown': this.panLanes(this.geom().visLanes); return true;
        case 'Home': this.selectEdge(-1); return true;
        case 'End': this.selectEdge(1); return true;
        case 'Enter': case ' ': this.openFiles(); return true;
        case 'Escape':
          if (s.search.query) this.clearSearch();
          else if (this.filtersActive()) this.flash('Filters stay on until you change them: f branches, a authors, d dates.');
          return true;
      }
      return false;
    }
    filesKey(k) {
      const page = Math.max(1, this.geom().panel.h - 3);
      switch (k) {
        case 'ArrowUp': case 'k': this.fileMove(-1); return true;
        case 'ArrowDown': case 'j': this.fileMove(1); return true;
        case 'PageUp': this.fileMove(-page); return true;
        case 'PageDown': this.fileMove(page); return true;
        case 'Enter': case 'ArrowRight': case 'l': case ' ': this.openDiff(); return true;
        case 'Escape': case 'ArrowLeft': case 'h': case 'Backspace': this.backToTimeline(); return true;
      }
      return false;
    }
    diffKey(k) {
      const g = this.geom();
      const page = Math.max(1, (g.full ? g.full.h : g.panel.h) - 3);
      switch (k) {
        case 'ArrowUp': case 'k': this.diffBy(-1); return true;
        case 'ArrowDown': case 'j': this.diffBy(1); return true;
        case 'PageUp': case 'b': this.diffBy(-page); return true;
        case 'PageDown': case ' ': this.diffBy(page); return true;
        case 'Home': this.s.diffScroll = 0; return true;
        case 'End': this.diffBy(1e9); return true;
        case 'ArrowLeft': case 'h': this.s.diffX = Math.max(0, this.s.diffX - 8); return true;
        case 'ArrowRight': case 'l': this.s.diffX = Math.min(400, this.s.diffX + 8); return true;
        case ',': this.openDiff(this.s.fileSel - 1); return true;
        case '.': this.openDiff(this.s.fileSel + 1); return true;
        case 'Escape': case 'Backspace': this.s.focus = 'files'; return true;
      }
      return false;
    }
    // Pointer input from the shell, in cell coordinates.
    tap(x, y) {
      this.tourStop();
      const hits = this.lastHits;
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return this.onHit(h, x, y);
      }
      return false;
    }
    onHit(h, x, y) {
      const s = this.s;
      if (s.exited) { this.relaunch(); return true; }
      switch (h.t) {
        case 'timeline': {
          let best = null, bd = 6;
          for (const n of this.nodeHits) { const d = Math.abs(n.x - x) + 2 * Math.abs(n.y - y); if (d < bd) { bd = d; best = n; } }
          if (!best) return false;
          if (best.h === s.sel && s.focus === 'timeline') this.openFiles();
          else { this.select(best.h); if (s.focus !== 'timeline' && !this.geom().compact) s.focus = 'timeline'; }
          return true;
        }
        case 'file': if (s.focus === 'files' && s.fileSel === h.i) this.openDiff(); else { s.fileSel = h.i; s.focus = 'files'; } return true;
        case 'tab': if (h.f === 'timeline') this.backToTimeline(); else if (h.f === 'files') this.openFiles(); else if (h.f === 'diff' && s.diffPath) s.focus = 'diff'; return true;
        case 'back': if (s.focus === 'diff') s.focus = 'files'; else this.backToTimeline(); return true;
        case 'help': this.openOverlay('help'); return true;
        case 'ov': { const items = this.ovItems().filter((it) => !it.header); s.ovSel = h.i; this.ovToggle(items[h.i]); return true; }
        case 'ovbulk': this.ovBulk(h.mode); return true;
        case 'ovclose': s.overlay = null; return true;
        case 'box': return true;
        case 'summary': this.openFiles(); return true;
        case 'world': {
          let best = null, bd = Infinity;
          for (const n of this.nodeHits) { if (!this.navOk(n.h)) continue; const d = Math.abs(n.x - x) + 3 * Math.abs(n.y - y); if (d < bd) { bd = d; best = n; } }
          if (!best) return false;
          if (best.h === s.sel && s.focus === 'timeline' && bd <= 3) this.openFiles();
          else { this.select(best.h); if (s.focus !== 'timeline' && !this.geom().compact) s.focus = 'timeline'; }
          return true;
        }
      }
      return false;
    }
    wheel(x, y, dx, dy) {
      const hit = this.lastHits.slice().reverse().find((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
      if (!hit) return false;
      if (hit.t === 'diffArea') { this.s.diffX = Math.max(0, this.s.diffX + dx); this.diffBy(dy); return true; }
      if (hit.t === 'filesArea' || hit.t === 'file') { this.fileMove(dy); return true; }
      if (hit.t === 'timeline') { this.panBy(dx, dy); return true; }
      if (hit.t === 'world') { this.panBy(dx + dy, 0); return true; }
      return false;
    }

    // ------------------------------------------------------------ drawing
    frame(cols, rows) {
      const s = this.s;
      s.cols = cols; s.rows = rows;
      this.G = s.unicode ? GU : GA;
      const scr = new Screen(cols, rows, !s.unicode);
      if (s.exited) { this.drawExited(scr); this.lastHits = scr.hits; return scr; }
      let L = this.layout();
      let g = this.geom();
      if (!s.inited) { this.init(g); L = this.layout(); g = this.geom(); }
      this.clamp(g);
      this.computeMatches();
      this.nodeHits = [];
      this.drawHeader(scr, g, L);
      if (g.full) this.drawDetail(scr, g.full);
      else if (g.world) {
        if (!s.smooth || s.camX == null) s.camX = s.scrollX;
        this.drawWorld(scr, g.tl, g, L, { interactive: true });
        if (g.panel.h) { if (s.focus === 'timeline' || g.compact) this.drawHud(scr, g.panel); else this.drawPanel(scr, g.panel, false); }
      } else {
        this.drawTimeline(scr, g.tl, g, L, { interactive: true });
        if (g.panel.h) this.drawPanel(scr, g.panel, g.compact);
      }
      this.drawFooter(scr, g);
      if (s.overlay) this.drawOverlay(scr);
      this.lastHits = scr.hits;
      return scr;
    }

    drawHeader(scr, g, L) {
      const s = this.s, m = this.m, G = this.G, st = m.status;
      const W = scr.cols;
      scr.fill(0, 0, W, 1, this.S('hd'));
      const parts = [];
      parts.push([' ' + (m.meta.repo || 'repository'), 'hd b', 0]);
      if (m.head.unborn) parts.push(['no commits yet on ' + (m.headBranch || '?'), 'hd wa', 1]);
      else if (m.head.detached) parts.push(['HEAD detached at ' + this.short(m.head.hash), 'hd wa b', 1]);
      else parts.push(['on ' + m.headBranch + ' ' + G.head + ' ' + this.short(m.head.hash), 'hd', 1]);
      if (st && st.upstream && (st.ahead || st.behind)) parts.push([(st.ahead ? G.ahead + st.ahead : '') + (st.ahead && st.behind ? ' ' : '') + (st.behind ? G.behind + st.behind : '') + ' ' + st.upstream, 'hd mu', 5]);
      if (st && !m.head.unborn) {
        const bits = [];
        if (st.conflicted) bits.push('!' + st.conflicted);
        if (st.staged) bits.push(G.staged + st.staged);
        if (st.modified) bits.push(G.mod + st.modified);
        if (st.untracked) bits.push(G.untracked + st.untracked);
        parts.push(bits.length ? [bits.join(' '), 'hd wa', 2] : [G.clean + (s.unicode ? ' clean' : ''), 'hd ok', 2]);
      }
      const total = m.list.length, shown = L.nodes.length;
      parts.push([(shown === total ? total : shown + ' of ' + total) + ' commits', 'hd', 3]);
      if (this.filtersActive()) {
        const f = [];
        if (s.hidden.size) f.push(s.hidden.size + ' refs hidden');
        if (s.authors) f.push(s.authors.size + ' of ' + m.authors.length + ' authors');
        if (s.range.id !== 'all') f.push(s.range.label);
        parts.push([f.join(', '), 'hd ac', 3]);
      }
      parts.push([g.world ? '~' + WZ[s.wzoom] + ' commits/screen' : 'zoom ' + E.ZOOMS[s.zoom].short + '/col', 'hd mu', 6]);
      if (L.nodes.length) {
        const t0 = E.timeAt(L, s.scrollX), t1 = E.timeAt(L, s.scrollX + g.tw - 1);
        parts.push([fmtDay(t0) + ' ' + G.ell + ' ' + fmtDay(t1), 'hd mu', 7]);
      }
      const help = '? help ';
      const room = W - E.width(help) - 1;
      const keep = new Set();
      let used = 0;
      for (const p of parts.slice().sort((a, b) => a[2] - b[2])) {
        const w = E.width(p[0]) + 2;
        if (used + w <= room) { keep.add(p); used += w; }
      }
      let x = 0;
      for (const p of parts) {
        if (!keep.has(p)) continue;
        x += scr.text(x, 0, p[0], this.S(p[1]), W - x) + 2;
      }
      if (W - E.width(help) > x) {
        scr.text(W - E.width(help), 0, help, this.S('hd mu'));
        scr.hits.push({ x: W - E.width(help), y: 0, w: E.width(help), h: 1, t: 'help' });
      }
    }

    laneChain(L, lane, x0, x1) {
      let best = null, bo = -1;
      const selChain = L.idx.has(this.s.sel) ? L.chainOf.get(this.s.sel) : -1;
      for (const ch of L.members[lane] || []) {
        const o = Math.min(ch.end, x1) - Math.max(ch.start, x0);
        if (o < 0) continue;
        if (ch.id === selChain) return ch;
        if (o > bo) { bo = o; best = ch; }
      }
      return best;
    }

    drawTimeline(scr, A, g, L, opt) {
      const s = this.s, m = this.m, G = this.G;
      const gut = opt.gutter != null ? opt.gutter : g.gutter;
      const tx = A.x + gut, W = Math.max(1, A.w - gut);
      const sx = opt.scrollX != null ? opt.scrollX : s.scrollX;
      const sy = opt.scrollY != null ? opt.scrollY : s.scrollY;
      const H = Math.max(1, opt.band != null ? opt.band : g.band || 1);
      const yAxis = A.y, yTick = A.y + 1, yBand = A.y + 2, yLanes = A.y + 2 + H;
      const R = Math.max(0, A.h - 2 - H);
      const r0 = sy * 2, r1 = r0 + R;
      const x0 = sx, x1 = sx + W - 1;
      const sel = opt.interactive ? s.sel : null;
      if (A.h <= 0) return;
      if (!L.nodes.length) { this.drawEmpty(scr, A); return; }

      // ---- connectors, rasterised for this viewport only
      const N = W * Math.max(R, 1);
      const mask = new Uint8Array(N), part = new Uint8Array(N), dash = new Uint8Array(N), solid = new Uint8Array(N);
      const vcol = new Int8Array(N).fill(-1), hcol = new Int8Array(N).fill(-1), pcol = new Int8Array(N).fill(-1);
      const add = (x, r, mk, seg) => {
        const cx = x - x0, cr = r - r0;
        if (cx < 0 || cx >= W || cr < 0 || cr >= R) return;
        const i = cr * W + cx;
        mask[i] |= mk;
        if (mk === (UP | DN)) vcol[i] = seg.color;
        else if (mk === (LT | RT)) hcol[i] = seg.color;
        else { part[i] = 1; pcol[i] = seg.color; }
        if (seg.dash) dash[i] = 1; else solid[i] = 1;
      };
      for (const seg of E.segsIn(L, x0, x1)) {
        if (seg.t === 'h') {
          if (seg.row < r0 || seg.row >= r1) continue;
          for (let x = Math.max(seg.x1, x0); x <= Math.min(seg.x2, x1); x++) add(x, seg.row, (x > seg.x1 ? LT : 0) | (x < seg.x2 ? RT : 0), seg);
        } else {
          if (seg.col < x0 || seg.col > x1) continue;
          for (let r = Math.max(seg.r1, r0); r <= Math.min(seg.r2, r1 - 1); r++) add(seg.col, r, (r > seg.r1 ? UP : 0) | (r < seg.r2 ? DN : 0), seg);
        }
      }
      const MASK = s.unicode ? MASK_U : MASK_A;
      for (let cr = 0; cr < R; cr++) {
        for (let cx = 0; cx < W; cx++) {
          const i = cr * W + cx, mk = mask[i];
          if (!mk) continue;
          let ch, color;
          if (mk === 15 && !part[i]) { ch = MASK[UP | DN]; color = vcol[i]; } // a crossing: the vertical passes over
          else { ch = MASK[mk]; color = part[i] ? pcol[i] : vcol[i] >= 0 ? vcol[i] : hcol[i]; }
          if (dash[i] && !solid[i]) { if (mk === (LT | RT)) ch = G.dashH; else if (mk === (UP | DN)) ch = G.dashV; }
          scr.put(tx + cx, yLanes + cr, ch, this.S('c' + color + ' ln'));
        }
      }
      const free = (x, r) => {
        const cx = x - x0, cr = r - r0;
        if (cx < 0 || cx >= W || cr < 0 || cr >= R) return false;
        return !mask[cr * W + cx] && scr.get(tx + cx, yLanes + cr) === ' ';
      };
      for (const mk of L.markers) {
        if (mk.x < x0 || mk.x > x1 || mk.row < r0 || mk.row >= r1) continue;
        if (mk.kind === 'hidden-parent') { if (free(mk.x, mk.row)) scr.put(tx + mk.x - x0, yLanes + mk.row - r0, G.dashV, this.S('c' + mk.color + ' ln')); continue; }
        scr.put(tx + mk.x - x0, yLanes + mk.row - r0, mk.kind === 'lstub' ? G.lstub : G.rstub, this.S('c' + mk.color + ' b'));
      }

      // ---- commits
      const headHash = m.head && m.head.hash;
      const visible = E.nodesIn(L, x0, x1);
      let selX = -1;
      for (const n of visible) {
        const r = 2 * n.lane;
        if (r < r0 || r >= r1) continue;
        const c = m.commits.get(n.h), ch = L.chains[n.chain];
        const cx = n.x - x0, cr = r - r0, i = cr * W + cx;
        let kind = c.parents.length > 1 ? 'merge' : 'commit';
        if (n.h === headHash) kind = 'head';
        else if (s.authors && !s.authors.has(c.authorKey)) kind = 'dim';
        let st = 'c' + ch.color;
        if (kind === 'head') st += ' b';
        if (kind === 'dim') st += ' d';
        if (this.matchSet.has(n.h)) st += ' mt';
        if (n.h === sel) { st += ' inv'; selX = cx; }
        scr.put(tx + cx, yLanes + cr, G[kind], this.S(st), { k: kind, m: mask[i], mt: this.matchSet.has(n.h) });
        if (opt.interactive) this.nodeHits.push({ x: tx + cx, y: yLanes + cr, h: n.h });
        if (L.skew.has(n.h) && cr + 1 < R && free(n.x, r + 1)) scr.put(tx + cx, yLanes + cr + 1, G.warn, this.S('wa b'));
      }

      // ---- labels: tips, inline names, refs inside a path, captions
      const room = (x, r, max) => { let w = 0; while (w < max && free(x + w, r)) w++; return w; };
      const writeLabel = (x, r, text, st, max) => {
        const avail = room(x, r, max);
        if (avail < 3) return 0;
        return scr.text(tx + x - x0, yLanes + r - r0, text, st, avail);
      };
      for (const ch of L.shown) {
        if (ch.lane < 0) continue;
        const r = 2 * ch.lane;
        if (r < r0 || r >= r1 || ch.end < x0 || ch.start > x1) continue;
        const st = this.S('c' + ch.color + (ch.inferred ? ' it' : ' b'));
        if (ch.labelMode === 'tip') {
          const lx = Math.max(ch.labelX, x0);
          if (lx <= x1) writeLabel(lx, r, ch.labelX >= x0 ? ch.label : E.truncateLeft(ch.label, ch.label.length - (x0 - ch.labelX)), st, x1 - lx + 1);
        } else if (ch.labelMode === 'inline') {
          // a pure horizontal stretch of this path's own line; stop at any crossing
          const lw = E.width(ch.label) + 2;
          let ok = 0;
          for (let k = 0; k < lw; k++) {
            const x = ch.labelX - 1 + k, cx = x - x0;
            if (cx < 0 || cx >= W || mask[(r - r0) * W + cx] !== (LT | RT)) break;
            ok++;
          }
          if (ok - 2 >= Math.min(E.width(ch.label), 10)) {
            const text = E.truncate(ch.label, ok - 2, s.unicode ? '…' : '~');
            const cx0 = ch.labelX - 1 - x0;
            scr.put(tx + cx0, yLanes + r - r0, ' ', '');
            const w = scr.text(tx + cx0 + 1, yLanes + r - r0, text, st, ok - 2);
            scr.put(tx + cx0 + 1 + w, yLanes + r - r0, ' ', '');
          }
        }
      }
      for (const n of visible) {
        const c = m.commits.get(n.h), ch = L.chains[n.chain];
        const r = 2 * n.lane + 1;
        if (r < r0 || r >= r1) continue;
        const names = c.refs.filter((ref) => ref.kind !== 'tag' && L.refSet.has(ref) && ref !== ch.ref).map((ref) => (ref.kind === 'head' ? 'HEAD (detached)' : ref.short));
        if (ch.labelMode === 'tip' && ch.vis[ch.vis.length - 1] === n.h) continue;
        if (names.length) writeLabel(n.x, r, names.join(', '), this.S('c' + ch.color + ' b'), 30);
      }
      for (const ch of L.shown) {
        if (ch.labelMode !== 'none' || !ch.fullLabel) continue;
        const r = 2 * ch.lane + 1;
        if (r < r0 || r >= r1 || ch.end < x0 || ch.start > x1) continue;
        const lx = Math.max(ch.start + 1, x0);
        const max = Math.min(ch.captionMax != null ? ch.captionMax - (lx - ch.start - 1) : 30, x1 - lx + 1);
        if (max >= 6 && room(lx, r, max) >= Math.min(9, E.width(ch.fullLabel))) writeLabel(lx, r, ch.fullLabel, this.S('c' + ch.color + ' it'), max);
      }

      // ---- axis, tag rail, gutter, selection column
      const ax = E.axisLabels(L, x0, x1, 12);
      for (let cx = 0; cx < W; cx++) scr.put(tx + cx, yTick, G.hline, this.S('mu ln'));
      // the selected commit's time is shown on the axis row; labels keep clear of it
      let readout = null;
      if (sel && L.idx.has(sel)) {
        const sxc = L.xOf.get(sel) - x0;
        const txt = ' ' + fmtShort(m.commits.get(sel).committerTime) + ' ';
        const w = E.width(txt);
        if (sxc >= 0 && sxc < W && W >= w) readout = { txt, at: Math.max(0, Math.min(W - w, sxc - Math.floor(w / 2))), w };
      }
      let lastEnd = -2;
      ax.ticks.forEach((tk, k) => {
        const cx = tk.x - x0;
        if (cx < 0 || cx >= W) return;
        scr.put(tx + cx, yTick, G.tick, this.S('mu ln'));
        if (cx <= lastEnd + 1) return;
        const label = axisText(tk.t, ax.unit, lastEnd < 0);
        if (E.width(label) > W - cx) return;
        if (readout && cx < readout.at + readout.w + 1 && cx + E.width(label) > readout.at - 1) return;
        const w = scr.text(tx + cx, yAxis, label, this.S('mu'), W - cx);
        lastEnd = cx + w;
      });
      if (x0 > 0) scr.put(tx, yTick, G.left, this.S('ac b'));
      if (x1 < L.width - 1) scr.put(tx + W - 1, yTick, G.right, this.S('ac b'));
      // release flags on the tag rail
      const tags = [];
      for (const n of E.nodesIn(L, x0, x1)) for (const ref of m.commits.get(n.h).refs) if (ref.kind === 'tag' && L.refSet.has(ref)) tags.push({ x: n.x, ref });
      tags.sort((a, b) => a.x - b.x);
      tags.forEach((tg, i) => {
        const cx = tg.x - x0;
        const max = Math.min(W - cx, i + 1 < tags.length ? tags[i + 1].x - tg.x - 1 : W);
        if (max >= 2) scr.text(tx + cx, yBand, G.tag + tg.ref.short, this.S('tg b'), max);
      });
      if (selX >= 0) for (let y = yTick; y < yLanes + R; y++) scr.addClass(tx + selX, y, this.S('cur'));
      if (readout) scr.text(tx + readout.at, yAxis, readout.txt, this.S('cr b'), readout.w);
      if (gut > 0) {
        for (let y = A.y; y < A.y + A.h; y++) scr.put(A.x + gut - 1, y, G.vline, this.S('mu ln'));
        scr.text(A.x + 1, yAxis, E.ZOOMS[s.zoom].short + '/col', this.S('mu'), gut - 2);
        scr.text(A.x + 1, yBand, 'tags', this.S('mu'), gut - 2);
        for (let cr = 0; cr < R; cr += 2) {
          const ch = this.laneChain(L, (r0 + cr) / 2, x0, x1);
          if (!ch) continue;
          const name = ch.ref ? (ch.ref.kind === 'head' ? 'HEAD' : ch.name) : ch.name ? '~' + ch.name : G.sep;
          scr.text(A.x + 1, yLanes + cr, name, this.S('c' + ch.color + (ch.inferred ? ' it' : ' b')), gut - 2);
        }
        if (sy > 0) scr.put(A.x + gut - 1, yLanes, G.up, this.S('ac b'));
        if (sy + Math.ceil(R / 2) < L.lanes) scr.put(A.x + gut - 1, yLanes + Math.max(0, R - 1), G.down, this.S('ac b'));
      }
      if (opt.interactive) scr.hits.push({ x: tx, y: yLanes, w: W, h: R, t: 'timeline' });
    }

    // Smooth camera for the world view: the shell calls this on animation frames.
    animate() {
      const s = this.s;
      if (!this.world() || !s.smooth || s.camX == null) { s.camX = s.scrollX; return false; }
      let d = s.scrollX - s.camX;
      if (Math.abs(d) < 0.6) { s.camX = s.scrollX; return false; }
      const tw = Math.max(20, s.cols);
      if (Math.abs(d) > tw * 1.5) { s.camX = s.scrollX - Math.sign(d) * tw; d = s.scrollX - s.camX; }
      s.camX += Math.sign(d) * Math.max(0.6, Math.abs(d) * 0.2);
      if (Math.abs(s.scrollX - s.camX) < 0.6) s.camX = s.scrollX;
      return true;
    }
    // Text over the scenery keeps the sky or ground colour behind it.
    wtext(scr, X, y, str, st, max, tint) {
      if (max <= 0) return 0;
      let t = scr.prep(str);
      if (E.width(t) > max) t = E.truncate(t, max, this.s.unicode ? '…' : '~');
      let w = 0;
      for (const c of E.cells(t)) {
        if (w + c.w > max) break;
        const cls = this.S((st ? st + ' ' : '') + tint(X + w, y));
        if (c.w === 2) scr.putWide(X + w, y, c.ch, cls); else scr.put(X + w, y, c.ch, cls);
        w += c.w;
      }
      return w;
    }

    // The world view: trails, commits and labels over the scenery of their age.
    drawWorld(scr, A, g, L, opt) {
      const s = this.s, m = this.m, G = this.G;
      if (A.h <= 0) return;
      if (!L.nodes.length) { this.drawEmpty(scr, A); return; }
      const W = A.w, tx = A.x;
      const x0 = opt.scrollX != null ? opt.scrollX : Math.round(s.camX != null ? s.camX : s.scrollX);
      const x1 = x0 + W - 1;
      const sy = opt.scrollY != null ? opt.scrollY : s.scrollY;
      const top = A.y, bottom = A.y + A.h - 1;
      const yG = opt.yGround != null ? opt.yGround : g.yGround;
      const gap = opt.gap || g.gap, vis = opt.visLanes || g.visLanes;
      const sel = opt.interactive ? s.sel : null;
      const yOf = (lane) => yG - (lane - sy) * gap;
      const laneOn = (lane) => lane >= sy && lane < sy + vis;
      const ctx = WD.context(L, m, L.spacing || 8);
      const ridges = [];
      for (const seg of E.segsIn(L, x0 - 80, x1 + 80)) {
        if (seg.t !== 'h') continue;
        const lane = seg.row / 2;
        if (lane > sy && laneOn(lane)) ridges.push({ x1: seg.x1, x2: seg.x2, h: yG - yOf(lane), level: lane - sy });
      }
      const art = WD.paint(scr, { x0, W, tx, top, yGround: yG, bottom, ctx, unicode: s.unicode, phase: opt.interactive ? s.phase : 0, S: (c) => this.S(c), ridges });
      const tint = (X, y) => art.tint(X - tx, y), under = (X, y) => art.under(X - tx, y);

      // ---- trails
      const R = A.h, N = W * R;
      const mask = new Uint8Array(N), part = new Uint8Array(N), dash = new Uint8Array(N), solid = new Uint8Array(N), ui = new Uint8Array(N);
      const vcol = new Int8Array(N).fill(-1), hcol = new Int8Array(N).fill(-1), pcol = new Int8Array(N).fill(-1);
      const idx = (x, y) => { const cx = x - x0, cy = y - top; return cx < 0 || cx >= W || cy < 1 || cy >= R ? -1 : cy * W + cx; };
      const add = (x, y, mk, seg) => {
        const i = idx(x, y);
        if (i < 0) return;
        mask[i] |= mk;
        if (mk === (UP | DN)) vcol[i] = seg.color;
        else if (mk === (LT | RT)) hcol[i] = seg.color;
        else { part[i] = 1; pcol[i] = seg.color; }
        if (seg.dash) dash[i] = 1; else solid[i] = 1;
      };
      for (const seg of E.segsIn(L, x0, x1)) {
        if (seg.t === 'h') {
          const lane = seg.row / 2;
          if (!laneOn(lane)) continue;
          const y = yOf(lane);
          for (let x = Math.max(seg.x1, x0); x <= Math.min(seg.x2, x1); x++) add(x, y, (x > seg.x1 ? LT : 0) | (x < seg.x2 ? RT : 0), seg);
        } else {
          if (seg.col < x0 || seg.col > x1) continue;
          const ya = yOf(seg.r1 / 2), yb = yOf(seg.r2 / 2);
          const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
          for (let y = Math.max(lo, top + 1); y <= Math.min(hi, bottom); y++) add(seg.col, y, (y > lo ? UP : 0) | (y < hi ? DN : 0), seg);
        }
      }
      const MASK = s.unicode ? MASK_U : MASK_A;
      for (let cy = 1; cy < R; cy++) {
        for (let cx = 0; cx < W; cx++) {
          const i = cy * W + cx, mk = mask[i];
          if (!mk) continue;
          let ch, color;
          if (mk === 15 && !part[i]) { ch = MASK[UP | DN]; color = vcol[i]; }
          else { ch = MASK[mk]; color = part[i] ? pcol[i] : vcol[i] >= 0 ? vcol[i] : hcol[i]; }
          if (dash[i] && !solid[i]) { if (mk === (LT | RT)) ch = G.dashH; else if (mk === (UP | DN)) ch = G.dashV; }
          const X = tx + cx, y = top + cy;
          scr.put(X, y, ch, this.S('c' + color + ' tr ' + under(X, y)));
          ui[i] = 1;
        }
      }
      for (const mk of L.markers) {
        if (mk.x < x0 || mk.x > x1) continue;
        const lane = Math.floor(mk.row / 2);
        if (!laneOn(lane)) continue;
        const y = yOf(lane) + (mk.row % 2), i = idx(mk.x, y);
        if (i < 0) continue;
        const X = tx + mk.x - x0;
        if (mk.kind === 'hidden-parent') { if (!ui[i]) scr.put(X, y, G.dashV, this.S('c' + mk.color + ' ' + tint(X, y))); }
        else scr.put(X, y, mk.kind === 'lstub' ? G.lstub : G.rstub, this.S('c' + mk.color + ' b ' + tint(X, y)));
        ui[i] = 1;
      }

      // ---- commits
      const headHash = m.head && m.head.hash;
      const visible = E.nodesIn(L, x0, x1);
      let selN = null;
      for (const n of visible) {
        if (!laneOn(n.lane)) continue;
        const y = yOf(n.lane), i = idx(n.x, y);
        if (i < 0) continue;
        const c = m.commits.get(n.h), ch = L.chains[n.chain];
        let kind = c.parents.length > 1 ? 'merge' : 'commit';
        if (n.h === headHash) kind = 'head';
        else if (s.authors && !s.authors.has(c.authorKey)) kind = 'dim';
        let st = 'c' + ch.color;
        if (kind === 'head') st += ' b';
        if (kind === 'dim') st += ' d';
        if (this.matchSet.has(n.h)) st += ' mt';
        if (n.h === sel) { st += ' inv'; selN = { n, y }; }
        const X = tx + n.x - x0;
        scr.put(X, y, G[kind], this.S(st + ' ' + under(X, y)), { k: kind, m: mask[i], mt: this.matchSet.has(n.h) });
        ui[i] = 1;
        if (opt.interactive) this.nodeHits.push({ x: X, y, h: n.h });
        if (L.skew.has(n.h)) { const j = idx(n.x, y + 1); if (j >= 0 && !ui[j]) { scr.put(X, y + 1, G.warn, this.S('wa b ' + tint(X, y + 1))); ui[j] = 1; } }
      }

      // ---- labels
      const room = (x, y, max) => { let w = 0; while (w < max) { const i = idx(x + w, y); if (i < 0 || ui[i]) break; w++; } return w; };
      const label = (x, y, text, st, max, minW) => {
        const avail = room(x, y, max);
        if (avail < (minW || 3)) return 0;
        const w = this.wtext(scr, tx + x - x0, y, text, st, avail, tint);
        for (let k = 0; k < w; k++) { const i = idx(x + k, y); if (i >= 0) ui[i] = 1; }
        return w;
      };
      const flagged = new Set();
      for (const n of visible) {
        if (!laneOn(n.lane)) continue;
        const tags = m.commits.get(n.h).refs.filter((r) => r.kind === 'tag' && L.refSet.has(r));
        if (tags.length && label(n.x, yOf(n.lane) - 1, G.tag + tags.map((t) => t.short).join(' '), 'tg b', 24, 2)) flagged.add(n.h);
      }
      if (selN) {
        const y = selN.y - (flagged.has(selN.n.h) ? 2 : 1), X = tx + selN.n.x - x0;
        [[y, s.unicode ? '▲' : 'A'], [y - 1, s.unicode ? '●' : 'o']].forEach(([yy, ch]) => {
          const i = idx(selN.n.x, yy);
          if (i >= 0) { scr.put(X, yy, ch, this.S('tv ' + under(X, yy))); ui[i] = 1; }
        });
      }
      for (const ch of L.shown) {
        if (ch.lane < 0 || !laneOn(ch.lane) || ch.end < x0 || ch.start > x1) continue;
        const y = yOf(ch.lane);
        const st = 'c' + ch.color + (ch.inferred ? ' it' : ' b');
        if (ch.labelMode === 'tip') {
          // a name whose path ended off to the left is left out rather than cut
          if (ch.labelX >= x0 && ch.labelX <= x1) label(ch.labelX, y, ch.label, st, x1 - ch.labelX + 1);
        } else if (ch.labelMode === 'inline') {
          const lw = E.width(ch.label) + 2;
          let ok = 0;
          for (let k = 0; k < lw; k++) { const i = idx(ch.labelX - 1 + k, y); if (i < 0 || mask[i] !== (LT | RT)) break; ok++; }
          if (ok - 2 >= Math.min(E.width(ch.label), 10)) {
            const text = E.truncate(ch.label, ok - 2, s.unicode ? '…' : '~');
            const X0 = tx + ch.labelX - 1 - x0;
            scr.put(X0, y, ' ', this.S(tint(X0, y)));
            const w = this.wtext(scr, X0 + 1, y, text, st, ok - 2, tint);
            scr.put(X0 + 1 + w, y, ' ', this.S(tint(X0 + 1 + w, y)));
          }
        }
      }
      for (const n of visible) {
        if (!laneOn(n.lane)) continue;
        const c = m.commits.get(n.h), ch = L.chains[n.chain];
        if (ch.labelMode === 'tip' && ch.vis[ch.vis.length - 1] === n.h) continue;
        const names = c.refs.filter((ref) => ref.kind !== 'tag' && L.refSet.has(ref) && ref !== ch.ref).map((ref) => (ref.kind === 'head' ? 'HEAD (detached)' : ref.short));
        if (names.length) label(n.x, yOf(n.lane) + 1, names.join(', '), 'c' + ch.color + ' b', 30);
      }
      for (const ch of L.shown) {
        // paths that come in from the left are named at the edge instead
        if (ch.labelMode !== 'none' || !ch.fullLabel || !laneOn(ch.lane) || ch.end < x0 || ch.start > x1 || ch.start < x0) continue;
        const lx = ch.start + 1;
        const max = Math.min(ch.captionMax != null ? ch.captionMax : 30, x1 - lx + 1);
        if (max >= 6) label(lx, yOf(ch.lane) + 1, ch.fullLabel, 'c' + ch.color + ' it', max, Math.min(9, E.width(ch.fullLabel)));
      }
      // names of trails that come in from the left edge
      for (let l = sy; l < Math.min(L.lanes, sy + vis); l++) {
        const ch = this.laneChain(L, l, x0, x0 + 2);
        if (!ch || ch.start >= x0) continue;
        if (ch.labelMode === 'tip' && ch.labelX <= x1) continue;
        const name = ch.ref ? (ch.ref.kind === 'head' ? 'HEAD' : ch.name) : ch.name ? '~' + ch.name : null;
        if (name) label(x0 + 1, yOf(l) - 1, (s.unicode ? '‹ ' : '< ') + name, 'c' + ch.color + (ch.inferred ? ' it' : ' b'), Math.min(26, W - 2), Math.min(E.width(name) + 2, 10));
      }

      // ---- dates along the top
      const ax = E.axisLabels(L, x0, x1, 12);
      let readout = null;
      if (sel && L.idx.has(sel)) {
        const sxc = L.xOf.get(sel) - x0;
        const txt = ' ' + fmtShort(m.commits.get(sel).committerTime) + ' ';
        const w = E.width(txt);
        if (sxc >= 0 && sxc < W && W >= w) readout = { txt, at: Math.max(0, Math.min(W - w, sxc - Math.floor(w / 2))), w };
      }
      let lastEnd = -2;
      ax.ticks.forEach((tk) => {
        const cx = tk.x - x0;
        if (cx < 0 || cx >= W || cx <= lastEnd + 1) return;
        const lbl = (s.unicode ? '╷' : '|') + axisText(tk.t, ax.unit, lastEnd < 0);
        if (E.width(lbl) > W - cx) return;
        if (readout && cx < readout.at + readout.w + 1 && cx + E.width(lbl) > readout.at - 1) return;
        lastEnd = cx + this.wtext(scr, tx + cx, top, lbl, 'mu', W - cx, tint);
      });
      if (readout) this.wtext(scr, tx + readout.at, top, readout.txt, 'cr b', readout.w, tint);
      if (opt.interactive) scr.hits.push({ x: tx, y: top, w: W, h: A.h, t: 'world' });
    }

    // The commit box under the world.
    drawHud(scr, A) {
      const s = this.s, m = this.m, G = this.G, L = this.L;
      if (A.h < 3) return;
      const B = G.box, bst = this.S('bx');
      const xr = A.x + A.w - 1, yb = A.y + A.h - 1;
      for (let x = A.x + 1; x < xr; x++) { scr.put(x, A.y, B[4], bst); scr.put(x, yb, B[4], bst); }
      for (let y = A.y + 1; y < yb; y++) { scr.put(A.x, y, B[5], bst); scr.put(xr, y, B[5], bst); }
      scr.put(A.x, A.y, B[0], bst); scr.put(xr, A.y, B[1], bst); scr.put(A.x, yb, B[2], bst); scr.put(xr, yb, B[3], bst);
      scr.hits.push({ x: A.x, y: A.y, w: A.w, h: A.h, t: 'summary' });
      const c = m.commits.get(s.sel);
      if (!c) { scr.text(A.x + 2, A.y + 1, 'Nothing selected.', this.S('mu'), A.w - 4); return; }
      const er = WD.eraOf(m, c.hash);
      const ch = L && L.idx.has(c.hash) ? L.chains[L.chainOf.get(c.hash)] : null;
      const color = ch ? 'c' + ch.color : '';
      const hint = ' ' + G.enter + ' open ';
      const hw = E.width(hint);
      const tw = scr.text(A.x + 2, A.y, ' ' + er.era.name + ' ' + G.sep + ' commit ' + er.n + ' of ' + er.N + ' ', this.S('ac b'), Math.max(0, A.w - 5 - hw));
      if (A.w - 5 - tw >= hw) scr.text(xr - 1 - hw, A.y, hint, this.S('mu'));
      const end = A.x + A.w - 2;
      const kind = c.hash === m.head.hash ? 'head' : c.parents.length > 1 ? 'merge' : 'commit';
      let x = A.x + 2;
      if (s.unicode) { scr.put(x, A.y + 1, G[kind], this.S(color + ' b'), { k: kind, m: 0 }); x += 2; }
      else x += scr.text(x, A.y + 1, G[kind] + ' ', this.S(color + ' b'));
      scr.text(x, A.y + 1, c.subject, this.S('b'), end - x);
      const where = ch ? (ch.ref ? (ch.ref.kind === 'head' ? 'HEAD' : ch.name) : ch.name ? '~' + ch.name : '') : '';
      const segs = [[this.short(c.hash), 'ac'], [E.sanitize(c.authorName), ''], [fmtShort(c.committerTime), 'mu']];
      if (where) segs.push([where, color + ' b']);
      x = A.x + 2;
      segs.forEach(([t, st], i) => {
        if (i) x += scr.text(x, A.y + 2, ' ' + G.sep + ' ', this.S('mu'), end - x);
        x += scr.text(x, A.y + 2, t, this.S(st), end - x);
      });
      if (A.h < 5) return;
      const f = this.files(c.hash);
      x = A.x + 2;
      if (f.status === 'ready') {
        let ins = 0, del = 0;
        for (const ff of f.files) { ins += ff.ins || 0; del += ff.del || 0; }
        x += scr.text(x, A.y + 3, f.files.length + (f.files.length === 1 ? ' file  ' : ' files  '), '', end - x);
        x += scr.text(x, A.y + 3, '+' + ins, this.S('ad'), end - x);
        x += scr.text(x, A.y + 3, ' ' + G.minus + del, this.S('rm'), end - x);
      } else if (f.status === 'loading') x += scr.text(x, A.y + 3, 'loading files' + G.ell, this.S('mu'), end - x);
      const tags = c.refs.filter((r) => r.kind === 'tag');
      if (tags.length) x += scr.text(x, A.y + 3, '  ' + G.tag + ' ' + tags.map((t) => t.short).join(' '), this.S('tg b'), end - x);
      const on = E.containing(m, c.hash).map((r) => r.short);
      if (on.length) scr.text(x, A.y + 3, '  on ' + (on.length > 3 ? on.slice(0, 3).join(', ') + ', +' + (on.length - 3) + ' more' : on.join(', ')), this.S('mu'), end - x);
    }

    drawEmpty(scr, A) {
      const m = this.m, s = this.s;
      let lines;
      if (!m.list.length) lines = ['No commits yet.', 'HEAD points at the unborn branch ' + (m.headBranch || '?') + '.', 'Make a first commit and run git-timeline again.'];
      else if (s.hidden.size >= m.refs.length) lines = ['Every branch and tag is hidden.', 'Press f to choose what to show.'];
      else lines = ['No commits in this date range.', 'Press d to change the range.'];
      const y0 = A.y + Math.max(0, Math.floor((A.h - lines.length) / 2));
      lines.forEach((l, i) => {
        const w = Math.min(E.width(l), A.w - 2);
        scr.text(A.x + Math.max(1, Math.floor((A.w - w) / 2)), y0 + i, l, this.S(i === 0 ? 'b' : 'mu'), A.w - 2);
      });
    }

    // ---- lower panel
    panelTitle(scr, A, tabs, right) {
      const G = this.G, s = this.s;
      for (let x = A.x; x < A.x + A.w; x++) scr.put(x, A.y, G.hline, this.S('mu ln'));
      let x = A.x + 1;
      for (const tb of tabs) {
        const active = tb.f === s.focus || (tb.f === 'timeline' && s.focus === 'timeline');
        const label = ' ' + tb.label + ' ';
        const w = scr.text(x, A.y, label, this.S(tb.on ? (active ? 'ac b inv' : 'b') : 'mu'), A.x + A.w - x - 1);
        if (tb.f) scr.hits.push({ x, y: A.y, w, h: 1, t: 'tab', f: tb.f });
        x += w + 1;
      }
      if (right) {
        const w = E.width(right);
        if (A.x + A.w - w - 2 > x) scr.text(A.x + A.w - w - 1, A.y, right, this.S('mu'));
      }
    }
    drawPanel(scr, A, compact) {
      const s = this.s;
      if (compact) { this.drawSummary(scr, A); return; }
      if (s.focus === 'diff') { this.drawDiff(scr, A); return; }
      if (A.w >= 100) {
        const lw = Math.floor(A.w * 0.55);
        this.drawInfo(scr, { x: A.x, y: A.y, w: lw, h: A.h }, true);
        this.drawFiles(scr, { x: A.x + lw, y: A.y, w: A.w - lw, h: A.h }, true);
      } else {
        const c = this.m.commits.get(s.sel);
        const n = c ? this.infoLines(c, A.w - 2).length : 0;
        if (c && A.h - 1 - n - 1 >= 4) {
          this.drawInfo(scr, { x: A.x, y: A.y, w: A.w, h: n + 1 }, true);
          this.drawFiles(scr, { x: A.x, y: A.y + n + 1, w: A.w, h: A.h - n - 1 }, false, true);
        } else if (s.focus === 'files') this.drawFiles(scr, A, false);
        else this.drawInfo(scr, A, false);
      }
    }
    drawDetail(scr, A) {
      const s = this.s;
      if (s.focus === 'diff') { this.drawDiff(scr, A); return; }
      if (s.focus === 'files') {
        const top = Math.max(4, Math.min(Math.floor(A.h * 0.45), 12));
        this.drawInfo(scr, { x: A.x, y: A.y, w: A.w, h: top }, true);
        this.drawFiles(scr, { x: A.x, y: A.y + top, w: A.w, h: A.h - top }, false, true);
      } else this.drawInfo(scr, A, false);
    }
    drawSummary(scr, A) {
      const s = this.s, m = this.m, G = this.G;
      const c = m.commits.get(s.sel);
      for (let x = A.x; x < A.x + A.w; x++) scr.put(x, A.y, G.hline, this.S('mu ln'));
      if (!c) return;
      const hint = ' ' + G.enter + ' details ';
      scr.text(A.x + A.w - E.width(hint) - 1, A.y, hint, this.S('ac b'));
      scr.text(A.x + 1, A.y + 1, c.subject, this.S('b'), A.w - 2);
      scr.text(A.x + 1, A.y + 2, this.short(c.hash) + ' ' + G.sep + ' ' + E.sanitize(c.authorName) + ' ' + G.sep + ' ' + fmtShort(c.committerTime), this.S('mu'), A.w - 2);
      scr.hits.push({ x: A.x, y: A.y, w: A.w, h: A.h, t: 'summary' });
    }

    infoLines(c, w) {
      const m = this.m, G = this.G, L = this.L, s = this.s;
      const lines = [];
      const K = (k) => [k.padEnd(10), this.S('mu')];
      const kind = c.parents.length > 1 ? 'merge' : 'commit';
      const glyph = c.hash === m.head.hash ? G.head : G[kind];
      const ch = L.idx.has(c.hash) ? L.chains[L.chainOf.get(c.hash)] : null;
      const color = ch ? 'c' + ch.color : '';
      const subj = E.wrap(E.sanitize(c.subject), Math.max(10, w - 2)).slice(0, 2);
      subj.forEach((t, i) => lines.push(i === 0 ? [[glyph + ' ', this.S(color + ' b')], [t, this.S('b')]] : [['  ', ''], [t, this.S('b')]]));
      const hashText = w >= 72 ? c.hash : this.short(c.hash);
      lines.push([K('commit'), [hashText, this.S('ac')], c.parents.length > 1 ? ['  merge of ' + c.parents.length + ' parents', this.S('mu')] : ['', '']]);
      lines.push([K('author'), [E.sanitize(c.authorName), ''], [' <' + E.sanitize(c.authorEmail) + '>', this.S('mu')]]);
      const az = origZone(c.authorTime, c.authorISO), cz = origZone(c.committerTime, c.committerISO);
      const sameTime = c.authorTime === c.committerTime;
      const samePerson = c.authorName === c.committerName && c.authorEmail === c.committerEmail;
      if (sameTime && samePerson) lines.push([K('date'), [fmtLong(c.authorTime), ''], [az ? '  (' + az + ' author time)' : '', this.S('mu')]]);
      else {
        lines.push([K('authored'), [fmtLong(c.authorTime), ''], [az ? '  (' + az + ')' : '', this.S('mu')]]);
        lines.push([K('committed'), [fmtLong(c.committerTime), ''], [(cz ? '  (' + cz + ')' : '') + (samePerson ? '' : '  by ' + E.sanitize(c.committerName)), this.S('mu')]]);
      }
      const ps = c.parents.map((p) => {
        if (!m.commits.has(p)) return this.short(p) + (m.meta.shallow ? ' (not in this shallow clone)' : ' (not loaded)');
        if (!L.vis.has(p)) return this.short(p) + ' (outside the range)';
        return this.short(p);
      });
      const er = WD.eraOf(m, c.hash);
      lines.push([K('era'), [er.era.name, this.S('ac')], ['  ' + G.sep + ' commit ' + er.n + ' of ' + er.N, this.S('mu')]]);
      lines.push([K('parents'), [ps.length ? ps.join('  ') : c.shallow ? 'history cut here (shallow clone)' : 'none: this is a root commit', this.S(ps.length ? '' : 'mu')]]);
      if (c.refs.length) {
        const segs = [K('refs')];
        for (const r of c.refs) {
          const icon = r.kind === 'tag' ? G.tag : r.kind === 'head' ? G.head : s.unicode ? G.branch : '';
          segs.push([(icon ? icon + ' ' : '') + (r.kind === 'head' ? 'HEAD (detached)' : r.short) + '  ', this.S(r.kind === 'tag' ? 'tg b' : color + ' b')]);
        }
        lines.push(segs);
      }
      const inb = E.containing(m, c.hash).map((r) => r.short);
      if (inb.length) lines.push([K('on'), [inb.length > 4 ? inb.slice(0, 4).join(', ') + ', +' + (inb.length - 4) + ' more' : inb.join(', '), '']]);
      const f = this.files(c.hash);
      if (f.status === 'ready') {
        let ins = 0, del = 0, bin = 0;
        for (const x of f.files) { ins += x.ins || 0; del += x.del || 0; if (x.bin) bin++; }
        lines.push([K('changes'), [f.files.length + (f.files.length === 1 ? ' file' : ' files') + '  ', ''], ['+' + ins, this.S('ad')], [' ' + G.minus + del, this.S('rm')], [bin ? '  ' + bin + ' binary' : '', this.S('mu')], [c.parents.length > 1 ? '  vs first parent' : '', this.S('mu')]]);
      } else if (f.status === 'loading') lines.push([K('changes'), ['loading' + G.ell, this.S('mu')]]);
      else if (f.status === 'error') lines.push([K('changes'), ['could not load: ' + (f.message || 'error'), this.S('wa')]]);
      if (L.skew.has(c.hash)) lines.push([[G.warn + ' ', this.S('wa b')], ['Dated before its parent. Drawn after it so ancestry stays correct.', this.S('wa')]]);
      if (c.body) {
        lines.push([['', '']]);
        for (const para of E.sanitize(c.body, { newlines: 'keep', tabs: 4 }).split('\n')) for (const t of E.wrap(para, Math.max(10, w - 2))) lines.push([[t, '']]);
      }
      return lines;
    }
    drawInfo(scr, A, wide) {
      const s = this.s, m = this.m, G = this.G;
      const c = m.commits.get(s.sel);
      const f = c ? this.files(c.hash) : null;
      const nf = f && f.status === 'ready' ? f.files.length : null;
      const tabs = [{ label: 'Commit', on: true }];
      if (!wide) tabs.push({ label: 'Files' + (nf != null ? ' ' + nf : ''), f: 'files', on: false });
      this.panelTitle(scr, A, tabs, wide ? null : G.enter + ' files');
      if (!c) { scr.text(A.x + 2, A.y + 2, 'Nothing selected.', this.S('mu')); return; }
      const lines = this.infoLines(c, A.w - 2);
      const H = A.h - 1;
      for (let i = 0; i < Math.min(H, lines.length); i++) {
        const y = A.y + 1 + i;
        if (i === H - 1 && lines.length > H) { scr.text(A.x + 1, y, G.ell + ' ' + (lines.length - H + 1) + ' more lines', this.S('mu'), A.w - 2); break; }
        let x = A.x + 1;
        for (const [t, st] of lines[i]) { if (!t) continue; x += scr.text(x, y, t, st, A.x + A.w - 1 - x, true); }
      }
    }
    statusStyle(stc) { return { A: 'ad', D: 'rm', M: 'wa', R: 'ac', C: 'ac', T: 'mu' }[stc] || 'mu'; }
    drawFiles(scr, A, side, stacked) {
      const s = this.s, G = this.G;
      const c = this.m.commits.get(s.sel);
      const f = c ? this.files(c.hash) : { status: 'none' };
      const tabs = side || stacked ? [] : [{ label: 'Commit', f: 'timeline', on: false }];
      let summary = '';
      if (f.status === 'ready') {
        let ins = 0, del = 0;
        for (const x of f.files) { ins += x.ins || 0; del += x.del || 0; }
        summary = '+' + ins + ' ' + G.minus + del;
      }
      tabs.push({ label: 'Files' + (f.status === 'ready' ? ' ' + f.files.length : ''), f: 'files', on: true });
      this.panelTitle(scr, A, tabs, s.focus === 'files' ? G.enter + ' diff  esc back' : stacked ? G.enter + ' files  ' + summary : summary);
      if (side) for (let y = A.y + 1; y < A.y + A.h; y++) scr.put(A.x, y, G.vline, this.S('mu ln'));
      const x0 = A.x + (side ? 2 : 1), w = A.w - (side ? 3 : 2);
      if (f.status === 'loading') { scr.text(x0, A.y + 1, 'Loading changed files' + G.ell, this.S('mu'), w); return; }
      if (f.status === 'error') { scr.text(x0, A.y + 1, 'Could not load changed files: ' + (f.message || 'error'), this.S('wa'), w); return; }
      if (f.status !== 'ready') { scr.text(x0, A.y + 1, f.status === 'unavailable' ? 'Changed files are not part of this snapshot.' : '', this.S('mu'), w); return; }
      if (!f.files.length) { scr.text(x0, A.y + 1, 'No file changes in this commit.', this.S('mu'), w); return; }
      const H = A.h - 1;
      if (s.fileSel < s.fileScroll) s.fileScroll = s.fileSel;
      if (s.fileSel >= s.fileScroll + H) s.fileScroll = s.fileSel - H + 1;
      s.fileScroll = Math.max(0, Math.min(s.fileScroll, Math.max(0, f.files.length - H)));
      scr.hits.push({ x: A.x, y: A.y + 1, w: A.w, h: H, t: 'filesArea' });
      for (let i = 0; i < H && s.fileScroll + i < f.files.length; i++) {
        const k = s.fileScroll + i, x = f.files[k], y = A.y + 1 + i;
        const selected = k === s.fileSel && (s.focus === 'files' || s.focus === 'diff');
        const rowSt = selected ? ' sel' : '';
        if (selected) scr.fill(x0 - 1, y, w + 2, 1, this.S('sel'));
        const stat = x.sub ? 'submodule' : x.bin ? 'binary' : '+' + x.ins + ' ' + G.minus + x.del;
        const sw = E.width(stat);
        const letter = x.sub ? 'S' : x.st;
        scr.text(x0, y, letter, this.S(this.statusStyle(x.st) + ' b' + rowSt));
        const pathW = Math.max(4, w - sw - 3);
        let p = E.sanitize(x.path);
        if (x.old) {
          const a = E.sanitize(x.old).split('/'), b = p.split('/');
          let k2 = 0;
          while (k2 < a.length - 1 && k2 < b.length - 1 && a[k2] === b[k2]) k2++;
          const pre = a.slice(0, k2).join('/');
          p = (pre ? pre + '/' : '') + '{' + a.slice(k2).join('/') + ' ' + G.arrow + ' ' + b.slice(k2).join('/') + '}';
        }
        scr.text(x0 + 2, y, E.truncateLeft(p, pathW, s.unicode ? '…' : '~'), this.S(rowSt.trim()), pathW, true);
        let sx = x0 + w - sw;
        if (x.sub || x.bin) scr.text(sx, y, stat, this.S('mu' + rowSt));
        else {
          sx += scr.text(sx, y, '+' + x.ins, this.S('ad' + rowSt));
          scr.text(sx, y, ' ' + G.minus + x.del, this.S('rm' + rowSt));
        }
        scr.hits.push({ x: A.x, y, w: A.w, h: 1, t: 'file', i: k });
      }
    }
    drawDiff(scr, A) {
      const s = this.s, G = this.G;
      const c = this.m.commits.get(s.sel);
      const f = c ? this.files(c.hash) : null;
      const file = f && f.status === 'ready' ? f.files.find((x) => x.path === s.diffPath) : null;
      const n = f && f.status === 'ready' ? f.files.length : 0;
      this.panelTitle(scr, A, [{ label: 'Files', f: 'files', on: false }, { label: 'Diff', f: 'diff', on: true }], (n ? s.fileSel + 1 + '/' + n + '  ' : '') + ', . file  esc back');
      scr.hits.push({ x: A.x, y: A.y + 1, w: A.w, h: A.h - 1, t: 'diffArea' });
      if (!file) { scr.text(A.x + 1, A.y + 1, 'No file selected.', this.S('mu'), A.w - 2); return; }
      let x = A.x + 1;
      const y1 = A.y + 1;
      x += scr.text(x, y1, (file.sub ? 'S' : file.st) + ' ', this.S(this.statusStyle(file.st) + ' b'));
      const p = (file.old ? E.sanitize(file.old) + ' ' + G.arrow + ' ' : '') + E.sanitize(file.path);
      x += scr.text(x, y1, p, this.S('b'), A.w - 20, true);
      if (file.sub) scr.text(x + 2, y1, 'submodule pointer', this.S('mu'));
      else if (file.bin) scr.text(x + 2, y1, 'binary ' + bytes(file.oldSize || 0) + ' ' + G.arrow + ' ' + bytes(file.newSize || 0), this.S('mu'));
      else { x += 2; x += scr.text(x, y1, '+' + file.ins, this.S('ad')); scr.text(x, y1, ' ' + G.minus + file.del, this.S('rm')); }
      const P = this.patch(c.hash, file.path);
      const top = A.y + 2, H = A.h - 2;
      if (P.status === 'loading') { scr.text(A.x + 1, top, 'Loading patch' + G.ell, this.S('mu')); return; }
      if (P.status !== 'ready') { scr.text(A.x + 1, top, 'Patch unavailable.', this.S('wa')); return; }
      const lines = P.lines;
      const total = lines.length + (P.patch.truncated ? 1 : 0);
      s.diffScroll = Math.max(0, Math.min(s.diffScroll, Math.max(0, total - 3)));
      const nums = A.w >= 70;
      const gw = nums ? 11 : 0;
      const tw = A.w - 2 - gw;
      for (let i = 0; i < H; i++) {
        const k = s.diffScroll + i, y = top + i;
        if (k >= total) break;
        if (k === lines.length) {
          const msg = G.hline + G.hline + ' preview truncated: ' + Math.min(lines.length, P.patch.lines) + ' of ' + P.patch.lines.toLocaleString('en-GB') + ' lines shown (limit 400 lines / 64 KB) ' + G.hline + G.hline;
          scr.text(A.x + 1, y, msg, this.S('wa b'), A.w - 2);
          break;
        }
        const ln = lines[k];
        const st = { add: 'ad', del: 'rm', hunk: 'hk', meta: 'mu', ctx: '' }[ln.t];
        if (nums) {
          scr.text(A.x + 1, y, (ln.o != null ? String(ln.o).padStart(4) : '    ') + ' ' + (ln.n != null ? String(ln.n).padStart(4) : '    '), this.S('mu'));
          scr.put(A.x + 1 + 10, y, G.vline, this.S('mu ln'));
        }
        const body = E.sanitize(ln.s, { tabs: 4 });
        const cs = E.cells(body);
        let skip = s.diffX, start = 0;
        while (start < cs.length && skip > 0) { skip -= cs[start].w; start++; }
        let out = '', used = 0, cut = false;
        for (let j = start; j < cs.length; j++) { if (used + cs[j].w > tw) { cut = true; break; } out += cs[j].ch; used += cs[j].w; }
        const bx = A.x + 1 + gw;
        if (ln.t === 'add' || ln.t === 'del') scr.fill(bx, y, tw, 1, this.S(st + 'b'));
        scr.text(bx, y, out, this.S(st + (ln.t === 'add' || ln.t === 'del' ? ' ' + st + 'b' : '')), tw, true);
        if (cut) scr.put(A.x + A.w - 2, y, G.more, this.S('mu b'));
      }
    }

    drawFooter(scr, g) {
      const s = this.s, G = this.G, W = scr.cols, y = scr.rows - 1;
      scr.fill(0, y, W, 1, this.S('ft'));
      if (s.search.prompt) {
        let x = scr.text(0, y, ' /', this.S('ft b'));
        x += scr.text(x, y, s.search.input, this.S('ft'), W - x - 18);
        scr.put(x, y, G.cursor, this.S('ft ac'));
        const n = this.findMatches(s.search.input).length;
        const right = (s.search.input.trim() ? n + (n === 1 ? ' match' : ' matches') + '  ' : '') + G.enter + ' find  esc cancel ';
        if (W - E.width(right) > x + 2) scr.text(W - E.width(right), y, right, this.S('ft mu'));
        return;
      }
      let hints;
      if (s.overlay === 'help') hints = [['any key', 'close']];
      else if (s.overlay === 'dates') hints = [['↑↓', 'move'], [G.enter, 'apply'], ['esc', 'close']];
      else if (s.overlay) hints = [['↑↓', 'move'], ['space', 'toggle'], ['a', 'all'], ['n', 'none'], ['o', 'only'], ['esc', 'close']];
      else if (s.focus === 'files') hints = [['↑↓', 'file'], [G.enter, 'diff'], ['esc', 'back'], ['tab', 'panel'], ['?', 'help']];
      else if (s.focus === 'diff') hints = [['↑↓', 'scroll'], ['←→', 'pan'], [', .', 'file'], ['esc', 'back'], ['?', 'help']];
      else if (this.world()) hints = [['←→', 'commit'], ['↑↓', 'trail'], ['[ ]', 'zoom'], [G.enter, 'open'], ['p', 'journey'], ['v', 'graph'], ['/', 'search'], ['?', 'help'], ['q', 'quit']];
      else hints = [['←→', 'commit'], ['↑↓', 'lane'], ['[ ]', 'zoom'], [G.enter, 'open'], ['v', 'world'], ['f', 'branches'], ['/', 'search'], ['?', 'help'], ['q', 'quit']];
      if (!s.unicode) hints = hints.map(([k, v]) => [k.replace('↑↓', 'up/dn').replace('←→', 'lt/rt'), v]);
      const msg = s.msg && this.now() < s.msg.until ? s.msg : null;
      if (msg) scr.next = Math.min(scr.next, msg.until);
      const msgW = msg ? Math.min(W - 2, E.width(msg.text) + 2) : 0;
      let x = 1;
      for (const [k, v] of hints) {
        const w = E.width(k) + 1 + E.width(v);
        if (x + w > W - msgW - 1) break;
        x += scr.text(x, y, k, this.S('ft key b'));
        x += scr.text(x + 1, y, v, this.S('ft mu')) + 3;
      }
      if (msg) scr.text(Math.max(1, W - msgW), y, msg.text, this.S('ft ' + (msg.kind === 'warn' ? 'wa b' : 'ac')), W - 2);
    }

    drawOverlay(scr) {
      const s = this.s, G = this.G;
      scr.hits.push({ x: 0, y: 0, w: scr.cols, h: scr.rows, t: 'ovclose' });
      if (s.overlay === 'help') { this.drawHelp(scr); return; }
      const all = this.ovItems();
      const title = { branches: 'Branches and tags', authors: 'Authors', dates: 'Date range' }[s.overlay];
      const note = s.overlay === 'branches' ? 'History reachable from the checked refs is shown.' : s.overlay === 'authors' ? 'Unchecked authors stay in the graph, dimmed.' : 'Relative to when this snapshot was taken (' + fmtDay(this.m.meta.capturedAt || 0) + ').';
      const W = Math.min(scr.cols - 2, 60);
      const maxRows = Math.max(3, scr.rows - 8);
      const listH = Math.min(all.length, maxRows);
      const H = listH + 5;
      const bx = Math.floor((scr.cols - W) / 2), by = Math.max(0, Math.floor((scr.rows - H) / 2));
      this.box(scr, bx, by, W, H, title);
      scr.hits.push({ x: bx, y: by, w: W, h: H, t: 'box' });
      scr.text(bx + 2, by + 1, note, this.S('mu'), W - 4);
      const selectable = all.filter((x) => !x.header);
      const cur = selectable[s.ovSel];
      const curRow = all.indexOf(cur);
      if (curRow < s.ovScroll) s.ovScroll = curRow;
      if (curRow >= s.ovScroll + listH) s.ovScroll = curRow - listH + 1;
      s.ovScroll = Math.max(0, Math.min(s.ovScroll, all.length - listH));
      for (let i = 0; i < listH; i++) {
        const it = all[s.ovScroll + i];
        const y = by + 2 + i;
        if (!it) break;
        if (it.header) { scr.text(bx + 2, y, it.header, this.S('mu b'), W - 4); continue; }
        const isCur = it === cur;
        if (isCur) scr.fill(bx + 1, y, W - 2, 1, this.S('sel'));
        const mark = it.radio ? (it.on ? G.radioOn : G.radioOff) : it.on ? G.on : G.off;
        const st = isCur ? ' sel' : '';
        let x = bx + 2;
        x += scr.text(x, y, mark + ' ', this.S((it.on ? 'ac b' : 'mu') + st));
        const hintW = it.hint ? E.width(it.hint) : 0;
        scr.text(x, y, it.label, this.S((it.on ? '' : 'mu') + st), W - 4 - (x - bx - 2) - hintW - 2);
        if (it.hint && W > 30) scr.text(bx + W - 2 - hintW, y, it.hint, this.S('mu' + st));
        scr.hits.push({ x: bx + 1, y, w: W - 2, h: 1, t: 'ov', i: selectable.indexOf(it) });
      }
      const foot = by + H - 2;
      if (s.overlay !== 'dates') {
        let x = bx + 2;
        for (const [label, mode] of [['all', 'all'], ['none', 'none'], ['only this', 'only']]) {
          const w = scr.text(x, foot, '[' + label + ']', this.S('ac'));
          scr.hits.push({ x, y: foot, w, h: 1, t: 'ovbulk', mode });
          x += w + 2;
        }
      }
      const done = '[done]';
      scr.text(bx + W - 2 - E.width(done), foot, done, this.S('ac b'));
      scr.hits.push({ x: bx + W - 2 - E.width(done), y: foot, w: E.width(done), h: 1, t: 'ovclose' });
    }
    box(scr, x, y, w, h, title) {
      const B = this.G.box;
      scr.fill(x, y, w, h, this.S('ov'));
      for (let i = 1; i < w - 1; i++) { scr.put(x + i, y, B[4], this.S('bx ov')); scr.put(x + i, y + h - 1, B[4], this.S('bx ov')); }
      for (let j = 1; j < h - 1; j++) { scr.put(x, y + j, B[5], this.S('bx ov')); scr.put(x + w - 1, y + j, B[5], this.S('bx ov')); }
      scr.put(x, y, B[0], this.S('bx ov')); scr.put(x + w - 1, y, B[1], this.S('bx ov'));
      scr.put(x, y + h - 1, B[2], this.S('bx ov')); scr.put(x + w - 1, y + h - 1, B[3], this.S('bx ov'));
      if (title) scr.text(x + 2, y, ' ' + title + ' ', this.S('b ov'), w - 4);
    }
    drawHelp(scr) {
      const s = this.s, G = this.G;
      const keys = [
        [s.unicode ? '← →  h l' : 'left right  h l', 'previous / next commit in time'],
        [s.unicode ? '↑ ↓  k j' : 'up down  k j', 'nearest commit on the trail above / below'],
        [s.unicode ? '⇧← ⇧→  H L' : 'shift+left/right  H L', 'pan half a screen, keep the selection'],
        ['PgUp PgDn  J K', 'scroll lanes'],
        ['[ ]  - +', 'zoom out / in (also pinch)'],
        ['g  G', 'jump to HEAD / oldest commit'],
        [G.enter + '  tab  esc', 'open files, then diff · next panel · back'],
        [', .', 'previous / next file in the diff'],
        ['f  a  d', 'filter branches · authors · date range'],
        ['/  n  N', 'search · older match · newer match'],
        ['p', 'journey: travel from the first commit to HEAD'],
        ['v', 'world view / graph view (time to scale)'],
        ['q  ctrl+c', 'quit (restores the terminal)'],
      ];
      const legend = [
        [G.commit, 'commit'], [G.merge, 'merge commit'], [G.head, 'HEAD'], [G.dim, 'commit by a filtered-out author'],
        [G.tag, 'release tag'], ['~name', 'branch name taken from a merge message'],
        [G.lstub + G.dashH, 'history continues outside the range'], [G.warn, 'dated before its parent; drawn after it'],
        [s.unicode ? '♟' : 'i', 'you, at the selected commit'],
        ['world', 'every ' + WD.PER_ERA + ' commits, a new age: sea, shores, forests,'],
        ['', 'dinosaurs, ice, stone age, ancient, medieval, industry,'],
        ['', 'city, far future. Branches are trails; hills rise under them'],
      ];
      const W = Math.min(scr.cols - 2, 66);
      const H = Math.min(scr.rows - 2, keys.length + legend.length + 6);
      const bx = Math.floor((scr.cols - W) / 2), by = Math.max(0, Math.floor((scr.rows - H) / 2));
      this.box(scr, bx, by, W, H, 'Keys and legend');
      scr.hits.push({ x: bx, y: by, w: W, h: H, t: 'ovclose' });
      const kw = Math.min(20, Math.floor(W * 0.38));
      let y = by + 1;
      for (const [k, v] of keys) {
        if (y >= by + H - 1) break;
        scr.text(bx + 2, y, k, this.S('ac b ov'), kw);
        scr.text(bx + 2 + kw + 1, y, v, this.S('ov'), W - kw - 5);
        y++;
      }
      if (y < by + H - 2) { scr.text(bx + 2, ++y - 1 + 1, 'Legend', this.S('mu b ov'), W - 4); y += 1; }
      for (const [k, v] of legend) {
        if (y >= by + H - 1) break;
        const nodeKind = { [G.commit]: 'commit', [G.merge]: 'merge', [G.head]: 'head', [G.dim]: 'dim' }[k];
        if (nodeKind && s.unicode) scr.put(bx + 3, y, k, this.S('c0 ov' + (nodeKind === 'dim' ? ' d' : '')), { k: nodeKind, m: 0 });
        else scr.text(bx + 3, y, k, this.S((k === G.warn ? 'wa' : k === G.tag ? 'tg' : 'c0') + ' b ov'), 6);
        scr.text(bx + 2 + 7, y, v, this.S('ov'), W - 12);
        y++;
      }
    }
    drawExited(scr) {
      const G = this.G;
      const w = Math.max(10, scr.cols - 2);
      let y = 1;
      scr.text(1, y, '$ git-timeline', this.S('b'), w); y += 2;
      for (const t of E.wrap('git-timeline exited. It closed the alternate screen and restored the cursor and keyboard modes, as it does after q, Ctrl+C or an error.', w)) scr.text(1, y++, t, this.S('mu'), w);
      y++;
      scr.text(1, y, '$ ', this.S('b'), w);
      scr.put(3, y, G.cursor, this.S('ac'));
      y += 3;
      for (const t of E.wrap('Press any key, or tap, to run it again.', w)) scr.text(1, y++, t, this.S('ac'), w);
      scr.hits.push({ x: 0, y: 0, w: scr.cols, h: scr.rows, t: 'relaunch' });
    }
  }

  // ---------------------------------------------------------------- non-interactive output
  function renderStatic(model, o) {
    o = o || {};
    const app = new App(model, {});
    app.s.unicode = o.unicode !== false;
    app.s.color = o.color !== false;
    app.s.zoom = o.zoom != null ? o.zoom : 2;
    app.G = app.s.unicode ? GU : GA;
    const G = app.G, m = model;
    const head = m.head.unborn ? 'no commits yet' : m.head.detached ? 'HEAD detached at ' + app.short(m.head.hash) : 'HEAD ' + G.arrow + ' ' + m.headBranch + ' ' + app.short(m.head.hash);
    const legend = G.commit + ' commit  ' + G.merge + ' merge  ' + G.head + ' HEAD  ' + G.tag + ' tag  ~name inferred from a merge  ' + G.lstub + ' continues outside the range  ' + G.warn + ' dated before its parent';
    if (o.view !== 'graph') {
      // the world, end to end: one slot of 8 cells per commit, every 7 commits a new age
      app.s.view = 'world';
      app.spacing = () => 8;
      const L = app.layout();
      const gap = 3, groundRows = 3, sky = 8;
      const H = 1 + sky + (Math.max(1, L.lanes) - 1) * gap + 1 + groundRows;
      const title = (m.meta.repo || 'repository') + '  ' + head + '  ' + L.nodes.length + ' commits  ' + WD.PER_ERA + ' commits per age of Earth  (snapshot, not interactive)';
      const note = 'world: branches are trails, hills rise under them; every ' + WD.PER_ERA + ' commits the land moves on through Earth\'s history, from the primordial sea to the far future';
      const cols = Math.max(64, L.width + 20);
      const rows = H + 3;
      const scr = new Screen(cols, rows, !app.s.unicode);
      scr.text(0, 0, title, app.S('b'));
      const A = { x: 0, y: 1, w: cols, h: H };
      app.drawWorld(scr, A, {}, L, { interactive: false, scrollX: 0, scrollY: 0, yGround: A.y + H - groundRows - 1, gap, visLanes: Math.max(1, L.lanes) });
      scr.text(0, rows - 2, legend, app.S('mu'));
      scr.text(0, rows - 1, note, app.S('mu'));
      scr.meta = { title, legend: [legend, note] }; // full text, for printing outside the grid
      return scr;
    }
    app.s.view = 'graph';
    const L = app.layout();
    let nameW = 4;
    for (const ch of L.shown) nameW = Math.max(nameW, E.width(ch.ref ? ch.name : '~' + (ch.name || '')));
    const gut = Math.min(26, nameW + 3);
    const laneRows = Math.max(1, 2 * L.lanes);
    const title = (m.meta.repo || 'repository') + '  ' + head + '  ' + L.nodes.length + ' commits  1 column = ' + E.ZOOMS[app.s.zoom].long + '  (snapshot, not interactive)';
    const cols = gut + Math.max(L.width + 2, L.nodes.length ? 40 : 52);
    const rows = 1 + 2 + 1 + laneRows + 1;
    const scr = new Screen(cols, rows, !app.s.unicode);
    scr.text(0, 0, title, app.S('b'));
    app.drawTimeline(scr, { x: 0, y: 1, w: cols, h: 3 + laneRows }, { gutter: gut, tw: cols - gut, visLanes: L.lanes, band: 1 }, L, { interactive: false, scrollX: 0, scrollY: 0, gutter: gut, band: 1 });
    scr.text(0, rows - 1, legend, app.S('mu'));
    scr.meta = { title, legend: [legend] };
    return scr;
  }
  function renderJSON(model, o) {
    o = o || {};
    const L = E.layout(model, { sec: E.ZOOMS[o.zoom != null ? o.zoom : 2].sec });
    const m = model;
    const j = (v) => JSON.stringify(v);
    const out = ['{'];
    out.push('  "format": "git-timeline/snapshot@1",');
    out.push('  "repository": ' + j({ name: m.meta.repo, head: { hash: m.head.hash, ref: m.head.ref, detached: !!m.head.detached, unborn: !!m.head.unborn }, shallow: !!m.meta.shallow, capturedAt: m.meta.capturedAt }) + ',');
    out.push('  "layout": ' + j({ secondsPerColumn: L.sec, width: L.width, lanes: L.lanes }) + ',');
    out.push('  "paths": [');
    L.shown.forEach((ch, i) => out.push('    ' + j({ id: ch.id, lane: ch.lane, name: ch.name, ref: ch.ref ? ch.ref.name : null, inferred: ch.inferred, from: ch.start, to: ch.end, commits: ch.vis.length }) + (i < L.shown.length - 1 ? ',' : '')));
    out.push('  ],');
    out.push('  "commits": [');
    L.nodes.forEach((n, i) => {
      const c = m.commits.get(n.h);
      out.push('    ' + j({ hash: c.hash, parents: c.parents, x: n.x, lane: n.lane, path: n.chain, subject: c.subject, author: c.authorName, authorTime: c.authorTime, committerTime: c.committerTime, refs: c.refs.map((r) => r.name), era: WD.eraOf(m, c.hash).era.name, skew: L.skew.has(c.hash) || undefined }) + (i < L.nodes.length - 1 ? ',' : ''));
    });
    out.push('  ],');
    out.push('  "edges": [');
    L.edges.forEach((e, i) => out.push('    ' + j({ child: e.from, parent: e.to, kind: e.kind, abbreviated: e.dash || undefined }) + (i < L.edges.length - 1 ? ',' : '')));
    out.push('  ]');
    out.push('}');
    return out.join('\n') + '\n';
  }

  const api = { App, Screen, renderStatic, renderJSON, parsePatch, MASK_U, MASK_A, GU, GA, UP, DN, LT, RT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GTTui = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
