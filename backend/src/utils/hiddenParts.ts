import { promises as fs } from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// "Hidden parts" — a reversible, DISPLAY-ONLY hide of specific pistons by DMC.
// -----------------------------------------------------------------------------
// Sibling of hideState.ts (the demo-mode date cutoff), but keyed on an explicit
// list of exact DMCs instead of a date. When a DMC is on the list, every read
// path filters it out with `DMC NOT IN (...)`, so:
//   - Part Trace search for it returns 0 rows -> the existing 404 "No records
//     found" response.
//   - It disappears from every Lists view and from the Dashboard counts.
//   - Its images stop resolving.
// NOTHING is deleted from SAM_Log — Node-RED keeps writing normally; we only
// change what the read queries choose to show. Clearing the list (or emptying
// the JSON file) makes the parts reappear instantly. 100% reversible.
//
// Persisted to a small JSON file on the mounted /data/logs volume so the state
// survives a backend restart, and mirrored in-memory (refreshed on a short
// interval) so the hot query path can read it synchronously without a disk hit
// per request — and so a manual edit of the file converges without a redeploy.

const STATE_FILE = process.env.HIDDEN_DMCS_FILE ?? '/data/logs/hidden-dmcs.json';

// A DMC value is inlined as a SQL string literal, so validate it hard: the
// stored key is only brackets/parens/angle, dot, dash, underscore and
// alphanumerics — no quote, whitespace or control byte can ever reach a query.
const DMC_RE = /^[A-Za-z0-9.\-[\]()>_]{1,128}$/;

let cached: string[] = [];
let loaded = false;

function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const v of list) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s && DMC_RE.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { dmcs?: unknown };
    cached = sanitize(parsed.dmcs);
  } catch {
    cached = []; // no file / unreadable => nothing hidden
  }
  loaded = true;
}

// Synchronous accessor for the query path. Returns the validated DMC list.
export function getHiddenDmcsCached(): string[] {
  return cached;
}

// SQL condition `col NOT IN ('a','b')`, or '' when nothing is hidden. Every
// value already passed DMC_RE; single quotes are doubled as belt-and-braces.
export function hiddenDmcInClause(col = 'DMC'): string {
  if (cached.length === 0) return '';
  const lits = cached.map((d) => `'${d.replace(/'/g, "''")}'`).join(', ');
  return `${col} NOT IN (${lits})`;
}

// Same, pre-wrapped as an appendable ` AND (...)` fragment for the direct
// SAM_Log queries that build their WHERE by string concatenation.
export function hiddenDmcAndClause(col = 'DMC'): string {
  const c = hiddenDmcInClause(col);
  return c ? ` AND ${c}` : '';
}

// Async accessor — guarantees a load has happened at least once.
export async function getHiddenDmcs(): Promise<string[]> {
  if (!loaded) await loadFromDisk();
  return cached;
}

// Replace the hidden set (pass [] to reveal everything).
export async function setHiddenDmcs(list: string[]): Promise<string[]> {
  const clean = sanitize(list);
  cached = clean;
  loaded = true;
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ dmcs: clean }, null, 2), 'utf8');
  } catch {
    // Persistence failure is non-fatal: the in-memory value still applies for
    // this process; it just won't survive a restart.
  }
  return clean;
}

// Initial load + periodic refresh (so a manual file edit converges without a
// redeploy). Called once from main.ts.
export function initHiddenParts(): void {
  void loadFromDisk();
  const t = setInterval(() => {
    void loadFromDisk();
  }, 3000);
  t.unref();
}
