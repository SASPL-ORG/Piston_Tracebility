import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import type { PaginatedResponse, SamLogRecord } from '../types/index.js';

const VALID_SORT_COLUMNS = [
  'Date_Time', 'Plant_Id', 'DMC', 'Circlip_Result', 'Circlip_Time',
  'Ring_Result', 'Ring_Time', 'Ring_Count', 'Unloading_Time', 'Result',
];

interface ListQuery {
  type?: string;
  from?: string;
  to?: string;
  plant?: string;
  page?: string;
  size?: string;
  sort?: string;
  order?: string;
  search?: string;
}

function buildWhereClause(query: ListQuery, request: any): string {
  const conditions: string[] = [];

  if (query.from) {
    conditions.push('Date_Time >= @from');
    request.input('from', query.from);
  }
  if (query.to) {
    conditions.push('Date_Time <= @to');
    request.input('to', query.to + ' 23:59:59.999');
  }
  if (query.plant) {
    conditions.push('Plant_Id = @plant');
    request.input('plant', query.plant);
  }
  if (query.search) {
    conditions.push('DMC LIKE @search');
    request.input('search', `%${query.search}%`);
  }

  switch (query.type) {
    case 'pass':
      conditions.push("Result = 'PASS'");
      break;
    case 'fail':
      conditions.push("(Result = 'FAIL' OR Result IS NULL)");
      break;
    case 'circlip_fail':
      conditions.push("Circlip_Result = 'FAIL'");
      break;
    case 'ring_fail':
      conditions.push("Ring_Result = 'FAIL'");
      break;
  }

  return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
}

export default async function listRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/list', async (req) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(200, Math.max(1, parseInt(req.query.size || '50', 10)));
    const sort = VALID_SORT_COLUMNS.includes(req.query.sort || '') ? req.query.sort! : 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * size;

    const pool = await getPool();

    // Count query
    const countRequest = pool.request();
    const whereClause = buildWhereClause(req.query, countRequest);
    const countResult = await countRequest.query(`SELECT COUNT(*) as total FROM dbo.SAM_Log ${whereClause}`);
    const total = countResult.recordset[0].total;

    // Data query
    const dataRequest = pool.request();
    const dataWhere = buildWhereClause(req.query, dataRequest);
    dataRequest.input('offset', offset);
    dataRequest.input('size', size);

    const dataResult = await dataRequest.query(`
      SELECT * FROM dbo.SAM_Log
      ${dataWhere}
      ORDER BY ${sort} ${order}
      OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    `);

    const response: PaginatedResponse<SamLogRecord> = {
      data: dataResult.recordset,
      total,
      page,
      size,
      total_pages: Math.ceil(total / size),
    };

    return response;
  });

  // CSV export
  app.get<{ Querystring: ListQuery }>('/export', async (req, reply) => {
    const pool = await getPool();
    const dataRequest = pool.request();
    const whereClause = buildWhereClause(req.query, dataRequest);
    const sort = VALID_SORT_COLUMNS.includes(req.query.sort || '') ? req.query.sort! : 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

    const result = await dataRequest.query(`
      SELECT * FROM dbo.SAM_Log ${whereClause} ORDER BY ${sort} ${order}
    `);

    const records = result.recordset;
    if (records.length === 0) {
      reply.status(404);
      return { error: 'No records found for export' };
    }

    const headers = Object.keys(records[0]);
    const csvRows = [headers.join(',')];
    for (const record of records) {
      const values = headers.map((h) => {
        const val = record[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      });
      csvRows.push(values.join(','));
    }

    const csv = csvRows.join('\n');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename=sam_log_export_${new Date().toISOString().slice(0, 10)}.csv`);
    return csv;
  });
}
