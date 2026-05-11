import { getPool } from '../db/connection.js';
import { getImageConfig } from './config.js';

export type MatchResult = number | null | 'PENDING' | 'NO_MATCH';

interface MatchInput {
  fullDmc: string;
  inspectionType: 'CIRCLIP' | 'RING';
  capturedAt: Date;
}

// SAM_Log's Circlip_Time and Ring_Time are PLC-emitted wall-clock strings
// in the SCADA box's local timezone (no TZ info attached). The image's
// capturedAt is a true UTC instant from fs.stat. To compare like-for-like
// we format capturedAt using local-time components and parse both with
// TRY_CONVERT(DATETIME2, ..., 120) on the SQL side. Requires the container
// to run with TZ set to the SCADA box's timezone (e.g. Asia/Kolkata).
function toDbWallClock(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// Resolves the parsed image to a SAM_Log inspection event.
//   number   → matched a ring inspection at that Ring_Count
//   null     → matched a circlip inspection (circlip uses ring_count = NULL)
//   PENDING  → no match yet, but within timeout — try again later
//   NO_MATCH → no match and past timeout — give up
export async function matchToSamLog(input: MatchInput): Promise<MatchResult> {
  const cfg = getImageConfig();
  const pool = await getPool();

  const capturedWall = toDbWallClock(input.capturedAt);

  if (input.inspectionType === 'CIRCLIP') {
    const result = await pool
      .request()
      .input('dmc', input.fullDmc)
      .input('capturedAt', capturedWall)
      .input('tol', cfg.matchToleranceSeconds)
      .query(`
        SELECT TOP 1 1 AS found
        FROM dbo.SAM_Log
        WHERE DMC = @dmc
          AND Circlip_Time IS NOT NULL
          AND Circlip_Result IS NOT NULL
          AND ABS(DATEDIFF(SECOND,
                TRY_CONVERT(DATETIME2, Circlip_Time, 120),
                TRY_CONVERT(DATETIME2, @capturedAt, 120)
              )) <= @tol
      `);

    if (result.recordset.length > 0) return null;
    return checkPending(input.capturedAt);
  }

  // RING — asymmetric window: image's capturedAt is allowed to be up to
  // `pre` seconds BEFORE Ring_Time (CV-X may finish the file write a moment
  // before the PLC logs the result) and up to `tol` seconds AFTER. We pick
  // the LATEST Ring_Time inside the window — when attempts are close
  // together, an image written in attempt N's tail must stay on attempt N
  // and not cross over into attempt N+1's window.
  const result = await pool
    .request()
    .input('dmc', input.fullDmc)
    .input('capturedAt', capturedWall)
    .input('tol', cfg.matchToleranceSeconds)
    .input('pre', cfg.matchPreToleranceSeconds)
    .query(`
      SELECT TOP 1 Ring_Count
      FROM dbo.SAM_Log
      WHERE DMC = @dmc
        AND Ring_Time IS NOT NULL
        AND Ring_Result IS NOT NULL
        AND DATEDIFF(SECOND,
              TRY_CONVERT(DATETIME2, Ring_Time, 120),
              TRY_CONVERT(DATETIME2, @capturedAt, 120)
            ) >= -@pre
        AND DATEDIFF(SECOND,
              TRY_CONVERT(DATETIME2, Ring_Time, 120),
              TRY_CONVERT(DATETIME2, @capturedAt, 120)
            ) <= @tol
      ORDER BY TRY_CONVERT(DATETIME2, Ring_Time, 120) DESC
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
