import { getPool } from '../db/connection.js';

// Writes a row to dbo.Alarm_Log. Best-effort — alarm-logging failures must
// never bubble up and crash the indexer.
export async function logAlarm(
  code: string,
  dmc: string | null,
  source: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('code', code)
      .input('dmc', dmc)
      .input('source', source)
      .input('payload', JSON.stringify(payload))
      .query(`
        INSERT INTO dbo.Alarm_Log (alarm_code, DMC, source, payload_json, ts)
        VALUES (@code, @dmc, @source, @payload, SYSDATETIME())
      `);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[alarms] failed to log alarm', code, (err as Error).message);
  }
}
