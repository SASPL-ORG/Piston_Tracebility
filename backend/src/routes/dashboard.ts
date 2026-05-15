import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  bindProductionDayFilterInputs,
  buildLatestPerDmcCte,
  STATE_CASE_SQL,
  SHIFT_CASE_SQL,
} from '../db/state.js';
import { SHIFTS } from '../config/shifts.js';
import type {
  DashboardResponse,
  ProductionGranularity,
  StateBreakdownItem,
  ShiftBreakdownItem,
  ShiftId,
  PartState,
} from '../types/index.js';

interface DashboardQuery {
  from?: string;
  to?: string;
  plant?: string;
}

// Adaptive bucketing: hour for short ranges, day for medium, week for long.
// Boundaries chosen so a typical 'This Month' selection still gets daily bars.
function pickGranularity(fromStr?: string, toStr?: string): ProductionGranularity {
  if (!fromStr || !toStr) return 'hour';
  const from = Date.parse(fromStr);
  const to = Date.parse(toStr);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 'hour';
  const days = Math.floor((to - from) / 86_400_000) + 1;
  if (days <= 1) return 'hour';
  if (days <= 31) return 'day';
  return 'week';
}

// Returns a SELECT expression and matching GROUP BY expression for the bucket.
function bucketSql(granularity: ProductionGranularity): { selectExpr: string; groupExpr: string } {
  switch (granularity) {
    case 'hour':
      return {
        selectExpr: "FORMAT(l.Date_Time, 'yyyy-MM-dd HH:00')",
        groupExpr: "FORMAT(l.Date_Time, 'yyyy-MM-dd HH:00')",
      };
    case 'day':
      return {
        selectExpr: "FORMAT(l.Date_Time, 'yyyy-MM-dd')",
        groupExpr: "FORMAT(l.Date_Time, 'yyyy-MM-dd')",
      };
    case 'week':
      // ISO-style: bucket by Monday of the week.
      return {
        selectExpr:
          "FORMAT(DATEADD(week, DATEDIFF(week, 0, l.Date_Time), 0), 'yyyy-MM-dd')",
        groupExpr: 'DATEADD(week, DATEDIFF(week, 0, l.Date_Time), 0)',
      };
  }
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: DashboardQuery }>('/dashboard', async (req) => {
    const filters = req.query;
    const granularity = pickGranularity(filters.from, filters.to);
    const { selectExpr, groupExpr } = bucketSql(granularity);
    const pool = await getPool();

    // KPIs.
    const kpiRequest = pool.request();
    const kpiConds = bindProductionDayFilterInputs(kpiRequest, filters);
    const kpiCte = buildLatestPerDmcCte(kpiConds);
    const kpiResult = await kpiRequest.query(`
      ${kpiCte}
      SELECT
        COUNT(DISTINCT l.DMC) AS total,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'CIRCLIP_SCRAP' THEN 1 ELSE 0 END) AS circlip_fail,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'RING_NG' THEN 1 ELSE 0 END) AS ring_fail,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN p.max_ring_count > 1 THEN 1 ELSE 0 END) AS reinspected
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
    `);
    const kpiRow = kpiResult.recordset[0] || {};
    const total = kpiRow.total || 0;
    const passed = kpiRow.passed || 0;

    // Production breakdown — three buckets per time slice. In_Progress is
    // its own column so the chart doesn't paint pending parts as failures.
    const prodRequest = pool.request();
    const prodConds = bindProductionDayFilterInputs(prodRequest, filters);
    const prodCte = buildLatestPerDmcCte(prodConds);
    const prodResult = await prodRequest.query(`
      ${prodCte}
      SELECT
        ${selectExpr} AS bucket,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('CIRCLIP_SCRAP','RING_NG') THEN 1 ELSE 0 END) AS failed
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      GROUP BY ${groupExpr}
      ORDER BY ${groupExpr}
    `);

    // State distribution — same source-of-truth classifier, COUNT DISTINCT
    // per state. Replaces the old plant donut, which was degenerate when
    // each install talks to one machine's DB.
    const stateRequest = pool.request();
    const stateConds = bindProductionDayFilterInputs(stateRequest, filters);
    const stateCte = buildLatestPerDmcCte(stateConds);
    const stateResult = await stateRequest.query(`
      ${stateCte}
      , classified AS (
        SELECT l.DMC, ${STATE_CASE_SQL} AS state
        FROM latest l
        INNER JOIN per_dmc p ON p.DMC = l.DMC
      )
      SELECT state, COUNT(DISTINCT DMC) AS count
      FROM classified
      GROUP BY state
    `);

    const STATE_ORDER: PartState[] = [
      'PACKED',
      'RING_OK',
      'IN_PROGRESS',
      'RING_NG',
      'CIRCLIP_SCRAP',
    ];
    const byState = new Map<PartState, number>(
      stateResult.recordset.map((r: { state: PartState; count: number }) => [r.state, r.count]),
    );
    const stateBreakdown: StateBreakdownItem[] = STATE_ORDER.map((s) => ({
      state: s,
      count: byState.get(s) ?? 0,
    })).filter((s) => s.count > 0);

    // Shift breakdown — same KPIs as the top-line tiles, sliced by the
    // minute-of-day of the latest row's Date_Time. Within the production-day
    // window (07:30 → next-day 07:30), each part falls into exactly one
    // shift, so the three rows sum to the top-line KPI values.
    const shiftRequest = pool.request();
    const shiftConds = bindProductionDayFilterInputs(shiftRequest, filters);
    const shiftCte = buildLatestPerDmcCte(shiftConds);
    const shiftResult = await shiftRequest.query(`
      ${shiftCte}
      SELECT
        ${SHIFT_CASE_SQL} AS shift,
        COUNT(DISTINCT l.DMC) AS total,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'CIRCLIP_SCRAP' THEN 1 ELSE 0 END) AS circlip_fail,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'RING_NG' THEN 1 ELSE 0 END) AS ring_fail,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN p.max_ring_count > 1 THEN 1 ELSE 0 END) AS reinspected
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      GROUP BY ${SHIFT_CASE_SQL}
    `);
    const byShift = new Map<ShiftId, Record<string, number>>(
      shiftResult.recordset.map(
        (r: { shift: ShiftId } & Record<string, number>) => [r.shift, r],
      ),
    );
    const shiftBreakdown: ShiftBreakdownItem[] = SHIFTS.map((def) => {
      const row = byShift.get(def.id);
      const t = (row?.total as number) ?? 0;
      const p = (row?.passed as number) ?? 0;
      return {
        shift: def.id,
        label: def.label,
        hours: def.hours,
        total: t,
        passed: p,
        circlip_fail: (row?.circlip_fail as number) ?? 0,
        ring_fail: (row?.ring_fail as number) ?? 0,
        in_progress: (row?.in_progress as number) ?? 0,
        reinspected: (row?.reinspected as number) ?? 0,
        pass_rate: t > 0 ? Math.round((p / t) * 1000) / 10 : 0,
      };
    });

    const response: DashboardResponse = {
      kpis: {
        total,
        passed,
        circlip_fail: kpiRow.circlip_fail || 0,
        ring_fail: kpiRow.ring_fail || 0,
        in_progress: kpiRow.in_progress || 0,
        reinspected: kpiRow.reinspected || 0,
        pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      },
      granularity,
      production_breakdown: prodResult.recordset,
      state_breakdown: stateBreakdown,
      shift_breakdown: shiftBreakdown,
    };
    return response;
  });

  // Distinct plant IDs (still used by Lists; Dashboard no longer fetches it).
  app.get('/plants', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT Plant_Id FROM dbo.SAM_Log WHERE Plant_Id IS NOT NULL ORDER BY Plant_Id
    `);
    return result.recordset.map((r: { Plant_Id: string }) => r.Plant_Id);
  });
}
