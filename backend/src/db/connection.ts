import sql from 'mssql';

let pool: sql.ConnectionPool | null = null;

function parseDbHost(host: string): { server: string; instanceName?: string } {
  const parts = host.split('\\');
  if (parts.length === 2) {
    return { server: parts[0], instanceName: parts[1] };
  }
  return { server: host };
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool) return pool;

  const dbHost = process.env.DB_HOST || 'localhost';
  const { server, instanceName } = parseDbHost(dbHost);

  const config: sql.config = {
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
  };

  pool = new sql.ConnectionPool(config);
  await pool.connect();
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}
