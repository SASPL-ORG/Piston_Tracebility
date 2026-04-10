import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';

interface PartParams {
  dmc: string;
}

export default async function partRoutes(app: FastifyInstance) {
  app.get<{ Params: PartParams }>('/part/:dmc', async (req, reply) => {
    const { dmc } = req.params;
    const pool = await getPool();

    const result = await pool
      .request()
      .input('dmc', dmc)
      .query('SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ORDER BY Date_Time DESC');

    if (result.recordset.length === 0) {
      reply.status(404);
      return { error: `No records found for DMC: ${dmc}` };
    }

    return {
      dmc,
      total_records: result.recordset.length,
      records: result.recordset,
    };
  });
}
