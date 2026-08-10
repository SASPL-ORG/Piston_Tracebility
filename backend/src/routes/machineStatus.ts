import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  resolveMachineWindow,
  formatIstIso,
  MachineWindowInputs,
} from '../utils/machineWindow.js';
import { merge, clip, intersect, totalSeconds, Iv } from '../utils/intervals.js';
import { cacheReads } from '../utils/responseCache.js';

// ---- Config -----------------------------------------------------------------
// The PLC publishes three mutually-exclusive state bits, so the cards
// derive directly from `dbo.vw_machine_state` — no cycle-time estimate
// and no alarm-overlap inference. ALARM_EXCLUDE stays for the alarm
// *detail* list only ("alarms active during faults") so the engineer
// can hide pure status / "ready" signals from the diagnostic table
// without affecting the headline math.
const alarmExclude: Set<string> = (() => {
  const raw = process.env.ALARM_EXCLUDE;
  if (!raw) return new Set<string>();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

// Format a JS Date as a SQL Server naive-datetime string in IST
// wall-clock. The container runs TZ=Asia/Kolkata (see docker-compose.yml)
// so getFullYear()/getMonth()/… return IST components directly.
//
// Why this exists: dbo.Machine_State.ts and dbo.SAM_Log.Date_Time are
// both written by SQL GETDATE() / Node-RED in IST wall-clock with NO
// timezone tag. The tedious driver, given a JS Date, sends it using
// UTC components — comparing IST-stored data against a UTC-binding
// shifts everything by 5.5h and misses rows that should be in the
// window. db/state.ts already binds the SAM_Log filters as strings
// (`${date} 07:00:00`), which is why the parts query works; this
// helper brings the state / alarm / parts queries onto the same
// driver-independent footing. See machine_status_fix_state_window.md.
function toIstSqlString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

// Inverse of the binding fix above. When SQL returns a naive IST
// datetime (Machine_State.ts, vw_machine_state.state_start, etc.) the
// mssql driver places the wall-clock components in the UTC slot of the
// JS Date — so a row at "15:35:42 IST" comes back as a Date whose
// .getTime() is the epoch for "15:35:42 UTC" (5.5h in the future).
// Reconstruct as a local-TZ Date (container is Asia/Kolkata) so
// .getTime() returns the true IST instant — same frame win.start /
// win.end already live in.
function sqlDateToIstMs(d: Date): number {
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ).getTime();
}

// ---- Repository -------------------------------------------------------------
// Reads only the views called out in the brief — never the raw tables.
// The one exception is `Machine_State` itself for the "any rows in
// window?" presence probe (the view doesn't expose that signal cleanly).
interface StateRow { state: string; state_start: Date; state_end: Date | null }
interface AlarmRow { alarm: string; alarm_start: Date; alarm_end: Date | null }
interface PartsAgg { total: number; good: number }

async function getStateSegments(start: Date, end: Date): Promise<StateRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .query(`
      SELECT state, state_start, state_end
      FROM dbo.vw_machine_state
      WHERE state_start < @end
        AND (state_end IS NULL OR state_end > @start)
    `);
  return r.recordset as StateRow[];
}

async function getAlarms(start: Date, end: Date): Promise<AlarmRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .query(`
      SELECT alarm, alarm_start, alarm_end
      FROM dbo.vw_machine_alarms
      WHERE alarm_start < @end
        AND (alarm_end IS NULL OR alarm_end > @start)
    `);
  return r.recordset as AlarmRow[];
}

async function getPartsAgg(start: Date, end: Date, plant: string | undefined): Promise<PartsAgg> {
  const pool = await getPool();
  const req = pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end));
  let plantClause = '';
  if (plant) {
    req.input('plant', plant);
    plantClause = ' AND plant = @plant';
  }
  const r = await req.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result = 'PASS' THEN 1 ELSE 0 END) AS good
    FROM dbo.vw_machine_parts
    WHERE completion_ts >= @start AND completion_ts < @end${plantClause}
  `);
  const row = r.recordset[0] ?? { total: 0, good: 0 };
  return { total: row.total ?? 0, good: row.good ?? 0 };
}

// "Has the PLC + NR ever written a state row inside this window?"
// Drives the no-signal banner. We probe the base table because the
// view filters out gaps — a window with NO data at all yields zero
// rows in the view too, which is indistinguishable from "PLC offline".
async function stateDataPresent(start: Date, end: Date): Promise<boolean> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .query(`SELECT TOP 1 1 AS n FROM dbo.Machine_State WHERE ts >= @start AND ts < @end`);
  return r.recordset.length > 0;
}

// Most recent ts in Machine_State across all time. Used to clamp the
// natural forward-extension of open segments (state_end IS NULL) — if
// no new state row has been written for too long, the line's stream
// has gone silent and we shouldn't keep crediting the last-known state
// indefinitely.
async function getLastStateTs(): Promise<Date | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .query(`SELECT MAX(ts) AS last_ts FROM dbo.Machine_State`);
  return r.recordset[0]?.last_ts ?? null;
}

// Past this gap from the last seen ts, an open segment stops being
// trusted as "still in that state" — the Idle bucket absorbs the
// unknown seconds, per brief: "idle absorbs logging gaps + power-off".
// 5 minutes is generous given that the live data shows transitions
// every ~90 seconds during normal operation.
const STATE_FRESHNESS_MS = 5 * 60 * 1000;

// ---- Response shape ---------------------------------------------------------
interface TopAlarmRow {
  alarm: string;
  occurrences: number;
  seconds: number;
}
interface MachineStatusResponse {
  window: { from: string; to: string; totalSeconds: number };
  stateSignalPresent: boolean;
  production: { seconds: number; pct: number };
  machineHold: { seconds: number; pct: number };
  idle: { seconds: number; pct: number };
  down: { seconds: number; pct: number };
  partsProcessed: number;
  goodParts: number;
  topAlarms: TopAlarmRow[];
  invariantOk: boolean;
  filtersIgnored?: boolean;
}

// ---- Route ------------------------------------------------------------------
export default async function machineStatusRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: MachineWindowInputs & { plant?: string };
  }>('/machine-status', { preHandler: cacheReads(30_000) }, async (req) => {
    const win = resolveMachineWindow(req.query);
    const winMs: Iv = [win.start.getTime(), win.end.getTime()];
    const totalSec = totalSeconds([winMs]);

    // Zero-length / future-only window: respond cleanly without
    // hitting the database.
    if (totalSec <= 0) {
      const empty: MachineStatusResponse = {
        window: { from: formatIstIso(win.start), to: formatIstIso(win.end), totalSeconds: 0 },
        stateSignalPresent: false,
        production:  { seconds: 0, pct: 0 },
        machineHold: { seconds: 0, pct: 0 },
        idle:        { seconds: 0, pct: 0 },
        down:        { seconds: 0, pct: 0 },
        partsProcessed: 0,
        goodParts: 0,
        topAlarms: [],
        invariantOk: true,
        ...(win.filtersIgnored ? { filtersIgnored: true } : {}),
      };
      req.log.info(`[machine-status] empty window from=${empty.window.from} to=${empty.window.to}`);
      return empty;
    }

    // Temporary debug log (per machine_status_fix_state_window.md) so the
    // bound @start/@end + the stateDataPresent result are visible while
    // confirming the IST wall-clock binding fix. Remove once verified.
    req.log.info(
      `[machine-status] bind @start='${toIstSqlString(win.start)}' @end='${toIstSqlString(win.end)}'`,
    );

    const [segs, allAlarms, parts, signalPresent, lastStateTs] = await Promise.all([
      getStateSegments(win.start, win.end),
      getAlarms(win.start, win.end),
      getPartsAgg(win.start, win.end, req.query.plant),
      stateDataPresent(win.start, win.end),
      getLastStateTs(),
    ]);

    // Cap any open segment's natural extension at lastStateTs + freshness
    // window. If the PLC stopped emitting hours ago, an open IDLE/RUNNING
    // segment from then-and-there shouldn't keep crediting state to the
    // current window — that gap is "signal lost" and folds into Idle.
    const winEndMsForClamp = win.end.getTime();
    const lastStateMs = lastStateTs ? sqlDateToIstMs(lastStateTs) : null;
    const openSegmentEnd =
      lastStateMs !== null
        ? Math.min(winEndMsForClamp, lastStateMs + STATE_FRESHNESS_MS)
        : winEndMsForClamp;

    req.log.info(
      `[machine-status] state rows fetched: segs=${segs.length} signalPresent=${signalPresent} ` +
        `lastStateMs=${lastStateMs ?? 'null'} openSegmentEnd=${openSegmentEnd}`,
    );

    // Build per-state interval lists: each segment clipped to the
    // window, NULL state_end clamped to window end. Then per-state
    // union via merge so overlapping segments (shouldn't happen, but
    // costs nothing to defend against) don't double-count.
    //
    // sqlDateToIstMs converts the naive-IST Date the driver returns
    // into a real IST instant — without this, every segment looks
    // 5.5h in the future and falls outside the window.
    const winEndMs = win.end.getTime();
    const ivByState = (st: string): Iv[] => {
      const raw: Iv[] = segs
        .filter((s) => s.state === st)
        .map((s) => [
          sqlDateToIstMs(s.state_start),
          // Closed segment: use its real state_end.
          // Open segment (state_end IS NULL): extend to openSegmentEnd,
          // which is capped at lastStateTs+freshness so a stale stream
          // doesn't fake state seconds into the present.
          s.state_end ? sqlDateToIstMs(s.state_end) : openSegmentEnd,
        ] as Iv);
      return clip(merge(raw), winMs);
    };

    const runningIvs = ivByState('RUNNING');
    const faultIvs   = ivByState('FAULT');
    const idleIvs    = ivByState('IDLE');

    const prodSec = totalSeconds(runningIvs);
    const holdSec = totalSeconds(faultIvs);
    // Idle = the state's own intervals PLUS any unaccounted gap
    // (logging dropouts, PLC offline, power off). Computing it as
    // `total - prod - hold` rather than summing IDLE segments lets
    // those gaps fold into Idle, per brief.
    const stateIdleSec = totalSeconds(idleIvs);
    const idleSec = Math.max(0, totalSec - prodSec - holdSec);
    const downSec = holdSec + idleSec;

    // Invariant — overlapping states (PLC bug) would show as negative
    // raw idleSec before the Math.max clamp. Surface it without
    // breaking the response.
    const invariantOk = totalSec - prodSec - holdSec >= -1;
    if (!invariantOk) {
      req.log.warn(
        `[machine-status] state overlap detected: total=${totalSec} prod=${prodSec} hold=${holdSec} stateIdle=${stateIdleSec}`,
      );
    }

    // ---- Alarms-in-window breakdown ----
    //
    // For each alarm that transitioned ON within this window, show:
    //  - occurrences = number of fresh ON events
    //  - seconds     = time during which that alarm was ON AND the PLC
    //                  was reporting FAULT (union of alarm intervals ∩
    //                  union of fault intervals)
    //
    // Stuck-on background signals are filtered out by checking
    // alarm.start < window.start — those are status flags that have been
    // ON since before the window began (e.g. CONTROL NOT ON, EXPANDER STN
    // - NOT READY TO ASSEMBLY). They're "active" during every fault
    // because they're "active" always; including them made every fault
    // second get credited to a dozen signals at once. By contrast a real
    // alarm that pulses ON inside the window has a fresh start time and
    // shows up correctly with its actual contribution.
    //
    // We do NOT use a triggering-only attribution here — that was too
    // restrictive. If two alarms fired during overlapping fault windows,
    // both deserve credit for the time they were each ON during fault.
    // Sums across distinct alarms can therefore exceed total Machine /
    // Alarm hold when alarms genuinely overlap each other; that's
    // expected and explained in the page subtitle.
    const winStartMs = win.start.getTime();
    const alarmsFiltered = allAlarms.filter((a) => !alarmExclude.has(a.alarm));
    const alarmIntervals = alarmsFiltered.map((a) => ({
      alarm: a.alarm,
      start: sqlDateToIstMs(a.alarm_start),
      end: a.alarm_end ? sqlDateToIstMs(a.alarm_end) : winEndMs,
    }));

    const perAlarmIvs = new Map<string, { occurrences: number; ivs: Iv[] }>();
    for (const a of alarmIntervals) {
      // Stuck-on guard: only count occurrences whose ON-transition lies
      // within the window. Pre-existing ON states (alarm rows whose
      // alarm_start predates the window) are background signals, not
      // events — they get dropped here.
      if (a.start < winStartMs) continue;
      const clipped = clip([[a.start, a.end] as Iv], winMs);
      if (clipped.length === 0) continue;
      const cur = perAlarmIvs.get(a.alarm) ?? { occurrences: 0, ivs: [] };
      cur.occurrences += 1;
      cur.ivs.push(...clipped);
      perAlarmIvs.set(a.alarm, cur);
    }

    const perAlarm = new Map<string, { occurrences: number; seconds: number }>();
    for (const [name, agg] of perAlarmIvs) {
      const overlap = intersect(merge(agg.ivs), faultIvs);
      let ms = 0;
      for (const [s, e] of overlap) ms += (e - s);
      perAlarm.set(name, {
        occurrences: agg.occurrences,
        seconds: Math.round(ms / 1000),
      });
    }
    // Sort by duration in fault desc; ties broken by occurrence count
    // (an alarm that fired 10 times but accumulated 0 fault seconds
    // still ranks above one with 0 occurrences) then by name for
    // deterministic output.
    const topAlarms: TopAlarmRow[] = Array.from(perAlarm.entries())
      .map(([alarm, v]) => ({ alarm, occurrences: v.occurrences, seconds: v.seconds }))
      .sort((a, b) => {
        if (b.seconds !== a.seconds) return b.seconds - a.seconds;
        if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
        return a.alarm.localeCompare(b.alarm);
      });

    const pct = (n: number) => Math.round((n / totalSec) * 1000) / 10;

    const response: MachineStatusResponse = {
      window: { from: formatIstIso(win.start), to: formatIstIso(win.end), totalSeconds: totalSec },
      stateSignalPresent: signalPresent,
      production:  { seconds: prodSec, pct: pct(prodSec) },
      machineHold: { seconds: holdSec, pct: pct(holdSec) },
      idle:        { seconds: idleSec, pct: pct(idleSec) },
      down:        { seconds: downSec, pct: pct(downSec) },
      partsProcessed: parts.total,
      goodParts: parts.good,
      topAlarms,
      invariantOk,
      ...(win.filtersIgnored ? { filtersIgnored: true } : {}),
    };

    req.log.info(
      `[machine-status] from=${response.window.from} to=${response.window.to} ` +
        `total=${totalSec}s prod=${prodSec}s hold=${holdSec}s idle=${idleSec}s down=${downSec}s ` +
        `parts=${parts.total} signal=${signalPresent} alarmsInFault=${topAlarms.length}` +
        (win.filtersIgnored ? ' (shift/hour ignored, multi-day)' : ''),
    );
    return response;
  });
}
