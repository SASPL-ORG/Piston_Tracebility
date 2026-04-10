import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import sql from 'mssql';

// The maintenance_snapshot table may be in a different database (e.g., 'test')
// This route tries SAM first, then falls back to checking 'test' database
async function getMaintenancePool(): Promise<{ pool: sql.ConnectionPool; dbName: string }> {
  const pool = await getPool();

  // Check if maintenance_snapshot exists in current database
  const check = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'maintenance_snapshot'
  `);

  if (check.recordset.length > 0) {
    return { pool, dbName: 'current' };
  }

  // Table not found - return pool anyway, queries will show empty
  return { pool, dbName: 'current' };
}

export default async function maintenanceRoutes(app: FastifyInstance) {
  // Get current status of all components (latest snapshot per component)
  app.get('/maintenance/status', async (_req, reply) => {
    try {
      const { pool } = await getMaintenancePool();

      // Check if table exists first
      const tableCheck = await pool.request().query(`
        SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'maintenance_snapshot'
      `);

      if (tableCheck.recordset.length === 0) {
        return [];
      }

      const result = await pool.request().query(`
        SELECT m.*
        FROM dbo.maintenance_snapshot m
        INNER JOIN (
          SELECT component_name, MAX(ts) as latest_ts
          FROM dbo.maintenance_snapshot
          GROUP BY component_name
        ) latest ON m.component_name = latest.component_name AND m.ts = latest.latest_ts
        ORDER BY m.component_name
      `);
      return result.recordset;
    } catch (err) {
      reply.status(500);
      return { error: (err as Error).message };
    }
  });

  // Get history for a specific component
  app.get<{ Params: { component: string }; Querystring: { from?: string; to?: string } }>(
    '/maintenance/history/:component',
    async (req, reply) => {
      try {
        const { component } = req.params;
        const { from, to } = req.query;
        const { pool } = await getMaintenancePool();

        // Check if table exists
        const tableCheck = await pool.request().query(`
          SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'maintenance_snapshot'
        `);

        if (tableCheck.recordset.length === 0) {
          return [];
        }

        const request = pool.request().input('component', component);
        const conditions = ['component_name = @component'];
        if (from) {
          conditions.push('ts >= @from');
          request.input('from', from);
        }
        if (to) {
          conditions.push('ts <= @to');
          request.input('to', to + ' 23:59:59.999');
        }

        const result = await request.query(`
          SELECT * FROM dbo.maintenance_snapshot
          WHERE ${conditions.join(' AND ')}
          ORDER BY ts DESC
        `);
        return result.recordset;
      } catch (err) {
        reply.status(500);
        return { error: (err as Error).message };
      }
    }
  );
}
