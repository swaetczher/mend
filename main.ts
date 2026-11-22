// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// the V4A patch format, JSON text-editor tool calls) and applies it to the
// tree of text files rooted at the working directory, changing every file or
// none at all. Implements SPEC.md version 1 in full: three tiers of line
// matching, atomic application, --format / --check / --strict, and the exit
// codes of section 2. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text broken into its line break, its lines, and whether it ends with a break. */
interface Split {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, new path -> ultimate origin path, for the `R` output lines. */
  readonly movedFrom = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string): void {
    const origin = this.movedFrom.get(oldP) ?? oldP;
    this.movedFrom.delete(oldP);
    this.movedFrom.set(newP, origin);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function keyOf(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  if (tier === 1) return t;
  return t.replace(/^[ \t]+/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const want = oldLines.map((l) => keyOf(l, tier));
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (keyOf(lines[i + j]!, tier) !== want[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Old lines O and new lines N of one replacement; nCtx[j] is the index in O of N[j] when it is a context line. */
interface Replacement {
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

/** Build the lines that replace a match: context lines come from the file itself, other lines are re-indented at tier 2. */
function buildNew(fileLines: string[], pos: number, tier: number, r: Replacement): string[] {
  const pLead = r.o.length > 0 ? leadWs(r.o[0]!) : '';
  const fLead = leadWs(fileLines[pos] ?? '');
  return r.n.map((line, j) => {
    const ci = r.nCtx[j]!;
    if (ci !== null) return fileLines[pos + ci]!;
    if (tier === 2 && r.o.length > 0 && line !== '' && line.trim() !== '' && line.startsWith(pLead)) {
      return fLead + line.slice(pLead.length);
    }
    return line;
  });
}

/** O and N of one hunk/chunk body: ' ' lines go in both, '-' in O, '+' in N; '\' lines are markers only. */
function bodyReplacement(body: string[]): Replacement {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    const kind = bl === '' ? ' ' : bl[0]!;
    const text = bl === '' ? '' : bl.slice(1);
    if (kind === ' ') {
      o.push(text);
      n.push(text);
      nCtx.push(o.length - 1);
    } else if (kind === '-') {
      o.push(text);
    } else if (kind === '+') {
      n.push(text);
      nCtx.push(null);
    }
  }
  return { o, n, nCtx };
}

/** True when a '\' line follows the hunk's last context or '+' line: the result then ends without a line break. */
function hunkNoEol(body: string[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl.startsWith('\\')) continue;
    if (bl === '' || bl[0] === ' ' || bl[0] === '+') {
      return k + 1 < body.length && body[k + 1]!.startsWith('\\');
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Format detection (section 4)                                        */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Hunk extends Replacement {
  a: number;
  body: string[];
  noEol: boolean;
}

interface Section {
  oldP: string | null;
  newP: string | null;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  create: boolean;
  del: boolean;
  phase: 'header' | 'hunks';
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const parsePath = (s: string): string | null => {
    const cut = s.split('\t')[0]!.trim();
    if (cut === '/dev/null') return null;
    return cut.replace(/^[ab]\//, '');
  };
  const newSection = (oldP: string | null, newP: string | null): Section => {
    const s: Section = { oldP, newP, hasPair: false, renameFrom: undefined, renameTo: undefined, create: false, del: false, phase: 'header', hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.phase === 'hunks') cur = newSection(null, null);
      if (!cur.hasPair) {
        cur.oldP = parsePath(line.slice(4));
        cur.newP = parsePath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.phase === 'header' && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const r = bodyReplacement(body);
      cur.hunks.push({ ...r, a, body, noEol: hunkNoEol(body) });
      cur.phase = 'hunks';
      continue;
    }
    if (cur !== null && cur.phase === 'header') {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text; the final break follows section 6. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  let endFinal: boolean | null = null;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.n);
      if (atEnd && h.n.length > 0) endFinal = !h.noEol;
      d += h.n.length;
    } else {
      const found = findTier(f.lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const endTouched = best + h.o.length === f.lines.length;
      const made = buildNew(f.lines, best, found.tier, h);
      f.lines.splice(best, h.o.length, ...made);
      if (endTouched) endFinal = !h.noEol;
      d += h.n.length - h.o.length;
    }
  }
  if (endFinal !== null) f.final = endFinal;
  return joinFile(f);
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  let oldP = s.oldP;
  let newP = s.newP;
  if (!s.hasPair) {
    if (s.renameFrom !== undefined) oldP = s.renameFrom;
    if (s.renameTo !== undefined) newP = s.renameTo;
  }
  const create = s.create || (oldP === null && newP !== null);
  const del = !create && (s.del || (newP === null && oldP !== null));
  const move = !create && !del && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    const paths = [oldP, newP].filter((p): p is string => p !== null);
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (create) {
      const np = newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out: string[] = [];
      for (const h of s.hunks) {
        for (const bl of h.body) {
          if (bl.startsWith('+')) out.push(bl.slice(1));
        }
      }
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.body.some((bl) => bl.startsWith('+'))) {
          noEol = h.noEol;
          break;
        }
      }
      tree.now.set(np, joinFile({ br: '\n', lines: out, final: !noEol }));
      return;
    }
    if (del) {
      const op = oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (move) {
      const op = oldP!;
      const np = newP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const text = applyHunks(tree.get(op)!, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.move(op, np);
      return;
    }
    const op = oldP ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(tree.get(op)!, s.hunks, strict, op));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ br: '\n', lines: [...newLines], final: true }));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const r: Replacement = { o: oldLines, n: newLines, nCtx: newLines.map(() => null) };
    const made = buildNew(f.lines, pos, found.tier, r);
    f.lines.splice(pos, oldLines.length, ...made);
    tree.now.set(path, joinFile(f));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface VChunk extends Replacement {
  anchor: string | null;
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const headRe = /^\*\*\* (Add File|Delete File|Update File):(.*)$/;
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = headRe.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const sectionLine = i + 1;
    i++;
    const raw: number[] = [];
    while (i < last) {
      if (headRe.test(lines[i]!)) break;
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'Add File') {
      const out: string[] = [];
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l === '') out.push('');
        else if (l.startsWith('+')) out.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ br: '\n', lines: out, final: true }));
      });
    } else if (kind === 'Delete File') {
      for (const idx of raw) throw new Exit2(`error: parse ${idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && lines[raw[0]!]!.startsWith('*** Move to:')) {
        moveTo = lines[raw[0]!]!.slice('*** Move to:'.length).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const finish = (): void => {
        if (cur !== null) {
          const r = bodyReplacement(cur.body);
          chunks.push({ ...r, anchor: cur.anchor, eof: cur.eof });
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const idx = raw[j]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          finish();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          finish();
        } else if (l.startsWith('*** ')) {
          throw new Exit2(`error: parse ${idx + 1}`);
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(l);
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      finish();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let foundIdx: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const key = keyOf(c.anchor, t);
          for (let k = cursor; k < f.lines.length; k++) {
            if (keyOf(f.lines[k]!, t) === key) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx !== null) break;
        }
        if (foundIdx === null) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (c.o.length === 0) {
        const pos = c.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...c.n);
        cursor = pos + c.n.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let hit: { tier: number; occ: number[] } | null = null;
        for (const t of tiers) {
          let occ = occurrences(f.lines, c.o, t).filter((p) => p >= cursor);
          if (c.eof) occ = occ.filter((p) => p + c.o.length === f.lines.length);
          if (occ.length > 0) {
            hit = { tier: t, occ };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        const pos = hit.occ[0]!;
        const made = buildNew(f.lines, pos, hit.tier, c);
        f.lines.splice(pos, c.o.length, ...made);
        cursor = pos + made.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.move(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running (sections 1, 2, 10)                                         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [np, op] of tree.movedFrom) {
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      covered.add(op);
      covered.add(np);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
