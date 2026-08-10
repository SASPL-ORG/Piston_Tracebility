import { promises as fs } from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// "Demo hide" cutoff — a reversible, DISPLAY-ONLY switch.
// -----------------------------------------------------------------------------
// When set, the app hides every piston record dated BEFORE the cutoff instant
// without deleting anything. Dashboard, Lists and Part Trace only surface rows
// with Date_Time >= cutoff, so:
//   - Hide today at 15:00  -> all history before 15:00 disappears.
//   - New production after 15:00 shows up live (its Date_Time is >= cutoff).
//   - Reveal simply clears the cutoff and ALL history reappears instantly.
//
// NOTHING here mutates SAM_Log. Node-RED keeps writing normally the whole time;
// we only change what the read queries choose to show. That is what makes it
// safe and 100% reversible.
//
// Persisted to a small JSON file on the mounted /data/logs volume so the state
// survives a backend restart, and mirrored in-memory (refreshed on a short
// interval) so the hot query path (buildLatestPerDmcCte) can read it
// synchronously without a disk hit per request.

const STATE_FILE =
  process.env.DASHBOARD_HIDE_STATE_FILE ?? '/data/logs/dashboard-hide-state.json';

// Strict 'YYYY-MM-DD HH:mm:ss'. This is the ONLY shape we ever store, and it
// matters: the value is inlined as a SQL literal in buildLatestPerDmcCte, so we
// validate it hard — nothing but a plain datetime can reach the query.
const CUTOFF_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

let cached: string | null = null;
let loaded = false;

function sanitize(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const v = String(ts).trim();
  return CUTOFF_RE.test(v) ? v : null;
}

// Server 'now' as a cutoff string in the container's local (TZ) time — matches
// how Date_Time / Loading_Time are stamped by Node-RED.
export function nowCutoff(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// Fixed "demo" cutoff. Clicking Demo hides everything dated BEFORE this instant,
// so the app shows production from 1 Aug 2026 onward — and nothing older. Kept
// as a stable constant (env-overridable) rather than "now" so the demo window
// is predictable. Falls back to the hard default if the env value is malformed.
export function demoCutoff(): string {
  const v = (process.env.DEMO_HIDE_CUTOFF ?? '2026-08-01 00:00:00').trim();
  return CUTOFF_RE.test(v) ? v : '2026-08-01 00:00:00';
}

async function loadFromDisk(): Promise<void> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { hideBefore?: string | null };
    cached = sanitize(parsed.hideBefore);
  } catch {
    cached = null; // no file / unreadable => nothing hidden
  }
  loaded = true;
}

// Synchronous accessor for the query path. Returns the validated cutoff or null.
export function getHideBeforeCached(): string | null {
  return cached;
}

// SQL condition fragment for direct SAM_Log queries that DON'T flow through
// buildLatestPerDmcCte (e.g. the Lists failure drill-downs). Returns '' when
// nothing is hidden. The cutoff is strictly validated, so inlining is safe.
export function hideCutoffCond(col = 'Date_Time'): string {
  return cached ? `${col} >= '${cached}'` : '';
}

// Async accessor for routes — guarantees a load has happened at least once.
export async function getHideBefore(): Promise<string | null> {
  if (!loaded) await loadFromDisk();
  return cached;
}

// Set (hide) or clear (reveal) the cutoff. Passing a non-datetime clears it.
export async function setHideBefore(ts: string | null): Promise<string | null> {
  const clean = sanitize(ts);
  cached = clean;
  loaded = true;
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ hideBefore: clean }), 'utf8');
  } catch {
    // Persistence failure is non-fatal: the in-memory value still applies for
    // this process; it just won't survive a restart.
  }
  return clean;
}

// Initial load + periodic refresh (so a manual file edit converges, and a
// multi-replica deployment stays roughly in sync). Called once from main.ts.
export function initHideState(): void {
  void loadFromDisk();
  const t = setInterval(() => {
    void loadFromDisk();
  }, 3000);
  t.unref();
}
