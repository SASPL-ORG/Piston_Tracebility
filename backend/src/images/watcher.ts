import { promises as fs } from 'fs';
import { getImageConfig } from './config.js';
import { indexImage } from './indexer.js';

// =============================================================================
// Image processor — polling-only, bounded worker pool, no chokidar.
//
// History: the previous design used chokidar + a `queue.then(...)` Promise
// chain. Over time the chain grew thousands of pending `.then()` callbacks;
// V8 prioritizes microtasks over macrotasks, so the chain starved HTTP
// responses (we measured /image GETs taking 43s) and the safety scan itself.
// Files would silently stop being processed. Restarts only reset the clock.
//
// New design:
//   - No chokidar — it has been observed to silently stop emitting `add`
//     events on Windows bind-mounts after backlog bursts. We poll instead.
//   - No Promise chain — N parallel worker tasks each pull paths off a Set.
//     When the Set drains they wait on a single shared resolver. The event
//     loop is never starved by a runaway microtask queue.
//   - DMC-level serialization — workers skip a path if another worker is
//     already processing a file with the same DMC, preventing the
//     `nextPictureNo` race that the old chain prevented globally.
//   - Watchdog — if backlog > 0 but no progress in N minutes, we log a loud
//     warning. Easy to wire alerting on this single line later.
// =============================================================================

interface ProcessorState {
  pending: Set<string>;
  inFlightByDmc: Map<string, number>; // refcount so 25 ring files of same DMC serialize, but different DMCs run in parallel
  // NO_MATCH retry counter, keyed by source path. A file gets one increment
  // every time the worker indexImage call finishes and the file is still
  // in source (meaning matcher returned NO_MATCH or the file was a dedup
  // hit on a row that never resolved). When the count exceeds the
  // quarantine threshold, the file is moved into a _quarantine folder so
  // the queue isn't permanently clogged by orphans (files whose PLC row
  // never arrives). Replaces the old 15-minute TTL cache — which made
  // every NO_MATCH file invisible to the scan for 15 minutes, exactly the
  // behaviour the operator was working around by running the drain
  // script manually.
  noMatchCount: Map<string, number>;
  inFlightPaths: Set<string>;
  // ALL parked workers' resolvers. A single shared slot would let one
  // worker's park overwrite another's, stranding them forever (the bug
  // that capped real throughput at ~1 worker out of 4).
  parkedResolvers: Array<() => void>;
  running: boolean;
  lastProcessedAt: number;
  totalProcessed: number;
  totalErrors: number;
  // Scan tick counters — observable via /admin/images/processor-state so
  // we can tell instantly if the setInterval has died (count stops
  // increasing while CV-X keeps writing).
  scanTickCount: number;
  scanLastRunAt: number;
  scanLastErrorMsg: string | null;
  scanTimer: NodeJS.Timeout | null;
  watchdogTimer: NodeJS.Timeout | null;
  workerPromises: Promise<void>[];
}

const state: ProcessorState = {
  pending: new Set(),
  inFlightByDmc: new Map(),
  noMatchCount: new Map(),
  inFlightPaths: new Set(),
  parkedResolvers: [],
  running: false,
  lastProcessedAt: 0,
  totalProcessed: 0,
  totalErrors: 0,
  scanTickCount: 0,
  scanLastRunAt: 0,
  scanLastErrorMsg: null,
  scanTimer: null,
  watchdogTimer: null,
  workerPromises: [],
};

function dmcKeyFromPath(p: string): string {
  // Filename shape: M160-T<...>-DB<NN>_<idx>_<CAMx>_<counter>.jpg
  // The DMC portion is everything before the first underscore.
  const base = p.split('/').pop() || p;
  const cut = base.indexOf('_');
  return cut > 0 ? base.slice(0, cut) : base;
}

function notifyWorkers(): void {
  // Wake every parked worker — they'll re-scan pending. The ones that find
  // nothing eligible will simply park again. Crucially, we DON'T pop a
  // single resolver: any worker waiting on an old promise that was
  // overwritten in a previous design would never see another notification.
  if (state.parkedResolvers.length === 0) return;
  const resolvers = state.parkedResolvers;
  state.parkedResolvers = [];
  for (const r of resolvers) r();
}

function enqueuePath(filePath: string): boolean {
  // Only skip if already in flight or already in the pending Set — no TTL
  // cache. This matches the behaviour of the drain script: every file in
  // source gets a fresh attempt on every scan tick.
  if (state.pending.has(filePath) || state.inFlightPaths.has(filePath)) return false;
  state.pending.add(filePath);
  notifyWorkers();
  return true;
}

// Walks the incoming tree and enqueues all unseen image files. Cheap to call
// frequently — the TTL cache + pending Set deduplicate within a window.
export async function scanIncomingOnce(
  log: (msg: string) => void,
): Promise<{ enqueued: number; skipped: number }> {
  log(`[images] scan ENTRY tick=${state.scanTickCount}`);
  const cfg = getImageConfig();

  let enqueued = 0;
  let skipped = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('_hold') || ent.name.startsWith('_quarantine')) continue;
      const p = dir + '/' + ent.name;
      if (ent.isDirectory()) {
        await walk(p, depth + 1);
      } else if (/\.(jpg|bmp)$/i.test(ent.name)) {
        if (enqueuePath(p)) enqueued++;
        else skipped++;
      }
    }
  }
  let walkError: string | null = null;
  let firstEntries = 0;
  try {
    // Also check what the top-level readdir returns to detect bind-mount
    // snapshot issues (the in-process scan returning 0 while a separate
    // `find` shows 8000+ files).
    const tlEntries = await fs.readdir(cfg.incomingPath, { withFileTypes: true });
    firstEntries = tlEntries.length;
    await walk(cfg.incomingPath, 0);
  } catch (err) {
    walkError = (err as Error).message;
  }
  // DEBUG: log every tick until the wedge is understood.
  log(
    `[images] scan tick #${state.scanTickCount}: topLevelEntries=${firstEntries} ` +
      `enqueued=${enqueued} skipped=${skipped} ` +
      `pending=${state.pending.size} inFlight=${state.inFlightPaths.size}` +
      (walkError ? ` walkError=${walkError}` : ''),
  );
  if (walkError) state.scanLastErrorMsg = walkError;
  return { enqueued, skipped };
}

// When a worker finishes indexImage and the file is STILL in source
// (NO_MATCH outcome, or a dedup-hit on a row that never resolved), this
// runs. The decision to quarantine is now age-based, not attempt-count
// based:
//   • If the file's mtime is older than IMAGE_QUARANTINE_FILE_AGE_MINUTES
//     (default 30 min) AND it has been NO_MATCH'd at least once, it's a
//     true orphan — its PLC row was never going to come. Move it out so
//     the queue doesn't see it again.
//   • Otherwise it's a fresh capture still waiting on its SAM_Log row;
//     keep retrying every scan tick.
// This means orphan files from yesterday (or a CV-X scan with no matching
// PLC event) leave the queue on their first NO_MATCH, but a fresh circlip
// image whose PLC stamp lands 30 seconds later keeps getting retried
// until it matches.
async function maybeQuarantine(filePath: string, log: (msg: string) => void): Promise<void> {
  // Must sit BEYOND the patient-pending window (48 h) so a legitimately
  // pending image — one still waiting for its inspection row — is never
  // quarantined before that window closes. Raised 240 min → 72 h.
  const ageMinutes = Math.max(
    parseInt(process.env.IMAGE_QUARANTINE_FILE_AGE_MINUTES || '4320', 10),
    1,
  );
  const next = (state.noMatchCount.get(filePath) ?? 0) + 1;
  state.noMatchCount.set(filePath, next);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    state.noMatchCount.delete(filePath);
    return;
  }
  const fileAgeMs = Date.now() - stat.mtimeMs;
  if (fileAgeMs < ageMinutes * 60_000) return; // still fresh, keep retrying

  const cfg = getImageConfig();
  const stampLocal = new Date();
  const y = stampLocal.getFullYear();
  const m = String(stampLocal.getMonth() + 1).padStart(2, '0');
  const d = String(stampLocal.getDate()).padStart(2, '0');
  const qdir = `${cfg.incomingPath}/_quarantine_${y}-${m}-${d}`;
  try {
    await fs.mkdir(qdir, { recursive: true });
    const base = filePath.split('/').pop() ?? 'unknown';
    const dest = `${qdir}/${base}`;
    await fs.rename(filePath, dest);
    log(
      `[images] quarantined (age=${Math.round(fileAgeMs / 60000)}m, retries=${next}): ${filePath}`,
    );
  } catch (err) {
    log(`[images] quarantine move failed for ${filePath}: ${(err as Error).message}`);
  } finally {
    state.noMatchCount.delete(filePath);
  }
}

// One worker loop. Pulls one path off the pending Set, processes it, repeats.
// When the Set is empty, parks on a single shared notifier resolved by
// `notifyWorkers()` whenever enqueuePath() succeeds.
async function workerLoop(id: number, log: (msg: string) => void): Promise<void> {
  while (state.running) {
    // Try to find a path whose DMC isn't already in flight (DMC-level serial).
    let pickedPath: string | null = null;
    for (const candidate of state.pending) {
      const dmc = dmcKeyFromPath(candidate);
      if ((state.inFlightByDmc.get(dmc) ?? 0) === 0) {
        pickedPath = candidate;
        state.inFlightByDmc.set(dmc, 1);
        break;
      }
    }

    if (!pickedPath) {
      // Either Set is empty, or every candidate's DMC is busy. Park until
      // someone notifies us (new file enqueued or DMC freed up). Each
      // worker pushes its own resolver — `notifyWorkers()` wakes them all.
      await new Promise<void>((resolve) => {
        state.parkedResolvers.push(resolve);
      });
      continue;
    }

    state.pending.delete(pickedPath);
    state.inFlightPaths.add(pickedPath);

    try {
      await indexImage(pickedPath);
      state.totalProcessed++;
      state.lastProcessedAt = Date.now();
    } catch (err) {
      state.totalErrors++;
      log(`[images] worker-${id} indexImage failed for ${pickedPath}: ${(err as Error).message}`);
    } finally {
      const dmc = dmcKeyFromPath(pickedPath);
      state.inFlightByDmc.delete(dmc);
      state.inFlightPaths.delete(pickedPath);

      // If the file is STILL in source after indexImage returned, the
      // match was either NO_MATCH or a dedup-hit. Tick its retry counter
      // and quarantine after the threshold. The fs.access is cheap.
      try {
        await fs.access(pickedPath);
        await maybeQuarantine(pickedPath, log);
      } catch {
        // File moved to destination — clear any partial counter.
        state.noMatchCount.delete(pickedPath);
      }

      // Other workers may have been parked waiting on this DMC to free up.
      notifyWorkers();
    }
  }
}

export async function startImageWatcher(log: (msg: string) => void): Promise<null> {
  if (state.running) return null;

  const cfg = getImageConfig();
  // Retry the path-access check with exponential backoff. If Docker hasn't
  // wired up the bind-mount yet (host just rebooted, very early startup),
  // the path returns ENOENT even though it will exist seconds later. The
  // previous behaviour was to give up and require a manual container
  // restart — now we wait it out.
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(cfg.incomingPath);
      log(`[images] incoming path accessible: ${cfg.incomingPath}`);
      break;
    } catch (err) {
      attempt++;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      log(
        `[images] incoming path not accessible (${cfg.incomingPath}): ` +
          `${(err as Error).message} — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const workerCount = Math.max(
    parseInt(process.env.IMAGE_WORKER_COUNT || '4', 10),
    1,
  );
  // Scan interval. Fast pollers (sub-second) make sense for the production
  // line where CV-X writes a frame every 1–3 seconds: we want any new file
  // moved within ~500 ms. Accepts decimal seconds (e.g. "0.5") via
  // IMAGE_SCAN_INTERVAL_SECONDS, OR IMAGE_SCAN_INTERVAL_MS for full
  // millisecond control. Floor of 250 ms to keep the event loop sane.
  const intervalSecondsEnv = process.env.IMAGE_SCAN_INTERVAL_SECONDS;
  const intervalMsEnv = process.env.IMAGE_SCAN_INTERVAL_MS;
  const parsedFromMs = intervalMsEnv ? parseFloat(intervalMsEnv) : NaN;
  const parsedFromSec = intervalSecondsEnv ? parseFloat(intervalSecondsEnv) * 1000 : NaN;
  const scanIntervalMs = Math.max(
    Number.isFinite(parsedFromMs) ? parsedFromMs : Number.isFinite(parsedFromSec) ? parsedFromSec : 500,
    250,
  );
  const watchdogMs =
    Math.max(parseInt(process.env.IMAGE_WATCHDOG_SECONDS || '120', 10), 30) * 1000;

  state.running = true;
  state.lastProcessedAt = Date.now();

  // Spawn N worker tasks. They share the pending Set; bounded concurrency.
  for (let i = 0; i < workerCount; i++) {
    state.workerPromises.push(workerLoop(i, log));
  }

  // Polling scan tick. Belt-and-braces: wrap in try/catch inside the
  // interval callback so a synchronous throw can't kill the timer, AND
  // track tick count + last-run timestamp so /admin/images/processor-state
  // can tell the operator instantly if the scan stalled.
  //
  // Re-entry guard: on a Windows bind-mount with thousands of session
  // folders, a single walk can take several seconds. Without this guard,
  // every 500 ms a new walk is queued and they all compete for I/O —
  // none ever finish. The guard skips a tick while a previous scan is
  // still running, so the next tick only fires after the prior completes.
  let scanInFlight = false;
  state.scanTimer = setInterval(() => {
    state.scanTickCount++;
    state.scanLastRunAt = Date.now();
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      scanIncomingOnce(log)
        .catch((err) => {
          state.scanLastErrorMsg = (err as Error).message;
          log(`[images] scan loop error: ${(err as Error).message}`);
        })
        .finally(() => { scanInFlight = false; });
    } catch (err) {
      scanInFlight = false;
      state.scanLastErrorMsg = (err as Error).message;
      log(`[images] scan tick threw synchronously: ${(err as Error).message}`);
    }
  }, scanIntervalMs);

  // Watchdog: monitors two failure modes.
  //  1. Workers stalled: pending > 0 but no progress for `watchdogMs`.
  //  2. Scan timer dead: scanLastRunAt hasn't advanced in 3× scanInterval.
  //     This actually happened in production — the setInterval mysteriously
  //     stopped firing, leaving workers idle while CV-X kept writing files.
  //     If we detect a dead timer, we clear+re-create it.
  state.watchdogTimer = setInterval(() => {
    const now = Date.now();

    // Mode 1: workers stalled.
    const workerIdle = now - state.lastProcessedAt;
    if (state.pending.size > 0 && workerIdle > watchdogMs) {
      log(
        `[images] WATCHDOG workers stalled ${Math.round(workerIdle / 1000)}s, ` +
          `pending=${state.pending.size}, in_flight=${state.inFlightPaths.size}, ` +
          `processed_total=${state.totalProcessed}, errors_total=${state.totalErrors}`,
      );
    }

    // Mode 2: scan timer dead. Recreate it.
    const scanIdle = state.scanLastRunAt > 0 ? now - state.scanLastRunAt : 0;
    if (scanIdle > scanIntervalMs * 3) {
      log(
        `[images] WATCHDOG scan timer dead (last tick ${Math.round(scanIdle / 1000)}s ago, ` +
          `total ticks=${state.scanTickCount}, last error=${state.scanLastErrorMsg}). Restarting timer.`,
      );
      if (state.scanTimer) clearInterval(state.scanTimer);
      state.scanTimer = setInterval(() => {
        state.scanTickCount++;
        state.scanLastRunAt = Date.now();
        try {
          scanIncomingOnce(log).catch((err) => {
            state.scanLastErrorMsg = (err as Error).message;
            log(`[images] scan loop error: ${(err as Error).message}`);
          });
        } catch (err) {
          state.scanLastErrorMsg = (err as Error).message;
          log(`[images] scan tick threw synchronously: ${(err as Error).message}`);
        }
      }, scanIntervalMs);
    }
  }, watchdogMs / 2);

  log(
    `[images] processor started (workers=${workerCount}, scan=${scanIntervalMs}ms, watchdog=${
      watchdogMs / 1000
    }s)`,
  );

  // Fire one scan immediately so startup doesn't wait the full interval.
  scanIncomingOnce(log).catch(() => undefined);
  return null;
}

// Compact image-watcher status for the /health endpoint. Distinct from
// getProcessorState() which is a verbose admin dump.
export function getImageWatcherStatus(): {
  running: boolean;
  path: string;
  lastFileAt: string | null;
  totalProcessed: number;
} {
  const cfg = getImageConfig();
  return {
    running: state.running,
    path: cfg.incomingPath,
    lastFileAt: state.lastProcessedAt > 0 ? new Date(state.lastProcessedAt).toISOString() : null,
    totalProcessed: state.totalProcessed,
  };
}

// Live snapshot of processor state, for the /admin/images/processor-state
// diagnostic. Returns counts (not the full Sets) so the response stays small.
export function getProcessorState(): {
  running: boolean;
  pending: number;
  pendingSample: string[];
  inFlightPaths: number;
  inFlightByDmc: number;
  noMatchTracked: number;
  parkedWorkers: number;
  totalProcessed: number;
  totalErrors: number;
  msSinceLastProcessed: number;
  scanTickCount: number;
  msSinceLastScan: number;
  scanLastError: string | null;
} {
  return {
    running: state.running,
    pending: state.pending.size,
    pendingSample: [...state.pending].slice(0, 5),
    inFlightPaths: state.inFlightPaths.size,
    inFlightByDmc: state.inFlightByDmc.size,
    noMatchTracked: state.noMatchCount.size,
    parkedWorkers: state.parkedResolvers.length,
    totalProcessed: state.totalProcessed,
    totalErrors: state.totalErrors,
    msSinceLastProcessed: state.lastProcessedAt > 0 ? Date.now() - state.lastProcessedAt : -1,
    scanTickCount: state.scanTickCount,
    msSinceLastScan: state.scanLastRunAt > 0 ? Date.now() - state.scanLastRunAt : -1,
    scanLastError: state.scanLastErrorMsg,
  };
}

export async function stopImageWatcher(): Promise<void> {
  state.running = false;
  if (state.scanTimer) {
    clearInterval(state.scanTimer);
    state.scanTimer = null;
  }
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
  // Wake up parked workers so they can observe running=false and exit.
  notifyWorkers();
  await Promise.allSettled(state.workerPromises);
  state.workerPromises = [];
  state.pending.clear();
  state.inFlightByDmc.clear();
  state.inFlightPaths.clear();
  state.noMatchCount.clear();
}
