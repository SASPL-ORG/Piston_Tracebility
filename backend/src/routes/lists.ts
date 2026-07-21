import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  bindProductionDayFilterInputs,
  buildLatestPerDmcCte,
  STATE_CASE_SQL,
  STATE_CASE_SQL_DISPLAY,
  PACKED_LOG_JOIN_SQL,
} from '../db/state.js';
import { cacheReads } from '../utils/responseCache.js';
import { serializeDateTimeFields } from '../db/datetime.js';
import type {
  ListFailureItem,
  ListFailuresResponse,
  ListSummaryEntry,
  ListSummaryResponse,
  PaginatedResponse,
  PartListItem,
} from '../types/index.js';

// Shift → time-of-day window in minutes-of-day. Mirrors the frontend
// SHIFT_PRESETS in src/pages/Lists.tsx and the SHIFT_CASE_SQL boundaries
// in db/state.ts. Used by /lists/failures to translate shift=A|B|C|all
// into the same hour filter the Lists table uses.
const SHIFT_WINDOWS: Record<'A' | 'B' | 'C', { fromMin: number; toMin: number }> = {
  A: { fromMin: 7 * 60,        toMin: 15 * 60 + 30 },  // 07:00 – 15:30
  B: { fromMin: 15 * 60 + 31,  toMin: 23 * 60 + 59 },  // 15:31 – 23:59
  C: { fromMin: 0,             toMin: 6 * 60 + 59 },   // 00:00 – 06:59
};

// Sort whitelist — these are columns on the latest row plus derived columns.
// The values map to the SQL column name in the inner SELECT.
const SORT_COLUMNS: Record<string, string> = {
  Date_Time: 'Date_Time',
  Plant_Id: 'Plant_Id',
  DMC: 'DMC',
  Circlip_Result: 'Circlip_Result',
  Circlip_Time: 'Circlip_Time',
  Ring_Result: 'Ring_Result',
  Ring_Time: 'Ring_Time',
  Ring_Count: 'Ring_Count',
  Unloading_Time: 'Unloading_Time',
  Result: 'Result',
  state: 'state',
  total_attempts: 'total_attempts',
  reinspected: 'reinspected',
};

interface ListQuery {
  type?: string;
  from?: string;
  to?: string;
  plant?: string;
  page?: string;
  size?: string;
  sort?: string;
  order?: string;
  search?: string;
  // Column-level filters (comma-separated). Empty / omitted = no filter.
  // state — one or more of the PartState enum values.
  state?: string;
  // circlip / ring — 'PASS' | 'FAIL' | 'BLANK' (NULL).
  circlip?: string;
  ring?: string;
  // Hour-of-day window — HH:mm strings. When both are set, narrows the
  // per-DMC result to parts whose latest row's time-of-day is in
  // [time_from, time_to] (inclusive). Composes with the date range so
  // e.g. From=2026-06-16 To=2026-06-16 time_from=08:00 time_to=10:00
  // means "parts produced on 16-Jun between 8 and 10 AM".
  // Shift selection on the UI is just a preset that fills these inputs.
  time_from?: string;
  time_to?: string;
}

// HH:mm -> minute-of-day. Returns null on bad input (treat as no filter).
function parseHourMin(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

// Outer-WHERE fragment for the hour-of-day window. The column arg lets
// callers point this at either the projected `Date_Time` (Lists outer
// WHERE) or the qualified `l.Date_Time` (Summary, which queries the
// CTE directly without classifiedSelect wrapping).
function buildTimeOfDayWhere(
  timeFrom: string | undefined,
  timeTo: string | undefined,
  col: string = 'Date_Time',
): string {
  const fromMin = parseHourMin(timeFrom);
  const toMin = parseHourMin(timeTo);
  if (fromMin === null && toMin === null) return '1 = 1';
  const expr = `(DATEPART(HOUR, ${col}) * 60 + DATEPART(MINUTE, ${col}))`;
  const parts: string[] = [];
  if (fromMin !== null) parts.push(`${expr} >= ${fromMin}`);
  if (toMin !== null) parts.push(`${expr} <= ${toMin}`);
  return `(${parts.join(' AND ')})`;
}

// Same bucket priority as the Dashboard's KPI partitioning — every DMC
// falls into EXACTLY one bucket, so summing the rows of the summary
// matrix equals "Total Parts" for the same filters. Identity:
//   total = passed + circlip_fail + ring_fail + in_progress
//         + circlip_reinspected + ring_reinspected
const SUMMARY_BUCKET_CASE = `CASE
  WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 'in_progress'
  WHEN ${STATE_CASE_SQL} = 'CIRCLIP_SCRAP' THEN 'circlip_fail'
  WHEN ${STATE_CASE_SQL} = 'RING_NG' THEN 'ring_fail'
  WHEN p.has_circlip_fail = 1 AND p.has_circlip_pass = 1 THEN 'circlip_reinspected'
  WHEN p.max_ring_count > 1 AND l.Ring_Result = 'PASS' THEN 'ring_reinspected'
  ELSE 'passed'
END`;

function buildTypeWhere(type: string | undefined): string {
  switch (type) {
    case 'passed':
      return "state IN ('PACKED','RING_OK')";
    case 'packed':
      return "state = 'PACKED'";
    case 'circlip_scrap':
      return "state = 'CIRCLIP_SCRAP'";
    case 'ring_rejected':
      return "state = 'RING_NG'";
    case 'in_progress':
      return "state = 'IN_PROGRESS'";
    // Re-Inspection = parts ultimately SAVED by either snap-ring OR ring
    // re-inspection. Union covers both flavors; parts that needed
    // re-inspection but still failed end up under ring_rejected /
    // circlip_scrap, not here.
    case 'reinspected':
      return "(state IN ('PACKED','RING_OK') AND (total_attempts > 1 OR (has_circlip_fail = 1 AND has_circlip_pass = 1)))";
    default:
      return '1 = 1';
  }
}

// Build a SQL WHERE fragment for a column-level filter. The selected
// values are validated against an allow-list to keep the SQL injection
// surface zero — the result is a literal IN(...) clause.
function buildInClause(
  column: string,
  raw: string | undefined,
  allowed: readonly string[],
): string {
  if (!raw) return '1 = 1';
  const picks = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const safe = picks.filter((p) => (allowed as readonly string[]).includes(p));
  if (safe.length === 0) return '1 = 1';
  const literal = safe.filter((v) => v !== 'BLANK').map((v) => `'${v}'`).join(',');
  const wantsBlank = safe.includes('BLANK');
  const parts: string[] = [];
  if (literal) parts.push(`${column} IN (${literal})`);
  if (wantsBlank) parts.push(`${column} IS NULL`);
  return `(${parts.join(' OR ')})`;
}

const STATE_VALUES = ['PACKED', 'COMPLETED', 'RING_OK', 'RING_NG', 'CIRCLIP_SCRAP', 'IN_PROGRESS'] as const;
const RESULT_VALUES = ['PASS', 'FAIL', 'BLANK'] as const;

function buildBaseCte(query: ListQuery, request: import('mssql').Request): string {
  // Same production-day window as the Dashboard so the two pages report
  // identical counts for the same date filter. A "date" in the URL maps
  // to [date 07:00, (date+1) 07:00) — Shift A start to next Shift A start.
  const conds = bindProductionDayFilterInputs(request, query);
  if (query.search) {
    conds.push('DMC LIKE @search');
    request.input('search', `%${query.search}%`);
  }
  return buildLatestPerDmcCte(conds);
}

function classifiedSelect(): string {
  // Snap Ring column semantics — follows the part's final state, not
  // the raw PLC stamp:
  //
  //   PACKED / RING_OK     → 'PASS'  (part is operationally OK,
  //                                   regardless of whether reinspection
  //                                   or operator override was used)
  //   CIRCLIP_SCRAP        → 'FAIL'  (part was scrapped for snap ring)
  //   RING_NG / IN_PROGRESS → whatever the PLC stamped (recovered to
  //                                   prefer PASS over FAIL when both
  //                                   exist), or '-' if no stamp yet
  //
  // Recovery values (has_circlip_pass / first_pass_circlip_time / ...)
  // come from per_dmc, computed in the same aggregate pass that already
  // produces has_circlip_fail / max_ring_count. No extra join, no extra
  // sort — the LEFT JOIN + ROW_NUMBER() shape used to be here was the
  // main bottleneck at scale and is gone now.
  return `(
    SELECT
      l.Date_Time, l.Plant_Id, l.DMC,
      CASE
        WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 'PASS'
        WHEN ${STATE_CASE_SQL} = 'CIRCLIP_SCRAP' THEN 'FAIL'
        ELSE COALESCE(
          l.Circlip_Result,
          CASE
            WHEN p.has_circlip_pass = 1 THEN 'PASS'
            WHEN p.has_circlip_fail = 1 THEN 'FAIL'
            ELSE NULL
          END
        )
      END AS Circlip_Result,
      COALESCE(l.Circlip_Time, p.first_pass_circlip_time, p.first_fail_circlip_time) AS Circlip_Time,
      l.Ring_Result, l.Ring_Time, l.Ring_Count, l.Unloading_Time, l.Result,
      l.Circlip_Rejection_Reason, l.Ring_Rejection_Reason,
      ${STATE_CASE_SQL_DISPLAY} AS state,
      p.max_ring_count AS total_attempts,
      p.has_circlip_fail,
      p.has_circlip_pass,
      CASE WHEN p.max_ring_count > 1 THEN 1 ELSE 0 END AS reinspected
    FROM latest l
    INNER JOIN per_dmc p ON p.DMC = l.DMC
    ${PACKED_LOG_JOIN_SQL}
  ) AS x`;
}

export default async function listRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/list', { preHandler: cacheReads(30_000) }, async (req) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(200, Math.max(1, parseInt(req.query.size || '50', 10)));
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * size;
    const typeWhere = buildTypeWhere(req.query.type);
    const stateWhere = buildInClause('state', req.query.state, STATE_VALUES);
    const circlipWhere = buildInClause('Circlip_Result', req.query.circlip, RESULT_VALUES);
    const ringWhere = buildInClause('Ring_Result', req.query.ring, RESULT_VALUES);
    const timeWhere = buildTimeOfDayWhere(req.query.time_from, req.query.time_to);

    const pool = await getPool();

    // Count
    const countRequest = pool.request();
    const countCte = buildBaseCte(req.query, countRequest);
    const countResult = await countRequest.query(`
      ${countCte}
      SELECT COUNT(*) AS total
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
        AND ${stateWhere}
        AND ${circlipWhere}
        AND ${ringWhere}
        AND ${timeWhere}
    `);
    const total = countResult.recordset[0].total;

    // Data
    const dataRequest = pool.request();
    const dataCte = buildBaseCte(req.query, dataRequest);
    dataRequest.input('offset', offset);
    dataRequest.input('size', size);

    const dataResult = await dataRequest.query(`
      ${dataCte}
      SELECT *
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
        AND ${stateWhere}
        AND ${circlipWhere}
        AND ${ringWhere}
        AND ${timeWhere}
      ORDER BY ${sortKey} ${order}
      OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    `);

    serializeDateTimeFields(dataResult.recordset);

    // Bulk-fetch per-DMC image counts for the page's DMCs in ONE
    // grouped query, then merge into each row. Faster than per-row
    // lookups (200 → 1 round-trip) and skips the join in the main
    // paged query so the count/data queries don't grow their sort
    // shape. Zero counts are added for DMCs that have no matched
    // Image_Index rows yet (either not captured or still pending).
    const dmcs = dataResult.recordset
      .map((r: Record<string, unknown>) => r.DMC as string | null)
      .filter((d): d is string => !!d);
    const imgCounts = new Map<string, { circlip: number; ring: number }>();
    if (dmcs.length > 0) {
      const imgReq = pool.request();
      const params = dmcs.map((d, i) => {
        imgReq.input(`d${i}`, d);
        return `@d${i}`;
      }).join(',');
      const imgRs = await imgReq.query(`
        SELECT DMC, inspection_type, COUNT(*) AS n
        FROM dbo.Image_Index WITH (NOLOCK)
        WHERE DMC IN (${params}) AND pending_match = 0
        GROUP BY DMC, inspection_type
      `);
      for (const row of imgRs.recordset as {
        DMC: string;
        inspection_type: string;
        n: number;
      }[]) {
        const entry = imgCounts.get(row.DMC) ?? { circlip: 0, ring: 0 };
        if (row.inspection_type === 'CIRCLIP') entry.circlip = row.n;
        else if (row.inspection_type === 'RING') entry.ring = row.n;
        imgCounts.set(row.DMC, entry);
      }
    }

    const data: PartListItem[] = dataResult.recordset.map((r: Record<string, unknown>) => {
      const dmc = r.DMC as string | null;
      const counts = dmc ? imgCounts.get(dmc) : undefined;
      return {
        Date_Time: r.Date_Time as string | null,
        Plant_Id: r.Plant_Id as string | null,
        DMC: dmc,
        Circlip_Result: r.Circlip_Result as string | null,
        Circlip_Time: r.Circlip_Time as string | null,
        Ring_Result: r.Ring_Result as string | null,
        Ring_Time: r.Ring_Time as string | null,
        Ring_Count: r.Ring_Count as number | null,
        Unloading_Time: r.Unloading_Time as string | null,
        Result: r.Result as string | null,
        state: r.state as PartListItem['state'],
        total_attempts: (r.total_attempts as number) ?? 0,
        reinspected: ((r.reinspected as number) ?? 0) === 1,
        circlip_rejection_reason: (r.Circlip_Rejection_Reason as string | null) ?? null,
        ring_rejection_reason: (r.Ring_Rejection_Reason as string | null) ?? null,
        circlip_image_count: counts?.circlip ?? 0,
        ring_image_count: counts?.ring ?? 0,
      };
    });

    const response: PaginatedResponse<PartListItem> = {
      data,
      total,
      page,
      size,
      total_pages: Math.ceil(total / size),
    };
    return response;
  });

  // CSV export — same filter set + same dedupe + same classification.
  app.get<{ Querystring: ListQuery }>('/export', async (req, reply) => {
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const typeWhere = buildTypeWhere(req.query.type);
    const stateWhere = buildInClause('state', req.query.state, STATE_VALUES);
    const circlipWhere = buildInClause('Circlip_Result', req.query.circlip, RESULT_VALUES);
    const ringWhere = buildInClause('Ring_Result', req.query.ring, RESULT_VALUES);
    const timeWhere = buildTimeOfDayWhere(req.query.time_from, req.query.time_to);

    const pool = await getPool();
    const request = pool.request();
    const cte = buildBaseCte(req.query, request);

    const result = await request.query(`
      ${cte}
      SELECT *
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
        AND ${stateWhere}
        AND ${circlipWhere}
        AND ${ringWhere}
        AND ${timeWhere}
      ORDER BY ${sortKey} ${order}
    `);

    serializeDateTimeFields(result.recordset);
    const records = result.recordset.map((r: Record<string, unknown>) => ({
      ...r,
      reinspected: ((r.reinspected as number) ?? 0) === 1,
    }));

    if (records.length === 0) {
      reply.status(404);
      return { error: 'No records found for export' };
    }

    // Explicit column list — the raw classifiedSelect projection now
    // includes Circlip_Rejection_Reason / Ring_Rejection_Reason; we
    // surface them as friendly "Circlip Reason" / "Ring Reason" columns
    // and blank out the cell when the result is PASS (per brief A3 —
    // PASS in the reason cell is noise in an export).
    const EXPORT_COLUMNS: { header: string; pick: (r: Record<string, unknown>) => unknown }[] = [
      { header: 'Date_Time',     pick: (r) => r.Date_Time },
      { header: 'Plant_Id',      pick: (r) => r.Plant_Id },
      { header: 'DMC',           pick: (r) => r.DMC },
      { header: 'State',         pick: (r) => r.state },
      { header: 'Circlip_Result',pick: (r) => r.Circlip_Result },
      { header: 'Circlip_Time',  pick: (r) => r.Circlip_Time },
      { header: 'Circlip Reason',pick: (r) => (r.Circlip_Result === 'FAIL' ? r.Circlip_Rejection_Reason : '') },
      { header: 'Ring_Result',   pick: (r) => r.Ring_Result },
      { header: 'Ring_Time',     pick: (r) => r.Ring_Time },
      { header: 'Ring Reason',   pick: (r) => (r.Ring_Result === 'FAIL' ? r.Ring_Rejection_Reason : '') },
      { header: 'Ring_Count',    pick: (r) => r.Ring_Count },
      { header: 'Unloading_Time',pick: (r) => r.Unloading_Time },
      { header: 'Result',        pick: (r) => r.Result },
      { header: 'Total_Attempts',pick: (r) => r.total_attempts },
      { header: 'Reinspected',   pick: (r) => r.reinspected },
    ];

    const csvRows = [EXPORT_COLUMNS.map((c) => c.header).join(',')];
    for (const record of records) {
      const values = EXPORT_COLUMNS.map((col) => {
        const val = col.pick(record as Record<string, unknown>);
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      });
      csvRows.push(values.join(','));
    }

    const csv = csvRows.join('\n');
    const bucket = req.query.type && req.query.type !== 'all' ? `_${req.query.type}` : '';
    reply.header('Content-Type', 'text/csv');
    reply.header(
      'Content-Disposition',
      `attachment; filename=sam_log${bucket}_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    return csv;
  });

  // Lists-page Production Summary matrix. Returns one row per (bucket,
  // part_code) pair — the frontend pivots this into a 6-bucket × 15-code
  // table matching the customer's Production Dashboard.xlsx template.
  //
  // Scope intentionally ignores the type / state / column filters: the
  // summary is a fixed view of the date+plant+hour-window slice, so it
  // always shows the full breakdown regardless of how the operator has
  // narrowed the table below.
  app.get<{
    Querystring: Pick<ListQuery, 'from' | 'to' | 'plant' | 'time_from' | 'time_to'>;
  }>('/summary', { preHandler: cacheReads(60_000) }, async (req) => {
    const pool = await getPool();
    const request = pool.request();
    const conds = bindProductionDayFilterInputs(request, req.query);
    const cte = buildLatestPerDmcCte(conds);
    const timeWhere = buildTimeOfDayWhere(req.query.time_from, req.query.time_to, 'l.Date_Time');

    // Include EVERY DMC that the Dashboard counts — DMCs without the
    // P234102 prefix (malformed scans, test pieces, etc.) get bucketed
    // under part_code='OTHER' instead of being dropped. Keeps the
    // Summary grand total in lockstep with the Dashboard "Total Parts"
    // KPI for the same date / shift / hour window.
    const result = await request.query(`
      ${cte}
      SELECT
        ${SUMMARY_BUCKET_CASE} AS bucket,
        CASE
          WHEN CHARINDEX('P234102', l.DMC) > 0
            THEN SUBSTRING(l.DMC, CHARINDEX('P234102', l.DMC) + 7, 4)
          ELSE 'OTHER'
        END AS part_code,
        COUNT(DISTINCT l.DMC) AS count
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      WHERE ${timeWhere}
      GROUP BY
        ${SUMMARY_BUCKET_CASE},
        CASE
          WHEN CHARINDEX('P234102', l.DMC) > 0
            THEN SUBSTRING(l.DMC, CHARINDEX('P234102', l.DMC) + 7, 4)
          ELSE 'OTHER'
        END
    `);

    // Make 'passed' INCLUSIVE of re-inspections — a part that ended
    // PASSED but had a circlip or ring retry along the way should still
    // count toward "Passed" (the dashboard tile and this row are the
    // same identity). The exclusive bucket already in the recordset is
    // promoted to inclusive by adding the re-inspection subset counts
    // for the same variant. The re-inspection rows stay in the response
    // unchanged — they still tell you HOW MANY of the passed parts were
    // saved by a retry. Frontend treats them as subsets and skips them
    // in column totals so totals don't double-count.
    const REINSP_BUCKETS = new Set(['circlip_reinspected', 'ring_reinspected']);
    type Row = { bucket: string; part_code: string; count: number };
    const raw = result.recordset as Row[];

    // Aggregate per (variant) the extra subset counts to add into passed.
    const extraPerCode = new Map<string, number>();
    for (const r of raw) {
      if (REINSP_BUCKETS.has(r.bucket)) {
        extraPerCode.set(r.part_code, (extraPerCode.get(r.part_code) ?? 0) + r.count);
      }
    }

    // Carry through every row, but bump 'passed' rows by the re-inspection
    // subset count for the same variant. If a variant has no exclusive
    // 'passed' row but has re-inspection rows, synthesize a 'passed' row
    // so the count surfaces.
    const seenPassed = new Set<string>();
    const entries: ListSummaryEntry[] = raw.map((r) => {
      if (r.bucket === 'passed') {
        seenPassed.add(r.part_code);
        return {
          bucket: r.bucket,
          part_code: r.part_code,
          count: r.count + (extraPerCode.get(r.part_code) ?? 0),
        };
      }
      return { bucket: r.bucket, part_code: r.part_code, count: r.count };
    });
    for (const [part_code, extra] of extraPerCode) {
      if (!seenPassed.has(part_code) && extra > 0) {
        entries.push({ bucket: 'passed', part_code, count: extra });
      }
    }

    const response: ListSummaryResponse = { entries };
    return response;
  });

  // Failures list with rejection reasons — fuels the "Snap Ring
  // Failures" / "Ring Failures" modal opened from the Production
  // Summary table.
  //
  // - type=circlip  →  every SAM_Log row where Circlip_Result='FAIL'
  //                    (event-level: a part with two failed snap-ring
  //                    attempts shows up twice)
  // - type=ring     →  latest row per DMC where Ring_Result='FAIL'
  //                    (part-level: parts whose FINAL ring attempt failed)
  //
  // Date / plant / shift filters reuse the same helpers the Lists table
  // uses, so the modal matches what's on screen behind it.
  app.get<{
    Querystring: {
      type?: string;
      from?: string;
      to?: string;
      shift?: string;
      plant?: string;
    };
  }>('/lists/failures', async (req) => {
    const type = req.query.type === 'ring' ? 'ring' : 'circlip';
    const shiftIn = req.query.shift;
    const shift: 'A' | 'B' | 'C' | 'all' =
      shiftIn === 'A' || shiftIn === 'B' || shiftIn === 'C' ? shiftIn : 'all';

    // Translate shift to the same minute-of-day window the Lists Shift
    // buttons set on the frontend. shift='all' = no time-of-day filter.
    const shiftWindow = shift === 'all' ? null : SHIFT_WINDOWS[shift];
    const timeWhereOnL = shiftWindow
      ? `(DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) BETWEEN ${shiftWindow.fromMin} AND ${shiftWindow.toMin}`
      : '1 = 1';
    const timeWhereRaw = shiftWindow
      ? `(DATEPART(HOUR, Date_Time) * 60 + DATEPART(MINUTE, Date_Time)) BETWEEN ${shiftWindow.fromMin} AND ${shiftWindow.toMin}`
      : '1 = 1';

    const ROW_CAP = 1000;
    const pool = await getPool();
    const request = pool.request();
    // Date + plant bound via the same helper the Lists endpoint uses —
    // production-day window, plant filter, identical semantics.
    const conds = bindProductionDayFilterInputs(request, req.query);

    let rows: Array<{ Date_Time: string | null; Plant_Id: string | null; DMC: string | null; rejection_reason: string | null }>;

    if (type === 'circlip') {
      // Event-level: every row with Circlip_Result='FAIL' inside the
      // window. No latest-per-DMC dedup — a part with two snap-ring
      // failures pre-reinspection produces two rows.
      const where = [...conds, "Circlip_Result = 'FAIL'", timeWhereRaw].join(' AND ');
      const r = await request.query(`
        SELECT TOP (${ROW_CAP + 1})
          Date_Time, Plant_Id, DMC, Circlip_Rejection_Reason AS rejection_reason
        FROM dbo.SAM_Log
        WHERE ${where}
        ORDER BY Date_Time DESC
      `);
      serializeDateTimeFields(r.recordset);
      rows = r.recordset;
    } else {
      // Part-level: one row per DMC where the LATEST attempt's ring
      // result is FAIL. Same buildLatestPerDmcCte pattern the rest of
      // the codebase uses for per-DMC views.
      const cte = buildLatestPerDmcCte(conds);
      const r = await request.query(`
        ${cte}
        SELECT TOP (${ROW_CAP + 1})
          l.Date_Time, l.Plant_Id, l.DMC, l.Ring_Rejection_Reason AS rejection_reason
        FROM latest l
        INNER JOIN per_dmc p ON p.DMC = l.DMC
        WHERE l.Ring_Result = 'FAIL'
          AND ${timeWhereOnL}
        ORDER BY l.Date_Time DESC
      `);
      serializeDateTimeFields(r.recordset);
      rows = r.recordset;
    }

    const truncated = rows.length > ROW_CAP;
    if (truncated) rows = rows.slice(0, ROW_CAP);

    const items: ListFailureItem[] = rows.map((row, i) => ({
      s_no: i + 1,
      date_time: row.Date_Time,
      plant_id: row.Plant_Id,
      dmc: row.DMC,
      rejection_reason: row.rejection_reason ?? null,
    }));

    const response: ListFailuresResponse = {
      type,
      count: items.length,
      ...(truncated ? { truncated: true } : {}),
      filters_applied: {
        from: req.query.from ?? null,
        to: req.query.to ?? null,
        shift,
        plant: req.query.plant ?? 'all',
      },
      items,
    };

    req.log.info(
      `[lists] failures type=${type} from=${req.query.from ?? ''} to=${req.query.to ?? ''} ` +
        `shift=${shift} plant=${req.query.plant ?? 'all'} → ${items.length} rows` +
        (truncated ? ' (truncated)' : ''),
    );

    return response;
  });
}
