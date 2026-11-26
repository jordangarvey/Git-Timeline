// Shared test harness: loads the engine + TUI and the captured example repo.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const E = require('../../src/core/engine.js');
export const T = require('../../src/core/tui.js');
export const history = (v = 'main') => require('../fixtures/history-' + v + '.json');
const objs = require('../fixtures/objects.json');
const filesBy = new Map(), patchBy = new Map();
for (const o of objs) {
  if (o.kind === 'files') filesBy.set(o.commit, o.files);
  else if (o.kind === 'patch') patchBy.set(o.commit + '\0' + o.path, o);
}
export const env = {
  now: () => 1795222100000,
  files: (h) => ({ status: 'ready', files: filesBy.get(h) || [] }),
  patch: (h, p) => { const x = patchBy.get(h + '\0' + p); return x ? { status: 'ready', patch: x } : { status: 'error' }; },
};
export function app(variant = 'main', opts = {}) {
  const a = new T.App(E.buildModel(history(variant)), env);
  Object.assign(a.s, opts);
  return a;
}
// The graph view: the plain timeline with time to scale.
export const graph = (variant = 'main', opts = {}) => app(variant, Object.assign({ view: 'graph' }, opts));
export const VIEWS = ['world', 'graph'];
