// Changed files and patches, loaded only when the UI asks for them and cached for the
// session. Fast keyboard navigation asks for many commits in a row, so file lists are
// debounced (the latest request wins) and run one at a time.
import { git, text } from './runner';
import type { Repo } from './repository';

export const MAX_PATCH_LINES = 400;
export const MAX_PATCH_BYTES = 64 * 1024;

export interface ChangedFile {
  st: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  path: string;
  old?: string;
  score?: number;
  ins: number | null;
  del: number | null;
  bin: boolean;
  sub: boolean;
  oldSize?: number;
  newSize?: number;
}
export interface Patch { text: string; truncated: boolean; lines: number; bytes: number }

type Result<T> = { status: 'loading' } | { status: 'error'; message: string } | ({ status: 'ready' } & T);

const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/;

export function parseDiffTree(out: string): ChangedFile[] {
  const tok = out.split('\0');
  if (tok[tok.length - 1] === '') tok.pop();
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < tok.length) {
    const m = RAW.exec(tok[i]);
    if (!m) break;
    const two = m[5] === 'R' || m[5] === 'C';
    const f: ChangedFile = { st: m[5], oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4], path: two ? tok[i + 2] : tok[i + 1], ins: null, del: null, bin: false, sub: m[1] === '160000' || m[2] === '160000' };
    if (two) { f.old = tok[i + 1]; f.score = Number(m[6] || 0); }
    files.push(f);
    i += two ? 3 : 2;
  }
  for (let k = 0; i < tok.length && k < files.length; k++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok[i]);
    if (!m) throw new Error('unexpected numstat output from git diff-tree');
    i += m[3] === '' ? 3 : 1; // renames: an empty path, then old and new as separate tokens
    if (m[1] === '-') files[k].bin = !files[k].sub;
    else { files[k].ins = +m[1]; files[k].del = +m[2]; }
  }
  return files;
}

export function limitPatch(patch: string): Patch {
  const all = patch.split('\n');
  if (all[all.length - 1] === '') all.pop();
  const out: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of all) {
    const b = Buffer.byteLength(line) + 1;
    if (out.length >= MAX_PATCH_LINES || bytes + b > MAX_PATCH_BYTES) { truncated = true; break; }
    out.push(line);
    bytes += b;
  }
  return { text: out.join('\n'), truncated, lines: all.length, bytes: Buffer.byteLength(patch) };
}

const ZERO = /^0+$/;

export class ObjectStore {
  private files = new Map<string, Result<{ files: ChangedFile[] }>>();
  private patches = new Map<string, Result<{ patch: Patch }>>();
  private base = new Map<string, string | null>();
  private wanted: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private patchQueue: Array<[string, string]> = [];
  private patchBusy = false;

  /** firstParent: each commit's first parent, from the loaded history. */
  constructor(private repo: Repo, private firstParent: (hash: string) => string | null, private onChange: () => void, private debounceMs = 90) {}

  filesFor(hash: string): Result<{ files: ChangedFile[] }> {
    const got = this.files.get(hash);
    if (got) return got;
    this.wanted = hash;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.debounceMs);
    return { status: 'loading' };
  }

  patchFor(hash: string, path: string): Result<{ patch: Patch }> {
    const key = hash + '\0' + path;
    const got = this.patches.get(key);
    if (got) return got;
    if (!this.patchQueue.some(([h, p]) => h === hash && p === path)) this.patchQueue = [[hash, path]]; // the latest file wins
    this.pumpPatch();
    return { status: 'loading' };
  }

  /** Loads a commit's files now (used by tests and non-interactive callers). */
  async loadFiles(hash: string): Promise<ChangedFile[]> {
    const parent = this.firstParent(hash);
    const range = parent ? [parent, hash] : ['--root', hash];
    let out = await git(['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-abbrev', '--raw', '--numstat', ...range], { cwd: this.repo.root, allowFail: !!parent });
    let base: string | null = parent;
    if (out === null) { // the parent is outside a shallow clone: show the whole tree as added
      out = await git(['diff-tree', '-r', '-z', '-M', '--no-commit-id', '--no-abbrev', '--raw', '--numstat', '--root', hash], { cwd: this.repo.root });
      base = null;
    }
    this.base.set(hash, base);
    const files = parseDiffTree(text(out));
    const blobs = [...new Set(files.filter((f) => f.bin).flatMap((f) => [f.oldSha, f.newSha]).filter((s) => !ZERO.test(s)))];
    if (blobs.length) {
      const sizes = new Map(
        text(await git(['cat-file', '--batch-check'], { cwd: this.repo.root, input: blobs.join('\n') + '\n' }))
          .split('\n').filter(Boolean)
          .map((l) => { const [sha, , size] = l.split(' '); return [sha, Number(size) || 0] as [string, number]; }),
      );
      for (const f of files) if (f.bin) { f.oldSize = sizes.get(f.oldSha) ?? 0; f.newSize = sizes.get(f.newSha) ?? 0; }
    }
    return files;
  }

  async loadPatch(hash: string, path: string): Promise<Patch> {
    if (!this.base.has(hash)) await this.loadFiles(hash);
    const base = this.base.get(hash) ?? null;
    const files = (this.files.get(hash) as { files?: ChangedFile[] } | undefined)?.files || (await this.loadFiles(hash));
    const f = files.find((x) => x.path === path);
    const paths = f && f.old ? [f.old, f.path] : [path];
    const range = base ? [base, hash] : ['--root', hash];
    const out = await git(['diff-tree', '-p', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--no-commit-id', ...range, '--', ...paths], { cwd: this.repo.root });
    return limitPatch(text(out));
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.wanted) return;
    const hash = this.wanted;
    this.wanted = null;
    if (this.files.has(hash)) { this.pump(); return; }
    this.busy = true;
    try {
      const files = await this.loadFiles(hash);
      this.files.set(hash, { status: 'ready', files });
    } catch (e) {
      this.files.set(hash, { status: 'error', message: (e as Error).message });
    }
    this.busy = false;
    this.onChange();
    if (this.wanted) this.pump();
  }

  private async pumpPatch(): Promise<void> {
    if (this.patchBusy || !this.patchQueue.length) return;
    const [hash, path] = this.patchQueue.shift() as [string, string];
    const key = hash + '\0' + path;
    if (this.patches.has(key)) { this.pumpPatch(); return; }
    this.patchBusy = true;
    try {
      this.patches.set(key, { status: 'ready', patch: await this.loadPatch(hash, path) });
    } catch (e) {
      this.patches.set(key, { status: 'error', message: (e as Error).message });
    }
    this.patchBusy = false;
    this.onChange();
    this.pumpPatch();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wanted = null;
    this.patchQueue = [];
  }
}
