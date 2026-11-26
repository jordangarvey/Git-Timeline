/* git-timeline prototype · the world
 *
 * The world view: one scrolling, full-screen landscape that travels through
 * Earth's history, seven commits per environment: primordial sea, first
 * shores, first forests, dinosaurs, the ice age, the stone age, the ancient
 * world, the Middle Ages, the industrial age, the modern city and the far
 * future. Branches are trails through it: hills rise under every trail that
 * forks up from the main path.
 *
 * This file paints the scenery into the TUI screen buffer: sky, far backdrop,
 * the hills under the trails, objects standing on the ground, and the ground.
 * The TUI draws the trails, commits and labels on top. Everything is anchored
 * to world columns, so it scrolls with the history; an animation phase moves
 * water, smoke, clouds, sails and traffic. Every glyph has an ASCII fallback.
 */
(function (root) {
  'use strict';
  const E = root.GTEngine || require('./engine.js');

  const ERAS = [
    { name: 'Primordial Sea', short: 'Sea' },
    { name: 'First Shores', short: 'Shores' },
    { name: 'First Forests', short: 'Forests' },
    { name: 'Age of Dinosaurs', short: 'Dinosaurs' },
    { name: 'Ice Age', short: 'Ice Age' },
    { name: 'Stone Age', short: 'Stone Age' },
    { name: 'Ancient World', short: 'Ancient' },
    { name: 'Middle Ages', short: 'Medieval' },
    { name: 'Industrial Age', short: 'Industry' },
    { name: 'Modern City', short: 'City' },
    { name: 'Far Future', short: 'Future' },
  ];
  const NE = ERAS.length;
  const PER_ERA = 7; // commits per environment

  // ------------------------------------------------------------ deterministic noise
  function h32(a, b) {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return h >>> 0;
  }
  const h01 = (x, salt) => h32(x, salt) / 4294967296;
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function vnoise(x, salt, period) {
    const p = x / period, i = Math.floor(p), f = p - i;
    const a = h01(i, salt), b = h01(i + 1, salt);
    return a + (b - a) * f * f * (3 - 2 * f);
  }
  const mod = (a, n) => ((a % n) + n) % n;

  // ------------------------------------------------------------ glyphs
  // ASCII fallback for every glyph the scenery uses.
  const AMAP = {
    '█': '#', '▓': '#', '▒': '%', '░': ':', '▀': '"', '▄': '_', '▌': '|', '▐': '|', '▖': '.', '▗': '.', '▘': "'", '▝': "'",
    '▙': 'L', '▟': 'J', '▛': 'F', '▜': '7', '▚': '\\', '▞': '/', '◢': '/', '◣': '\\', '◤': '/', '◥': '\\', '▲': '^', '▼': 'v',
    '▔': '-', '▁': '_', '▂': '_', '▃': '_', '▅': '=', '▆': '#', '▇': '#', '○': 'o', '◖': '(', '◗': ')', '◘': '#',
    '╱': '/', '╲': '\\', '╳': 'X', '│': '|', '┃': '|', '─': '-', '━': '=', '═': '=', '╻': '.', '┼': '+', '╋': '+', '┳': '+', '┻': '+',
    '┏': '.', '┓': '.', '╤': '+', '╭': '.', '╮': '.', '╰': "'", '╯': "'", '▪': ':', '·': '.', '•': 'o', '≈': '~', '✦': '*', '▬': '=', '◂': '<', '▸': '>', '♟': 'i', '♞': 'h',
  };
  function toAscii(str) { let o = ''; for (const ch of str) o += AMAP[ch] !== undefined ? AMAP[ch] : ch; return o; }

  // ------------------------------------------------------------ sprites
  // Rows of cells (space = transparent), a base colour key, optional paint rows
  // (colour key per cell; space or '.' = base) and back rows (background colour
  // per cell, for windows and doors drawn inside a wall). Colour keys become
  // classes 's' + key; background keys 'x' + key.
  function grid(rows, w, fill) { return rows ? rows.map((r) => (r || '').padEnd(w)) : null; }
  function spr(rows, base, paint, opt) {
    opt = opt || {};
    const w = Math.max(...rows.map((r) => r.length), ...(opt.frames || []).map((f) => Math.max(...f.map((r) => r.length))));
    const mk = (rs, ps) => {
      const u = grid(rs, w);
      const pp = grid(ps || [], w);
      const p = u.map((r, i) => { let o = ''; for (let k = 0; k < w; k++) { const c = (pp[i] || '')[k]; o += !c || c === ' ' || c === '.' ? base : c; } return o; });
      return { u, a: u.map(toAscii), p };
    };
    const main = mk(rows, paint);
    const s = { w, h: rows.length, u: main.u, a: main.a, p: main.p, b: opt.back ? rows.map((_, i) => (opt.back[i] || '').padEnd(w)) : null, smoke: opt.smoke || null, base };
    if (opt.frames) s.f = [main].concat(opt.frames.map((fr, i) => mk(fr, (opt.framePaint || [])[i] || paint)));
    return s;
  }
  function pyramid(h) {
    const rows = [], paint = [];
    for (let k = 0; k < h; k++) {
      const pad = ' '.repeat(h - 1 - k);
      rows.push(pad + (k === 0 ? '▲' : '◢' + '█'.repeat(2 * k - 1) + '◣') + pad);
      paint.push(pad + (k === 0 ? 'y' : 'd'.repeat(k + 1) + 'J'.repeat(k)) + pad);
    }
    return spr(rows, 'd', paint);
  }

  const SP = {
    // primordial sea
    islet: spr(['  ▄▟▙▄  ', '▗██████▖'], 'R', ['  gggg  ']),
    rock: spr([' ▄ ', '▟█▙'], 'R'),
    stack: spr([' ▄▄ ', '▐██▌', '▐█▛ ', '▟██▙'], 'O'),
    mats: spr([' ▗▄▄▖ ', '▟████▙'], 'g', ['', 'RRRRRR']),
    volcano: spr(['     ▄▓▄     ', '    ◢▀▀▀◣    ', '   ◢█████◣   ', '  ◢███████◣  ', ' ◢█████████◣ ', '◢███████████◣'], 'R', ['     RlR     ', '    RlllR    '], { smoke: [6] }),
    // first shores
    cliff: spr(['  ▗▄▄▄▖  ', ' ▟█████▙ ', '▐███████▌', '▐████████', '█████████'], 'O', ['  ggggg  ', ' gOOOOOg ']),
    rocks: spr([' ▄ ▄ ', '▟█▙█▙'], 'R'),
    plant: spr(['╲│╱', ' │ '], 'g'),
    crab: spr(['▖▗▄▖▗', '▝███▘'], 'l'),
    // first forests
    lyco: spr([' ▗▟▙▖ ', '▟████▙', '▝▜██▛▘', '  ▐▌  ', '  ▐▌  ', '  ▐▌  ', ' ▗▟▙▖ '], 'b', ['GGGGGG', 'GgggGG', 'GGGGGG']),
    lycoTall: spr([' ▗▟▙▖ ', '▟████▙', '▝▜██▛▘', '  ▐▌  ', ' ▗▟▙▖ ', '▝▜██▛▘', '  ▐▌  ', '  ▐▌  ', '  ▐▌  ', ' ▗▟▙▖ '], 'b', ['GGGGGG', 'GgggGG', 'GGGGGG', '', 'GGGGGG', 'GGGGGG']),
    treefern: spr(['▖ ▗▄▖ ▗', '▝▙███▟▘', '  ▝█▘  ', '   ▌   ', '   ▌   '], 'b', ['gggggg', 'gggggg', 'gggggg']),
    horsetail: spr(['╋ ╋', '╋ ╋', '┃ ┃'], 'g'),
    fern: spr(['╲│╱', ' ▀ '], 'g'),
    // dinosaurs
    brachio: spr(['          ▄▄▖', '         ▐█▀ ', '         ▐▌  ', '        ▗█▘  ', '  ▄▄▄▄▄▄█▌   ', '▄▟███████▌   ', '  ▐▌▐▌ ▐▌▐▌  '], 'G'),
    trex: spr(['     ▄▄▄▖', '    ▐█▄▄▘', ' ▄▄▟██▘  ', '▀▀▜██▛▀  ', '   ▌ ▐   '], 'G', ['', '    GGll ']),
    stego: spr(['  ▲ ▲ ▲   ', ' ▗█████▄▖ ', '▀███████▀▀', '  ▌ ▌ ▌ ▌ '], 'g', ['  l l l   ']),
    palm: spr(['▄▟▀ ▀▙▄', ' ▀▙█▟▀ ', '   █   ', '   ▐▌  ', '   ▐▌  ', '   ▟▙  '], 'b', ['ggg ggg', ' ggggg ']),
    cycad: spr(['╲ │ ╱', ' ╲│╱ ', ' ▟█▙ '], 'g', ['', '', ' bbb ']),
    // ice age
    mammoth: spr(['  ▗▄▄▄▄▄▄  ', ' ▟████████▖', '▐█████████▌', '▐████████▛╮', ' ▐▌▐▌ ▐▌ ▌ '], 'T', ['', '', '', '          w']),
    snowpine: spr(['  ▲  ', ' ◢█◣ ', ' ▟█▙ ', '◢███◣', '  ▌  '], 'G', ['  w  ', ' www ', '', '', '  b  ']),
    glacier: spr([' ▗▄▄▄▄▖ ', '▟██████▙', '████████'], 'i'),
    boulder: spr(['▗▄▖ ', '███▖'], 'i'),
    // stone age
    hut: spr(['   ▲   ', '  ◢▓◣  ', ' ◢▓▓▓◣ ', '◢▓▓▌▓▓◣'], 'b', ['', '', '', '   T   ']),
    campfire: spr([' ▲ ', '▟█▙', '▀▀▀'], 'o', ['', ' l ', 'bbb'], { smoke: [1], frames: [['▗▲▖', '▐█▌', '▀▀▀']] }),
    henge: spr(['▄▄▄▄▄ ▄▄▄▄▄', '▐▌ ▐▌ ▐▌ ▐▌', '▐▌ ▐▌ ▐▌ ▐▌', '▐▌ ▐▌ ▐▌ ▐▌'], 'r'),
    menhir: spr(['▗▖', '▐▌', '██'], 'r'),
    cave: spr(['   ▄▄▄▄▄   ', ' ▄███████▄ ', '▟███▀▀▀███▙', '███▌   ▐███', '███▌ ▲ ▐███'], 'O', ['', '', '', '', '     o     ']),
    hunter: spr([' o ', '╱█╲', '╱ ╲'], 'b'),
    tree: spr([' ▄█▄ ', '▟███▙', '▝███▘', '  ▌  '], 'g', ['', ' G   ', '', '  b  ']),
    // ancient world
    pyramid: pyramid(7),
    pyramidS: pyramid(4),
    sphinx: spr(['        ▗▄▖ ', '        ▐█▌ ', ' ▄▄▄▄▄▄▄██▌ ', '▀██████████▘'], 'd'),
    temple: spr(['    ▄▄▄▄▄    ', ' ▄▄▟█████▙▄▄ ', ' ▀▀▀▀▀▀▀▀▀▀▀ ', '  ▌ ▌ ▌ ▌ ▌  ', '  ▌ ▌ ▌ ▌ ▌  ', '  ▌ ▌ ▌ ▌ ▌  ', '▀▀▀▀▀▀▀▀▀▀▀▀▀'], 'w'),
    obelisk: spr([' ▲ ', ' █ ', ' █ ', ' █ ', ' █ ', '▄█▄'], 'd', [' y ']),
    ziggurat: spr(['   ▄▄▄▄▄   ', '   █████   ', ' ▄▄█████▄▄ ', ' █████████ ', '███████████'], 'k'),
    // middle ages
    castle: spr(['  ▲           ▲  ', ' ▟█▙         ▟█▙ ', ' ███ ▄ ▄ ▄ ▄ ███ ', ' ███▄█▄█▄█▄█▄███ ', ' ███████████████ ', ' ██████▛▀▜██████ ', ' ██████▌ ▐██████ '], 'r', ['  l           l  ', ' kkk         kkk ']),
    cottage: spr(['  ▄▄▄  ', ' ◢███◣ ', '◢█████◣', ' █▪▌▪█ '], 'k', ['', '', '', ' wywyw '], { back: ['', '', '', '  w w  '] }),
    church: spr(['   ▲   ', '   █   ', '  ▟█▙  ', ' ◢███◣ ', '◢█████◣', ' █▪█▪█ ', ' ██▌██ '], 'w', ['   r   ', '   r   ', '  rrr  ', ' kkkkk ', 'kkkkkkk', '  y y  ', '   b   '], { back: ['', '', '', '', '', '  w w  ', '   w   '] }),
    windmill: spr(['╲   ╱', ' ╲ ╱ ', '  ╳  ', ' ▟█▙ ', ' ███ ', ' █▌█ '], 'w', ['bbbbb', 'bbbbb', 'bbbbb', '', '', '  b  '], { frames: [['  │  ', '  │  ', '──┼──', ' ▟█▙ ', ' ███ ', ' █▌█ ']] }),
    // industrial age
    factory: spr([' ▐▌  ▐▌        ', ' ▐▌  ▐▌        ', ' ▐▌  ▐▌◢◣◢◣◢◣◢◣', '▄██▄▄██████████', '███████████████', '█▪▪█▪▪█▪▪█▪▪█▪█', '████▌ ▐████████'], 'k', ['', '', '       mmmmmmmm', '', '', ' yy yy yy yy y ', ''], { smoke: [1, 5], back: ['', '', '', '', '', ' kk kk kk kk k ', ''] }),
    warehouse: spr(['◢◣◢◣◢◣◢◣◢◣', '██████████', '█▪█▪█▪█▪█▪', '██▌ ▐█████'], 'k', ['mmmmmmmmmm', '', ' y y y y y'], { back: ['', '', ' k k k k k'] }),
    clocktower: spr(['  ▲  ', ' ▟█▙ ', ' █○█ ', ' ███ ', ' ███ ', ' █▪█ ', ' ███ ', ' █▪█ ', '▟███▙'], 'd', ['  R  ', ' RRR ', '  w  ', '', '', '  y  ', '', '  y  '], { back: ['', '', '  d  ', '', '', '  d  ', '', '  d  '] }),
    chimney: spr(['▐▌', '▐▌', '▐▌', '▐▌', '██'], 'k', null, { smoke: [0] }),
    gaslamp: spr(['▪', '┃', '┃', '┃'], 'R', ['y']),
    // modern city
    planter: spr([' ▄ ', '▟█▙', ' ▌ '], 'g', ['', '', ' b ']),
    streetlamp: spr(['┏━', '┃ ', '┃ ', '┻ '], 'm', [' y']),
    // far future
    dome: spr(['  ▄▄▄▄▄  ', ' ▟█████▙ ', '▐█▪█▪█▪█▌'], 'i', ['', '', '  c c c  '], { back: ['', '', '  i i i  '] }),
    rocket: spr(['  ▲  ', ' ▐█▌ ', ' ▐█▌ ', ' ▐█▌ ', ' ███ ', '▐███▌', '▟▀█▀▙', ' ░▒░ '], 'w', ['  l  ', '', '', '', '', '', 'RR RR', ' ooo '], { frames: [['  ▲  ', ' ▐█▌ ', ' ▐█▌ ', ' ▐█▌ ', ' ███ ', '▐███▌', '▟▀█▀▙', ' ▒░▒ ']] }),
    // sky
    cloud: spr([' ▄██▄▖ ', '▀▀▀▀▀▀▀'], 'W'),
    cloudS: spr([' ▄▄▖ ', '▀▀▀▀▀'], 'W'),
    smog: spr([' ▄▄▄▄▖  ', '▀▀▀▀▀▀▀▀'], 'f'),
    birds: spr(['▔▀ ▀▔'], 'R'),
    bird: spr(['▔▀▔'], 'R'),
    ptero: spr(['▔▼▔'], 'b'),
    dragonfly: spr(['─▪─'], 'c'),
    aurora: spr(['▁▂▃▂▁▂▃▂'], 'Q'),
    snow: spr(['·'], 'w'),
    star: spr(['·'], 'z'),
    starB: spr(['✦'], 'z'),
    plane: spr(['━┳━▸'], 'm'),
    flycar: spr(['◂▬▸'], 'n'),
    flycarC: spr(['◂▬▸'], 'c'),
    platform: spr(['▀▀▪▀▀'], 'p', ['  c  ']),
    sun: spr([' ▄█▄ ', '▐███▌', ' ▀█▀ '], 'y'),
    sunRed: spr([' ▄██▄ ', '▐████▌', ' ▀██▀ '], 'o'),
    sunPale: spr([' ▄█▄ ', '▐███▌', ' ▀█▀ '], 'M'),
    moon: spr(['▗█▖', '▝█▘'], 'M'),
    planet: spr(['   ▄▄▄   ', '══▐███▌══', '   ▀▀▀   '], 'p', ['', 'cc     cc']),
  };

  // Generated buildings for the city and the far future.
  function tower(r, maxH, kind) {
    const w = 4 + Math.floor(r() * 4);
    const h = Math.max(4, Math.min(maxH, 5 + Math.floor(r() * Math.max(1, maxH - 4))));
    const base = kind === 'brick' ? 'k' : r() < 0.5 ? 'm' : 'i';
    const rows = [], paint = [], back = [];
    const antenna = kind !== 'brick' && r() < 0.5;
    for (let y = 0; y < h; y++) {
      let row = '', pr = '', bk = '';
      for (let c = 0; c < w; c++) {
        if (y === 0 && antenna) { const on = c === Math.floor(w / 2); row += on ? '╻' : ' '; pr += on ? 'l' : ' '; bk += ' '; continue; }
        if (y === (antenna ? 1 : 0)) { row += '▄'; pr += base; bk += ' '; continue; }
        const win = c > 0 && c < w - 1 && (y % 2 === 0 || kind === 'brick') && (c % 2 === 1 || w <= 5);
        if (win) { const lit = r() < 0.55; row += '▪'; pr += lit ? 'y' : 'A'; bk += base; }
        else { row += '█'; pr += base; bk += ' '; }
      }
      rows.push(row); paint.push(pr); back.push(bk);
    }
    return spr(rows, base, paint, { back });
  }
  const towerGen = (r, maxH) => tower(r, maxH, 'glass');
  const brickGen = (r, maxH) => tower(r, Math.min(maxH, 9), 'brick');
  function spireGen(r, maxH) {
    const w = 2 + Math.floor(r() * 3);
    const h = Math.max(5, Math.min(maxH, 6 + Math.floor(r() * Math.max(1, maxH - 5))));
    const neon = r() < 0.5 ? 'n' : 'c';
    const rows = [], paint = [], back = [];
    for (let y = 0; y < h; y++) {
      let row = '', pr = '', bk = '';
      for (let c = 0; c < w; c++) {
        const mid = c === Math.floor((w - 1) / 2);
        if (y === 0) { row += mid ? '▲' : ' '; pr += neon; bk += ' '; continue; }
        if (y === 1) { row += mid || w === 2 ? '█' : ' '; pr += 'p'; bk += ' '; continue; }
        if (c === w - 1 && w > 2) { row += '▌'; pr += neon; bk += ' '; continue; }
        const lit = y % 2 === 0 && r() < 0.5;
        row += lit ? '▪' : '█'; pr += lit ? neon : 'p'; bk += lit ? 'p' : ' ';
      }
      rows.push(row); paint.push(pr); back.push(bk);
    }
    return spr(rows, 'p', paint, { back });
  }
  function elevatorGen(r, maxH) {
    const rows = [], paint = [];
    for (let y = 0; y < maxH; y++) { rows.push(y === 0 ? ' ╻ ' : y === maxH - 1 ? '▟█▙' : ' ┃ '); paint.push(''); }
    const s = spr(rows, 'c', paint);
    s.elevator = true;
    return s;
  }

  // What stands on the ground in each era: [sprite or generator, weight].
  const PAL = [
    [[SP.islet, 4], [SP.rock, 3], [SP.stack, 2], [SP.volcano, 1], [SP.mats, 2]],
    [[SP.cliff, 2], [SP.rocks, 3], [SP.plant, 4], [SP.crab, 2], [SP.mats, 1]],
    [[SP.lyco, 3], [SP.lycoTall, 2], [SP.treefern, 3], [SP.horsetail, 3], [SP.fern, 3]],
    [[SP.brachio, 1], [SP.trex, 1], [SP.stego, 1], [SP.palm, 4], [SP.cycad, 3], [SP.volcano, 1], [SP.fern, 2]],
    [[SP.mammoth, 2], [SP.snowpine, 5], [SP.glacier, 2], [SP.boulder, 2]],
    [[SP.hut, 3], [SP.campfire, 2], [SP.henge, 1], [SP.menhir, 2], [SP.cave, 1], [SP.hunter, 2], [SP.tree, 3], [SP.mammoth, 1]],
    [[SP.pyramid, 2], [SP.pyramidS, 2], [SP.sphinx, 1], [SP.temple, 1], [SP.obelisk, 2], [SP.ziggurat, 1], [SP.palm, 3]],
    [[SP.castle, 1], [SP.cottage, 4], [SP.church, 2], [SP.windmill, 2], [SP.tree, 4]],
    [[SP.factory, 3], [SP.warehouse, 3], [SP.clocktower, 1], [SP.chimney, 2], [SP.gaslamp, 2], [SP.cottage, 1]],
    [[towerGen, 8], [brickGen, 3], [SP.planter, 3], [SP.streetlamp, 3]],
    [[spireGen, 7], [SP.dome, 3], [elevatorGen, 1], [SP.rocket, 1]],
  ];
  // Sky: [sprite, chance per slot, top of band, bottom of band (fractions of the sky), cells per animation step].
  const CL = [SP.cloud, 0.06, 0.05, 0.55, 1 / 3], CS = [SP.cloudS, 0.06, 0.1, 0.6, 1 / 3];
  const SKY = [
    [CL, CS],
    [CL, CS, [SP.bird, 0.02, 0.2, 0.6, 1]],
    [CL, CS, [SP.dragonfly, 0.04, 0.35, 0.95, 1]],
    [CL, [SP.ptero, 0.05, 0.15, 0.6, 1]],
    [[SP.aurora, 0.08, 0, 0.22, 1 / 4], [SP.snow, 0.1, 0.1, 1, 0]],
    [CL, CS, [SP.birds, 0.03, 0.2, 0.6, 1]],
    [CS, [SP.bird, 0.03, 0.2, 0.6, 1]],
    [CL, CS, [SP.birds, 0.03, 0.2, 0.6, 1]],
    [[SP.smog, 0.09, 0.02, 0.6, 1 / 3], CS],
    [CS, [SP.plane, 0.025, 0.05, 0.4, 2], [SP.star, 0.05, 0, 0.3, 0]],
    [[SP.star, 0.07, 0, 1, 0], [SP.starB, 0.02, 0, 0.6, 0], [SP.flycar, 0.03, 0.25, 0.85, 3], [SP.flycarC, 0.03, 0.25, 0.85, -2], [SP.platform, 0.012, 0.3, 0.7, 1]],
  ];
  const CEL = [SP.sun, SP.sun, SP.sun, SP.sunRed, SP.sunPale, SP.sun, SP.sun, SP.sun, SP.sunRed, SP.moon, SP.planet];
  // Far backdrop, and the colour of the hills under trails.
  const BACK = [
    { style: 'islands', fg: 'B' }, { style: 'cliffs', fg: 'B' }, { style: 'hills', fg: 'H' }, { style: 'volcanoes', fg: 'V' },
    { style: 'peaks', fg: 'I', cap: 'E' }, { style: 'hills', fg: 'V' }, { style: 'dunes', fg: 'D' }, { style: 'hills', fg: 'H' },
    { style: 'hills', fg: 'K' }, { style: 'skyline', fg: 'K' }, { style: 'spires', fg: 'P' },
  ];
  const RIDGE = ['O', 'O', 'N', 'N', 'X', 'N', 'Z', 'N', 'O', 'C', 'Y'];

  // Ground under the main path: [glyph, colour] for row gi below the path.
  function ground(e, gi, x, ph, U) {
    const r = h01(x * 7 + gi * 131, 31 + e);
    switch (e) {
      case 0: { const w = mod(x + ph + gi * 3, 7); return [w < 2 ? (U ? '≈' : '~') : w === 4 ? '~' : ' ', 'U']; }
      case 1: if (gi === 0) return mod(x + ph, 9) < 3 ? [U ? '≈' : '~', 'U'] : [U ? '▀' : '"', 'd']; return [r < 0.18 ? (U ? '·' : '.') : ' ', 'J'];
      case 2: if (gi === 0) return [U ? '▀' : '"', 'g']; return [r < 0.22 ? (U ? '▪' : '.') : ' ', 'T'];
      case 3: if (gi === 0) return [U ? '▀' : '"', 'G']; return [r < 0.2 ? (U ? '▪' : '.') : ' ', 'G'];
      case 4: if (gi === 0) return [U ? '▀' : '"', 'E']; return [r < 0.15 ? (U ? '·' : '.') : ' ', 'i'];
      case 5: if (gi === 0) return [U ? '▀' : '"', 'g']; return [r < 0.18 ? (U ? '•' : 'o') : ' ', 'T'];
      case 6: if (gi === 0) return [U ? '▀' : '"', 'd']; return [r < 0.16 ? (U ? '·' : '.') : ' ', 'J'];
      case 7: if (gi === 0) return [U ? '▀' : '"', 'g']; if (gi === 1) return [mod(x, 3) === 0 ? (U ? '▪' : 'o') : ' ', 'r']; return [r < 0.14 ? (U ? '·' : '.') : ' ', 'T'];
      case 8: if (gi === 0) return [U ? '═' : '=', 'm']; if (gi === 1) return [mod(x, 2) === 0 ? (U ? '▀' : '"') : ' ', 'b']; return [r < 0.2 ? (U ? '·' : '.') : ' ', 'R'];
      case 9: {
        if (gi === 0) return [U ? '▔' : '-', 'r'];
        const lane = gi % 2 === 1;
        const speed = lane ? 2 : -2;
        const cx = mod(x - Math.floor(ph * speed) + gi * 13, 31);
        if (cx < 4) { const id = Math.floor((x - Math.floor(ph * speed) + gi * 13) / 31); const col = ['l', 'y', 'i', 'm'][h32(id, 77 + gi) % 4]; return [U ? '▟██▙'[cx] : '[##]'[cx], col]; }
        return [lane && mod(x, 6) < 3 ? (U ? '─' : '-') : ' ', 'L'];
      }
      case 10: if (gi === 0) return mod(x - ph * 3, 23) < 2 ? [U ? '▀' : '"', 'n'] : [U ? '▔' : '=', 'c']; return [mod(x + gi * 4, 8) === 0 ? (U ? '▪' : '.') : ' ', 'c'];
    }
    return [mod(x * 3 + gi, 11) === 0 ? (U ? '·' : '.') : ' ', 'mu'];
  }

  // ------------------------------------------------------------ eras
  const rankCache = new WeakMap();
  function ranks(m) {
    let R = rankCache.get(m);
    if (!R) {
      R = new Map();
      E.timeTopo(m, new Set(m.commits.keys())).order.forEach((h, i) => R.set(h, i));
      rankCache.set(m, R);
    }
    return R;
  }
  const eraOfRank = (r) => Math.max(0, Math.min(NE - 1, Math.floor(r / PER_ERA)));
  function eraOf(m, h) {
    const N = m.commits.size;
    const r = ranks(m).get(h);
    if (r == null) return { idx: 0, era: ERAS[0], n: 0, N };
    const idx = eraOfRank(r);
    return { idx, era: ERAS[idx], n: r + 1, N, first: idx * PER_ERA + 1, last: idx === NE - 1 ? N : Math.min(N, (idx + 1) * PER_ERA) };
  }
  // Where each environment starts on a world layout. Past the newest commit: fog.
  function context(L, m, spacing) {
    const R = ranks(m);
    const nodes = L.nodes;
    const half = Math.max(2, Math.floor((spacing || 8) / 2));
    const bx = [], be = [];
    let prev = null;
    for (let i = 0; i < nodes.length; i++) {
      const e = eraOfRank(R.get(nodes[i].h) || 0);
      if (prev === null) { bx.push(-Infinity); be.push(e); }
      else if (e !== prev) { bx.push(Math.round((nodes[i - 1].x + nodes[i].x) / 2)); be.push(e); }
      prev = e;
    }
    const firstX = nodes.length ? nodes[0].x : 0, lastX = nodes.length ? nodes[nodes.length - 1].x : 0;
    const fogX = lastX + Math.max(6, (spacing || 8) + half);
    if (nodes.length) { bx.push(fogX); be.push(-1); } else { bx.push(-Infinity); be.push(0); }
    const era = (x) => {
      let lo = 0, hi = bx.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bx[mid] <= x) lo = mid; else hi = mid - 1; }
      return be[lo];
    };
    const starts = bx.map((x, k) => (k === 0 ? firstX - half : x));
    return { era, bx, be, starts, fogX, firstX, lastX, spacing: spacing || 8 };
  }

  // ------------------------------------------------------------ painting
  /* o: { x0, W, tx, top, yGround, bottom, ctx, unicode, phase, S, ridges: [{x1, x2, h}] }
   * top is the first row of the world area (the date row), yGround the row of
   * the main path, bottom the last ground row. Returns tint(cx, y) so the TUI
   * can keep the sky and ground colour under what it draws on top. */
  function paint(scr, o) {
    const { x0, W, tx, top, yGround, bottom, ctx } = o;
    const U = !!o.unicode, ph = o.phase || 0;
    const rowsN = bottom - top + 1;
    const N = Math.max(0, W * rowsN);
    const CH = new Array(N).fill(' '), FG = new Array(N).fill(''), BG = new Array(N).fill('');
    const inb = (cx, y) => cx >= 0 && cx < W && y >= top && y <= bottom;
    const at = (cx, y) => (y - top) * W + cx;
    const put = (cx, y, ch, fg, bg) => { if (!inb(cx, y)) return; const i = at(cx, y); CH[i] = ch; FG[i] = fg || ''; BG[i] = bg || ''; };
    const empty = (cx, y) => inb(cx, y) && CH[at(cx, y)] === ' ';
    const jit = (y) => (h32(y, 991) % 3) - 1;
    const eraAt = (cx, y) => ctx.era(x0 + cx + jit(y));
    const skyH = Math.max(1, yGround - top - 1);
    const maxObj = Math.max(0, yGround - top - 3);

    const blit = (sp, wx, baseY, frame, clipTop) => {
      const fr = sp.f && frame != null ? sp.f[frame % sp.f.length] : sp;
      const rows = U ? fr.u : fr.a;
      for (let r = 0; r < sp.h; r++) {
        const y = baseY - (sp.h - 1 - r);
        if (y < (clipTop != null ? clipTop : top + 1) || y > bottom) continue;
        for (let c = 0; c < sp.w; c++) {
          const ch = rows[r][c];
          if (ch === ' ') continue;
          const bk = sp.b ? sp.b[r][c] : ' ';
          put(wx - x0 + c, y, ch, fr.p[r][c], bk === ' ' ? '' : bk);
        }
      }
    };

    // trails above the main path: a hill under each, higher trails further back.
    // Objects stand on the topmost trail over them, or on the ground.
    const ridges = o.ridges || [];
    const RP = 64, LV = 6;
    const ridgeH = [];
    for (let l = 0; l < LV; l++) ridgeH.push(new Int16Array(W + 2 * RP));
    const surf = new Int16Array(W + 2 * RP);
    for (const t of ridges) {
      const lv = Math.max(0, Math.min(LV - 1, (t.level || 1) - 1));
      const a = Math.max(-RP, t.x1 - x0 - 2 * t.h), b = Math.min(W + RP - 1, t.x2 - x0 + 2 * t.h);
      for (let cx = a; cx <= b; cx++) {
        const x = x0 + cx;
        const d = x < t.x1 ? t.x1 - x : x > t.x2 ? x - t.x2 : 0;
        const v = t.h - 1 - Math.ceil(d / 2);
        if (v > ridgeH[lv][cx + RP]) ridgeH[lv][cx + RP] = v;
        if (!d && t.h > surf[cx + RP]) surf[cx + RP] = t.h;
      }
    }

    // 1. sun, moon or planet: one per environment
    for (let k = 0; k < ctx.be.length; k++) {
      const e = ctx.be[k];
      if (e < 0) continue;
      const s0 = ctx.starts[k], s1 = k + 1 < ctx.starts.length ? ctx.starts[k + 1] : s0 + PER_ERA * ctx.spacing;
      const sp = CEL[e];
      const wx = Math.round(s0 + (s1 - s0) * 0.7) - Math.floor(sp.w / 2);
      if (wx + sp.w < x0 || wx > x0 + W) continue;
      blit(sp, wx, top + 1 + sp.h + (skyH > 14 ? 1 : 0));
    }

    // 2. sky items, anchored to world columns (moving ones wrap inside their stretch)
    const SKC = 48;
    for (let y = top + 1; y < yGround - 1; y++) {
      const fr = (y - top - 1) / skyH;
      for (let c = Math.floor((x0 - SKC) / SKC); c <= Math.floor((x0 + W) / SKC); c++) {
        const r = rng(h32(c, 7000 + y - top));
        for (let k = 0; k < 3; k++) {
          const off = Math.floor(r() * SKC), pick = r(), roll = r();
          const x = c * SKC + off;
          const e = ctx.era(x);
          if (e < 0) continue;
          const list = SKY[e];
          const it = list[Math.floor(pick * list.length)];
          if (fr < it[2] || fr > it[3] || roll >= it[1]) continue;
          const sp = it[0];
          const mx = it[4] ? c * SKC + mod(off + Math.floor(ph * it[4]), SKC) : x;
          let ok = true;
          for (let i = 0; i < sp.w && ok; i++) for (let j = 0; j < sp.h; j++) if (!empty(mx - x0 + i, y - j) && inb(mx - x0 + i, y - j)) ok = false;
          if (ok) blit(sp, mx, y, null, top + 1);
        }
      }
    }

    // 3. far backdrop: the open sea behind the first two ages, then hills, peaks, towns
    const maxB = Math.max(0, yGround - top - 4);
    const seaH = Math.max(1, Math.round(maxB * 0.3));
    for (let cx = 0; cx < W; cx++) {
      const e = ctx.era(x0 + cx);
      if (e !== 0 && e !== 1) continue;
      for (let k = 1; k <= seaH; k++) {
        const y = yGround - k;
        if (y <= top) break;
        const foam = h01((x0 + cx - Math.floor(ph / 2)) * 17 + k * 7, 26) < 0.07;
        put(cx, y, foam ? '~' : ' ', 'F', 'S');
      }
    }
    const backH = (x) => {
      const e = ctx.era(x);
      if (e < 0 || maxB <= 0) return 0;
      const st = BACK[e].style;
      let f = 0;
      if (st === 'islands') f = vnoise(x, 11, 9) > 0.78 ? 0.08 + 0.1 * vnoise(x, 12, 5) : 0;
      else if (st === 'cliffs') f = 0.1 + 0.18 * Math.round(vnoise(x, 13, 16) * 3) / 3;
      else if (st === 'hills') f = 0.1 + 0.24 * (0.65 * vnoise(x, 14 + e, 22) + 0.35 * vnoise(x, 15 + e, 9));
      else if (st === 'dunes') f = 0.08 + 0.2 * vnoise(x, 16, 28);
      else if (st === 'peaks' || st === 'volcanoes') {
        const P = 18;
        for (let k = Math.floor(x / P) - 2; k <= Math.floor(x / P) + 2; k++) {
          const c = k * P + Math.floor(h01(k, 17 + e) * P * 0.7);
          const hh = (st === 'volcanoes' ? 0.22 + 0.33 * h01(k, 18 + e) : 0.3 + 0.45 * h01(k, 18 + e)) * maxB;
          const v = (hh - Math.abs(x - c)) / maxB;
          if (v > f) f = v;
        }
      } else if (st === 'skyline') {
        const id = Math.floor(x / 5), inner = mod(x, 5);
        f = inner === 4 && h01(id, 19) < 0.5 ? 0.1 : 0.22 + 0.62 * h01(id, 20);
      } else if (st === 'spires') {
        const id = Math.floor(x / 7), inner = mod(x, 7);
        f = inner < 2 && h01(id, 21) < 0.55 ? 0.3 + 0.6 * h01(id, 22) : 0.05 + 0.06 * vnoise(x, 23, 12);
      }
      return Math.max(0, Math.min(maxB, Math.round(f * maxB)));
    };
    const BH = new Int16Array(W + 2);
    for (let cx = -1; cx <= W; cx++) BH[cx + 1] = backH(x0 + cx);
    const surface = (cx, h, lh, rh, fg, cap, blocky, ascii) => {
      // the top cell of a column of height h with neighbours lh and rh
      if (blocky) return U ? ['▄', fg] : ['_', fg];
      if (lh < h && rh < h) return [U ? '▲' : '^', cap || fg];
      if (lh < h) return [U ? '◢' : '/', cap || fg];
      if (rh < h) return [U ? '◣' : '\\', cap || fg];
      return [U ? '█' : ascii, cap || fg];
    };
    for (let cx = 0; cx < W; cx++) {
      const h = BH[cx + 1];
      if (!h) continue;
      const x = x0 + cx, e = ctx.era(x);
      const b = BACK[e];
      const blocky = b.style === 'skyline' || b.style === 'spires';
      for (let k = 1; k <= h; k++) {
        const y = yGround - k;
        if (y <= top) break;
        if (k === h) {
          const [ch, fg] = surface(cx, h, BH[cx], BH[cx + 2], b.fg, b.cap, blocky, '-');
          if (blocky && !U && BH[cx] === h && BH[cx + 2] === h) put(cx, y, '_', fg); else put(cx, y, ch, fg);
          if (b.style === 'volcanoes' && BH[cx] < h && BH[cx + 2] < h) put(cx, y, U ? '▲' : '^', 'l');
          continue;
        }
        if (!U) { const edge = BH[cx] < k ? '|' : BH[cx + 2] < k ? '|' : blocky && mod(x, 2) === 0 && k % 2 === 0 ? '.' : ' '; if (edge !== ' ') put(cx, y, edge, b.fg); continue; }
        if (blocky && mod(x, 2) === 1 && k % 2 === 0 && h01(x * 31 + k, 23) < 0.45) put(cx, y, '▪', 'y', b.fg);
        else put(cx, y, '█', b.cap && k > h - 2 ? b.cap : b.fg);
      }
    }

    // 4. hills under the trails that fork up from the main path, back to front
    for (let lv = LV - 1; lv >= 0; lv--) {
      const RH = ridgeH[lv];
      const shade = lv === 0 ? '' : lv === 1 ? '2' : '3';
      for (let cx = 0; cx < W; cx++) {
        const h = RH[cx + RP];
        if (h <= 0) continue;
        const x = x0 + cx, e = ctx.era(x);
        if (e < 0) continue;
        const fg = RIDGE[e] + shade;
        const built = e >= 8;
        for (let k = 1; k <= h; k++) {
          const y = yGround - k;
          if (y <= top) break;
          if (k === h) {
            const lh = RH[cx + RP - 1], rh = RH[cx + RP + 1];
            if (lh < h || rh < h) { const [ch] = surface(cx, h, lh, rh, fg, null, false, ' '); put(cx, y, ch, fg); continue; }
            if (!U) continue;
          }
          if (!U) { if (RH[cx + RP - 1] < k || RH[cx + RP + 1] < k) put(cx, y, '|', fg); continue; }
          if (built && lv === 0 && mod(x, 4) === 1 && k % 3 === 1 && h01(x * 7 + k, 24) < 0.7) put(cx, y, '▪', h01(x * 3 + k, 28) < 0.6 ? 'y' : 'A', fg);
          else put(cx, y, lv < 2 && h01(x * 13 + k * 5, 27 + lv) < 0.04 ? '▓' : '█', fg);
        }
      }
    }

    // 5. objects: on the topmost trail over them, or on the ground
    const OCH = 40;
    const objs = [];
    for (let c = Math.floor((x0 - OCH) / OCH); c <= Math.floor((x0 + W + OCH) / OCH); c++) {
      const r = rng(h32(c, 4242));
      let x = c * OCH + Math.floor(r() * 5);
      while (x < (c + 1) * OCH) {
        const e = ctx.era(x + 2);
        if (e < 0) break;
        const pal = PAL[e];
        let tot = 0;
        for (const p of pal) tot += p[1];
        let roll = r() * tot, ent = pal[0][0];
        for (const p of pal) { roll -= p[1]; if (roll < 0) { ent = p[0]; break; } }
        const cx0 = x - x0;
        const S0 = cx0 >= -RP && cx0 < W + RP ? surf[cx0 + RP] : 0;
        const room = Math.max(4, Math.min(maxObj, yGround - S0 - 2 - top)); // generated buildings fit the space above their trail
        const sp = typeof ent === 'function' ? ent(r, room) : ent;
        const gap = e >= 9 ? 1 + Math.floor(r() * 3) : 1 + Math.floor(r() * 5) + (r() < 0.15 ? 6 : 0);
        if (x + sp.w > (c + 1) * OCH) break;
        let S = -1;
        if (cx0 >= -RP && cx0 + sp.w <= W + RP) {
          S = surf[cx0 + RP];
          for (let k = 1; k < sp.w && S >= 0; k++) if (surf[cx0 + k + RP] !== S) S = -1;
        }
        if (S >= 0) {
          const base = yGround - S - 1;
          if (sp.h <= base - top - 1 && ctx.era(x + sp.w - 1) >= 0) objs.push({ sp, x, base });
        }
        x += sp.w + gap;
      }
    }
    for (const ob of objs) {
      if (ob.x + ob.sp.w < x0 || ob.x > x0 + W) continue;
      blit(ob.sp, ob.x, ob.base, ph);
      if (ob.sp.elevator) { const py = ob.base - 1 - mod(ph, Math.max(1, ob.sp.h - 2)); put(ob.x - x0 + 1, py, U ? '◘' : '#', 'n'); }
      if (ob.sp.smoke) {
        for (const ox of ob.sp.smoke) {
          for (let k = 1; k <= 4; k++) {
            const y = ob.base - ob.sp.h + 1 - k;
            const cx = ob.x + ox - x0 + Math.floor((k + mod(ph, 2)) / 2);
            if (y > top && empty(cx, y)) put(cx, y, (k + ph) % 2 ? (U ? '░' : '.') : (U ? '▒' : 'o'), 'f');
          }
        }
      }
    }

    // 6. ground under the main path
    for (let y = yGround + 1; y <= bottom; y++) {
      for (let cx = 0; cx < W; cx++) {
        const e = eraAt(cx, y);
        const [ch, fg] = ground(e, y - yGround - 1, x0 + cx, ph, U);
        if (ch !== ' ') put(cx, y, ch, fg);
      }
    }

    // 7. past the newest commit: unwritten fog
    for (let cx = 0; cx < W; cx++) {
      if (x0 + cx < ctx.fogX) continue;
      for (let y = top + 1; y < yGround; y++) {
        const i = at(cx, y);
        CH[i] = h01((x0 + cx) * 13 + y, 25) < 0.03 ? (U ? '·' : '.') : ' '; FG[i] = '!mu'; BG[i] = '';
      }
    }

    // 8. environment names, where each one begins
    const title = (wx, text) => {
      let cx = wx - x0;
      const y = top + 1;
      if (cx < 0) cx = 0;
      const w = E.width(text);
      if (cx + w > W) return;
      for (let i = 0; i < w; i++) if (FG[at(cx + i, y)] === '!tt') return;
      let k = 0;
      for (const ch of text) { put(cx + k, y, ch, '!tt'); k++; }
    };
    let firstShown = false;
    for (let k = 0; k < ctx.be.length; k++) {
      const s0 = ctx.starts[k];
      const s1 = k + 1 < ctx.starts.length ? ctx.starts[k + 1] : Infinity;
      if (s1 <= x0 || s0 >= x0 + W) continue;
      const e = ctx.be[k];
      const text = e < 0 ? (U ? '┆ unwritten' : ': unwritten') : (U ? '▸ ' : '> ') + ERAS[e].name;
      if (s0 < x0 && !firstShown) { if (s1 - x0 > E.width(text) + 2) title(x0, text); }
      else title(s0, text);
      firstShown = true;
    }

    // emit, with the sky or ground colour of each cell's environment
    const tint = (cx, y) => { const e = eraAt(cx, y); return (y >= yGround ? 'wg' : 'wk') + (e < 0 ? 'f' : e); };
    // What lies behind a cell drawn on top: the colour of a solid block of scenery, else the sky or ground.
    const SOLID = /^[gGbwirRdkmncpuBHDKVIPNOXCZYJTAyloWEMLUFQS][23]?$/;
    const under = (cx, y) => {
      if (!inb(cx, y)) return tint(cx, y);
      const i = at(cx, y);
      if (BG[i]) return 'x' + BG[i];
      return CH[i] === '█' && SOLID.test(FG[i]) ? 'x' + FG[i] : tint(cx, y);
    };
    for (let y = top; y <= bottom; y++) {
      for (let cx = 0; cx < W; cx++) {
        const i = at(cx, y);
        const fg = FG[i];
        let cls = !fg ? '' : fg[0] === '!' ? fg.slice(1) : 's' + fg;
        cls = (cls ? cls + ' ' : '') + (BG[i] ? 'x' + BG[i] : tint(cx, y));
        scr.put(tx + cx, y, CH[i], o.S(cls));
      }
    }
    return { tint, under };
  }

  // Sprite sanity: rectangular, paint the same size, ASCII rows pure ASCII.
  function selfCheck() {
    const bad = [];
    const check = (name, s) => {
      const sets = [s].concat(s.f || []);
      for (const fr of sets) {
        if (fr.u.length !== s.h || fr.p.length !== s.h) bad.push(name + ': height');
        fr.u.forEach((r, i) => {
          if (r.length !== s.w || fr.p[i].length !== s.w || fr.a[i].length !== s.w) bad.push(name + ': width row ' + i);
          if (!/^[\x20-\x7e]*$/.test(fr.a[i])) bad.push(name + ': ASCII row ' + i + ' ' + JSON.stringify(fr.a[i]));
        });
      }
      if (s.b && (s.b.length !== s.h || s.b.some((r) => r.length !== s.w))) bad.push(name + ': back');
    };
    for (const [k, s] of Object.entries(SP)) check(k, s);
    const r = rng(1);
    for (let i = 0; i < 40; i++) { check('tower', towerGen(r, 14)); check('brick', brickGen(r, 14)); check('spire', spireGen(r, 14)); check('elevator', elevatorGen(r, 12)); }
    return bad;
  }

  const api = { ERAS, PER_ERA, SP, AMAP, toAscii, ranks, eraOfRank, eraOf, context, paint, selfCheck, ground };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GTWorld = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
