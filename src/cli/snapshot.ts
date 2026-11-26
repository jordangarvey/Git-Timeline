// The non-interactive snapshot (--format ascii): the whole history drawn once, as plain
// text or with colour, optionally cut into bands that fit the terminal's width.
import { AnsiRenderer, Depth, Theme, plainRow } from '../term/ansi';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../core/tui.js');

export interface SnapshotOptions {
  unicode: boolean;
  depth: Depth;
  theme: Theme;
  view: 'world' | 'graph';
  /** Band width in columns; 0 or undefined draws one long strip. */
  width?: number;
  notice?: string;
}

function wrap(text: string, width: number): string[] {
  if (!width || text.length <= width) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

export function renderSnapshot(model: unknown, o: SnapshotOptions): string {
  const scr = T.renderStatic(model, { unicode: o.unicode, color: o.depth !== 'none', view: o.view, zoom: 2 });
  const color = o.depth !== 'none';
  const R = color ? new AnsiRenderer(o.depth, o.theme) : null;
  const footer = o.view === 'world' ? 2 : 1;
  const body = { from: 1, to: scr.rows - footer }; // the strip, between the title and the legend
  const width = o.width && o.width < scr.cols ? o.width : scr.cols;
  const text = o.width ? width : 0; // wrap the title and legend only when cutting into bands
  const styled = (text: string, st: string) => (R ? R.sgr(st) + text + '\x1b[0m' : text);
  const lines: string[] = [];
  const meta = scr.meta as { title: string; legend: string[] } | undefined;
  for (const t of wrap(meta ? meta.title : plainRow(scr, 0), text)) lines.push(styled(t, 'b'));
  for (let x0 = 0; x0 < scr.cols; x0 += width) {
    const x1 = Math.min(scr.cols, x0 + width);
    if (x0 > 0) lines.push('');
    for (let y = body.from; y < body.to; y++) lines.push(R ? R.row(scr, y, x0, x1) : plainRow(scr, y, x0, x1));
  }
  lines.push('');
  const legend = meta ? meta.legend : Array.from({ length: scr.rows - body.to }, (_, k) => plainRow(scr, body.to + k));
  for (const l of legend) for (const t of wrap(l, text)) lines.push(styled(t, 'mu'));
  if (o.notice) for (const t of wrap(o.notice, text)) lines.push(styled(t, 'mu'));
  return lines.join('\n') + '\n';
}
