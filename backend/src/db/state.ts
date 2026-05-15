import sql from 'mssql';

export type PartState = 'PACKED' | 'RING_OK' | 'RING_NG' | 'CIRCLIP_SCRAP' | 'IN_PROGRESS';

export interface SamLogRowForState {
  Circlip_Result: string | null;
  Ring_Result: string | null;
  Unloading_Time: string | null;
}

export function classifyState(latest: SamLogRowForState, hasCirclipFail: boolean): PartState {
  if (hasCirclipFail) return 'CIRCLIP_SCRAP';
  const ring = latest.Ring_Result;
  const unload = latest.Unloading_Time;
  if (ring === 'PASS' && unload !== null && unload !== '') return 'PACKED';
  if (ring === 'PASS') return 'RING_OK';
  if (ring === 'FAIL') return 'RING_NG';
  return 'IN_PROGRESS';
}

// SQL CASE expression equivalent to classifyState.
// Expects p.has_circlip_fail, l.Ring_Result, l.Unloading_Time in scope.
export const STATE_CASE_SQL = `CASE
  WHEN p.has_circlip_fail = 1 THEN 'CIRCLIP_SCRAP'
  WHEN l.Ring_Result = 'PASS' AND l.Unloading_Time IS NOT NULL AND l.Unloading_Time <> '' THEN 'PACKED'
  WHEN l.Ring_Result = 'PASS' THEN 'RING_OK'
  WHEN l.Ring_Result = 'FAIL' THEN 'RING_NG'
  ELSE 'IN_PROGRESS'
END`;

// Shift classification by latest-row Date_Time hour-of-day:
//   Shift A: 07:30 – 15:30   (450 <= minute-of-day < 930)
//   Shift B: 15:30 – 23:30   (930 <= minute-of-day < 1410)
//   Shift C: 23:30 – 07:30   (everything else — wraps midnight)
// Uses DATEPART, which reads l.Date_Time's stored components directly
// (SQL Server stored value is local time set by GETDATE() at insert).
export const SHIFT_CASE_SQL = `CASE
  WHEN (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) >= 450
   AND (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) <  930 THEN 'A'
  WHEN (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) >= 930
   AND (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) < 1410 THEN 'B'
  ELSE 'C'
END`;

export interface DmcFilter {
  from?: string;
  to?: string;
  plant?: string;
}

// Binds @from/@to/@plant on the request and returns the SAM_Log WHERE conditions.
export function bindFilterInputs(request: sql.Request, filters: DmcFilter): string[] {
  const conds: string[] = [];
  if (filters.from) {
    conds.push('Date_Time >= @from');
    request.input('from', filters.from);
  }
  if (filters.to) {
    conds.push('Date_Time <= @to');
    request.input('to', filters.to + ' 23:59:59.999');
  }
  if (filters.plant) {
    conds.push('Plant_Id = @plant');
    request.input('plant', filters.plant);
  }
  return conds;
}

// Returns a CTE prefix that yields:
//   filtered  - rows passing the SAM_Log filter
//   per_dmc   - one row per DMC: DMC, max_ring_count, has_circlip_fail, first_seen, last_seen
//   latest    - one row per DMC = the row with max(Ring_Count); contains all SAM_Log columns
//
// Use as: `${cte} SELECT ... FROM latest l INNER JOIN per_dmc p ON p.DMC = l.DMC ...`
export function buildLatestPerDmcCte(extraConditions: string[]): string {
  const conds = ['DMC IS NOT NULL', ...extraConditions];
  const where = `WHERE ${conds.join(' AND ')}`;
  return `WITH filtered AS (
    SELECT * FROM dbo.SAM_Log
    ${where}
  ),
  per_dmc AS (
    SELECT
      DMC,
      MAX(Ring_Count) AS max_ring_count,
      MAX(CASE WHEN Circlip_Result = 'FAIL' THEN 1 ELSE 0 END) AS has_circlip_fail,
      MIN(Date_Time) AS first_seen,
      MAX(Date_Time) AS last_seen
    FROM filtered
    GROUP BY DMC
  ),
  latest AS (
    SELECT f.*
    FROM filtered f
    INNER JOIN per_dmc p2 ON p2.DMC = f.DMC AND p2.max_ring_count = f.Ring_Count
  )`;
}
