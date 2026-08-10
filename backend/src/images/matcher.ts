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
  const pool = await getPool();
  const capturedWall = toDbWallClock(input.capturedAt);

  if (input.inspectionType === 'CIRCLIP') {
    // DMC-FIRST: attach the image to its part's circlip inspection whenever
    // that inspection exists — NO time window. The DMC in the filename is the
    // part's true identity; the old ±tolerance window only ever caused false
    // quarantines when the PLC and camera clocks drifted apart. Circlip is
    // one-shot per part, so a row's mere existence is a definitive match.
    const result = await pool
      .request()
      .input('dmc', input.fullDmc)
      .query(`
        SELECT TOP 1 1 AS found
        FROM dbo.SAM_Log WITH (NOLOCK)
        WHERE DMC = @dmc AND Circlip_Result IS NOT NULL
      `);
    if (result.recordset.length > 0) return null;
    // Row not written yet (Node-RED lag / outage) — wait for it (see
    // checkPending; the window is long so a late row still resolves).
    return checkPending(input.capturedAt);
  }

  // RING — DMC-FIRST. Fetch every ring attempt recorded for this DMC.
  //   0 attempts → row not written yet → PENDING (wait for it)
  //   1 attempt  → attach unconditionally, no clock involved
  //   N attempts → route to the attempt whose Ring_Time is CLOSEST to the
  //                image's capturedAt. This is a RELATIVE comparison, so a
  //                constant camera↔PLC clock offset does NOT break it; time
  //                only ever disambiguates re-inspections of the same DMC.
  const result = await pool
    .request()
    .input('dmc', input.fullDmc)
    .input('capturedAt', capturedWall)
    .query(`
      SELECT Ring_Count,
        ABS(DATEDIFF(SECOND,
          TRY_CONVERT(DATETIME2, Ring_Time, 120),
          TRY_CONVERT(DATETIME2, @capturedAt, 120)
        )) AS delta
      FROM dbo.SAM_Log WITH (NOLOCK)
      WHERE DMC = @dmc AND Ring_Result IS NOT NULL AND Ring_Count IS NOT NULL
      ORDER BY CASE WHEN Ring_Time IS NULL THEN 1 ELSE 0 END, delta ASC
    `);

  if (result.recordset.length === 0) return checkPending(input.capturedAt);
  const rc = result.recordset[0].Ring_Count;
  return typeof rc === 'number' ? rc : null;
}

function checkPending(capturedAt: Date): 'PENDING' | 'NO_MATCH' {
  const cfg = getImageConfig();
  const ageMinutes = (Date.now() - capturedAt.getTime()) / 60000;
  return ageMinutes < cfg.pendingTimeoutMinutes ? 'PENDING' : 'NO_MATCH';
}
