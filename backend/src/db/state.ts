import sql from 'mssql';
import { getHideBeforeCached } from '../utils/hideState.js';
import { hiddenDmcInClause } from '../utils/hiddenParts.js';

// PartState has two stages along the "passed inspection" axis:
//   COMPLETED — line says "all stations passed + part unloaded". This is
//               what we used to call 'PACKED' before the Zebra packing
//               station was wired in.
//   PACKED    — has a non-reject row in dbo.Packed_Log_TEST. Implies
//               COMPLETED but adds that the operator physically packed
//               the piston into a bin.
// SQL queries derive PACKED via a LEFT JOIN with Packed_Log_TEST plus a
// wrapped state expression — see packedJoinSql + STATE_CASE_SQL_DISPLAY
// below. Bucket queries (passed / failed / in_progress) keep using
// STATE_CASE_SQL untouched, because for inspection-bucketing purposes
// COMPLETED and PACKED are the same thing.
export type PartState =
  | 'PACKED'
  | 'COMPLETED'
  | 'RING_OK'
  | 'RING_NG'
  | 'CIRCLIP_SCRAP'
  | 'IN_PROGRESS'
  // ABORTED — only a loading scan exists and the piston never reached the
  // circlip station (no circlip data). It was picked / faulted at loading, so
  // it is NOT genuinely in progress. Split out per the client's rule: a piston
  // only counts as IN_PROGRESS once it has reached circlip assembly.
  | 'ABORTED';

export interface SamLogRowForState {
  Circlip_Result: string | null;
  Circlip_Time?: string | null;
  Ring_Result: string | null;
  Unloading_Time: string | null;
  Result: string | null;
  Circlip_Rejection_Reason?: string | null;
  Ring_Rejection_Reason?: string | null;
}

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------
// When a station rejects a part it writes the cause into
// Circlip_Rejection_Reason / Ring_Rejection_Reason. Crucially it does NOT
// always also set Circlip_Result='FAIL' — for reasons raised before the
// inspection completes (recipe/barcode mismatch, abnormal part, groove
// anodizing missing, already-processed) the Result column stays NULL. Those
// parts stop dead at the station, but the old classifier only looked at
// Circlip_Result and so reported them as IN_PROGRESS forever.
//
// "No rejection" is written three different ways by the line — NULL, 'NA'
// and 'PASS' — so the rule is: a reason counts as a rejection unless it is
// one of those sentinels.
const REASON_SENTINELS = new Set(['NA', 'PASS']);

// Commissioning/test strings that leaked into production data. They are not
// real rejections, so they must not inflate the scrap counts. Kept as an
// explicit list: anything NOT matched here still counts as a rejection, so a
// genuinely new reason can never silently fall back to IN_PROGRESS.
const REASON_TEST_VALUES = new Set(['R1', 'R2', 'R5', 'AB', 'TEST', 'TEST1', 'TEST4', 'SAM']);

export function isRejectionReason(reason: string | null | undefined): boolean {
  if (reason === null || reason === undefined) return false;
  const v = reason.trim().toUpperCase();
  if (v === '') return false;
  return !REASON_SENTINELS.has(v) && !REASON_TEST_VALUES.has(v);
}

// "Did the circlip station reject this part?" across ALL rows of a DMC —
// the reject may be recorded on row 0 while the latest row is a ring attempt.
// Single source of truth for the several callers that used to hand-roll
// `records.some(r => r.Circlip_Result === 'FAIL')` and so missed
// reason-only rejections.
export function hasCirclipRejection(
  rows: Array<{ Circlip_Result: string | null; Circlip_Rejection_Reason?: string | null }>,
): boolean {
  return rows.some(
    (r) => r.Circlip_Result === 'FAIL' || isRejectionReason(r.Circlip_Rejection_Reason),
  );
}

// SQL twin of isRejectionReason(). `col` is a fully-qualified column
// reference, e.g. 'l.Ring_Rejection_Reason'. Kept next to the TS version so
// the two can't drift.
export function rejectionReasonSql(col: string): string {
  const excluded = [...REASON_SENTINELS, ...REASON_TEST_VALUES]
    .map((v) => `'${v}'`)
    .join(', ');
  return `(${col} IS NOT NULL AND LTRIM(RTRIM(${col})) <> '' AND UPPER(LTRIM(RTRIM(${col}))) NOT IN (${excluded}))`;
}

// The PLC's Result column is the authoritative final verdict. If it says
// PASS and the part has been unloaded, the line considers the part good
// — regardless of any earlier circlip fail (operator override workflow)
// or a missing Ring_Result row.
function plcMarkedGood(latest: SamLogRowForState): boolean {
  return (
    latest.Result === 'PASS' &&
    latest.Unloading_Time !== null &&
    latest.Unloading_Time !== ''
  );
}

// Line-side state — returns 'PACKED' for inspection-finished parts. This
// is the lower-level signal that ignores whether the operator has Zebra-
// packed the piston into a bin. Callers that need the display-level
// state (split into COMPLETED vs PACKED) should compose this with their
// own packed-log check.
export function classifyState(latest: SamLogRowForState, hasCirclipFail: boolean): PartState {
  // Honour the PLC's final verdict first. An operator-override part has
  // Circlip_Result=FAIL recorded but Result=PASS and Unloading_Time set —
  // we treat it as PACKED.
  if (plcMarkedGood(latest)) return 'PACKED';
  // A circlip rejection reason is as final as Circlip_Result='FAIL' — the
  // part is stopped at the station and never reaches the ring.
  if (hasCirclipFail || isRejectionReason(latest.Circlip_Rejection_Reason)) return 'CIRCLIP_SCRAP';
  const ring = latest.Ring_Result;
  const unload = latest.Unloading_Time;
  const unloaded = unload !== null && unload !== '';
  if (ring === 'PASS' && unloaded) return 'PACKED';
  if (ring === 'PASS') return 'RING_OK';
  // Same treatment on the ring side. Checked after the PASS branches so an
  // explicit PASS always wins over a stale reason string.
  if (ring === 'FAIL' || isRejectionReason(latest.Ring_Rejection_Reason)) return 'RING_NG';
  if (unloaded) return 'PACKED';
  // Reached the circlip station (any circlip data recorded) → genuinely in
  // progress. Only a loading scan with no circlip data → ABORTED (picked /
  // faulted at loading).
  const reachedCirclip = latest.Circlip_Result != null || latest.Circlip_Time != null;
  return reachedCirclip ? 'IN_PROGRESS' : 'ABORTED';
}

// Display-level wrapper around classifyState — splits the line-side
// 'PACKED' verdict into 'PACKED' (operator scanned the piston at the
// Zebra packing station) or 'COMPLETED' (line says it's done but the
// operator hasn't packed it yet). Used by callers that present state
// to the user instead of using it for inspection bucketing.
export function classifyDisplayState(
  latest: SamLogRowForState,
  hasCirclipFail: boolean,
  isPacked: boolean,
): PartState {
  const lineState = classifyState(latest, hasCirclipFail);
  if (lineState !== 'PACKED') return lineState;
  return isPacked ? 'PACKED' : 'COMPLETED';
}

// SQL CASE expression equivalent to classifyState.
// Expects p.has_circlip_fail, p.has_circlip_pass, l.Ring_Result,
// l.Unloading_Time, l.Result in scope. CIRCLIP_SCRAP triggers only when
// there was a circlip fail, NO later circlip pass, AND the PLC's overall
// Result wasn't PASS (operator-override parts get classified as PACKED).
//
// Outputs the LINE-side state — 'PACKED' here means "line-finished",
// i.e. what the rest of this file calls COMPLETED in PartState. The
// outward-facing /lists and /dashboard state column uses
// STATE_CASE_SQL_DISPLAY (below) to split that into COMPLETED vs PACKED
// based on Packed_Log_TEST presence; everything else (bucket counts,
// passed/failed math) keeps using this unchanged because for those
// purposes the distinction doesn't matter.
export const STATE_CASE_SQL = `CASE
  WHEN l.Result = 'PASS' AND l.Unloading_Time IS NOT NULL AND l.Unloading_Time <> '' THEN 'PACKED'
  WHEN (p.has_circlip_fail = 1 OR p.has_circlip_reject = 1) AND p.has_circlip_pass = 0 THEN 'CIRCLIP_SCRAP'
  WHEN l.Ring_Result = 'PASS' AND l.Unloading_Time IS NOT NULL AND l.Unloading_Time <> '' THEN 'PACKED'
  WHEN l.Ring_Result = 'PASS' THEN 'RING_OK'
  WHEN l.Ring_Result = 'FAIL' OR ${rejectionReasonSql('l.Ring_Rejection_Reason')} THEN 'RING_NG'
  WHEN l.Unloading_Time IS NOT NULL AND l.Unloading_Time <> '' THEN 'PACKED'
  -- Reached the circlip station (any circlip data recorded) but not finished →
  -- genuinely IN_PROGRESS. Only a loading scan with no circlip data → ABORTED
  -- (picked / faulted at loading), per the client's circlip-assembly rule.
  WHEN l.Circlip_Result IS NOT NULL OR l.Circlip_Time IS NOT NULL
       OR p.has_circlip_pass = 1 OR p.has_circlip_fail = 1 OR p.has_circlip_reject = 1 THEN 'IN_PROGRESS'
  ELSE 'ABORTED'
END`;

// LEFT JOIN against Packed_Log_TEST that surfaces a 0/1 "is_packed" flag
// per latest DMC. Use in queries that need the display-level state. The
// derived table dedupes by DMC so a DMC packed-then-unpacked-then-packed
// still shows up as packed once (we filter Is_Reject = 0 — reject scans
// don't claim the bin slot). WITH (NOLOCK) — same rationale as SAM_Log
// above: reporting queries tolerate dirty reads.
// "Was this DMC's snap ring re-inspected?" — shared by the dashboard KPI,
// the Lists summary matrix and the Lists reinspected filter so the three
// can't drift. Fires on Circlip_Count > 1 (the real signal, see the CTE)
// OR the legacy fail-then-pass pair (the handful of parts that did keep a
// FAIL row). Expects p.max_circlip_count / p.has_circlip_fail /
// p.has_circlip_pass in scope.
export const CIRCLIP_REINSPECTED_SQL =
  '(p.max_circlip_count > 1 OR (p.has_circlip_fail = 1 AND p.has_circlip_pass = 1))';

export const PACKED_LOG_JOIN_SQL = `
  LEFT JOIN (
    SELECT DISTINCT DMC FROM dbo.Packed_Log_TEST WITH (NOLOCK) WHERE Is_Reject = 0
  ) pl ON pl.DMC = l.DMC`;

// Display-level state — splits STATE_CASE_SQL's 'PACKED' into either
// 'PACKED' (Zebra-packed) or 'COMPLETED' (line-finished but not yet
// scanned by the operator). Pairs with PACKED_LOG_JOIN_SQL which makes
// pl.DMC available in scope.
export const STATE_CASE_SQL_DISPLAY = `CASE
  WHEN pl.DMC IS NOT NULL THEN 'PACKED'
  WHEN ${STATE_CASE_SQL} = 'PACKED' THEN 'COMPLETED'
  ELSE ${STATE_CASE_SQL}
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

// Production-day variant of the filter binding. Used by the dashboard so a
// "date" in the URL maps to [date 07:00, (date+1) 07:00) — meaning all three
// shifts of that production date are in scope, including Shift C which
// spans midnight into the next calendar date. The 07:00 boundary aligns
// with Shift A start.
export function bindProductionDayFilterInputs(
  request: sql.Request,
  filters: DmcFilter,
): string[] {
  const conds: string[] = [];
  if (filters.from) {
    conds.push('Date_Time >= @prod_start');
    request.input('prod_start', `${filters.from} 07:00:00`);
  }
  if (filters.to) {
    // Half-open upper bound: (to + 1 day) 07:00 — so the inclusive "to" date
    // covers its own Shift C all the way into the next morning.
    conds.push("Date_Time < DATEADD(DAY, 1, @prod_end_anchor)");
    request.input('prod_end_anchor', `${filters.to} 07:00:00`);
  }
  if (filters.plant) {
    conds.push('Plant_Id = @plant');
    request.input('plant', filters.plant);
  }
  return conds;
}

// Shift classification by latest-row Date_Time hour-of-day. Used in
// combination with bindProductionDayFilterInputs so the windows align with
// the production-day boundaries:
//   Shift A: 07:00 – 15:30  ([420, 931))
//   Shift B: 15:31 – 23:59  ([931, 1440))
//   Shift C: 00:00 – 06:59  ([0, 420))
// Inside the production-day window for date X, Shift C's pre-07:00 portion
// belongs to X (not X+1) because of the production-day boundary.
export const SHIFT_CASE_SQL = `CASE
  WHEN (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) >= 420
   AND (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) <  931 THEN 'A'
  WHEN (DATEPART(HOUR, l.Date_Time) * 60 + DATEPART(MINUTE, l.Date_Time)) >= 931 THEN 'B'
  ELSE 'C'
END`;

// Outer-WHERE fragment for the shift toggle. Returns `1 = 1` when shift is
// undefined ("All" scope). When a specific shift is requested, this filters
// the per-DMC result set by the latest row's shift — so each part is
// attributed to exactly one shift and the sum invariant
// (All = Shift A + Shift B + Shift C) holds.
//
// MUST be applied AFTER `latest`/`per_dmc` have been computed (i.e. in the
// outer SELECT's WHERE) — never inside `filtered`, which would dedup parts
// per-shift and break the invariant.
export function shiftWhereSql(shift: 'A' | 'B' | 'C' | undefined): string {
  if (!shift) return '1 = 1';
  return `${SHIFT_CASE_SQL} = '${shift}'`;
}

// Same logic as SHIFT_CASE_SQL but references a raw Date_Time column instead
// of `l.Date_Time` — for use against `dbo.SAM_Log` directly when we want
// event-level (rather than per-DMC) counts to match HMI semantics.
const SHIFT_CASE_SQL_RAW = `CASE
  WHEN (DATEPART(HOUR, Date_Time) * 60 + DATEPART(MINUTE, Date_Time)) >= 420
   AND (DATEPART(HOUR, Date_Time) * 60 + DATEPART(MINUTE, Date_Time)) <  931 THEN 'A'
  WHEN (DATEPART(HOUR, Date_Time) * 60 + DATEPART(MINUTE, Date_Time)) >= 931 THEN 'B'
  ELSE 'C'
END`;

export function shiftWhereSqlRaw(shift: 'A' | 'B' | 'C' | undefined): string {
  if (!shift) return '1 = 1';
  return `${SHIFT_CASE_SQL_RAW} = '${shift}'`;
}

// --- DMC separator reduction --------------------------------------------
// A packing-station scan arrives as the raw ISO/IEC 15434 envelope with its
// control-byte separators intact (Android Chrome keeps them), e.g.
//   [)> <RS> 06 <GS> VTH16 <GS> ... <GS> DB73 <GS> <RS> <EOT>
// whereas Node-RED stores those separators rewritten to printable '.' (RS)
// and '-' (GS) and drops the trailing GS/RS/EOT:
//   [)>.06-VTH16-...-DB73
// To match a scan against the stored key we delete every separator from BOTH
// sides and compare the remainder. This MUST stay in sync with
// normalizeScannedDmc() in frontend/src/lib/api.ts — same character set.

// The separator chars enumerated for SQL TRANSLATE: '.', '-', space, then the
// ISO-15434 control bytes (EOT 0x04, FS 0x1C, GS 0x1D, RS 0x1E, US 0x1F) and
// TAB/CR/LF. Bind this as an nvarchar param; chars not present in a given
// value are simply left untouched by TRANSLATE.
export const DMC_SEPARATOR_CHARS =
  '.- ' + String.fromCharCode(4, 28, 29, 30, 31, 9, 13, 10);

// TS-side reduction (mirror of the client regex /[\x00-\x20\x7f.\-]/g): delete
// all C0 control chars, DEL, space, '.' and '-'. Everything else - including
// the "[)>06" header and the alphanumeric payload - is preserved.
export function stripDmcSeparators(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x20\x7f.\-]/g, '');
}

// Rebuild the CANONICAL stored key from a raw ISO/IEC 15434 scan, the way
// Node-RED stored it at loading: RS (0x1E) -> '.', GS (0x1D) -> '-', drop the
// remaining control bytes (EOT etc.) and any trailing separators. This lets a
// raw packing/Part-Trace scan hit the indexed DMC column with an EXACT match
// instead of the non-sargable REPLACE(TRANSLATE(...)) full-table scan — turning
// a multi-second lookup into a sub-millisecond one. If the transform ever fails
// to match (Node-RED changes its storage), callers keep the separator-
// insensitive scan as a correctness fallback, so this can only ever speed
// things up, never break a match.
export function canonicalizeDmcScan(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/\x1e/g, '.').replace(/\x1d/g, '-');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, ''); // strip remaining control bytes
  s = s.replace(/[.\-\s]+$/, ''); // drop trailing separators / whitespace
  return s;
}
// Returns a CTE prefix that yields:
//   filtered  - rows passing the SAM_Log filter
//   per_dmc   - one row per DMC: DMC, max_ring_count, has_circlip_fail,
//               has_circlip_pass, first_seen, last_seen
//   latest    - one row per DMC = the row with max(Ring_Count); contains all SAM_Log columns
//
// has_circlip_pass lets the classifier distinguish a part that failed
// circlip once but was later passed by reinspection (NOT scrap) from one
// that genuinely never passed circlip (CIRCLIP_SCRAP).
//
// Use as: `${cte} SELECT ... FROM latest l INNER JOIN per_dmc p ON p.DMC = l.DMC ...`
export function buildLatestPerDmcCte(extraConditions: string[]): string {
  const conds = ['DMC IS NOT NULL', ...extraConditions];
  // "Demo hide" cutoff — reversible, display-only. When set, every read that
  // flows through this CTE (Dashboard + Lists) hides rows dated before the
  // cutoff. The value is strictly validated ('YYYY-MM-DD HH:mm:ss') in
  // hideState, so inlining it as a literal here is injection-safe. Clearing
  // the cutoff (reveal) makes all history reappear — nothing is ever deleted.
  const hideBefore = getHideBeforeCached();
  if (hideBefore) conds.push(`Date_Time >= '${hideBefore}'`);
  // "Hidden parts" — reversible, display-only removal of specific DMCs. Same
  // safety model as the demo cutoff above: the list is strictly validated in
  // hiddenParts, so the inlined `DMC NOT IN (...)` literal is injection-safe.
  // Covers Dashboard + Lists (both flow through this CTE); nothing is deleted.
  const hiddenDmcs = hiddenDmcInClause('DMC');
  if (hiddenDmcs) conds.push(hiddenDmcs);
  const where = `WHERE ${conds.join(' AND ')}`;
  // per_dmc folds in the snap-ring recovery aggregates so the Lists page
  // can render Circlip_Result/Time for re-inspected parts without an
  // extra LEFT JOIN + ROW_NUMBER() subquery — at 200K+ rows that join's
  // sort was the main scaling bottleneck. The MIN(CASE) trick gives us
  // the earliest PASS/FAIL Circlip_Time per DMC in the same aggregate
  // pass that already computes has_circlip_pass / has_circlip_fail.
  //
  // WITH (NOLOCK) hint — SAM_Log is under heavy concurrent write
  // pressure (PLC via Node-RED writes continuously, image indexer
  // reads/joins for CV-X matching). Reporting queries take reader
  // locks and get stuck behind those writes; dashboard endpoints then
  // time out at 30s. Reporting can tolerate dirty reads (a row-level
  // uncommitted read at worst gives us a slightly-stale row) — that
  // trade is what NOLOCK/READ UNCOMMITTED buys us.
  return `WITH filtered AS (
    SELECT * FROM dbo.SAM_Log WITH (NOLOCK)
    ${where}
  ),
  per_dmc AS (
    SELECT
      DMC,
      MAX(Ring_Count) AS max_ring_count,
      MAX(CASE WHEN Circlip_Result = 'FAIL' THEN 1 ELSE 0 END) AS has_circlip_fail,
      MAX(CASE WHEN Circlip_Result = 'PASS' THEN 1 ELSE 0 END) AS has_circlip_pass,
      -- Circlip re-inspection is recorded by INCREMENTING Circlip_Count on
      -- the same row (Node-RED overwrites Circlip_Result FAIL->PASS), NOT by
      -- adding a FAIL row the way ring attempts add rows. So the earlier
      -- has_circlip_fail/has_circlip_pass pair almost never both fire, and
      -- Circlip_Count is the real signal for "snap ring was re-inspected".
      MAX(ISNULL(Circlip_Count, 0)) AS max_circlip_count,
      -- A circlip rejection reason on ANY row of the DMC stops the part at
      -- the station even when Circlip_Result was never written.
      MAX(CASE WHEN ${rejectionReasonSql('Circlip_Rejection_Reason')} THEN 1 ELSE 0 END) AS has_circlip_reject,
      MIN(Date_Time) AS first_seen,
      MAX(Date_Time) AS last_seen,
      MIN(CASE WHEN Circlip_Result = 'PASS' THEN Circlip_Time END) AS first_pass_circlip_time,
      MIN(CASE WHEN Circlip_Result = 'FAIL' THEN Circlip_Time END) AS first_fail_circlip_time
    FROM filtered
    GROUP BY DMC
  ),
  latest AS (
    SELECT f.*
    FROM filtered f
    INNER JOIN per_dmc p2 ON p2.DMC = f.DMC AND p2.max_ring_count = f.Ring_Count
  )`;
}
