# Changelog

## 0.0.1 (2026-11-26)

First release.

- Interactive timeline in the terminal: the world view (an age of Earth every seven
  commits, branches as trails with hills under them) and the graph view (time to
  scale), switched with `v`.
- Commit details, changed files and diffs, loaded from Git only when you open them.
- Navigation by commit and by trail, zoom, branch and tag filter, author filter (dims),
  date ranges, search, the journey from the first commit to HEAD, mouse support.
- `--format ascii` snapshot (cut into bands with `--width`) and `--format json`.
- 24-bit, 256 and 16 colours, no colour, ASCII-only output, light and dark themes.
- Read-only by construction; the terminal is restored after `q`, Ctrl+C, Ctrl+Z, a
  signal or an error.
