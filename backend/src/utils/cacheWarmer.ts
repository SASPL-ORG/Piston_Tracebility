import { getPool } from '../db/connection.js';

// -----------------------------------------------------------------------------
// Buffer-pool keep-warm.
// -----------------------------------------------------------------------------
// The dashboard / lists / summary reports all scan SAM_Log for the selected
// date range + join Packed_Log_TEST. Those tables are SMALL (SAM_Log ~95K rows,
// Packed_Log_TEST ~10K), so the queries run in well under a second — WHEN their
// pages are in SQL Server's buffer pool. The problem: dbo.Image_Index has ~2.5M
// rows and the image indexer (many workers) churns it continuously. On SQL
// Server Express (buffer pool capped at ~1GB) that churn EVICTS the small
// reporting tables, and the next report query has to re-read them from disk —
// turning a 70ms query into ~9s until the pages are cached again.
//
// This task periodically runs the real report CTE for the current production
// month, which touches exactly the SAM_Log range pages + the Packed_Log_TEST
// scan the reports need — keeping them resident so a user's dashboard/list load
// stays fast even during heavy image indexing. It's cheap when warm (~70ms) and
// self-healing when cold (it eats the one slow read so the user doesn't).
//
// Independent of the HTTP response cache (that's handled by getOrComputeSWR) —
// this is purely about keeping the DB pages hot.

const INTERVAL_MS = parseInt(process.env.CACHE_WARM_INTERVAL_MS || '8000', 10);
let running = false;

// A deliberately CHEAP touch: full single-pass scans of the two small reporting
// tables, reading the heap columns the reports actually project (COUNT(col)
// forces the data/heap pages to be read, not just an index). On a ~95K-row and
// a ~10K-row table this is a fraction of a second even when the pages are cold
// on disk — so it can NEVER hit the query timeout, unlike the full report CTE
// (GROUP BY + join) which balloons to many seconds when cold. Keeping these
// pages resident is enough: the report's per-DMC aggregation is CPU-cheap once
// its inputs are in memory. Runs often so it wins the eviction race against the
// image indexer's Image_Index churn.
async function warmOnce(): Promise<void> {
  if (running) return; // never overlap
  running = true;
  try {
    const pool = await getPool();
    await pool.request().query(`
      SELECT COUNT(*) AS n, COUNT(Result) AS a, COUNT(Unloading_Time) AS b,
             COUNT(Ring_Result) AS c, COUNT(Circlip_Result) AS d,
             COUNT(Ring_Count) AS e, COUNT(Ring_Rejection_Reason) AS f,
             COUNT(Circlip_Rejection_Reason) AS g
      FROM dbo.SAM_Log WITH (NOLOCK)`);
    await pool.request().query(`
      SELECT COUNT(*) AS n, COUNT(DMC) AS d
      FROM dbo.Packed_Log_TEST WITH (NOLOCK) WHERE Is_Reject = 0`);
  } catch {
    // Non-fatal: a warm miss just means the next real query eats a cold read.
  } finally {
    running = false;
  }
}

export function initCacheWarmer(): void {
  setTimeout(() => void warmOnce(), 1500).unref();
  const t = setInterval(() => void warmOnce(), INTERVAL_MS);
  t.unref();
}
