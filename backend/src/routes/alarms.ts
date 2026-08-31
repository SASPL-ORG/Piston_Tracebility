import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import { serializeDateTime } from '../db/datetime.js';
import type {
  AlarmListItem,
  AlarmStatus,
  PaginatedResponse,
} from '../types/index.js';

interface AlarmsQuery {
  from?: string;
  to?: string;
  status?: string;
  batch?: string;
  page?: string;
  size?: string;
  sort?: string;
  order?: string;
}

const SORT_COLUMNS: Record<string, string> = {
  LogTime: 'LogTime',
  BatchID: 'BatchID',
  Alarm: 'Alarm',
  Status: 'Status',
  ID: 'ID',
};

function buildWhere(query: AlarmsQuery, request: import('mssql').Request): string {
  const conds: string[] = [];
  if (query.from) {
    conds.push('LogTime >= @from');
    request.input('from', query.from);
  }
  if (query.to) {
    conds.push('LogTime <= @to');
    request.input('to', query.to + ' 23:59:59.999');
  }
  if (query.status === 'ON' || query.status === 'OFF') {
    conds.push('Status = @status');
    request.input('status', query.status);
  }
  if (query.batch) {
    conds.push('BatchID LIKE @batch');
    request.input('batch', `%${query.batch}%`);
  }
  return conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
}

function shapeRow(r: {
  ID: number;
  LogTime: Date | null;
  BatchID: string | null;
  Alarm: string;
  Status: string;
}): AlarmListItem {
  return {
    id: r.ID,
    logTime: serializeDateTime(r.LogTime),
    batchId: r.BatchID ?? null,
    alarm: r.Alarm,
    status: (r.Status === 'ON' ? 'ON' : 'OFF') as AlarmStatus,
  };
}

export default async function alarmRoutes(app: FastifyInstance) {
  app.get<{ Querystring: AlarmsQuery }>('/alarms', async (req) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(200, Math.max(1, parseInt(req.query.size || '50', 10)));
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'LogTime';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * size;

    const pool = await getPool();

    // Count
    const countRequest = pool.request();
    const where = buildWhere(req.query, countRequest);
    const countResult = await countRequest.query(
      `SELECT COUNT(*) AS total FROM dbo.PLC_Alarms ${where}`,
    );
    const total = countResult.recordset[0].total;

    // Data
    const dataRequest = pool.request();
    const dataWhere = buildWhere(req.query, dataRequest);
    dataRequest.input('offset', offset);
    dataRequest.input('size', size);
    const dataResult = await dataRequest.query(`
      SELECT ID, LogTime, BatchID, Alarm, Status
      FROM dbo.PLC_Alarms
      ${dataWhere}
      ORDER BY ${sortKey} ${order}
      OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    `);

    const response: PaginatedResponse<AlarmListItem> = {
      data: dataResult.recordset.map(shapeRow),
      total,
      page,
      size,
      total_pages: Math.ceil(total / size),
    };
    return response;
  });

  // Spreadsheet export — same filters as /alarms but NO pagination: every
  // matching alarm row. Returns CSV (opens directly in Excel / Google Sheets),
  // with a UTF-8 BOM so Excel reads it in the right encoding.
  app.get<{ Querystring: AlarmsQuery }>('/alarms/export', async (req, reply) => {
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'LogTime';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const pool = await getPool();
    const request = pool.request();
    const where = buildWhere(req.query, request);
    const result = await request.query(`
      SELECT ID, LogTime, BatchID, Alarm, Status
      FROM dbo.PLC_Alarms WITH (NOLOCK)
      ${where}
      ORDER BY ${sortKey} ${order}
    `);
    const rows = result.recordset.map(shapeRow);

    if (rows.length === 0) {
      reply.status(404);
      return { error: 'No alarms found for export' };
    }

    const COLUMNS: { header: string; pick: (r: AlarmListItem) => unknown }[] = [
      { header: 'Log Time',       pick: (r) => r.logTime },
      { header: 'Batch ID (DMC)', pick: (r) => r.batchId },
      { header: 'Alarm',          pick: (r) => r.alarm },
      { header: 'Status',         pick: (r) => r.status },
    ];
    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csvRows = [COLUMNS.map((c) => c.header).join(',')];
    for (const r of rows) csvRows.push(COLUMNS.map((c) => esc(c.pick(r))).join(','));
    const csv = '﻿' + csvRows.join('\n');

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename=plc_alarms_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    return csv;
  });
}
