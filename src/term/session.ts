// The interactive session: alternate screen, raw keyboard (and optional mouse) input,
// redraws on input, resize and animation, and a terminal that is always put back the
// way it was: on q, Ctrl+C, Ctrl+Z, a signal or an unexpected error.
import type * as tty from 'tty';
import { AnsiRenderer, Depth, Theme, themeFromEnv, themeFromOsc11 } from './ansi';
import { InputDecoder, InputEvent } from './input';
import { ObjectStore } from '../git/objects';
import type { Repo } from '../git/repository';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../core/tui.js');

export interface SessionOptions {
  unicode: boolean;
  depth: Depth;
  theme: Theme | 'auto';
  view: 'world' | 'graph';
  motion: boolean;
  mouse: boolean;
  journey: boolean;
  select: string | null;
  notice?: string;
}

const ENTER = (mouse: boolean) => '\x1b[?1049h\x1b[?25l\x1b[?7l' + (mouse ? '\x1b[?1000h\x1b[?1006h' : '') + '\x1b[0m\x1b[2J';
const LEAVE = '\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

/** Asks the terminal for its background colour (OSC 11). Resolves null after a short wait. */
function queryBackground(inp: tty.ReadStream, out: tty.WriteStream, ms: number): Promise<Theme | null> {
  return new Promise((resolve) => {
    let got = '';
    const done = (t: Theme | null) => { clearTimeout(timer); inp.off('data', onData); resolve(t); };
    const onData = (d: string) => { got += d; const t = themeFromOsc11(got); if (t) done(t); };
    const timer = setTimeout(() => done(null), ms);
    inp.on('data', onData);
    out.write('\x1b]11;?\x1b\\');
  });
}

export async function runInteractive(model: unknown, repo: Repo, o: SessionOptions): Promise<number> {
  const out = process.stdout as tty.WriteStream;
  const inp = process.stdin as tty.ReadStream;
  inp.setRawMode(true);
  inp.setEncoding('utf8');
  inp.resume();

  let theme: Theme = o.theme === 'auto' ? themeFromEnv(process.env) || 'dark' : o.theme;
  if (o.theme === 'auto' && !process.env.COLORFGBG && o.depth !== 'none') theme = (await queryBackground(inp, out, 150)) || 'dark';
  const renderer = new AnsiRenderer(o.depth, theme);

  return new Promise<number>((resolveSession) => {
    let finished = false;
    let prev: string[] = [];
    let lastCols = 0, lastRows = 0;
    let renderTimer: NodeJS.Immediate | null = null;
    let expiryTimer: NodeJS.Timeout | null = null;
    let journeyTimer: NodeJS.Timeout | null = null;
    let glideTimer: NodeJS.Timeout | null = null;
    let tickTimer: NodeJS.Timeout | null = null;
    const decoder = new InputDecoder();

    const store = new ObjectStore(repo, (h) => {
      const c = (model as { commits: Map<string, { parents: string[] }> }).commits.get(h);
      return c && c.parents.length ? c.parents[0] : null;
    }, () => schedule());
    const app = new T.App(model, {
      now: () => Date.now(),
      files: (h: string) => store.filesFor(h),
      patch: (h: string, p: string) => store.patchFor(h, p),
    });
    app.s.unicode = o.unicode;
    app.s.color = o.depth !== 'none';
    app.s.view = o.view;
    app.s.smooth = o.motion;
    if (o.select) app.s.sel = o.select;
    if (o.notice) app.flash(o.notice);

    const write = (s: string) => { try { out.write(s); } catch { /* the terminal went away */ } };

    function restore(): void {
      for (const t of [expiryTimer, journeyTimer, glideTimer, tickTimer]) if (t) clearTimeout(t);
      if (renderTimer) clearImmediate(renderTimer);
      expiryTimer = journeyTimer = glideTimer = tickTimer = null;
      renderTimer = null;
      write(LEAVE);
      try { inp.setRawMode(false); } catch { /* not a TTY any more */ }
    }
    function finish(code: number): void {
      if (finished) return;
      finished = true;
      restore();
      store.dispose();
      inp.off('data', onData);
      inp.pause();
      out.off('resize', schedule);
      process.off('exit', onExit);
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
      for (const s of SIGNALS) process.off(s, onSignal);
      process.off('SIGCONT', onCont);
      resolveSession(code);
    }

    function render(): void {
      renderTimer = null;
      if (finished) return;
      const cols = Math.max(20, out.columns || 80), rows = Math.max(8, out.rows || 24);
      let scr;
      try {
        scr = app.frame(cols, rows);
      } catch (e) {
        finish(1);
        process.stderr.write('git-timeline: ' + ((e as Error).stack || e) + '\n');
        return;
      }
      if (app.s.exited) { finish(0); return; }
      let buf = '';
      if (cols !== lastCols || rows !== lastRows) { buf += '\x1b[0m\x1b[2J'; prev = []; lastCols = cols; lastRows = rows; }
      for (let y = 0; y < rows; y++) {
        const line = renderer.row(scr, y);
        if (line !== prev[y]) { buf += '\x1b[' + (y + 1) + ';1H' + line; prev[y] = line; }
      }
      if (buf) write('\x1b[?2026h' + buf + '\x1b[?2026l');
      if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
      if (Number.isFinite(scr.next)) expiryTimer = setTimeout(schedule, Math.max(10, scr.next - Date.now() + 5));
    }
    function schedule(): void {
      if (!renderTimer && !finished) renderTimer = setImmediate(render);
    }

    // the world view's camera glides to the selection
    function glide(): void {
      glideTimer = null;
      if (finished) return;
      const more = app.animate();
      render();
      if (more) glideTimer = setTimeout(glide, 25);
    }
    function kick(): void {
      if (!glideTimer && app.s.smooth && app.s.view === 'world' && app.s.camX !== app.s.scrollX) glideTimer = setTimeout(glide, 16);
    }
    function afterInput(): void {
      if (app.s.tour && !journeyTimer) {
        journeyTimer = setInterval(() => {
          if (!app.s.tour) { if (journeyTimer) clearInterval(journeyTimer); journeyTimer = null; schedule(); return; }
          app.tourStep();
          kick();
          schedule();
        }, 55);
      }
      kick();
      schedule();
    }

    function handle(ev: InputEvent): void {
      if (ev.type === 'mouse') {
        if (ev.action === 'press' && ev.button === 0) app.tap(ev.x, ev.y);
        else if (ev.action === 'wheel') {
          const dx = (ev.dx + (ev.shift ? ev.dy : 0)) * 4, dy = ev.shift ? 0 : ev.dy * (app.s.focus === 'timeline' && app.s.view === 'world' ? 4 : 3);
          app.wheel(ev.x, ev.y, dx, dy);
        }
        return;
      }
      if (ev.ctrl && ev.key === 'c') { app.quit(); return; }
      if (ev.ctrl && ev.key === 'z') { suspend(); return; }
      if (ev.ctrl && ev.key === 'l') { lastCols = 0; return; }
      if (app.s.search.prompt) {
        if (ev.key === 'Backspace') app.searchInput(Array.from(app.s.search.input as string).slice(0, -1).join(''));
        else if (ev.key === 'Enter' || ev.key === 'Escape') app.key(ev.key, {});
        else if (!ev.ctrl && !ev.alt && Array.from(ev.key).length === 1 && ev.key >= ' ') app.searchInput(app.s.search.input + ev.key);
        return;
      }
      app.key(ev.key, { shift: !!ev.shift, ctrl: !!ev.ctrl, alt: !!ev.alt });
    }
    function onData(d: string): void {
      for (const ev of decoder.feed(d)) handle(ev);
      afterInput();
    }

    function suspend(): void {
      if (process.platform === 'win32') return;
      restore();
      process.kill(process.pid, 'SIGTSTP');
    }
    function onCont(): void {
      if (finished) return;
      try { inp.setRawMode(true); } catch { /* ignore */ }
      write(ENTER(o.mouse));
      lastCols = 0;
      if (o.motion) startTicker();
      schedule();
    }
    const SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGHUP'];
    function onSignal(sig: NodeJS.Signals): void { finish(sig === 'SIGHUP' ? 129 : 143); }
    function onExit(): void { if (!finished) restore(); }
    function onCrash(e: unknown): void {
      finish(1);
      process.stderr.write('git-timeline: unexpected error\n' + ((e as Error)?.stack || String(e)) + '\n');
    }
    function startTicker(): void {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        if (app.s.view === 'world' && !app.s.overlay && !finished) { app.s.phase++; schedule(); }
      }, 650);
    }

    process.on('exit', onExit);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    for (const s of SIGNALS) process.on(s, onSignal);
    if (process.platform !== 'win32') process.on('SIGCONT', onCont);
    out.on('resize', schedule);
    inp.on('data', onData);
    write(ENTER(o.mouse));
    if (o.motion) startTicker();
    render();
    if (o.journey && !finished) { app.tourStart(); afterInput(); }
  });
}
