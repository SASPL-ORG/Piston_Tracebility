import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  bindProductionDayFilterInputs,
  buildLatestPerDmcCte,
  STATE_CASE_SQL,
  STATE_CASE_SQL_DISPLAY,
  PACKED_LOG_JOIN_SQL,
  CIRCLIP_REINSPECTED_SQL,
  shiftWhereSql,
} from '../db/state.js';
import { getOrComputeSWR } from '../utils/responseCache.js';
import type {
  DashboardResponse,
  ProductionGranularity,
  StateBreakdownItem,
  ShiftId,
  PartState,
} from '../types/index.js';

interface DashboardQuery {
  from?: string;
  to?: string;
  plant?: string;
  shift?: string;
}

function parseShift(s: string | undefined): ShiftId | undefined {
  return s === 'A' || s === 'B' || s === 'C' ? s : undefined;
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
    // Single-flight + stale-while-revalidate: at most one recompute per
    // (range/shift) key runs at a time; everyone else gets the cached numbers
    // instantly (briefly stale during a refresh). This is what stops the
    // dashboard from 500-ing under the auto-refresh + retry thundering herd.
    return getOrComputeSWR(req.url, 30_000, async () => {
    const filters = req.query;
    const shift = parseShift(filters.shift);
    const shiftWhere = shiftWhereSql(shift);
    const granularity = pickGranularity(filters.from, filters.to);
    const { selectExpr, groupExpr } = bucketSql(granularity);
    const pool = await getPool();

    // All KPIs are distinct-DMC counts, partitioned so the identity holds:
    //   total = passed + circlip_fail + ring_fail + in_progress
    //         + circlip_reinspected + ring_reinspected
    // Every part falls into exactly ONE bucket. Buckets evaluated in
    // priority order so a part with both circlip and ring reinspections
    // lands in `circlip_reinspected` only (whichever is "deeper"
    // upstream is the more notable category to flag).
    //
    //   1. in_progress         — still mid-cycle
    //   2. circlip_fail        — final CIRCLIP_SCRAP (permanently failed circlip)
    //   3. ring_fail           — final RING_NG       (permanently failed ring)
    //   4. circlip_reinspected — had a circlip retry that saved it
    //   5. ring_reinspected    — had a ring retry that saved it
    //   6. passed              — clean first-time pass (no retries needed)
    // Bucket priority is encoded once and reused so the totals stay
    // consistent across queries.
    const BUCKET_CASE = `CASE
      WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 'in_progress'
      WHEN ${STATE_CASE_SQL} = 'CIRCLIP_SCRAP' THEN 'circlip_fail'
      WHEN ${STATE_CASE_SQL} = 'RING_NG' THEN 'ring_fail'
      WHEN ${CIRCLIP_REINSPECTED_SQL} THEN 'circlip_reinspected'
      WHEN p.max_ring_count > 1 AND l.Ring_Result = 'PASS' THEN 'ring_reinspected'
      ELSE 'passed'
    END`;

    // Build all three panel queries up front, each on its own pooled request,
    // then run them CONCURRENTLY. They're fully independent, so a dashboard
    // load takes as long as the slowest single query instead of their sum —
    // and each connection is held for less time, which is what keeps the
    // endpoint from tipping over the 30s timeout when the DB is busy.

    // KPI tiles. 'passed' is INCLUSIVE — counts every DMC that ended in PACKED
    // or RING_OK, regardless of whether it needed snap-ring or ring
    // re-inspection along the way. Re-inspection counts are SUBSETS of passed.
    const dmcRequest = pool.request();
    const dmcConds = bindProductionDayFilterInputs(dmcRequest, filters);
    const dmcCte = buildLatestPerDmcCte(dmcConds);
    const dmcQuery = dmcRequest.query(`
      ${dmcCte}
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${BUCKET_CASE} = 'circlip_fail' THEN 1 ELSE 0 END) AS circlip_fail,
        SUM(CASE WHEN ${BUCKET_CASE} = 'ring_fail' THEN 1 ELSE 0 END) AS ring_fail,
        SUM(CASE WHEN ${BUCKET_CASE} = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN ${BUCKET_CASE} = 'circlip_reinspected' THEN 1 ELSE 0 END) AS circlip_reinspected,
        SUM(CASE WHEN ${BUCKET_CASE} = 'ring_reinspected' THEN 1 ELSE 0 END) AS ring_reinspected
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      WHERE ${shiftWhere}
    `);

    // Production breakdown — three buckets per time slice. In_Progress is
    // its own column so the chart doesn't paint pending parts as failures.
    const prodRequest = pool.request();
    const prodConds = bindProductionDayFilterInputs(prodRequest, filters);
    const prodCte = buildLatestPerDmcCte(prodConds);
    const prodQuery = prodRequest.query(`
      ${prodCte}
      SELECT
        ${selectExpr} AS bucket,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${STATE_CASE_SQL} = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('CIRCLIP_SCRAP','RING_NG') THEN 1 ELSE 0 END) AS failed
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      WHERE ${shiftWhere}
      GROUP BY ${groupExpr}
      ORDER BY ${groupExpr}
    `);

    // State distribution — same source-of-truth classifier, COUNT DISTINCT
    // per state. Replaces the old plant donut, which was degenerate when
    // each install talks to one machine's DB.
    const stateRequest = pool.request();
    const stateConds = bindProductionDayFilterInputs(stateRequest, filters);
    const stateCte = buildLatestPerDmcCte(stateConds);
    const stateQuery = stateRequest.query(`
      ${stateCte}
      , classified AS (
        SELECT l.DMC, ${STATE_CASE_SQL_DISPLAY} AS state
        FROM latest l
        INNER JOIN per_dmc p ON p.DMC = l.DMC
        ${PACKED_LOG_JOIN_SQL}
        WHERE ${shiftWhere}
      )
      SELECT state, COUNT(DISTINCT DMC) AS count
      FROM classified
      GROUP BY state
    `);

    const [dmcResult, prodResult, stateResult] = await Promise.all([
      dmcQuery,
      prodQuery,
      stateQuery,
    ]);

    const dmcRow = dmcResult.recordset[0] || {};
    const total = dmcRow.total || 0;
    const passed = dmcRow.passed || 0;
    const kpiRow = {
      circlip_fail: dmcRow.circlip_fail || 0,
      ring_fail: dmcRow.ring_fail || 0,
      in_progress: dmcRow.in_progress || 0,
      circlip_reinspected: dmcRow.circlip_reinspected || 0,
      ring_reinspected: dmcRow.ring_reinspected || 0,
    };

    const STATE_ORDER: PartState[] = [
      'PACKED',
      'COMPLETED',
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

    // Pass Rate = OK yield. `passed` is already INCLUSIVE of parts saved
    // by either re-inspection (changed when "Passed" became inclusive on
    // the KPI tile), so we use it directly — adding the re-inspection
    // subset counts on top would double-count and push the rate over
    // 100%.
    const okCount = passed;
    const response: DashboardResponse = {
      kpis: {
        total,
        passed,
        circlip_fail: kpiRow.circlip_fail || 0,
        ring_fail: kpiRow.ring_fail || 0,
        in_progress: kpiRow.in_progress || 0,
        circlip_reinspected: kpiRow.circlip_reinspected || 0,
        ring_reinspected: kpiRow.ring_reinspected || 0,
        pass_rate: total > 0 ? Math.round((okCount / total) * 1000) / 10 : 0,
      },
      granularity,
      production_breakdown: prodResult.recordset,
      state_breakdown: stateBreakdown,
    };
    return response;
    });
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
