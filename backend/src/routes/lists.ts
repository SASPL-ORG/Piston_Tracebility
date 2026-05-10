import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';
import {
  bindFilterInputs,
  buildLatestPerDmcCte,
  STATE_CASE_SQL,
} from '../db/state.js';
import { serializeDateTimeFields } from '../db/datetime.js';
import type { PaginatedResponse, PartListItem } from '../types/index.js';

// Sort whitelist — these are columns on the latest row plus derived columns.
// The values map to the SQL column name in the inner SELECT.
const SORT_COLUMNS: Record<string, string> = {
  Date_Time: 'Date_Time',
  Plant_Id: 'Plant_Id',
  DMC: 'DMC',
  Circlip_Result: 'Circlip_Result',
  Circlip_Time: 'Circlip_Time',
  Ring_Result: 'Ring_Result',
  Ring_Time: 'Ring_Time',
  Ring_Count: 'Ring_Count',
  Unloading_Time: 'Unloading_Time',
  Result: 'Result',
  state: 'state',
  total_attempts: 'total_attempts',
  reinspected: 'reinspected',
};

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

function buildTypeWhere(type: string | undefined): string {
  switch (type) {
    case 'passed':
      return "state IN ('PACKED','RING_OK')";
    case 'packed':
      return "state = 'PACKED'";
    case 'circlip_scrap':
      return "state = 'CIRCLIP_SCRAP'";
    case 'ring_rejected':
      return "state = 'RING_NG'";
    case 'in_progress':
      return "state = 'IN_PROGRESS'";
    case 'reinspected':
      return 'reinspected = 1';
    default:
      return '1 = 1';
  }
}

function buildBaseCte(query: ListQuery, request: import('mssql').Request): string {
  const conds = bindFilterInputs(request, query);
  if (query.search) {
    conds.push('DMC LIKE @search');
    request.input('search', `%${query.search}%`);
  }
  return buildLatestPerDmcCte(conds);
}

function classifiedSelect(): string {
  return `(
    SELECT
      l.Date_Time, l.Plant_Id, l.DMC, l.Circlip_Result, l.Circlip_Time,
      l.Ring_Result, l.Ring_Time, l.Ring_Count, l.Unloading_Time, l.Result,
      ${STATE_CASE_SQL} AS state,
      p.max_ring_count AS total_attempts,
      CASE WHEN p.max_ring_count > 1 THEN 1 ELSE 0 END AS reinspected
    FROM latest l
    INNER JOIN per_dmc p ON p.DMC = l.DMC
  ) AS x`;
}

export default async function listRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/list', async (req) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(200, Math.max(1, parseInt(req.query.size || '50', 10)));
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const offset = (page - 1) * size;
    const typeWhere = buildTypeWhere(req.query.type);

    const pool = await getPool();

    // Count
    const countRequest = pool.request();
    const countCte = buildBaseCte(req.query, countRequest);
    const countResult = await countRequest.query(`
      ${countCte}
      SELECT COUNT(*) AS total
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
    `);
    const total = countResult.recordset[0].total;

    // Data
    const dataRequest = pool.request();
    const dataCte = buildBaseCte(req.query, dataRequest);
    dataRequest.input('offset', offset);
    dataRequest.input('size', size);

    const dataResult = await dataRequest.query(`
      ${dataCte}
      SELECT *
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
      ORDER BY ${sortKey} ${order}
      OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY
    `);

    serializeDateTimeFields(dataResult.recordset);
    const data: PartListItem[] = dataResult.recordset.map((r: Record<string, unknown>) => ({
      Date_Time: r.Date_Time as string | null,
      Plant_Id: r.Plant_Id as string | null,
      DMC: r.DMC as string | null,
      Circlip_Result: r.Circlip_Result as string | null,
      Circlip_Time: r.Circlip_Time as string | null,
      Ring_Result: r.Ring_Result as string | null,
      Ring_Time: r.Ring_Time as string | null,
      Ring_Count: r.Ring_Count as number | null,
      Unloading_Time: r.Unloading_Time as string | null,
      Result: r.Result as string | null,
      state: r.state as PartListItem['state'],
      total_attempts: (r.total_attempts as number) ?? 0,
      reinspected: ((r.reinspected as number) ?? 0) === 1,
    }));

    const response: PaginatedResponse<PartListItem> = {
      data,
      total,
      page,
      size,
      total_pages: Math.ceil(total / size),
    };
    return response;
  });

  // CSV export — same filter set + same dedupe + same classification.
  app.get<{ Querystring: ListQuery }>('/export', async (req, reply) => {
    const sortKey = SORT_COLUMNS[req.query.sort || ''] || 'Date_Time';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const typeWhere = buildTypeWhere(req.query.type);

    const pool = await getPool();
    const request = pool.request();
    const cte = buildBaseCte(req.query, request);

    const result = await request.query(`
      ${cte}
      SELECT *
      FROM ${classifiedSelect()}
      WHERE ${typeWhere}
      ORDER BY ${sortKey} ${order}
    `);

    serializeDateTimeFields(result.recordset);
    const records = result.recordset.map((r: Record<string, unknown>) => ({
      ...r,
      reinspected: ((r.reinspected as number) ?? 0) === 1,
    }));

    if (records.length === 0) {
      reply.status(404);
      return { error: 'No records found for export' };
    }

    const headers = Object.keys(records[0]);
    const csvRows = [headers.join(',')];
    for (const record of records) {
      const values = headers.map((h) => {
        const val = (record as Record<string, unknown>)[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      });
      csvRows.push(values.join(','));
    }

    const csv = csvRows.join('\n');
    const bucket = req.query.type && req.query.type !== 'all' ? `_${req.query.type}` : '';
    reply.header('Content-Type', 'text/csv');
    reply.header(
      'Content-Disposition',
      `attachment; filename=sam_log${bucket}_${new Date().toISOString().slice(0, 10)}.csv`,
    );
    return csv;
  });
}
