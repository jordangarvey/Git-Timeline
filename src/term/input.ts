// Decodes raw terminal input (keys, escape sequences, SGR mouse reports) into the key
// names the UI understands: 'ArrowLeft', 'Enter', 'Escape', 'Tab', 'a', '?' and so on.

export interface KeyEvent { type: 'key'; key: string; shift?: boolean; ctrl?: boolean; alt?: boolean }
export interface MouseEvent { type: 'mouse'; action: 'press' | 'release' | 'wheel'; button: number; x: number; y: number; dx: number; dy: number; shift?: boolean }
export type InputEvent = KeyEvent | MouseEvent;

const CSI_KEYS: Record<string, string> = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End', Z: 'Tab' };
const TILDE_KEYS: Record<string, string> = { '1': 'Home', '7': 'Home', '4': 'End', '8': 'End', '5': 'PageUp', '6': 'PageDown', '3': 'Delete', '2': 'Insert' };

function mods(param: string | undefined): { shift: boolean; alt: boolean; ctrl: boolean } {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

export class InputDecoder {
  private buf = '';

  /** Feeds a chunk; returns the complete events. A lone ESC at the end is a key press. */
  feed(chunk: string): InputEvent[] {
    this.buf += chunk;
    const out: InputEvent[] = [];
    let i = 0;
    const s = this.buf;
    while (i < s.length) {
      const c = s[i];
      if (c === '\x1b') {
        const rest = s.slice(i);
        // SGR mouse: ESC [ < b ; x ; y (M|m)
        let m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (m) {
          const b = +m[1], x = +m[2] - 1, y = +m[3] - 1;
          const shift = !!(b & 4);
          if (b & 64) {
            const dir = b & 3; // 0 up, 1 down, 2 left, 3 right
            out.push({ type: 'mouse', action: 'wheel', button: b, x, y, dx: dir === 2 ? -1 : dir === 3 ? 1 : 0, dy: dir === 0 ? -1 : dir === 1 ? 1 : 0, shift });
          } else if (!(b & 32)) out.push({ type: 'mouse', action: m[4] === 'M' ? 'press' : 'release', button: b & 3, x, y, dx: 0, dy: 0, shift });
          i += m[0].length;
          continue;
        }
        // CSI: ESC [ params final
        m = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(rest);
        if (m) {
          const params = m[1].split(';');
          const fin = m[2];
          if (fin === '~') {
            const k = TILDE_KEYS[params[0]];
            if (k) out.push({ type: 'key', key: k, ...mods(params[1]) });
          } else if (CSI_KEYS[fin]) {
            const md = mods(params[1]);
            if (fin === 'Z') md.shift = true;
            out.push({ type: 'key', key: CSI_KEYS[fin], ...md });
          }
          i += m[0].length;
          continue;
        }
        // SS3: ESC O A (application cursor keys)
        m = /^\x1bO([A-DHF])/.exec(rest);
        if (m) { out.push({ type: 'key', key: CSI_KEYS[m[1]] }); i += m[0].length; continue; }
        // OSC reply (e.g. to a colour query): swallow it
        m = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
        if (m) { i += m[0].length; continue; }
        if (rest.length === 1) { out.push({ type: 'key', key: 'Escape' }); i++; continue; }
        if (rest[1] === '[' || rest[1] === 'O' || rest[1] === ']') {
          // an incomplete sequence: wait for the rest unless it is clearly garbage
          if (rest.length < 32) break;
          i++;
          continue;
        }
        if (rest[1] === '\x1b') { out.push({ type: 'key', key: 'Escape' }); i++; continue; }
        // ESC + key: Alt+key
        const cp = rest.codePointAt(1) as number;
        const ch = String.fromCodePoint(cp);
        out.push({ type: 'key', key: ch, alt: true });
        i += 1 + ch.length;
        continue;
      }
      if (c === '\r' || c === '\n') out.push({ type: 'key', key: 'Enter' });
      else if (c === '\t') out.push({ type: 'key', key: 'Tab' });
      else if (c === '\x7f' || c === '\b') out.push({ type: 'key', key: 'Backspace' });
      else if (c === '\x03') out.push({ type: 'key', key: 'c', ctrl: true });
      else if (c === '\x1a') out.push({ type: 'key', key: 'z', ctrl: true });
      else if (c === '\x0c') out.push({ type: 'key', key: 'l', ctrl: true });
      else if (c < ' ') out.push({ type: 'key', key: String.fromCharCode(c.charCodeAt(0) + 96), ctrl: true });
      else {
        const cp = s.codePointAt(i) as number;
        const ch = String.fromCodePoint(cp);
        out.push({ type: 'key', key: ch });
        i += ch.length;
        continue;
      }
      i++;
    }
    this.buf = s.slice(i);
    return out;
  }

  /** Called when no more input arrived shortly after a lone ESC. */
  flush(): InputEvent[] {
    if (this.buf === '\x1b') { this.buf = ''; return [{ type: 'key', key: 'Escape' }]; }
    this.buf = '';
    return [];
  }

  get pending(): boolean { return this.buf.length > 0; }
}
