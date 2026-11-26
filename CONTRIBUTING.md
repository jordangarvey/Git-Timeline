# Contributing

Thanks for helping. A few things keep this project easy to work on:

- **Read-only, always.** git-timeline must never write to a repository, run a shell,
  or reach the network. New git calls go through `src/git/runner.ts` with an argument
  array.
- **Untrusted text.** Anything from a repository (messages, names, paths, ref names)
  is drawn with `Screen.text`, which sanitises control characters. Never write
  repository text to the terminal any other way.
- **Layers stay apart.** Git reading (`src/git`) knows nothing about drawing; the
  model and layout (`src/core/engine.js`) know nothing about terminals; the UI
  (`src/core/tui.js`, `src/core/world.js`) draws into a character buffer; only
  `src/term` talks to the terminal. See docs/ARCHITECTURE.md.
- **Tests with every change.** `npm test` builds and runs everything. Git tests make
  temporary repositories with a private HOME, so they never touch your own config or
  repositories. Tests use Node's built-in runner (`node:test`), which keeps the
  project free of runtime and test dependencies.
- **No new runtime dependencies** without a very good reason.

Development:

```sh
npm install
npm test
npm run typecheck
node dist/cli/main.js -C /path/to/some/repo
```

To report a bug, open an issue with the command you ran, your OS, terminal and
font, and what you expected to see. A `--format json` snapshot of a public
repository that shows the problem helps a lot.
