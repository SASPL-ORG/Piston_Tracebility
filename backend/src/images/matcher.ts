import { getPool } from '../db/connection.js';
import { getImageConfig } from './config.js';

export type MatchResult = number | null | 'PENDING' | 'NO_MATCH';

interface MatchInput {
  fullDmc: string;
  inspectionType: 'CIRCLIP' | 'RING';
  capturedAt: Date;
}

// Resolves the parsed image to a SAM_Log inspection event.
//   number   → matched a ring inspection at that Ring_Count
//   null     → matched a circlip inspection (circlip uses ring_count = NULL)
//   PENDING  → no match yet, but within timeout — try again later
//   NO_MATCH → no match and past timeout — give up
export async function matchToSamLog(input: MatchInput): Promise<MatchResult> {
  const cfg = getImageConfig();
  const pool = await getPool();

  if (input.inspectionType === 'CIRCLIP') {
    const result = await pool
      .request()
      .input('dmc', input.fullDmc)
      .input('capturedAt', input.capturedAt)
      .input('tol', cfg.matchToleranceSeconds)
      .query(`
        SELECT TOP 1 1 AS found
        FROM dbo.SAM_Log
        WHERE DMC = @dmc
          AND Circlip_Time IS NOT NULL
          AND Circlip_Result IS NOT NULL
          AND ABS(DATEDIFF(SECOND,
                TRY_CONVERT(DATETIME2, Circlip_Time, 120),
                @capturedAt
              )) <= @tol
      `);

    if (result.recordset.length > 0) return null;
    return checkPending(input.capturedAt);
  }

  // RING — pick the closest Ring_Time within tolerance.
  const result = await pool
    .request()
    .input('dmc', input.fullDmc)
    .input('capturedAt', input.capturedAt)
    .input('tol', cfg.matchToleranceSeconds)
    .query(`
      SELECT TOP 1 Ring_Count
      FROM dbo.SAM_Log
      WHERE DMC = @dmc
        AND Ring_Time IS NOT NULL
        AND Ring_Result IS NOT NULL
        AND ABS(DATEDIFF(SECOND,
              TRY_CONVERT(DATETIME2, Ring_Time, 120),
              @capturedAt
            )) <= @tol
      ORDER BY ABS(DATEDIFF(SECOND,
                TRY_CONVERT(DATETIME2, Ring_Time, 120),
                @capturedAt
              )) ASC
    `);

  if (result.recordset.length > 0) {
    const rc = result.recordset[0].Ring_Count;
    return typeof rc === 'number' ? rc : null;
  }
  return checkPending(input.capturedAt);
}

function checkPending(capturedAt: Date): 'PENDING' | 'NO_MATCH' {
  const cfg = getImageConfig();
  const ageMinutes = (Date.now() - capturedAt.getTime()) / 60000;
  return ageMinutes < cfg.pendingTimeoutMinutes ? 'PENDING' : 'NO_MATCH';
}
