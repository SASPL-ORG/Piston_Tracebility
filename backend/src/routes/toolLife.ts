import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';

// Per-tool dedupe window for the PLC notify call. The frontend fires
// the notify-exhausted POST as soon as it detects produced >= life on a
// 15-second poll, and multiple operators may have the Tool Life page
// open. The PLC only needs ONE "stop" signal per exhausted tool — and
// re-firing every 15s would spam Node-RED. This map remembers the last
// notify time per tool name and short-circuits anything inside the
// window. Survives only the backend process lifetime; container restarts
// reset it (acceptable — operator gets re-notified, PLC stays stopped).
const NOTIFY_DEDUPE_WINDOW_MS = 60_000;
const lastNotifyAt = new Map<string, number>();

// Returns the count of distinct parts produced since a given timestamp.
// "Produced" mirrors the dashboard's definition: a distinct DMC that has
// appeared in SAM_Log. Used by the Tool Life feature on the Maintenance
// page: when the operator enters a Life-in-Quantity for a tool, the UI
// captures `now` and then polls this endpoint to compute Quantity Left.
//
// The `ts` query param is an ISO-8601 timestamp in UTC (e.g. the value of
// `new Date().toISOString()` on the browser). SAM_Log.Date_Time is also
// stored in UTC (see backend/src/db/datetime.ts), so the comparison is
// apples-to-apples.
export default async function toolLifeRoutes(app: FastifyInstance) {
  // Startup-time config visibility — make it obvious from `docker logs`
  // whether the tool-life PLC signal will actually fire. The URL is
  // logged in full (it's a network address, not a secret); the token,
  // if set, is masked to just "configured".
  const startupUrl = process.env.NODE_RED_TOOL_LIFE_WEBHOOK_URL;
  const startupToken = process.env.NODE_RED_WEBHOOK_TOKEN;
  if (startupUrl) {
    app.log.info(
      `[tool-life] webhook configured: url='${startupUrl}' token=${startupToken ? 'configured' : 'unset'}`,
    );
  } else {
    app.log.warn(
      `[tool-life] webhook NOT configured — set NODE_RED_TOOL_LIFE_WEBHOOK_URL in .env to enable PLC stop signal`,
    );
  }

  app.get<{ Querystring: { ts?: string } }>('/tool-life/produced-since', async (req, reply) => {
    const ts = req.query.ts;
    if (!ts || isNaN(Date.parse(ts))) {
      reply.status(400);
      return { error: 'ts query param required as ISO-8601 timestamp' };
    }
    const pool = await getPool();
    // "Newly produced part since @ts" = a DMC whose FIRST row in SAM_Log is
    // at or after @ts. Counting plain rows would over-count because each
    // re-inspection adds another SAM_Log row with a fresh Date_Time, so
    // parts produced last week would inflate today's number whenever
    // they get re-inspected.
    //
    // SAM_Log.Date_Time is stored as IST wall-clock without a timezone tag.
    // The browser sends `new Date().toISOString()` which is a UTC instant.
    // Binding it as a JS Date lets the mssql driver send it as UTC and the
    // comparison silently shifts by 5h30m. Convert to the container's
    // local wall-clock (TZ=Asia/Kolkata) and bind as a string — same
    // pattern bindFilterInputs uses for the dashboard's from/to dates.
    const d = new Date(ts);
    const sqlTs =
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const result = await pool
      .request()
      .input('ts', sqlTs)
      .query(
        `SELECT COUNT(*) AS n FROM (
           SELECT DMC, MIN(Date_Time) AS first_seen
           FROM dbo.SAM_Log
           WHERE DMC IS NOT NULL
           GROUP BY DMC
         ) t
         WHERE first_seen >= @ts`,
      );
    const count: number = result.recordset[0]?.n ?? 0;
    return { count };
  });

  // Tool-life exhaustion signal — relays a stop command to the PLC via
  // a Node-RED webhook. The frontend calls this once per tool the first
  // time it detects produced >= life; dedupe below protects the PLC
  // against spam if multiple browsers fire concurrently or if the
  // operator dismisses + redetects.
  //
  // Webhook URL is supplied via NODE_RED_TOOL_LIFE_WEBHOOK_URL env var.
  // If unset, the endpoint logs a warning and returns 200 with
  // dispatched=false (so the frontend doesn't error-flash on systems
  // where the wiring isn't done yet). Optional auth header lives in
  // NODE_RED_WEBHOOK_TOKEN — sent as `Authorization: Bearer <token>`.
  app.post<{
    Body: { tool_id?: string; tool_name?: string; quantity_left?: number };
  }>('/tool-life/notify-exhausted', async (req, reply) => {
    const tool = String(req.body?.tool_name ?? req.body?.tool_id ?? '').trim();
    if (!tool) {
      reply.status(400);
      return { ok: false, error: 'tool_name required' };
    }
    const now = Date.now();
    const last = lastNotifyAt.get(tool);
    if (last && now - last < NOTIFY_DEDUPE_WINDOW_MS) {
      req.log.info(
        `[tool-life] notify-exhausted tool='${tool}' SKIPPED (within ${NOTIFY_DEDUPE_WINDOW_MS / 1000}s dedupe window)`,
      );
      return { ok: true, dispatched: false, dedupedAgainstAt: new Date(last).toISOString() };
    }

    const url = process.env.NODE_RED_TOOL_LIFE_WEBHOOK_URL;
    if (!url) {
      req.log.warn(
        `[tool-life] notify-exhausted tool='${tool}' but NODE_RED_TOOL_LIFE_WEBHOOK_URL is unset — no PLC signal sent`,
      );
      // Still mark it sent so the frontend doesn't keep retrying — the
      // missing config is an admin problem, not a transient one.
      lastNotifyAt.set(tool, now);
      return { ok: true, dispatched: false, error: 'webhook url not configured' };
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = process.env.NODE_RED_WEBHOOK_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const payload = {
      source: 'piston-traceability',
      event: 'tool_life_exhausted',
      tool_name: tool,
      quantity_left: req.body?.quantity_left ?? 0,
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      lastNotifyAt.set(tool, now);
      req.log.info(
        `[tool-life] notify-exhausted tool='${tool}' → POST ${url} → ${res.status}`,
      );
      if (!res.ok) {
        reply.status(502);
        return { ok: false, dispatched: false, webhookStatus: res.status };
      }
      return { ok: true, dispatched: true, webhookStatus: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error(
        `[tool-life] notify-exhausted tool='${tool}' → POST ${url} failed: ${msg}`,
      );
      // Don't dedupe on failure — the next poll should retry.
      reply.status(502);
      return { ok: false, dispatched: false, error: msg };
    }
  });
}
