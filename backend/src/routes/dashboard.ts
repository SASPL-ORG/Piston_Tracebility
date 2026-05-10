import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import { bindFilterInputs, buildLatestPerDmcCte, STATE_CASE_SQL } from '../db/state.js';
import type { DashboardResponse } from '../types/index.js';

interface DashboardQuery {
  from?: string;
  to?: string;
  plant?: string;
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: DashboardQuery }>('/dashboard', async (req) => {
    const filters = req.query;
    const pool = await getPool();

    // KPIs: classify each DMC's latest-row state, then aggregate.
    const kpiRequest = pool.request();
    const kpiConds = bindFilterInputs(kpiRequest, filters);
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

    // Hourly breakdown: bucket by latest row's Date_Time, classify the same way.
    const hourlyRequest = pool.request();
    const hourlyConds = bindFilterInputs(hourlyRequest, filters);
    const hourlyCte = buildLatestPerDmcCte(hourlyConds);

    const hourlyResult = await hourlyRequest.query(`
      ${hourlyCte}
      SELECT
        FORMAT(l.Date_Time, 'yyyy-MM-dd HH:00') AS hour,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN ${STATE_CASE_SQL} NOT IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS failed
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      GROUP BY FORMAT(l.Date_Time, 'yyyy-MM-dd HH:00')
      ORDER BY hour
    `);

    // Plant breakdown: same classification, grouped by latest row's Plant_Id.
    const plantRequest = pool.request();
    const plantConds = bindFilterInputs(plantRequest, filters);
    const plantCte = buildLatestPerDmcCte(plantConds);

    const plantResult = await plantRequest.query(`
      ${plantCte}
      SELECT
        l.Plant_Id AS plant_id,
        COUNT(DISTINCT l.DMC) AS total,
        SUM(CASE WHEN ${STATE_CASE_SQL} IN ('PACKED','RING_OK') THEN 1 ELSE 0 END) AS passed
      FROM latest l
      INNER JOIN per_dmc p ON p.DMC = l.DMC
      GROUP BY l.Plant_Id
      ORDER BY l.Plant_Id
    `);

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
      hourly_breakdown: hourlyResult.recordset,
      plant_breakdown: plantResult.recordset,
    };

    return response;
  });

  // Distinct plant IDs for the filter dropdown.
  app.get('/plants', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT Plant_Id FROM dbo.SAM_Log WHERE Plant_Id IS NOT NULL ORDER BY Plant_Id
    `);
    return result.recordset.map((r: { Plant_Id: string }) => r.Plant_Id);
  });
}
