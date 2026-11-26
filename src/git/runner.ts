// The only place git-timeline starts a process. Read-only by construction:
//  - execFile with an argument array, never a shell, so nothing from a repository
//    or the command line is ever interpreted as shell text;
//  - --no-optional-locks so `git status` never rewrites the index;
//  - fsmonitor hooks, signatures, colour and lazy fetches of missing objects are off;
//  - prompts are disabled and every call has a timeout.
import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(message: string, readonly kind: 'missing' | 'failed' | 'timeout') {
    super(message);
    this.name = 'GitError';
  }
}

const PREFIX = [
  '--no-optional-locks',
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
  '-c', 'color.ui=false',
];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
  };
}

export interface GitCall {
  cwd: string;
  input?: string;
  allowFail?: boolean;
  timeoutMs?: number;
}

/** Shapes of the commands run, for diagnostics (`--debug` lists them). */
export const calls = new Map<string, number>();

function shape(args: string[]): string {
  const out: string[] = [];
  let paths = false;
  for (const a of args) {
    if (paths) { if (out[out.length - 1] !== '<path>…') out.push('<path>…'); continue; }
    if (a === '--') { paths = true; out.push(a); }
    else if (/^[0-9a-f]{40,64}$/.test(a)) out.push('<commit>');
    else if (a.startsWith('--format=')) out.push('--format=<fields>');
    else if (a.startsWith('--since=') || a.startsWith('--until=')) out.push(a.split('=')[0] + '=<date>');
    else out.push(a);
  }
  return 'git ' + out.join(' ');
}

/** Runs git and resolves with stdout, or null when allowFail is set and git failed. */
export function git(args: string[], o: GitCall): Promise<Buffer | null> {
  const key = shape(args);
  calls.set(key, (calls.get(key) || 0) + 1);
  const bin = process.env.GIT_TIMELINE_GIT || 'git';
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = execFile(
        bin,
        [...PREFIX, ...args],
        { cwd: o.cwd, env: gitEnv(), encoding: 'buffer', timeout: o.timeoutMs ?? 30000, maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) { resolve(stdout as Buffer); return; }
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') { reject(new GitError('git is not installed, or is not on your PATH.', 'missing')); return; }
          if (o.allowFail) { resolve(null); return; }
          if (e.killed) { reject(new GitError('git ' + args[0] + ' took too long and was stopped.', 'timeout')); return; }
          const lines = (stderr as Buffer).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
          const msg = (lines.find((l) => l.startsWith('fatal:')) || lines[lines.length - 1] || 'git ' + args[0] + ' failed').replace(/^(fatal|error): /, '');
          reject(new GitError(msg, 'failed'));
        },
      );
    } catch (err) {
      reject(err);
      return;
    }
    child.stdin?.on('error', () => {}); // git may exit before reading stdin
    if (o.input === undefined) child.stdin?.end();
    else child.stdin?.end(o.input);
  });
}

export const text = (b: Buffer | null): string => (b ? b.toString('utf8') : '');
