/* git-timeline prototype · layout engine
 *
 * Pure functions: no DOM, no git, no terminal size, no rendering.
 * The same file runs in the browser (classic script) and in Node tests.
 *
 *   records ──buildModel──▶ model ──layout(zoom, filters)──▶ columns, lanes, connector segments
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ small utilities
  class Heap {
    constructor(less) { this.a = []; this.less = less; }
    get size() { return this.a.length; }
    push(v) {
      const a = this.a;
      a.push(v);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.less(a[i], a[p])) break;
        const t = a[i]; a[i] = a[p]; a[p] = t; i = p;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && this.less(a[l], a[m])) m = l;
          if (r < a.length && this.less(a[r], a[m])) m = r;
          if (m === i) break;
          const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
        }
      }
      return top;
    }
  }

  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  // ------------------------------------------------------------------ untrusted text
  // Repository text (subjects, bodies, names, paths, refs) is untrusted. Control
  // characters become visible symbols so nothing can drive the terminal.
  const isBidi = (cp) => cp === 0x061c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x2028 || cp === 0x2029;
  function sanitize(s, o) {
    if (s == null) return '';
    s = String(s);
    if (s.normalize) s = s.normalize('NFC');
    const keepNL = !!(o && o.newlines === 'keep');
    const tab = o && typeof o.tabs === 'number' ? ' '.repeat(o.tabs) : null;
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp < 0x7f) { out += ch; continue; }
      if (cp === 0x0a && keepNL) out += '\n';
      else if (cp === 0x09 && tab !== null) out += tab;
      else if (cp < 0x20) out += String.fromCharCode(0x2400 + cp); // ␀ … ␟, ESC → ␛
      else if (cp === 0x7f) out += '␡';
      else if (cp < 0xa0) out += '�'; // C1 controls (CSI 0x9b, etc.)
      else if (isBidi(cp)) out += '�'; // reordering controls ("Trojan Source")
      else out += ch;
    }
    return out;
  }

  // Terminal cell widths (wcwidth-style; East Asian Wide and emoji take two cells)
  const WIDE = [[0x1100, 0x115F], [0x231A, 0x231B], [0x2329, 0x232A], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F], [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3], [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF], [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x1F004, 0x1F004], [0x1F0CF, 0x1F0CF], [0x1F18E, 0x1F18E], [0x1F191, 0x1F19A], [0x1F200, 0x1F2FF], [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F7E0, 0x1F7EB], [0x1F90C, 0x1F9FF], [0x1FA70, 0x1FAFF], [0x20000, 0x3FFFD]];
  const ZERO = [[0x0300, 0x036F], [0x0483, 0x0489], [0x0591, 0x05BD], [0x0610, 0x061A], [0x064B, 0x065F], [0x0E31, 0x0E31], [0x0E34, 0x0E3A], [0x1AB0, 0x1AFF], [0x1DC0, 0x1DFF], [0x200B, 0x200D], [0x20D0, 0x20FF], [0xFE00, 0xFE0F], [0xFE20, 0xFE2F], [0xFEFF, 0xFEFF], [0x1F3FB, 0x1F3FF], [0xE0100, 0xE01EF]];
  function inRanges(cp, R) {
    let lo = 0, hi = R.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < R[mid][0]) hi = mid - 1;
      else if (cp > R[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  }
  function charWidth(cp) {
    if (cp < 0x300) return cp < 0x20 ? 0 : 1;
    if (inRanges(cp, ZERO)) return 0;
    return inRanges(cp, WIDE) ? 2 : 1;
  }
  // Split into terminal cells; zero-width marks attach to the previous cell.
  function cells(s) {
    const out = [];
    for (const ch of s) {
      const w = charWidth(ch.codePointAt(0));
      if (w === 0) { if (out.length) out[out.length - 1].ch += ch; continue; }
      out.push({ ch, w });
    }
    return out;
  }
  function width(s) {
    let w = 0;
    for (const ch of s) w += charWidth(ch.codePointAt(0));
    return w;
  }
  function truncate(s, max, ell) {
    if (ell == null) ell = '…';
    if (max <= 0) return '';
    if (width(s) <= max) return s;
    const ew = width(ell);
    let out = '', used = 0;
    for (const c of cells(s)) {
      if (used + c.w > max - ew) break;
      out += c.ch; used += c.w;
    }
    return out + ell;
  }
  function truncateLeft(s, max, ell) {
    if (ell == null) ell = '…';
    if (max <= 0) return '';
    if (width(s) <= max) return s;
    const cs = cells(s);
    const ew = width(ell);
    let out = '', used = 0;
    for (let i = cs.length - 1; i >= 0; i--) {
      if (used + cs[i].w > max - ew) break;
      out = cs[i].ch + out; used += cs[i].w;
    }
    return ell + out;
  }
  // Greedy word wrap of one line (no newlines) to a display width.
  function wrap(s, max) {
    if (max <= 0) return [];
    let lead = /^\s*/.exec(s)[0];
    if (width(lead) >= max / 2) lead = '';
    const words = s.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lw = width(lead);
    const lines = [];
    let cur = lead, cw = lw;
    for (let w of words) {
      let ww = width(w);
      const sep = cw > lw ? 1 : 0;
      if (cw + sep + ww <= max) { cur += (sep ? ' ' : '') + w; cw += sep + ww; continue; }
      if (cw > lw) { lines.push(cur); cur = lead; cw = lw; }
      while (cw + ww > max) {
        const head = truncate(w, max - cw, '');
        if (!head) break;
        lines.push(cur + head);
        w = w.slice(head.length); ww = width(w); cur = lead; cw = lw;
      }
      cur += w; cw += ww;
    }
    lines.push(cur);
    return lines;
  }

  // ------------------------------------------------------------------ model
  function normRef(r) {
    const n = r.name;
    let kind = 'other', short = n;
    if (n.startsWith('refs/heads/')) { kind = 'branch'; short = n.slice(11); }
    else if (n.startsWith('refs/remotes/')) { kind = 'remote'; short = n.slice(13); }
    else if (n.startsWith('refs/tags/')) { kind = 'tag'; short = n.slice(10); }
    return { name: n, kind, short, target: r.target, annotated: !!r.annotated, message: r.message || '', tagger: r.tagger || '', taggerTime: r.taggerTime || null };
  }

  function buildModel(records) {
    const m = { meta: {}, head: { hash: null, ref: null, detached: false, unborn: true }, status: null, refs: [], commits: new Map(), list: [], children: new Map(), authors: [], shortLen: 7, warnings: [], headBranch: null };
    const raw = [];
    for (const r of records || []) {
      if (r.kind === 'meta') m.meta = r;
      else if (r.kind === 'head') m.head = r;
      else if (r.kind === 'status') m.status = r;
      else if (r.kind === 'ref') raw.push(r);
      else if (r.kind === 'commit' && !m.commits.has(r.h)) {
        const c = {
          hash: r.h, parents: Array.from(new Set(r.p || [])),
          authorName: r.an || '', authorEmail: r.ae || '', authorTime: r.at, authorISO: r.ai || '',
          committerName: r.cn || '', committerEmail: r.ce || '', committerTime: r.ct, committerISO: r.ci || '',
          subject: r.s || '', body: r.b || '', shallow: !!r.shallow, refs: [], missing: [],
        };
        m.commits.set(c.hash, c);
        m.list.push(c);
      }
    }
    for (const c of m.list) {
      for (const p of c.parents) {
        if (!m.commits.has(p)) { c.missing.push(p); continue; }
        let k = m.children.get(p);
        if (!k) m.children.set(p, (k = []));
        k.push(c.hash);
      }
    }
    for (const r of raw) {
      const ref = normRef(r);
      if (!m.commits.has(ref.target)) { m.warnings.push('Ref ' + ref.name + ' points at an object that is not a loaded commit.'); continue; }
      m.refs.push(ref);
    }
    if (m.head && m.head.detached && m.commits.has(m.head.hash)) m.refs.push({ name: 'HEAD', kind: 'head', short: 'HEAD', target: m.head.hash, annotated: false, message: '' });
    for (const ref of m.refs) m.commits.get(ref.target).refs.push(ref);
    m.headBranch = m.head && m.head.ref ? m.head.ref.replace(/^refs\/heads\//, '') : null;
    const hs = m.list.map((c) => c.hash).sort();
    let common = 0;
    for (let i = 1; i < hs.length; i++) {
      let k = 0;
      while (k < hs[i].length && hs[i][k] === hs[i - 1][k]) k++;
      if (k > common) common = k;
    }
    m.shortLen = Math.max(7, common + 1);
    const by = new Map();
    for (const c of m.list) {
      const name = sanitize(c.authorName);
      const key = name + ' <' + c.authorEmail + '>';
      let a = by.get(key);
      if (!a) by.set(key, (a = { key, name, email: c.authorEmail, count: 0 }));
      a.count++;
      c.authorKey = key;
    }
    m.authors = Array.from(by.values()).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    return m;
  }

  // ------------------------------------------------------------------ ordering
  // Kahn's algorithm with a min-heap on committer time: parents always come
  // before children; among commits that are ready, the earliest goes first.
  function timeTopo(m, set, extra) {
    const C = m.commits;
    const indeg = new Map();
    const kids = new Map();
    const heap = new Heap((a, b) => a.t < b.t || (a.t === b.t && a.h < b.h));
    for (const h of set) {
      const c = C.get(h);
      const ps = extra ? c.parents.concat(extra(h)) : c.parents;
      let d = 0;
      for (const p of ps) {
        if (!set.has(p)) continue;
        d++;
        let k = kids.get(p);
        if (!k) kids.set(p, (k = []));
        k.push(h);
      }
      indeg.set(h, d);
      if (d === 0) heap.push({ h, t: c.committerTime });
    }
    const order = [];
    while (heap.size) {
      const { h } = heap.pop();
      order.push(h);
      for (const k of kids.get(h) || []) {
        const d = indeg.get(k) - 1;
        indeg.set(k, d);
        if (d === 0) heap.push({ h: k, t: C.get(k).committerTime });
      }
    }
    let cycle = false;
    if (order.length < set.size) {
      cycle = true; // malformed history (e.g. a bad replace ref): keep going, flag it
      const placed = new Set(order);
      const rest = Array.from(set).filter((h) => !placed.has(h)).sort((a, b) => C.get(a).committerTime - C.get(b).committerTime || (a < b ? -1 : 1));
      for (const h of rest) order.push(h);
    }
    return { order, cycle };
  }

  function inferBranchName(subject, k) {
    let mt;
    if ((mt = /^Merge branch '([^']+)'/.exec(subject))) return k === 1 ? mt[1] : null;
    if ((mt = /^Merge branches (.+?)(?: into \S+)?$/.exec(subject))) {
      const names = [];
      const re = /'([^']+)'/g;
      let x;
      while ((x = re.exec(mt[1]))) names.push(x[1]);
      return names[k - 1] || null;
    }
    if ((mt = /^Merge remote-tracking branch '([^']+)'/.exec(subject))) return k === 1 ? mt[1] : null;
    if ((mt = /^Merge pull request #\d+ from [^\s/]+\/(\S+)/.exec(subject))) return k === 1 ? mt[1] : null;
    return null;
  }

  function refPriority(m, refs, want) {
    const find = (w) => {
      if (!w) return null;
      return refs.find((r) => r.name === w) || refs.find((r) => r.kind === 'branch' && r.short === w) || refs.find((r) => r.kind === 'remote' && r.short === w) || refs.find((r) => r.kind === 'tag' && r.short === w) || null;
    };
    let primary = find(want);
    const def = m.meta && m.meta.defaultBranch;
    if (!primary) for (const w of [def, def && 'origin/' + def, 'main', 'master', 'trunk', 'develop', m.headBranch]) { primary = find(w); if (primary) break; }
    if (!primary) primary = refs.find((r) => r.kind === 'branch') || refs[0] || null;
    const rank = (r) => (r.kind === 'branch' && r.short === m.headBranch ? 0 : r.kind === 'head' ? 1 : r.kind === 'branch' ? 2 : r.kind === 'remote' ? 3 : r.kind === 'tag' ? 4 : 5);
    const rest = refs.filter((r) => r !== primary).sort((a, b) => rank(a) - rank(b) || (a.short < b.short ? -1 : a.short > b.short ? 1 : 0));
    return { primary, order: primary ? [primary].concat(rest) : rest };
  }

  function nearestVisible(m, start, vis, since, budget) {
    const found = [];
    const seen = new Set();
    const stack = [start];
    const floor = since == null ? -Infinity : since - 30 * 86400;
    while (stack.length && seen.size < budget) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      const c = m.commits.get(h);
      if (!c) continue;
      if (vis.has(h)) { found.push(h); continue; }
      if (c.committerTime < floor) continue;
      for (const p of c.parents) stack.push(p);
    }
    return found;
  }

  // ------------------------------------------------------------------ layout
  const ZOOMS = [
    { sec: 604800, short: '1w', long: '1 week' },
    { sec: 259200, short: '3d', long: '3 days' },
    { sec: 86400, short: '1d', long: '1 day' },
    { sec: 43200, short: '12h', long: '12 hours' },
    { sec: 21600, short: '6h', long: '6 hours' },
    { sec: 10800, short: '3h', long: '3 hours' },
    { sec: 3600, short: '1h', long: '1 hour' },
    { sec: 1200, short: '20m', long: '20 minutes' },
  ];
  const PAD_LEFT = 4;
  const STUB = 3;
  const LANE_GAP = 2; // at least one empty column between two paths sharing a lane
  const NCOLORS = 8;
  const LABEL_MAX = 40;
  const BUCKET = 64;

  /**
   * layout(model, {sec, hidden, since, until, primary, ascii}) → positioned graph.
   *
   * 1. Visible refs seed reachability; their first-parent chains become paths
   *    (primary branch first). Commits reachable only through merges form
   *    anonymous paths, labelled from the merge subject when it parses.
   * 2. Columns: time-respecting topological order; a commit sits at its time
   *    column, pushed right past the previous commit (+1) and its parents (+2).
   *    Every commit owns its column, so a vertical connector can never cross
   *    an unrelated node. Timestamps are never modified.
   * 3. Lanes: greedy interval colouring by start column (optimal lane count);
   *    each path takes the free lane closest to its parent's, primary pinned to 0.
   * 4. Connectors are segments in lane-row coordinates (lane L = row 2L, gaps on
   *    odd rows). Fork: down at the parent's column, then along the child's lane.
   *    Merge: along the merged path's lane, then up at the merge commit's column.
   */
  function layout(m, o) {
    o = o || {};
    const sec = o.sec || 86400;
    const hidden = o.hidden || new Set();
    const C = m.commits;
    const refs = m.refs.filter((r) => !hidden.has(r.name));
    const refSet = new Set(refs);

    // 1. reachability
    const reach = new Set();
    const st = refs.map((r) => r.target);
    while (st.length) {
      const h = st.pop();
      if (reach.has(h)) continue;
      const c = C.get(h);
      if (!c) continue;
      reach.add(h);
      for (const p of c.parents) if (C.has(p) && !reach.has(p)) st.push(p);
    }

    // 2. paths (first-parent chains)
    const pr = refPriority(m, refs, o.primary);
    const chainOf = new Map();
    const chains = [];
    const make = (tip, ref, name) => {
      if (chainOf.has(tip) || !reach.has(tip)) return null;
      const id = chains.length;
      const list = [];
      let h = tip;
      while (h !== undefined && reach.has(h) && !chainOf.has(h)) { list.push(h); chainOf.set(h, id); h = C.get(h).parents[0]; }
      list.reverse();
      const ch = { id, ref: ref || null, name: name || null, inferred: !ref && !!name, kind: ref ? ref.kind : 'anon', commits: list, vis: [], primary: false, lane: -1, color: -1, start: 0, end: 0, label: '', labelX: 0, leftStub: false, rightStub: false };
      chains.push(ch);
      return ch;
    };
    for (const r of pr.order) {
      const ch = make(r.target, r, r.short);
      if (ch && r === pr.primary) ch.primary = true;
    }
    const all = timeTopo(m, reach).order;
    for (let i = all.length - 1; i >= 0; i--) {
      const h = all[i];
      if (chainOf.has(h)) continue;
      let name = null;
      for (const k of m.children.get(h) || []) {
        if (!reach.has(k)) continue;
        const kc = C.get(k);
        const idx = kc.parents.indexOf(h);
        if (idx > 0) { name = inferBranchName(kc.subject, idx); if (name) break; }
      }
      make(h, null, name);
    }

    // 3. date range, and abbreviated edges through commits it hides
    const inRange = (c) => (o.since == null || c.committerTime >= o.since) && (o.until == null || c.committerTime <= o.until);
    const vis = new Set();
    for (const h of reach) if (inRange(C.get(h))) vis.add(h);
    const virt = new Map(); // child -> [{anc, idx}] dashed edges to visible ancestors
    const virtFrom = new Map(); // anc -> [{child, idx}]
    const hiddenParents = new Map(); // child -> [{p, idx}] parents with nothing visible behind them
    if (vis.size !== reach.size) {
      for (const h of vis) {
        C.get(h).parents.forEach((p, idx) => {
          if (!C.has(p) || vis.has(p)) return;
          const found = nearestVisible(m, p, vis, o.since, 2000);
          if (found.length) {
            let arr = virt.get(h);
            if (!arr) virt.set(h, (arr = []));
            for (const a of found) {
              if (arr.some((x) => x.anc === a)) continue;
              arr.push({ anc: a, idx });
              let back = virtFrom.get(a);
              if (!back) virtFrom.set(a, (back = []));
              back.push({ child: h, idx });
            }
          } else {
            let arr = hiddenParents.get(h);
            if (!arr) hiddenParents.set(h, (arr = []));
            arr.push({ p, idx });
          }
        });
      }
    }
    const extraParents = (h) => (virt.get(h) || []).map((v) => v.anc);

    // 4. columns
    const topo = timeTopo(m, vis, virt.size ? extraParents : null);
    const order = topo.order;
    let origin = o.since != null ? o.since : Infinity;
    if (origin === Infinity) for (const h of vis) origin = Math.min(origin, C.get(h).committerTime);
    if (origin === Infinity) origin = o.now || 0;
    const xOf = new Map();
    const skew = new Set();
    // o.spacing: commit-indexed mode for the world view. Every commit gets an equal
    // slot of that many cells, in the same time-respecting topological order.
    const spacing = o.spacing > 1 ? Math.floor(o.spacing) : 0;
    const pad = o.pad != null ? o.pad : PAD_LEFT;
    let lastX = spacing ? pad - spacing : PAD_LEFT - 1;
    for (const h of order) {
      const c = C.get(h);
      let x = spacing ? lastX + spacing : Math.max(PAD_LEFT + Math.floor((c.committerTime - origin) / sec), lastX + 1);
      let maxPT = -Infinity;
      for (const p of c.parents) {
        if (xOf.has(p)) x = Math.max(x, xOf.get(p) + 2);
        const pc = C.get(p);
        if (pc && pc.committerTime > maxPT) maxPT = pc.committerTime;
      }
      for (const a of extraParents(h)) if (xOf.has(a)) x = Math.max(x, xOf.get(a) + 2);
      if (c.committerTime < maxPT) skew.add(h);
      xOf.set(h, x);
      lastX = x;
    }

    // 5. path extents and tip labels
    const shown = [];
    for (const ch of chains) {
      ch.vis = ch.commits.filter((h) => vis.has(h));
      if (!ch.vis.length) continue;
      shown.push(ch);
      const first = ch.vis[0], last = ch.vis[ch.vis.length - 1];
      let start = xOf.get(first), end = xOf.get(last);
      const fc = C.get(first);
      const fp = fc.parents[0];
      if (fp !== undefined && vis.has(fp)) start = Math.min(start, xOf.get(fp));
      else {
        const v = (virt.get(first) || []).find((e) => e.idx === 0);
        if (v) start = Math.min(start, xOf.get(v.anc));
        else if (fp !== undefined || fc.shallow) { ch.leftStub = true; start = xOf.get(first) - STUB; }
      }
      for (const h of ch.vis) {
        for (const k of m.children.get(h) || []) if (vis.has(k) && C.get(k).parents.indexOf(h) > 0) end = Math.max(end, xOf.get(k));
        for (const b of virtFrom.get(h) || []) if (b.idx > 0) end = Math.max(end, xOf.get(b.child));
      }
      const tipX = xOf.get(last);
      if (ch.commits[ch.commits.length - 1] !== last) { ch.rightStub = true; end = Math.max(end, tipX + STUB); }
      const label = tipLabel(m, ch, last, refSet, !!o.ascii);
      ch.fullLabel = label;
      ch.labelMode = 'none';
      if (label && end === (ch.rightStub ? tipX + STUB : tipX)) {
        // the path ends at its tip: label after it, and reserve the space in the lane
        ch.labelMode = 'tip';
        ch.label = label;
        ch.labelX = end + 2;
        end = ch.labelX + width(label) - 1;
      } else if (label) {
        // merged path: put the name inside the widest gap of its own segment, so a
        // label never stops another path from reusing the lane after the merge
        const pts = [start, end];
        for (const h of ch.vis) {
          pts.push(xOf.get(h));
          for (const k of m.children.get(h) || []) if (vis.has(k) && C.get(k).parents.indexOf(h) > 0) pts.push(xOf.get(k));
        }
        pts.sort((a, b) => a - b);
        let best = null;
        const need = width(label);
        for (let i = 1; i < pts.length; i++) {
          const room = pts[i] - pts[i - 1] - 3; // keep one line cell on each side
          if (room >= need) { best = { x: pts[i - 1] + 2, w: room }; break; }
          if (!best || room > best.w) best = { x: pts[i - 1] + 2, w: room };
        }
        if (best && best.w >= Math.min(need, 10)) {
          ch.labelMode = 'inline';
          ch.label = truncate(label, best.w, o.ascii ? '~' : '…');
          ch.labelX = best.x;
        }
      }
      ch.start = start;
      ch.end = end;
    }

    // 6. lanes
    const prim = shown.find((ch) => ch.primary);
    const ends = [];
    const members = [];
    if (prim) { prim.lane = 0; ends[0] = Infinity; members[0] = [prim]; }
    const parentLane = (ch) => {
      const first = ch.vis[0];
      const fp = C.get(first).parents[0];
      let pid = fp !== undefined && vis.has(fp) ? chainOf.get(fp) : -1;
      if (pid < 0) { const v = (virt.get(first) || []).find((e) => e.idx === 0); if (v) pid = chainOf.get(v.anc); }
      if (pid >= 0 && chains[pid].lane >= 0) return chains[pid].lane;
      const tip = ch.vis[ch.vis.length - 1];
      for (const k of m.children.get(tip) || []) {
        if (vis.has(k) && C.get(k).parents.indexOf(tip) > 0) { const kc = chains[chainOf.get(k)]; if (kc.lane >= 0) return kc.lane; }
      }
      return 0;
    };
    const rest = shown.filter((ch) => ch !== prim).sort((a, b) => a.start - b.start || a.id - b.id);
    for (const ch of rest) {
      const pl = parentLane(ch);
      let best = -1, score = Infinity;
      for (let l = 0; l < ends.length; l++) {
        if (ends[l] + LANE_GAP > ch.start) continue;
        const d = l > pl ? l - pl : pl - l + 0.5; // prefer just below the parent
        if (d < score) { score = d; best = l; }
      }
      if (best < 0) { best = ends.length; members[best] = []; }
      ch.lane = best;
      ends[best] = ch.end;
      members[best].push(ch);
    }
    const lanes = ends.length;

    // colours: stable per name, different from neighbours alive at the same time
    if (prim) prim.color = 0;
    for (const ch of shown.slice().sort((a, b) => a.start - b.start || a.id - b.id)) {
      if (ch.color >= 0) continue;
      const used = new Set();
      for (let l = ch.lane - 1; l <= ch.lane + 1; l++) {
        for (const o2 of members[l] || []) if (o2 !== ch && o2.color >= 0 && o2.start <= ch.end + 6 && ch.start <= o2.end + 6) used.add(o2.color);
      }
      const pref = 1 + (fnv(ch.name || 'path' + ch.id) % (NCOLORS - 1));
      ch.color = pref;
      for (let k = 0; k < NCOLORS - 1; k++) {
        const c2 = 1 + ((pref - 1 + k) % (NCOLORS - 1));
        if (!used.has(c2)) { ch.color = c2; break; }
      }
    }

    // 7. connectors
    const segs = [];
    const markers = [];
    const edges = [];
    const rowOf = (ch) => 2 * ch.lane;
    const H = (r, x1, x2, color, dash) => { if (x2 < x1) { const t = x1; x1 = x2; x2 = t; } if (x2 > x1) segs.push({ t: 'h', row: r, x1, x2, color, dash: !!dash }); };
    const V = (x, r1, r2, color, dash) => { if (r2 < r1) { const t = r1; r1 = r2; r2 = t; } if (r2 > r1) segs.push({ t: 'v', col: x, r1, r2, x1: x, x2: x, color, dash: !!dash }); };
    const connect = (child, parent, idx, dash) => {
      const cc = chains[chainOf.get(child)], pc = chains[chainOf.get(parent)];
      const xc = xOf.get(child), xp = xOf.get(parent);
      let kind;
      if (cc === pc) { H(rowOf(cc), xp, xc, cc.color, dash); kind = 'chain'; }
      else if (idx === 0 && cc.vis[0] === child) { V(xp, rowOf(pc), rowOf(cc), cc.color, dash); H(rowOf(cc), xp, xc, cc.color, dash); kind = 'fork'; }
      else { H(rowOf(pc), xp, xc, pc.color, dash); V(xc, rowOf(pc), rowOf(cc), pc.color, dash); kind = 'merge'; }
      edges.push({ from: child, to: parent, kind, dash: !!dash });
    };
    for (const h of order) {
      const c = C.get(h);
      c.parents.forEach((p, idx) => { if (vis.has(p)) connect(h, p, idx, false); });
      for (const v of virt.get(h) || []) connect(h, v.anc, v.idx, true);
      const ch = chains[chainOf.get(h)];
      const x = xOf.get(h);
      if (ch.leftStub && ch.vis[0] === h) {
        H(rowOf(ch), x - STUB, x, ch.color, true);
        markers.push({ x: x - STUB, row: rowOf(ch), kind: 'lstub', color: ch.color, hash: h });
      }
      const extra = (hiddenParents.get(h) || []).filter((e) => e.idx > 0).concat(c.parents.slice(1).filter((p) => !C.has(p)).map((p) => ({ p, idx: 1 })));
      if (extra.length) {
        const pc = chainOf.has(extra[0].p) ? chains[chainOf.get(extra[0].p)] : null;
        markers.push({ x, row: rowOf(ch) + 1, kind: 'hidden-parent', color: pc && pc.color >= 0 ? pc.color : ch.color, hash: h });
      }
    }
    for (const ch of shown) {
      if (!ch.rightStub) continue;
      const xl = xOf.get(ch.vis[ch.vis.length - 1]);
      H(rowOf(ch), xl, xl + STUB, ch.color, true);
      markers.push({ x: xl + STUB, row: rowOf(ch), kind: 'rstub', color: ch.color });
    }

    // 8. nodes, index structures, time axis anchors
    const nodes = order.map((h) => ({ h, x: xOf.get(h), lane: chains[chainOf.get(h)].lane, chain: chainOf.get(h) }));
    const idx = new Map();
    nodes.forEach((n, i) => idx.set(n.h, i));
    const byLane = [];
    for (const n of nodes) (byLane[n.lane] || (byLane[n.lane] = [])).push(n);
    let widthCols = lastX + 3;
    for (const ch of shown) widthCols = Math.max(widthCols, ch.end + 3);
    const anchorsX = [], anchorsT = [];
    let te = -Infinity;
    for (const n of nodes) { te = Math.max(te, C.get(n.h).committerTime); anchorsX.push(n.x); anchorsT.push(te); }
    const buckets = new Map();
    segs.forEach((s, i) => {
      for (let b = Math.floor(s.x1 / BUCKET); b <= Math.floor(s.x2 / BUCKET); b++) {
        let l = buckets.get(b);
        if (!l) buckets.set(b, (l = []));
        l.push(i);
      }
    });
    return {
      sec, origin, order, xOf, chainOf, chains, shown, lanes, members, segs, markers, edges, nodes, idx, byLane,
      width: widthCols, skew, vis, reach, virt, hiddenParents, anchorsX, anchorsT, buckets, refs, refSet,
      primary: prim || null, warnings: topo.cycle ? ['History contains a cycle; ancestry could not be fully ordered.'] : [],
    };
  }

  function tipLabel(m, ch, tip, refSet, ascii) {
    const arrow = ascii ? ' -> ' : ' → ';
    const c = m.commits.get(tip);
    const headHere = m.head && m.head.hash === tip;
    if (ch.rightStub) return ch.ref ? ch.name : ch.name ? '~' + ch.name : '';
    const parts = [];
    if (ch.ref && ch.ref.target === tip) {
      if (ch.ref.kind === 'head') parts.push('HEAD (detached)');
      else if (headHere && m.head.ref === ch.ref.name) parts.push('HEAD' + arrow + ch.name);
      else parts.push(ch.name);
    } else if (!ch.ref && ch.name) parts.push('~' + ch.name);
    for (const r of c.refs) {
      if (r === ch.ref || r.kind === 'tag' || !refSet.has(r)) continue;
      if (r.kind === 'head') parts.unshift('HEAD (detached)');
      else if (headHere && m.head.ref === r.name) parts.unshift('HEAD' + arrow + r.short);
      else parts.push(r.short);
    }
    return truncate(parts.join(', '), LABEL_MAX, ascii ? '~' : '…');
  }

  // ------------------------------------------------------------------ queries
  function colAt(L, t) {
    const X = L.anchorsX, T = L.anchorsT, n = X.length;
    if (!n) return PAD_LEFT + (t - L.origin) / L.sec;
    if (t <= T[0]) return X[0] - (T[0] - t) / L.sec;
    if (t >= T[n - 1]) return X[n - 1] + (t - T[n - 1]) / L.sec;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] >= t) hi = mid; else lo = mid + 1; }
    if (T[lo] === t) return X[lo];
    return X[lo - 1] + ((t - T[lo - 1]) / (T[lo] - T[lo - 1])) * (X[lo] - X[lo - 1]);
  }
  function timeAt(L, x) {
    const X = L.anchorsX, T = L.anchorsT, n = X.length;
    if (!n) return L.origin + (x - PAD_LEFT) * L.sec;
    if (x <= X[0]) return T[0] - (X[0] - x) * L.sec;
    if (x >= X[n - 1]) return T[n - 1] + (x - X[n - 1]) * L.sec;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (X[mid] >= x) hi = mid; else lo = mid + 1; }
    if (X[lo] === x) return T[lo];
    return T[lo - 1] + ((x - X[lo - 1]) / (X[lo] - X[lo - 1])) * (T[lo] - T[lo - 1]);
  }
  function segsIn(L, x0, x1) {
    const seen = new Set();
    const out = [];
    for (let b = Math.floor(x0 / BUCKET); b <= Math.floor(x1 / BUCKET); b++) {
      for (const i of L.buckets.get(b) || []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = L.segs[i];
        if (s.x2 >= x0 && s.x1 <= x1) out.push(s);
      }
    }
    return out;
  }
  function lowerBound(nodes, x) {
    let lo = 0, hi = nodes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (nodes[mid].x < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function nodesIn(L, x0, x1) {
    const out = [];
    for (let i = lowerBound(L.nodes, x0); i < L.nodes.length && L.nodes[i].x <= x1; i++) out.push(L.nodes[i]);
    return out;
  }
  function nearestInLane(L, lane, x, ok) {
    const arr = L.byLane[lane];
    if (!arr || !arr.length) return null;
    const i = lowerBound(arr, x);
    let best = null, bd = Infinity;
    for (let j = i; j < arr.length; j++) { if (arr[j].x - x >= bd) break; if (!ok || ok(arr[j].h)) { bd = arr[j].x - x; best = arr[j]; break; } }
    for (let j = i - 1; j >= 0; j--) { if (x - arr[j].x >= bd) break; if (!ok || ok(arr[j].h)) { if (x - arr[j].x < bd) { bd = x - arr[j].x; best = arr[j]; } break; } }
    return best;
  }

  // Local-calendar boundaries between t0 and t1 for an axis unit.
  const UNITS = [
    { id: 'hour', s: 3600 }, { id: '3h', s: 10800 }, { id: '6h', s: 21600 }, { id: '12h', s: 43200 },
    { id: 'day', s: 86400 }, { id: 'week', s: 604800 }, { id: 'month', s: 2629746 }, { id: 'quarter', s: 7889238 }, { id: 'year', s: 31556952 },
  ];
  function boundaries(unit, t0, t1) {
    const out = [];
    const d0 = new Date(t0 * 1000);
    const Y = d0.getFullYear(), M = d0.getMonth(), D = d0.getDate();
    const push = (d) => { const t = d.getTime() / 1000; if (t >= t0 && t <= t1) out.push(t); return t <= t1 && out.length < 500; };
    if (unit === 'hour' || unit === '3h' || unit === '6h' || unit === '12h') {
      const step = { hour: 1, '3h': 3, '6h': 6, '12h': 12 }[unit];
      for (let k = 0; k < 24 * 800; k += step) if (!push(new Date(Y, M, D, k))) break;
    } else if (unit === 'day') {
      for (let k = 0; k < 4000; k++) if (!push(new Date(Y, M, D + k))) break;
    } else if (unit === 'week') {
      const dow = (d0.getDay() + 6) % 7;
      for (let k = 0; k < 2000; k++) if (!push(new Date(Y, M, D - dow + 7 * k))) break;
    } else if (unit === 'month') {
      for (let k = 0; k < 1200; k++) if (!push(new Date(Y, M + k, 1))) break;
    } else if (unit === 'quarter') {
      for (let k = 0; k < 400; k++) if (!push(new Date(Y, Math.floor(M / 3) * 3 + 3 * k, 1))) break;
    } else {
      for (let k = 0; k < 200; k++) if (!push(new Date(Y + k, 0, 1))) break;
    }
    return out;
  }
  function axisLabels(L, x0, x1, minGap) {
    const t0 = timeAt(L, x0), t1 = timeAt(L, x1);
    const eff = Math.max(1, (t1 - t0) / Math.max(1, x1 - x0));
    const unit = UNITS.find((u) => u.s / eff >= (minGap || 10)) || UNITS[UNITS.length - 1];
    return { unit: unit.id, ticks: boundaries(unit.id, t0, t1).map((t) => ({ t, x: Math.round(colAt(L, t)) })) };
  }

  // Branches (local and remote-tracking) whose history contains a commit.
  function containing(m, hash) {
    if (!m._anc) m._anc = new Map();
    const out = [];
    for (const r of m.refs) {
      if (r.kind !== 'branch' && r.kind !== 'remote') continue;
      let set = m._anc.get(r.name);
      if (!set) {
        set = new Set();
        const st = [r.target];
        while (st.length) {
          const h = st.pop();
          if (set.has(h)) continue;
          const c = m.commits.get(h);
          if (!c) continue;
          set.add(h);
          for (const p of c.parents) st.push(p);
        }
        m._anc.set(r.name, set);
      }
      if (set.has(hash)) out.push(r);
    }
    return out;
  }

  const api = {
    sanitize, charWidth, cells, width, truncate, truncateLeft, wrap,
    buildModel, layout, timeTopo, inferBranchName, colAt, timeAt, segsIn, nodesIn, nearestInLane, axisLabels, boundaries, containing,
    ZOOMS, PAD_LEFT, STUB, UNITS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GTEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
