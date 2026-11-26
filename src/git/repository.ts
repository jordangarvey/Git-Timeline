// Finds the repository for a path, and reads its history in a few git calls.
import fs from 'fs';
import path from 'path';
import { git, text, GitError } from './runner';

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface Repo {
  /** Top of the work tree, or the git directory of a bare repository. */
  root: string;
  bare: boolean;
  shallow: boolean;
  name: string;
}

export async function openRepository(dir: string): Promise<Repo> {
  const abs = path.resolve(dir);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new RepoError('no such directory: ' + dir);
  }
  if (!st.isDirectory()) throw new RepoError('not a directory: ' + dir);
  const out = await git(['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--is-shallow-repository', '--absolute-git-dir'], { cwd: abs, allowFail: true });
  if (!out) {
    // tell a missing git apart from "not a repository"
    await git(['version'], { cwd: abs });
    throw new RepoError('not a git repository: ' + (dir === '.' ? 'the current directory' : dir) + ' (or any of its parents)');
  }
  const [bare, inside, shallow, gitDir] = text(out).trim().split('\n');
  let root = gitDir;
  if (inside === 'true') root = text(await git(['rev-parse', '--show-toplevel'], { cwd: abs })).trim();
  else if (bare !== 'true') root = path.dirname(gitDir); // run from inside .git
  const base = path.basename(root);
  return { root, bare: bare === 'true', shallow: shallow === 'true', name: base === '.git' ? path.basename(path.dirname(root)) : base.replace(/\.git$/, '') || root };
}

export interface HistoryOptions {
  maxCount?: number;
  since?: string;
  until?: string;
}

const LOG_FIELDS = ['%H', '%P', '%aN', '%aE', '%at', '%aI', '%cN', '%cE', '%ct', '%cI', '%s', '%b'];
const REF_FIELDS = ['%(refname)', '%(objecttype)', '%(objectname)', '%(*objectname)', '%(*objecttype)', '%(symref)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents)'];

/** Reads refs, commits and working-tree status as records for the graph model. */
export async function loadHistory(repo: Repo, o: HistoryOptions = {}): Promise<object[]> {
  const cwd = repo.root;
  const [symOut, headOut, versionOut, refOut] = await Promise.all([
    git(['symbolic-ref', '-q', 'HEAD'], { cwd, allowFail: true }),
    git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd, allowFail: true }),
    git(['version'], { cwd }),
    git(['for-each-ref', '--format=' + REF_FIELDS.join('%00') + '%1e', 'refs/heads', 'refs/remotes', 'refs/tags'], { cwd }),
  ]);
  const symref = text(symOut).trim() || null;
  const headHash = text(headOut).trim() || null;

  const refs: Record<string, unknown>[] = [];
  let defaultBranch: string | null = null;
  for (const rec of text(refOut).split('\x1e\n')) {
    if (!rec) continue;
    const [name, otype, oname, peeled, ptype, sym, tagger, temail, tdate, contents] = rec.split('\0');
    if (sym) {
      if (/^refs\/remotes\/[^/]+\/HEAD$/.test(name)) defaultBranch = sym.replace(/^refs\/remotes\/[^/]+\//, '');
      continue;
    }
    const annotated = otype === 'tag';
    const r: Record<string, unknown> = { kind: 'ref', name, target: annotated ? peeled : oname, targetType: annotated ? ptype : otype, annotated };
    if (annotated) Object.assign(r, { tagObject: oname, tagger, taggerEmail: (temail || '').replace(/^<|>$/g, ''), taggerTime: Number(tdate) || null, message: (contents || '').replace(/\n+$/, '') });
    refs.push(r);
  }

  // every commit reachable from the refs and HEAD, in one git process; tips go on stdin
  const tips = [...new Set(refs.filter((r) => r.targetType === 'commit').map((r) => String(r.target)).concat(headHash ? [headHash] : []))];
  const commits: Record<string, unknown>[] = [];
  let truncated = false;
  if (tips.length) {
    const args = ['log', '-z', '--no-color', '--no-decorate', '--format=' + LOG_FIELDS.join('%x00')];
    if (o.maxCount) args.push('--max-count=' + o.maxCount);
    if (o.since) args.push('--since=' + o.since);
    if (o.until) args.push('--until=' + o.until);
    args.push('--stdin');
    const raw = text(await git(args, { cwd, input: tips.join('\n') + '\n', timeoutMs: 180000 }));
    const parts = raw.split('\0');
    if (parts[parts.length - 1] === '') parts.pop();
    if (parts.length % LOG_FIELDS.length !== 0) throw new GitError('unexpected output from git log (' + parts.length + ' fields)', 'failed');
    for (let i = 0; i < parts.length; i += LOG_FIELDS.length) {
      const f = parts.slice(i, i + LOG_FIELDS.length);
      // records after the first carry the separator's trailing newline
      const h = f[0].replace(/^\n/, '');
      commits.push({ kind: 'commit', h, p: f[1] ? f[1].split(' ') : [], an: f[2], ae: f[3], at: +f[4], ai: f[5], cn: f[6], ce: f[7], ct: +f[8], ci: f[9], s: f[10], b: f[11].replace(/\n+$/, '') });
    }
    truncated = !!o.maxCount && commits.length >= o.maxCount;
  }
  if (repo.shallow) {
    const file = text(await git(['rev-parse', '--git-path', 'shallow'], { cwd })).trim();
    try {
      const boundary = new Set(fs.readFileSync(path.resolve(cwd, file), 'utf8').split('\n').filter(Boolean));
      for (const c of commits) if (boundary.has(String(c.h))) c.shallow = true;
    } catch {
      // no shallow file: nothing to mark
    }
  }

  const records: object[] = [];
  const meta = {
    kind: 'meta', schema: 1, repo: repo.name, capturedAt: Math.floor(Date.now() / 1000), git: text(versionOut).trim(),
    shallow: repo.shallow, defaultBranch, truncated, filters: { maxCount: o.maxCount || null, since: o.since || null, until: o.until || null },
  };
  records.push(meta, { kind: 'head', hash: headHash, ref: symref, detached: !symref && !!headHash, unborn: !headHash });
  if (!repo.bare) records.push(await loadStatus(cwd));
  records.push(...refs, ...commits);
  return records;
}

async function loadStatus(cwd: string): Promise<object> {
  const st = { kind: 'status', branch: null as string | null, oid: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const out = await git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'], { cwd, allowFail: true, timeoutMs: 20000 });
  const tokens = text(out).split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# branch.oid ')) st.oid = t.slice(13);
    else if (t.startsWith('# branch.head ')) st.branch = t.slice(14);
    else if (t.startsWith('# branch.upstream ')) st.upstream = t.slice(18);
    else if (t.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(t); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    else if (t[0] === '1' || t[0] === '2') {
      if (t[2] !== '.') st.staged++;
      if (t[3] !== '.') st.modified++;
      if (t[0] === '2') i++; // renames carry the original path as an extra token
    } else if (t[0] === 'u') st.conflicted++;
    else if (t[0] === '?') st.untracked++;
  }
  return st;
}

/** Resolves a branch, tag or other revision to a commit hash, or null. */
export async function resolveRef(repo: Repo, ref: string): Promise<string | null> {
  if (!ref || ref.startsWith('-')) return null;
  const out = await git(['rev-parse', '-q', '--verify', ref + '^{commit}'], { cwd: repo.root, allowFail: true });
  return text(out).trim() || null;
}
