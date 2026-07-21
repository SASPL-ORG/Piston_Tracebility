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
}
