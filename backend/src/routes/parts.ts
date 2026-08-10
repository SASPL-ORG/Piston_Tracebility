import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import { classifyState, hasCirclipRejection, isRejectionReason, stripDmcSeparators, canonicalizeDmcScan, DMC_SEPARATOR_CHARS } from '../db/state.js';
import { getHideBeforeCached } from '../utils/hideState.js';
import { serializeDateTime, serializeDateTimeFields } from '../db/datetime.js';
import { renderPartTracePdf, deriveSerializedRecords } from '../reports/partTracePdf.js';
import type {
  AlarmEvent,
  AlarmStatus,
  EventTimelineStep,
  PartTraceResponse,
  SamLogRecord,
} from '../types/index.js';

// Internal-only widening of SamLogRecord so the timeline builder can
// read the NR-stamped rejection-reason columns (which we deliberately
// don't expose on the public SamLogRecord type — see types/index.ts).
type SamLogRowWithReason = SamLogRecord & {
  Circlip_Rejection_Reason?: string | null;
  Ring_Rejection_Reason?: string | null;
};

// A per-station completion event from dbo.Station_Events, captured live by
// Node-RED at the DMC-bearing checkpoint stations. The timeline uses station
// #6 (snap ring ASSEMBLY) — the one real checkpoint SAM_Log never recorded
// (SAM_Log only tracks the two inspections, load and unload). Empty for
// parts built before this capture existed, so the timeline degrades to its
// SAM_Log-only view.
interface StationEvent {
  timestamp: string | null;
  status: 'OK' | 'FAIL' | null;
  reason: string | null;
}

interface StationEventRow {
  Station_No: number;
  Event_Time: string | null;
  Result: string | null;
  Reason: string | null;
}

const RING_ASSEMBLY_SUBSTATIONS = [
  'Expander Ring',
  'Bottom Ring',
  'Bottom Rail Ring',
  'Second Ring',
  'Top Ring',
];

// Build the 13-event journey from the part's SAM_Log rows. Visibility
// rules come straight from event_timeline_brief.md:
//   - SAM_Log row exists                  → event 3
//   - earliest row has Circlip_Time       → events 4, 5, 6, 7
//   - event 7 = FAIL                      → event 8, stop
//   - latest row has Ring_Time            → events 9, 10, 11, 12, 13
//   - event 13 = FAIL                     → event 14, stop
//   - Unloading_Time set on latest row    → event 15
//
// Earliest row carries the loading + circlip data (Ring_Count 0 or 1);
// latest row carries the most recent ring + unload data. This handles
// re-inspections — only the final state appears at event 13.
function buildEventTimeline(
  records: SamLogRowWithReason[],
  stationEvents: Map<number, StationEvent>,
): EventTimelineStep[] {
  const timeline: EventTimelineStep[] = [];
  if (records.length === 0) return timeline;

  const earliest = records[0];
  const latest = records[records.length - 1];

  // Event 3 — always shown once SAM_Log has a row for the DMC.
  // Prefer the permanent Loading_Time (the actual load-scan moment); fall
  // back to Date_Time only for historical rows created before Loading_Time
  // existed, where Date_Time is the closest thing we have.
  timeline.push({
    step: 3,
    label: 'DMC 1 — Loading Scan',
    type: 'checkpoint',
    timestamp: earliest.Loading_Time ?? earliest.Date_Time,
    status: 'OK',
    reason: null,
  });

  // Snap-ring branch — gated on Circlip_Time being stamped.
  if (!earliest.Circlip_Time && !isRejectionReason(earliest.Circlip_Rejection_Reason)) return timeline;

  timeline.push({ step: 4, label: 'Anodizing Presence',         type: 'intermediate' });

  // Snap ring ASSEMBLY — the one station SAM_Log doesn't record. If Node-RED
  // logged a station-6 completion for this DMC, show its real timestamp +
  // pass/fail; otherwise fall back to a plain intermediate marker (historical
  // parts, or an in-progress part not yet past assembly).
  const assembly = stationEvents.get(6);
  if (assembly?.timestamp) {
    timeline.push({
      step: 5,
      label: 'Snap Ring Assembly',
      type: 'checkpoint',
      timestamp: assembly.timestamp,
      status: assembly.status === 'FAIL' ? 'FAIL' : 'OK',
      reason: assembly.status === 'FAIL' ? assembly.reason : null,
    });
  } else {
    timeline.push({ step: 5, label: 'Snap Ring Assembly', type: 'intermediate' });
  }

  timeline.push({ step: 6, label: 'DMC 2 — Vision Inspection Station — Snap Ring', type: 'intermediate' });

  // A rejection reason is a fail even when Circlip_Result was never written —
  // reasons raised before the inspection completes (recipe/barcode mismatch,
  // abnormal part, groove anodizing missing) stop the part with a NULL result.
  const circlipFail =
    earliest.Circlip_Result === 'FAIL' || isRejectionReason(earliest.Circlip_Rejection_Reason);
  timeline.push({
    step: 7,
    label: 'Snap Ring Inspection',
    type: 'checkpoint',
    timestamp: earliest.Circlip_Time,
    status: circlipFail ? 'FAIL' : 'OK',
    reason: circlipFail ? (earliest.Circlip_Rejection_Reason ?? null) : null,
  });

  if (circlipFail) {
    timeline.push({ step: 8, label: 'Snap Ring Rejection Conveyor', type: 'conditional' });
    return timeline;
  }

  // Ring branch — gated on the latest row having Ring_Time stamped.
  if (!latest.Ring_Time) return timeline;

  timeline.push({
    step: 10,
    label: 'Ring Assembly Station',
    type: 'intermediate',
    substations: RING_ASSEMBLY_SUBSTATIONS,
  });
  timeline.push({ step: 12, label: 'DMC3 — Barcode Scan', type: 'intermediate' });

  const ringFail =
    latest.Ring_Result === 'FAIL' || isRejectionReason(latest.Ring_Rejection_Reason);
  timeline.push({
    step: 13,
    label: 'Ring Inspection',
    type: 'checkpoint',
    timestamp: latest.Ring_Time,
    status: ringFail ? 'FAIL' : 'OK',
    reason: ringFail ? (latest.Ring_Rejection_Reason ?? null) : null,
    attempts: latest.Ring_Count ?? 1,
  });

  if (ringFail) {
    timeline.push({ step: 14, label: 'Ring Rejection Conveyor', type: 'conditional' });
    return timeline;
  }

  // Unloading — the part leaves the inspection cell (Unloading_Time stamped).
  if (latest.Unloading_Time) {
    timeline.push({
      step: 15,
      label: 'Unloading Time',
      type: 'checkpoint',
      timestamp: latest.Unloading_Time,
      status: 'OK',
      reason: null,
    });
  }

  // Packed = Unloading_Time stamped on the latest row.
  if (latest.Unloading_Time) {
    timeline.push({
      step: 16,
      label: 'Packing Station',
      type: 'checkpoint',
      timestamp: latest.Unloading_Time,
      status: 'COMPLETED',
      reason: null,
    });
  }

  return timeline;
}

interface PartParams {
  dmc: string;
}

async function fetchPartRecords(dmc: string): Promise<SamLogRecord[]> {
  const pool = await getPool();
  const order = 'ORDER BY ISNULL(Ring_Count, 0) ASC, Date_Time ASC';

  // "Demo hide" cutoff — while active, a part dated before the cutoff reads as
  // not-found here (→ 404), keeping Part Trace consistent with the hidden
  // Dashboard/Lists. Validated 'YYYY-MM-DD HH:mm:ss' so the literal is safe.
  const hideBefore = getHideBeforeCached();
  const hide = hideBefore ? ` AND Date_Time >= '${hideBefore}'` : '';

  // Fast path: exact match on the indexed DMC column. Part Trace passes the
  // stored key verbatim, so this is the common case and stays sargable.
  const exact = await pool
    .request()
    .input('dmc', dmc)
    .query(`SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc${hide} ${order}`);
  if (exact.recordset.length > 0) return exact.recordset as SamLogRecord[];

  // Fast path: rebuild the canonical stored key from a raw scan and exact-match
  // the indexed DMC column, before the non-sargable separator-insensitive scan.
  const canonical = canonicalizeDmcScan(dmc);
  if (canonical && canonical !== dmc) {
    const canon = await pool
      .request()
      .input('dmc', canonical)
      .query(`SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc${hide} ${order}`);
    if (canon.recordset.length > 0) return canon.recordset as SamLogRecord[];
  }

  // Fallback: separator-insensitive match. A packing-station scan arrives as
  // the raw ISO/IEC 15434 envelope (control bytes intact) while the stored key
  // has those separators rewritten to '.'/'-', so the exact match above misses.
  // We reduce BOTH sides to their separator-free core (the SQL TRANSLATE here
  // mirrors stripDmcSeparators / normalizeScannedDmc) and compare. TRANSLATE
  // maps every separator to CHAR(1), which REPLACE then strips. This is a
  // non-sargable full scan, but packing lookups are one-at-a-time and only
  // reach this path after the indexed lookup found nothing.
  const norm = stripDmcSeparators(dmc);
  if (!norm) return [];
  const reduced = await pool
    .request()
    .input('norm', norm)
    .input('seps', DMC_SEPARATOR_CHARS)
    .query(
      `SELECT * FROM dbo.SAM_Log
       WHERE REPLACE(TRANSLATE(DMC, @seps, REPLICATE(CHAR(1), LEN(@seps))), CHAR(1), '') = @norm${hide}
       ${order}`,
    );
  return reduced.recordset as SamLogRecord[];
}

// Loads the live per-station completion events for this part (dbo.Station_Events,
// written by Node-RED). Keyed by the stored DMC, which matches SAM_Log.DMC
// exactly (same `]>.`-prefixed value). Returns a map station_no → latest event;
// a later Id wins so re-runs resolve to the most recent completion. Station_Events
// is optional infrastructure: a missing table or query error degrades to an empty
// map (SAM_Log-only timeline) rather than failing the whole Part Trace.
async function fetchStationEvents(
  dmc: string | null | undefined,
): Promise<Map<number, StationEvent>> {
  const map = new Map<number, StationEvent>();
  if (!dmc) return map;
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('dmc', dmc)
      .query(
        `SELECT Station_No, Event_Time, Result, Reason
         FROM dbo.Station_Events WHERE DMC = @dmc ORDER BY Id ASC`,
      );
    for (const r of result.recordset as StationEventRow[]) {
      map.set(r.Station_No, {
        // Event_Time is a server wall-clock string ('YYYY-MM-DD HH:mm:ss');
        // the frontend's formatDateTime accepts the space separator as-is.
        timestamp: r.Event_Time ?? null,
        status: r.Result == null ? null : r.Result === 'OK' ? 'OK' : 'FAIL',
        reason: r.Reason ?? null,
      });
    }
  } catch {
    // swallow — see note above.
  }
  return map;
}

// Loads PLC alarm edge events for this part. BatchID column on PLC_Alarms
// carries the DMC of whatever piston was active when the alarm fired.
async function fetchPartAlarms(dmc: string): Promise<AlarmEvent[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('dmc', dmc)
    .query(
      'SELECT ID, LogTime, Alarm, Status FROM dbo.PLC_Alarms WHERE BatchID = @dmc ORDER BY LogTime ASC',
    );
  return result.recordset.map((r: { ID: number; LogTime: Date | null; Alarm: string; Status: string }) => ({
    id: r.ID,
    logTime: serializeDateTime(r.LogTime),
    alarm: r.Alarm,
    status: (r.Status === 'ON' ? 'ON' : 'OFF') as AlarmStatus,
  }));
}

function sanitizeForFilename(s: string): string {
  // Filenames can't contain Windows-illegal chars; collapse anything funky to `_`.
  return s.replace(/[<>:"|?*\\/\s]/g, '_').slice(0, 80);
}

export default async function partRoutes(app: FastifyInstance) {
  app.get<{ Params: PartParams }>('/part/:dmc', async (req, reply) => {
    const { dmc } = req.params;
    // Run both queries in parallel — the alarms lookup is independent of the
    // SAM_Log records and shouldn't sit behind it.
    const [records, alarms] = await Promise.all([
      fetchPartRecords(dmc),
      fetchPartAlarms(dmc),
    ]);

    if (records.length === 0) {
      reply.status(404);
      return { error: `No records found for DMC: ${dmc}` };
    }

    // Per-station events are keyed by the STORED DMC (records[0].DMC), which
    // matches Station_Events exactly — the request param may be a raw scan that
    // only matched via the separator-insensitive fallback.
    const stationEvents = await fetchStationEvents(records[0].DMC);

    serializeDateTimeFields(records as unknown as Record<string, unknown>[]);
    const lastRow = records[records.length - 1];
    const hasCirclipFail = hasCirclipRejection(records);
    const totalAttempts = records.reduce(
      (max, r) => Math.max(max, r.Ring_Count ?? 0),
      0,
    );
    // Snap-ring re-inspection is recorded by incrementing Circlip_Count on
    // the same row (the FAIL is overwritten by the eventual PASS), so it
    // does NOT add rows the way ring attempts do. Detect it separately, or
    // a part re-inspected only at the snap-ring station shows "Reinspected:
    // No" while its Circlip_Count sits at 8.
    const maxCirclipCount = records.reduce(
      (max, r) => Math.max(max, (r as SamLogRowWithReason & { Circlip_Count?: number | null }).Circlip_Count ?? 0),
      0,
    );
    const reinspected = totalAttempts > 1 || maxCirclipCount > 1;

    // For a reinspected part, the PLC only writes Circlip_Result/Time on
    // the first row; subsequent re-attempt rows have NULL there. The UI's
    // "Current State" panel reads from `latest`, so without this merge the
    // Circlip Status would show as blank for any reinspected part.
    //
    // Prefer a PASS row over a FAIL row when both exist — for a part
    // saved by snap-ring reinspection we display the PASS that saved
    // it (and its timestamp), not the original FAIL. Falls back to any
    // non-null Circlip row when no PASS row exists. Mirrors the
    // ROW_NUMBER ordering in backend/src/routes/lists.ts so the two
    // pages agree.
    const circlipRow =
      records.find((r) => r.Circlip_Result === 'PASS') ??
      records.find((r) => r.Circlip_Result !== null);
    const latest = {
      ...lastRow,
      Circlip_Result: lastRow.Circlip_Result ?? circlipRow?.Circlip_Result ?? null,
      Circlip_Time: lastRow.Circlip_Time ?? circlipRow?.Circlip_Time ?? null,
    };

    const event_timeline = buildEventTimeline(records as SamLogRowWithReason[], stationEvents);
    req.log.info(`[part-trace] dmc=${dmc} → ${event_timeline.length} events in timeline`);

    const response: PartTraceResponse = {
      dmc,
      total_records: records.length,
      records,
      summary: {
        state: classifyState(latest, hasCirclipFail),
        total_attempts: totalAttempts,
        reinspected,
        latest,
        // "First seen" = when the part was loaded onto the line. Prefer the
        // permanent Loading_Time; fall back to the earliest row's Date_Time
        // for pre-feature parts (where Date_Time was later overwritten, so
        // it's only an approximation).
        first_seen: records[0].Loading_Time ?? records[0].Date_Time,
        last_seen: latest.Date_Time,
      },
      alarms,
      event_timeline,
    };
    return response;
  });

  // PDF report — same data set, server-rendered with pdfkit. Streams.
  app.get<{ Params: PartParams }>('/part/:dmc/report.pdf', async (req, reply) => {
    const { dmc } = req.params;
    const rawRecords = await fetchPartRecords(dmc);

    if (rawRecords.length === 0) {
      reply.status(404);
      return { error: `No records found for DMC: ${dmc}` };
    }

    const records = deriveSerializedRecords(rawRecords as unknown as Record<string, unknown>[]);
    const filename = `part-trace-${sanitizeForFilename(dmc)}-${new Date().toISOString().slice(0, 10)}.pdf`;
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(renderPartTracePdf({ dmc, records }));
  });
}
