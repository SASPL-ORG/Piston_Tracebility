import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  resolveMachineWindow,
  formatIstIso,
  MachineWindowInputs,
} from '../utils/machineWindow.js';
import { merge, clip, intersect, totalSeconds, Iv } from '../utils/intervals.js';
import { getOrComputeSWR } from '../utils/responseCache.js';

// ---- Config -----------------------------------------------------------------
// The PLC publishes three mutually-exclusive state bits (RUNNING / FAULT /
// IDLE) into dbo.Machine_State, now tagged per machine with Line_ID (1 = Machine
// 1, 2 = Machine 2). Each line is sequenced independently so the two machines
// never blend. ALARM_EXCLUDE hides pure status / "ready" signals from the alarm
// *detail* list only, without affecting the headline math.
const alarmExclude: Set<string> = (() => {
  const raw = process.env.ALARM_EXCLUDE;
  if (!raw) return new Set<string>();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

// Machine line -> Plant_Id used in dbo.vw_machine_parts. The parts view
// predates Line_ID and keys on the plant string, so we map the selector's
// line to its plant for the parts KPI.
const PLANT_BY_LINE: Record<number, string> = {
  1: 'IPL Ring Assembly Machine - 1',
  2: 'Sam Plant',
};

// Format a JS Date as a SQL Server naive-datetime string in IST wall-clock.
// The container runs TZ=Asia/Kolkata, and Machine_State.ts / PLC_Alarms.LogTime
// are written by SQL GETDATE() in IST wall-clock with NO timezone tag — so we
// must bind the window as a wall-clock string, not let the driver send UTC
// components (which would shift everything 5.5h). See machineStatus history.
function toIstSqlString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

// Inverse of the binding fix. A naive-IST datetime returned by the driver has
// its wall-clock components placed in the UTC slot of the JS Date; rebuild it
// as a local-TZ (IST) Date so .getTime() is the true IST instant — the same
// frame win.start / win.end live in.
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

// Past this gap from the last seen ts, an open segment stops being trusted as
// "still in that state" — the Idle bucket absorbs the unknown seconds.
const STATE_FRESHNESS_MS = 5 * 60 * 1000;

// ---- Repository (base tables, filtered per line) ----------------------------
interface StateRow { state: string; state_start: Date; state_end: Date | null }
interface AlarmRow { alarm: string; alarm_start: Date; alarm_end: Date | null }
interface PartsAgg { total: number; good: number }

// State segments for one machine. LEAD sequences that line's rows into
// [start, end) intervals; filtering by Line_ID BEFORE the window keeps each
// machine independent (no cross-machine blending).
async function getStateSegments(start: Date, end: Date, line: number): Promise<StateRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .input('line', line)
    .query(`
      WITH seg AS (
        SELECT state, ts, LEAD(ts) OVER (ORDER BY ts, id) AS next_ts
        FROM dbo.Machine_State WITH (NOLOCK)
        WHERE Line_ID = @line
      )
      SELECT state, ts AS state_start, next_ts AS state_end
      FROM seg
      WHERE ts < @end AND (next_ts IS NULL OR next_ts > @start)
      ORDER BY ts
    `);
  return r.recordset as StateRow[];
}

// Alarms for one machine — each ON paired with the next OFF of the same alarm
// on the same line (so an OFF from the other machine can't close it).
async function getAlarms(start: Date, end: Date, line: number): Promise<AlarmRow[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .input('line', line)
    .query(`
      SELECT alarm, alarm_start, alarm_end FROM (
        SELECT
          a.Alarm AS alarm,
          a.LogTime AS alarm_start,
          (SELECT TOP 1 o.LogTime FROM dbo.PLC_Alarms o WITH (NOLOCK)
             WHERE o.Alarm = a.Alarm AND o.Status = 'OFF'
               AND o.Line_ID = a.Line_ID AND o.LogTime >= a.LogTime
             ORDER BY o.LogTime ASC) AS alarm_end
        FROM dbo.PLC_Alarms a WITH (NOLOCK)
        WHERE a.Status = 'ON' AND a.Line_ID = @line
      ) x
      WHERE alarm_start < @end AND (alarm_end IS NULL OR alarm_end > @start)
    `);
  return r.recordset as AlarmRow[];
}

async function getPartsAgg(start: Date, end: Date, line: number): Promise<PartsAgg> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .input('plant', PLANT_BY_LINE[line])
    .query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN result = 'PASS' THEN 1 ELSE 0 END) AS good
      FROM dbo.vw_machine_parts
      WHERE completion_ts >= @start AND completion_ts < @end AND plant = @plant
    `);
  const row = r.recordset[0] ?? { total: 0, good: 0 };
  return { total: row.total ?? 0, good: row.good ?? 0 };
}

async function stateDataPresent(start: Date, end: Date, line: number): Promise<boolean> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('start', toIstSqlString(start))
    .input('end', toIstSqlString(end))
    .input('line', line)
    .query(`SELECT TOP 1 1 AS n FROM dbo.Machine_State WITH (NOLOCK)
            WHERE Line_ID = @line AND ts >= @start AND ts < @end`);
  return r.recordset.length > 0;
}

async function getLastStateTs(line: number): Promise<Date | null> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('line', line)
    .query(`SELECT MAX(ts) AS last_ts FROM dbo.Machine_State WITH (NOLOCK) WHERE Line_ID = @line`);
  return r.recordset[0]?.last_ts ?? null;
}

// ---- Response shape ---------------------------------------------------------
interface TopAlarmRow { alarm: string; occurrences: number; seconds: number }
interface SegmentRow { state: string; startMs: number; endMs: number }
interface StopRow { state: string; startMs: number; endMs: number; seconds: number }
interface Bucket { seconds: number; pct: number }

interface MachineTrack {
  line: number;
  stateSignalPresent: boolean;
  production: Bucket;
  machineHold: Bucket;
  idle: Bucket;
  down: Bucket;
  // How much of the window actually had per-line state data (prod+hold+idle),
  // and the full window length — so the UI can show coverage.
  monitoredSeconds: number;
  windowSeconds: number;
  partsProcessed: number;
  goodParts: number;
  topAlarms: TopAlarmRow[];
  // Chronological state band for the timeline, clipped to the window.
  segments: SegmentRow[];
  // Non-RUNNING periods — "when did the machine stop" — newest first.
  stops: StopRow[];
  invariantOk: boolean;
}

interface MachineStatusResponse {
  // startMs/endMs are the window's epoch bounds (IST instants) so the frontend
  // can position timeline segments exactly against the same frame.
  window: { from: string; to: string; totalSeconds: number; startMs: number; endMs: number };
  tracks: MachineTrack[];
  filtersIgnored?: boolean;
}

// Compute one machine's track (KPIs + timeline + stops) for the window.
async function computeTrack(line: number, win: { start: Date; end: Date }): Promise<MachineTrack> {
  const winMs: Iv = [win.start.getTime(), win.end.getTime()];
  const totalSec = totalSeconds([winMs]);

  const [segs, allAlarms, parts, signalPresent, lastStateTs] = await Promise.all([
    getStateSegments(win.start, win.end, line),
    getAlarms(win.start, win.end, line),
    getPartsAgg(win.start, win.end, line),
    stateDataPresent(win.start, win.end, line),
    getLastStateTs(line),
  ]);

  const winStartMs = win.start.getTime();
  const winEndMs = win.end.getTime();
  const lastStateMs = lastStateTs ? sqlDateToIstMs(lastStateTs) : null;
  const openSegmentEnd =
    lastStateMs !== null ? Math.min(winEndMs, lastStateMs + STATE_FRESHNESS_MS) : winEndMs;

  // Chronological, window-clipped segments for the timeline band.
  const segments: SegmentRow[] = [];
  for (const s of segs) {
    const rawStart = sqlDateToIstMs(s.state_start);
    const rawEnd = s.state_end ? sqlDateToIstMs(s.state_end) : openSegmentEnd;
    const cs = Math.max(rawStart, winStartMs);
    const ce = Math.min(rawEnd, winEndMs);
    if (ce > cs) segments.push({ state: s.state, startMs: cs, endMs: ce });
  }
  segments.sort((a, b) => a.startMs - b.startMs);

  // Per-state interval unions (defensive merge; states shouldn't overlap).
  const ivByState = (st: string): Iv[] =>
    merge(segments.filter((s) => s.state === st).map((s) => [s.startMs, s.endMs] as Iv));
  const runningIvs = ivByState('RUNNING');
  const faultIvs = ivByState('FAULT');

  // Each bucket is measured DIRECTLY from that line's state segments — not
  // "total - prod - hold". This matters because Line_ID only began populating
  // when Node-RED was updated, so a window can contain long stretches with NO
  // per-line data (e.g. before the cutover). Counting that unmonitored time as
  // idle would be wrong; instead we base percentages on the MONITORED time
  // (sum of the line's state segments) and expose how much of the window was
  // actually covered.
  const prodSec = totalSeconds(runningIvs);
  const holdSec = totalSeconds(faultIvs);
  const idleSec = totalSeconds(ivByState('IDLE'));
  const monitoredSec = prodSec + holdSec + idleSec;
  const downSec = holdSec + idleSec;
  const invariantOk = true;

  // Stops = every non-RUNNING segment, newest first, so the operator sees
  // exactly when (and how long) the machine was down. Sub-2s blips (the PLC
  // momentarily passing through IDLE between RUNNING and FAULT) are dropped
  // from the list — they're noise — but still drawn on the band.
  const stops: StopRow[] = segments
    .filter((s) => s.state !== 'RUNNING' && s.endMs - s.startMs >= 2000)
    .map((s) => ({ ...s, seconds: Math.round((s.endMs - s.startMs) / 1000) }))
    .sort((a, b) => b.startMs - a.startMs);

  // ---- Alarms-in-window breakdown (duration ON while the PLC was in FAULT).
  // Stuck-on background signals (ON since before the window) are dropped.
  const alarmsFiltered = allAlarms.filter((a) => !alarmExclude.has(a.alarm));
  const perAlarmIvs = new Map<string, { occurrences: number; ivs: Iv[] }>();
  for (const a of alarmsFiltered) {
    const start = sqlDateToIstMs(a.alarm_start);
    if (start < winStartMs) continue; // background / pre-existing signal
    const end = a.alarm_end ? sqlDateToIstMs(a.alarm_end) : winEndMs;
    const clipped = clip([[start, end] as Iv], winMs);
    if (clipped.length === 0) continue;
    const cur = perAlarmIvs.get(a.alarm) ?? { occurrences: 0, ivs: [] };
    cur.occurrences += 1;
    cur.ivs.push(...clipped);
    perAlarmIvs.set(a.alarm, cur);
  }
  const topAlarms: TopAlarmRow[] = Array.from(perAlarmIvs.entries())
    .map(([alarm, agg]) => {
      const overlap = intersect(merge(agg.ivs), faultIvs);
      let ms = 0;
      for (const [s, e] of overlap) ms += e - s;
      return { alarm, occurrences: agg.occurrences, seconds: Math.round(ms / 1000) };
    })
    .sort((a, b) => {
      if (b.seconds !== a.seconds) return b.seconds - a.seconds;
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      return a.alarm.localeCompare(b.alarm);
    });

  // Percentages are of MONITORED time so today's cutover (part of the window
  // has no per-line data) doesn't read as "96% idle".
  const denom = monitoredSec > 0 ? monitoredSec : 1;
  const pct = (n: number) => Math.round((n / denom) * 1000) / 10;
  return {
    line,
    stateSignalPresent: signalPresent,
    production: { seconds: prodSec, pct: pct(prodSec) },
    machineHold: { seconds: holdSec, pct: pct(holdSec) },
    idle: { seconds: idleSec, pct: pct(idleSec) },
    down: { seconds: downSec, pct: pct(downSec) },
    monitoredSeconds: monitoredSec,
    windowSeconds: totalSec,
    partsProcessed: parts.total,
    goodParts: parts.good,
    topAlarms,
    segments,
    stops,
    invariantOk,
  };
}

// Selector -> which machine lines to render. '1'/'2' pick one; anything else
// ('all' / 'both' / undefined) returns both machines, each dedicated.
function linesInScope(line: string | undefined): number[] {
  if (line === '1') return [1];
  if (line === '2') return [2];
  return [1, 2];
}

// ---- Route ------------------------------------------------------------------
export default async function machineStatusRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: MachineWindowInputs & { plant?: string; line?: string };
  }>('/machine-status', async (req) => {
    return getOrComputeSWR(req.url, 30_000, async () => {
      const win = resolveMachineWindow(req.query);
      const totalSec = totalSeconds([[win.start.getTime(), win.end.getTime()]]);
      const lines = linesInScope(req.query.line);

      if (totalSec <= 0) {
        const empty: MachineStatusResponse = {
          window: {
            from: formatIstIso(win.start),
            to: formatIstIso(win.end),
            totalSeconds: 0,
            startMs: win.start.getTime(),
            endMs: win.end.getTime(),
          },
          tracks: [],
          ...(win.filtersIgnored ? { filtersIgnored: true } : {}),
        };
        return empty;
      }

      const tracks = await Promise.all(lines.map((l) => computeTrack(l, win)));

      const response: MachineStatusResponse = {
        window: {
          from: formatIstIso(win.start),
          to: formatIstIso(win.end),
          totalSeconds: totalSec,
          startMs: win.start.getTime(),
          endMs: win.end.getTime(),
        },
        tracks,
        ...(win.filtersIgnored ? { filtersIgnored: true } : {}),
      };
      req.log.info(
        `[machine-status] from=${response.window.from} to=${response.window.to} ` +
          `lines=${lines.join(',')} tracks=${tracks.length}` +
          (win.filtersIgnored ? ' (shift/hour ignored, multi-day)' : ''),
      );
      return response;
    });
  });
}
