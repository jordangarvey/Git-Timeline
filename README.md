# git-timeline

Your Git history as a timeline in the terminal. It's one scrolling world that moves
through Earth's history, a new age every seven commits: primordial sea, first shores,
first forests, dinosaurs, the ice age, the stone age, the ancient world, the Middle
Ages, the industrial age, the modern city and the far future. The default branch is
the path along the ground. Every other branch is a trail that climbs a hill and comes
back down where it merges. Press `v` for the plain graph, with time to scale.

It is read-only. It never changes refs, the index, the working tree or config, and it
never touches the network.

## What it looks like

Real output from the 77-commit example repository (`scripts/make-demo-repo.mjs`),
printed with `git-timeline --format ascii --width 100 --no-color`. This is the
first band of the snapshot. In a terminal, it is in colour, full screen, and you
scroll through it.

```text
git-timeline  HEAD → main cf7d48a  77 commits  7 commits per age of Earth  (snapshot, not
interactive)
 ╷1 Jun 2026                                                   ╷15 Jun                         ╷22 J
    ▸ Primordial Sea                                        ▸ First Shores
                                                 ▄██▄▖
                                          ▄█▄   ▀▀▀▀▀▀▀                                           ▄█
                                         ▐███▌                                                   ▐██
                                          ▀█▀                                                     ▀█
               ▄██▄▖
              ▀▀▀▀▀▀▀
```

The graph view (`--view graph`), time to scale:

```text
git-timeline  HEAD → main cf7d48a  77 commits  1 column = 1 day  (snapshot, not interactive)
 1d/col                  │                                Jul 2026                       Aug
                         │────────────────────────────────┬──────────────────────────────┬──────────
 tags                    │                                     ⚑… ⚑v0.1.1
 main                    │    ●─●─●────●──◆─────◆─●──────◆─◆─●─●────◆─┬───●─◆─────◆─●─●─●───────────
                         │        │       │     │ │      │ │   │    │ │     │     │
 site                    │        ╰─●─●─●─┤     │ ├─●─●──│─╯   ├──●─╯ │     ├───●─┤
                         │                │     │ │      │     │      │     │     │
 experiment/canvas-rende…│                ├────●│─│──────│─────│──────│──●──│─────│────────────●────
                         │                │     │ │      │     │      │     │     │
 feature/search          │                ╰─●─●─╯ ╰──●─●─╯     ╰─●────◆─●───┤     │
                         │                         ~feature/ti… ~feature/tu…│     │
 feature/author-filter   │                                                  ├──●──┤
                         │                                                  │     │
 ~chore/ci               │                                                  ╰─●───╯
                         │                                                   ~chore/ci
```

## Install

You need **Node.js 18 or newer** and **Git 2.15 or newer** on your `PATH`.

From the package file:

```sh
npm install -g ./git-timeline-0.1.0.tgz
```

From source:

```sh
npm install
npm run build
npm link          # puts `git-timeline` on your PATH
```

## Use

Run it inside any repository:

```sh
git-timeline                      # interactive timeline of the current repository
git-timeline ../my-project        # or: --repo ../my-project, -C ../my-project
git-timeline --since 30d          # 12h, 30d, 6w, 3m, 1y, or a date: 2026-01-31
git-timeline --max-count 500      # the newest 500 commits (default 20000; 0 = all)
git-timeline --branch main        # start with a branch, tag or commit selected
git-timeline --view graph         # the plain timeline, time to scale
git-timeline --journey            # start by flying from the first commit to HEAD

git-timeline --format ascii       # print a snapshot (cut to the terminal's width)
git-timeline --format ascii --width 0 > history.txt   # one long strip
git-timeline --format json        # commits, parents, paths and layout, for scripts

git-timeline --ascii              # ASCII characters only
git-timeline --no-color           # no colour (NO_COLOR is honoured too)
git-timeline --theme light        # auto (default), dark or light
git-timeline --no-motion          # no animation (good over slow SSH)
git-timeline --no-mouse           # leave the mouse to your terminal's text selection
```

When standard output is not a terminal, it prints the `ascii` snapshot instead of
starting the interactive UI, without colour unless `FORCE_COLOR` is set.

Exit status: `0` on success, `1` when the repository can't be read (not a
repository, Git missing, an unknown `--branch`), `2` for bad options.

## Keys

| Key | Does |
| --- | --- |
| `←` `→` / `h` `l` | previous / next commit; the view glides along |
| `↑` `↓` / `k` `j` | nearest commit on the trail above / below |
| `Shift`+`←` `→` / `H` `L` | pan half a screen without moving the selection |
| `[` `]` / `-` `+` | zoom: fewer or more commits per screen (time per column in the graph) |
| `g` / `G` | HEAD / the oldest commit |
| `Enter` | open the commit's changed files, then a file's diff |
| `Tab`, `Esc` | next panel, back |
| `,` `.` | previous / next file while reading a diff |
| `f` `a` `d` | filter branches and tags, authors (dims, never hides), date range |
| `/` `n` `N` | search subjects, bodies, authors and hashes; older / newer match |
| `p` | the journey from the first commit to HEAD; any key stops it |
| `v` | world view / graph view |
| `?` | every key and the legend |
| `q`, `Ctrl+C` | quit |

With the mouse: click a commit to select it, click it again to open it; the wheel
scrolls the timeline, the file list and diffs.

## Legend

| Mark | Means |
| --- | --- |
| `●` | commit |
| `◆` | merge (more than one parent) |
| `◉` | HEAD |
| `⚑` | tag |
| `~name` | a path with no ref of its own, named from the merge message |
| `‹` `›` | history continues outside the date range |
| `!` | dated before its parent (clock skew); the order follows ancestry |
| the figure | you, at the selected commit |

Colour is never the only signal: every trail is labelled with its branch name.

## The world view

- **Seven commits per age.** A commit's age comes from its position in the whole
  history: commits 1 to 7 are in the sea, 8 to 14 on the shores, and so on to the far
  future from commit 71. A small project stops earlier; a big one stays in the future.
  Filters never change a commit's age.
- **About seven commits per screen,** so one screen is roughly one age. `[` and `]`
  change that. The dates along the top keep the real times.
- **Branches are trails.** The default branch runs along the ground. Every other branch
  forks up onto a trail with a hill under it. Higher trails sit further back and paler.
  Trees, dinosaurs, castles and towers stand on the topmost trail, so they never cover
  one.
- **Plain terminal text.** All of it is characters a terminal can print. Water, smoke,
  sails, traffic and stars move a little unless you pass `--no-motion`.

## Terminals and fallbacks

- **Colour:** 24-bit colour where the terminal says it supports it (`COLORTERM`,
  iTerm2, WezTerm, kitty, Alacritty, Ghostty, VS Code, Windows Terminal and others),
  otherwise 256 colours (`TERM=*-256color`, Apple Terminal), otherwise the 16 basic
  colours without the sky and ground tints. `NO_COLOR`, `--no-color` or `TERM=dumb`
  turn colour off; `FORCE_COLOR=1|2|3` forces 16, 256 or 24-bit colour.
- **Light or dark:** `--theme auto` reads `COLORFGBG`, or asks the terminal for its
  background colour (OSC 11) and waits at most 150 ms for an answer. Otherwise it
  assumes dark.
- **Characters:** box drawing and block elements need a font that has them; any
  modern monospace font does. `--ascii` uses plain ASCII throughout.
- **Mouse:** SGR mouse reporting (xterm and every terminal that copies it). Hold
  Shift (Option on macOS) to select text while it's on, or pass `--no-mouse`.
- **Smaller screens:** the layout adapts down to about 44 × 20; the commit details
  open full screen there.

## Read-only and private

- Git is started with `execFile` and an argument array, never through a shell, so
  nothing from a repository or the command line is ever run as a command.
- Every call passes `--no-optional-locks` (so `git status` doesn't rewrite the index),
  turns off fsmonitor hooks, signature checks, colour and pagers, and sets
  `GIT_NO_LAZY_FETCH=1` so a partial clone never fetches missing objects from the
  network. Prompts are off and every call has a timeout.
- Commit messages, names and paths are treated as untrusted. Control characters
  and escape sequences in them are shown as visible symbols, never sent to your
  terminal.
- It sends nothing anywhere and keeps no files.

The history is read in a handful of git processes (`rev-parse`, `for-each-ref`, one
`log` for every commit, `status`). Changed files and patches are read one commit at
a time, only when you look at them, and are kept for the session. Patches are cut
off at 400 lines or 64 KB.

## Limitations

- By default only the newest 20,000 commits are loaded; `--max-count 0` loads
  everything. Layout of 50,000 commits takes about a second on a laptop-class CPU.
- "on" in the commit details walks each ref's ancestry once; very large
  repositories would need commit-graph generation numbers instead.
- No syntax highlighting in diffs.
- The `ascii` snapshot of the world is one slot of 8 columns per commit, so long
  histories make long strips; `--width` cuts them into bands.
- Animation sends more output than a still screen; over a slow connection use
  `--no-motion`.
- Tested on Linux with Node 22 and Git 2.43. macOS and Windows Terminal should work
  but were not tested for this release.

## Develop

```sh
npm install
npm run build        # TypeScript → dist/
npm run typecheck
npm test             # builds, then runs every test with Node's test runner
npm pack --dry-run   # what would be published
node scripts/make-demo-repo.mjs /tmp/demo/repo   # the 77-commit example repository
```

The design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributions are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a problem, open an issue
with the command you ran, your terminal, and what you saw. A `--format json`
snapshot of a public repository that shows it is the most useful thing to attach.

## Licence

MIT
