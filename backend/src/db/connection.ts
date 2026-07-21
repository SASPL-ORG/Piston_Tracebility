import sql from 'mssql';

// =============================================================================
// SQL connection with auto-reconnect (self-heal).
//
// Why this exists: before this rewrite, getPool() created the connection
// pool once at startup. If SQL Server was still booting (SCADA box just
// rebooted), the initial connect failed, the pool got stuck broken, and
// every subsequent query failed with ECONNCLOSED until the container was
// manually restarted. This module retries with exponential backoff on
// startup and recreates the pool whenever it observes a dead connection.
// =============================================================================

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// Fallback logger before main.ts wires us up. Writes to console so the
// docker logs still capture early connect-loop output.
let log: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export function setConnectionLogger(l: Logger): void {
  log = l;
}

let pool: sql.ConnectionPool | null = null;
let connecting: Promise<sql.ConnectionPool> | null = null;
let healthy = false;
let lastConnectAt = 0;
let lastErrorAt = 0;
let lastErrorMsg = '';

export interface ConnectionStatus {
  connected: boolean;
  lastConnectAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  host: string;
}

function parseDbHost(host: string): { server: string; instanceName?: string } {
  const parts = host.split('\\');
  if (parts.length === 2) return { server: parts[0], instanceName: parts[1] };
  return { server: host };
}

function buildConfig(): sql.config {
  const dbHost = process.env.DB_HOST || 'localhost';
  const { server, instanceName } = parseDbHost(dbHost);
  return {
    server,
    port: parseInt(process.env.DB_PORT || '1433', 10),
    database: process.env.DB_NAME || 'SAM',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
      ...(instanceName ? { instanceName } : {}),
    },
    requestTimeout: 30000,
    connectionTimeout: 15000,
    pool: {
      // Bumped from 20 → 40 so 16 image workers can each hold a
      // connection without starving the HTTP endpoints. If SQL Server
      // Express's own limit is hit, error out cleanly (better than
      // silent deadlock at the pool layer).
      max: parseInt(process.env.DB_POOL_MAX || '40', 10),
      min: 2,
      idleTimeoutMillis: 30000,
    },
  };
}

function markUnhealthy(err: Error): void {
  if (!healthy) return; // already marked, avoid log spam
  healthy = false;
  lastErrorAt = Date.now();
  lastErrorMsg = err.message;
  log.warn(`[db] SQL connection lost: ${err.message} — will reconnect on next query`);
  // Close the pool (best-effort) so the next getPool() recreates it cleanly.
  const dead = pool;
  pool = null;
  if (dead) dead.close().catch(() => undefined);
}

// Single attempt to build + connect a fresh pool. Throws on failure so the
// caller can implement the backoff loop.
async function connectOnce(): Promise<sql.ConnectionPool> {
  const config = buildConfig();
  const newPool = new sql.ConnectionPool(config);
  // Listen for connection errors that surface after the initial connect —
  // e.g. SQL Server restart while the backend is running.
  newPool.on('error', (err: Error) => markUnhealthy(err));
  await newPool.connect();
  // Smoke test: a SELECT 1 catches situations where connect() returns OK
  // but the connection is half-open.
  await newPool.request().query('SELECT 1');
  return newPool;
}

// Connect with exponential backoff. Never throws — keeps retrying until
// it succeeds. The first call from getPool() blocks; subsequent callers
// (during the same retry storm) get the same promise via the `connecting`
// dedup, so we only have one connect loop at a time.
async function connectWithBackoff(): Promise<sql.ConnectionPool> {
  const dbHost = process.env.DB_HOST || 'localhost';
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      const p = await connectOnce();
      healthy = true;
      lastConnectAt = Date.now();
      log.info(`[db] SQL connected to ${dbHost} (attempt ${attempt})`);
      return p;
    } catch (err) {
      const msg = (err as Error).message;
      lastErrorAt = Date.now();
      lastErrorMsg = msg;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      log.error(
        `[db] SQL connect attempt ${attempt} failed: ${msg} — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && healthy) return pool;
  if (connecting) return connecting;
  connecting = connectWithBackoff()
    .then((p) => {
      pool = p;
      return p;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

// Snapshot of current connection health for /health.
export function getConnectionStatus(): ConnectionStatus {
  return {
    connected: healthy && pool !== null,
    lastConnectAt: lastConnectAt > 0 ? new Date(lastConnectAt).toISOString() : null,
    lastErrorAt: lastErrorAt > 0 ? new Date(lastErrorAt).toISOString() : null,
    lastErrorMsg: lastErrorMsg || null,
    host: process.env.DB_HOST || 'localhost',
  };
}

export async function closePool(): Promise<void> {
  const dead = pool;
  pool = null;
  healthy = false;
  if (dead) await dead.close().catch(() => undefined);
}
