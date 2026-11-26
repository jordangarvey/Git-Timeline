#!/usr/bin/env node
// git-timeline: a read-only, horizontally scrolling timeline of a Git repository.
import { parseArgs, HELP, UsageError, Options } from './options';
import { openRepository, loadHistory, resolveRef, RepoError } from '../git/repository';
import { GitError } from '../git/runner';
import { detectDepth, themeFromEnv } from '../term/ansi';
import { renderSnapshot } from './snapshot';
import { runInteractive } from '../term/session';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const E = require('../core/engine.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const T = require('../core/tui.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = require('../../package.json').version;

const fail = (msg: string) => process.stderr.write('git-timeline: ' + msg + '\n');

export async function main(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      fail(e.message);
      process.stderr.write("Try 'git-timeline --help'.\n");
      return 2;
    }
    throw e;
  }
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(VERSION + '\n'); return 0; }

  const tty = !!process.stdout.isTTY && !!process.stdin.isTTY;
  const format = o.format || (tty ? 'interactive' : 'ascii');
  if (format === 'interactive' && !tty) {
    fail('interactive mode needs a terminal. To print a snapshot instead, use --format ascii or --format json.');
    return 2;
  }

  try {
    const repo = await openRepository(o.repo);
    const records = await loadHistory(repo, { maxCount: o.maxCount || undefined, since: o.since, until: o.until });
    const model = E.buildModel(records);
    let select: string | null = null;
    if (o.branch) {
      select = await resolveRef(repo, o.branch);
      if (!select) { fail('no branch, tag or commit named ' + JSON.stringify(o.branch)); return 1; }
      if (!model.commits.has(select)) { fail(o.branch + ' is outside the loaded history. Try a larger --max-count or a wider --since.'); return 1; }
    }
    const notice = model.meta.truncated ? 'Showing the newest ' + model.list.length.toLocaleString('en-GB') + ' commits. --max-count 0 loads them all.' : undefined;

    if (format === 'json') {
      process.stdout.write(T.renderJSON(model, { zoom: 2 }) + '\n');
      return 0;
    }
    const depth = o.color ? detectDepth(process.env, !!process.stdout.isTTY) : 'none';
    if (format === 'ascii') {
      const theme = o.theme === 'auto' ? themeFromEnv(process.env) || 'dark' : o.theme;
      const width = o.width !== undefined ? o.width : process.stdout.isTTY ? process.stdout.columns || 0 : 0;
      process.stdout.write(renderSnapshot(model, { unicode: !o.ascii, depth, theme, view: o.view, width, notice }));
      return 0;
    }
    return await runInteractive(model, repo, {
      unicode: !o.ascii, depth, theme: o.theme, view: o.view, motion: o.motion, mouse: o.mouse, journey: o.journey, select, notice,
    });
  } catch (e) {
    if (e instanceof RepoError || e instanceof GitError) { fail(e.message); return 1; }
    throw e;
  }
}

if (require.main === module) {
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(0); });
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { fail('unexpected error: ' + ((e as Error)?.stack || String(e))); process.exitCode = 1; },
  );
}
