import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import type { DashboardResponse } from '../types/index.js';

interface DashboardQuery {
  from?: string;
  to?: string;
  plant?: string;
}

export default async function dashboardRoutes(app: FastifyInstance) {
  app.get<{ Querystring: DashboardQuery }>('/dashboard', async (req) => {
    const { from, to, plant } = req.query;
    const pool = await getPool();

    const conditions: string[] = [];
    const request = pool.request();

    if (from) {
      conditions.push('Date_Time >= @from');
      request.input('from', from);
    }
    if (to) {
      conditions.push('Date_Time <= @to');
      request.input('to', to + ' 23:59:59.999');
    }
    if (plant) {
      conditions.push('Plant_Id = @plant');
      request.input('plant', plant);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // KPIs
    const kpiResult = await request.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN Result = 'PASS' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN Circlip_Result = 'FAIL' THEN 1 ELSE 0 END) as circlip_fail,
        SUM(CASE WHEN Ring_Result = 'FAIL' THEN 1 ELSE 0 END) as ring_fail,
        SUM(CASE WHEN Result != 'PASS' OR Result IS NULL THEN 1 ELSE 0 END) as overall_fail
      FROM dbo.SAM_Log
      ${whereClause}
    `);

    const kpiRow = kpiResult.recordset[0];
    const total = kpiRow.total || 0;
    const passed = kpiRow.passed || 0;

    // Hourly breakdown - new request needed since inputs are consumed
    const hourlyRequest = pool.request();
    if (from) hourlyRequest.input('from', from);
    if (to) hourlyRequest.input('to', to + ' 23:59:59.999');
    if (plant) hourlyRequest.input('plant', plant);

    const hourlyResult = await hourlyRequest.query(`
      SELECT
        FORMAT(Date_Time, 'yyyy-MM-dd HH:00') as hour,
        SUM(CASE WHEN Result = 'PASS' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN Result != 'PASS' OR Result IS NULL THEN 1 ELSE 0 END) as failed
      FROM dbo.SAM_Log
      ${whereClause}
      GROUP BY FORMAT(Date_Time, 'yyyy-MM-dd HH:00')
      ORDER BY hour
    `);

    // Plant breakdown
    const plantRequest = pool.request();
    if (from) plantRequest.input('from', from);
    if (to) plantRequest.input('to', to + ' 23:59:59.999');
    if (plant) plantRequest.input('plant', plant);

    const plantResult = await plantRequest.query(`
      SELECT
        Plant_Id as plant_id,
        COUNT(*) as total,
        SUM(CASE WHEN Result = 'PASS' THEN 1 ELSE 0 END) as passed
      FROM dbo.SAM_Log
      ${whereClause}
      GROUP BY Plant_Id
      ORDER BY Plant_Id
    `);

    const response: DashboardResponse = {
      kpis: {
        total,
        passed,
        circlip_fail: kpiRow.circlip_fail || 0,
        ring_fail: kpiRow.ring_fail || 0,
        overall_fail: kpiRow.overall_fail || 0,
        pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      },
      hourly_breakdown: hourlyResult.recordset,
      plant_breakdown: plantResult.recordset,
    };

    return response;
  });

  // Get distinct plant IDs for filter dropdown
  app.get('/plants', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT DISTINCT Plant_Id FROM dbo.SAM_Log WHERE Plant_Id IS NOT NULL ORDER BY Plant_Id
    `);
    return result.recordset.map((r: { Plant_Id: string }) => r.Plant_Id);
  });
}
