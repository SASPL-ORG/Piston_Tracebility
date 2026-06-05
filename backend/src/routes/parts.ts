import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import { classifyState } from '../db/state.js';
import { serializeDateTime, serializeDateTimeFields } from '../db/datetime.js';
import { renderPartTracePdf, deriveSerializedRecords } from '../reports/partTracePdf.js';
import type {
  AlarmEvent,
  AlarmStatus,
  PartTraceResponse,
  SamLogRecord,
} from '../types/index.js';

interface PartParams {
  dmc: string;
}

async function fetchPartRecords(dmc: string): Promise<SamLogRecord[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('dmc', dmc)
    .query(
      'SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ORDER BY ISNULL(Ring_Count, 0) ASC, Date_Time ASC',
    );
  return result.recordset as SamLogRecord[];
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

    serializeDateTimeFields(records as unknown as Record<string, unknown>[]);
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
      alarms,
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
