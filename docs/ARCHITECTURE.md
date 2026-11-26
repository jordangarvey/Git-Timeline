# Architecture

```
git (read-only calls)          src/git/runner.ts, repository.ts, objects.ts
   │  records: refs, commits, HEAD, status; files and patches on demand
   ▼
model and layout               src/core/engine.js
   │  commit DAG, paths, lanes, columns, connector segments, time axis
   ▼
views                          src/core/tui.js (state, keys, panels, graph view)
   │                           src/core/world.js (the world view's scenery)
   │  draw into a Screen: a grid of characters, each with style classes
   ▼
terminal                       src/term/ansi.ts (styles → escape codes),
                               src/term/input.ts (keys and mouse),
                               src/term/session.ts (alternate screen, raw mode,
                               redraws, timers, restore)
```

The engine and the views are plain JavaScript with no dependency on Node or a
terminal: the same files run the browser prototype, where the Screen is drawn as
HTML instead of escape codes. The command line, git layer and terminal layer are
TypeScript. Everything ships as compiled JavaScript with no runtime dependencies.

## Reading Git

One `for-each-ref` for branches, remote-tracking branches and tags (annotated tags
peeled to their commit), one `log -z` for every commit reachable from them and HEAD
(tips passed on stdin, so there is no command-line length limit), `status
--porcelain=v2 -z`, and `rev-parse` for HEAD, shallow and bare repositories. All
output is NUL-delimited. Changed files (`diff-tree --raw --numstat -z -M` against the
first parent) and patches are read when the UI first asks for them, debounced so fast
navigation reads only the commit you stop on, and cached for the session.

## Layout

- **Paths.** Each ref claims its first-parent chain, the default branch first.
  Commits reachable only through merges become unnamed paths, labelled from the merge
  message (`~name`) when it parses. Ancestry is never inferred from names or times.
- **Order.** Commits are placed in time-respecting topological order (Kahn's algorithm
  with a min-heap on committer time): a parent always comes before its children, and
  among commits that are ready the earliest goes first. When clocks and ancestry
  disagree, ancestry wins and the commit is marked `!`. Timestamps are never
  rewritten.
- **Columns.** In the graph view a commit sits at its committer-time column, pushed
  right past the previous commit and past its parents, so every commit owns its column
  and no vertical connector can cross an unrelated commit. In the world view every
  commit gets an equal slot instead (`layout(m, { spacing })`), sized so a screen
  shows about seven.
- **Lanes.** Paths are sorted by start column and each takes the free lane closest to
  its parent's (greedy interval colouring, which uses the fewest lanes possible). The
  default branch is pinned to lane 0. Lanes are reused once a branch has merged, with
  room left for labels.
- **Drawing.** Connectors are stored as segments in 64-column buckets, so a frame
  rasterises only the visible viewport. Layout is recomputed only when the zoom,
  filters or (in the world view) the slot size change, never on selection.

## The world view

`world.js` paints scenery under the trails: a sky and ground tint per age, a sun,
moon or planet, sky items, a far backdrop (sea, cliffs, hills, peaks, volcanoes,
dunes, skylines), a hill under every trail above the default branch (layered back to
front, fainter with height), objects standing on the topmost trail or the ground, and
the ground itself. A commit's age is its position in the whole history divided by
seven. Everything is a pure function of the world column and a seed, so the scenery
scrolls with the history and is identical on every run; an animation phase moves
water, smoke, sails, traffic and stars. Every glyph has an ASCII fallback.

## Rendering to the terminal

The UI's Screen carries CSS-like class names (`c3 b`, `wk4`, `sG2`). `ansi.ts`
resolves them against a light or dark palette the way the stylesheet cascade would,
then writes 24-bit, 256-colour, 16-colour or attribute-only escape codes, sending only
what changes between neighbouring cells. Each redraw rewrites only the rows that
changed, inside a synchronised-update block. The session restores the terminal on
every way out, including Ctrl+Z (and resumes on SIGCONT), SIGTERM and SIGHUP.

## Tests

`npm test` runs, with Node's built-in test runner:

- `test/core`: the engine (DAG shapes, lanes, columns, equal and out-of-order
  timestamps, filters, a 50,000-commit benchmark), both views, keys and panels,
  ASCII and no-colour output, sanitising, wide characters.
- `test/git.test.mjs`: real temporary repositories: linear history, branches and
  merges, tags, detached HEAD, an empty repository, a dirty working tree, unusual
  paths and messages, renames, binaries, long patches, a shallow clone, limits, and a
  check that reading leaves `.git` byte-for-byte unchanged.
- `test/cli.test.mjs`: help, version, bad options, exit codes, snapshots, JSON,
  colour handling, and the interactive UI in a pseudo-terminal (via util-linux
  `script`, where available).
- `test/term.test.mjs`: options, key and mouse decoding, colour depth and theme
  detection, the renderer, and palette coverage.
