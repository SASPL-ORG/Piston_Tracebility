import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import { classifyState } from '../db/state.js';
import { serializeDateTimeFields } from '../db/datetime.js';
import type { PartTraceResponse, SamLogRecord } from '../types/index.js';

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
      .query(
        'SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ORDER BY ISNULL(Ring_Count, 0) ASC, Date_Time ASC',
      );

    if (result.recordset.length === 0) {
      reply.status(404);
      return { error: `No records found for DMC: ${dmc}` };
    }

    serializeDateTimeFields(result.recordset);
    const records: SamLogRecord[] = result.recordset;
    const latest = records[records.length - 1];
    const hasCirclipFail = records.some((r) => r.Circlip_Result === 'FAIL');
    const totalAttempts = records.reduce(
      (max, r) => Math.max(max, r.Ring_Count ?? 0),
      0,
    );

    const response: PartTraceResponse = {
      dmc,
      total_records: records.length,
      records,
      summary: {
        state: classifyState(latest, hasCirclipFail),
        total_attempts: totalAttempts,
        reinspected: totalAttempts > 1,
        latest,
        first_seen: records[0].Date_Time,
        last_seen: latest.Date_Time,
      },
    };
    return response;
  });
}
