import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db/connection.js';
import { classifyState, hasCirclipRejection, stripDmcSeparators, canonicalizeDmcScan, DMC_SEPARATOR_CHARS } from '../db/state.js';
import { serializeDateTime } from '../db/datetime.js';
import { classifyShift, type ShiftId } from '../config/shifts.js';
import type { SamLogRecord } from '../types/index.js';

// Packing-station verification + pack signal (README_MOBILE_SCANNER.md).
// The mobile app forwards the RAW scanned string (ISO/IEC 15434 envelope with
// control bytes intact) in a JSON body; normalization + SAM_Log matching live
// here (single source of truth). Pack records go to a separate, additive
// dbo.Packed_Log_TEST table — no existing data is touched.

const P_CODE_RE = /P234102M[0-9A-Z]{3}/;

interface ScanBody {
  scan?: string;
  reject?: boolean;
}

// Resolve a raw scan to its SAM_Log rows. Mirrors the fallback in
// routes/parts.ts fetchPartRecords: exact match first (in case a clean stored
// key is sent), then a separator-insensitive match where both sides are
// reduced with the same character set as stripDmcSeparators.
async function fetchByScan(scan: string): Promise<SamLogRecord[]> {
  const pool = await getPool();
  const order = 'ORDER BY ISNULL(Ring_Count, 0) ASC, Date_Time ASC';

  const exact = await pool
    .request()
    .input('dmc', scan)
    .query(`SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ${order}`);
  if (exact.recordset.length > 0) return exact.recordset as SamLogRecord[];

  // FAST PATH: rebuild the canonical stored key from the raw envelope and
  // exact-match the indexed DMC column. This is how the loading node stored it,
  // so it lands directly — replacing the multi-second full-table scan below on
  // every packing scan. The scan fallback stays as a correctness safety net.
  const canonical = canonicalizeDmcScan(scan);
  if (canonical && canonical !== scan) {
    const canon = await pool
      .request()
      .input('dmc', canonical)
      .query(`SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ${order}`);
    if (canon.recordset.length > 0) return canon.recordset as SamLogRecord[];
  }

  const norm = stripDmcSeparators(scan);
  if (!norm) return [];
  const reduced = await pool
    .request()
    .input('norm', norm)
    .input('seps', DMC_SEPARATOR_CHARS)
    .query(
      `SELECT * FROM dbo.SAM_Log
       WHERE REPLACE(TRANSLATE(DMC, @seps, REPLICATE(CHAR(1), LEN(@seps))), CHAR(1), '') = @norm
       ${order}`,
    );
  return reduced.recordset as SamLogRecord[];
}

// Derive the classified state from a part's ordered rows (mirrors parts.ts:
// the circlip PASS/Time only lives on the first row, so merge it onto latest).
function deriveState(records: SamLogRecord[]) {
  const lastRow = records[records.length - 1];
  const hasCirclipFail = hasCirclipRejection(records);
  const circlipRow =
    records.find((r) => r.Circlip_Result === 'PASS') ??
    records.find((r) => r.Circlip_Result !== null);
  const latest = {
    ...lastRow,
    Circlip_Result: lastRow.Circlip_Result ?? circlipRow?.Circlip_Result ?? null,
    Circlip_Time: lastRow.Circlip_Time ?? circlipRow?.Circlip_Time ?? null,
  };
  return classifyState(latest, hasCirclipFail);
}

// Returns the stored DMC key for a resolved part (the last row's DMC).
function storedKey(records: SamLogRecord[]): string {
  return records[records.length - 1].DMC ?? '';
}

function pCodeOf(...sources: (string | null | undefined)[]): string | null {
  for (const s of sources) {
    const m = (s ?? '').match(P_CODE_RE);
    if (m) return m[0];
  }
  return null;
}

// Operator-facing summary of "what happened to this part on the line",
// returned alongside the verdict so the Zebra screen can show the snap-ring
// + ring-inspection status, the production date and the shift that ran
// the part. Inspection-result mapping: PASS→OK, FAIL→FAIL, null→null
// (display as "—" or hide depending on UI). Shift is derived from
// Date_Time using the same boundaries as the dashboard (07:00 / 15:31 /
// 23:59) so the operator sees the SAME shift the dashboard reports.
export interface PartInfoForOperator {
  partNumber: string | null;
  snapRingStatus: 'OK' | 'FAIL' | null;
  ringInspectionStatus: 'OK' | 'FAIL' | null;
  processedAt: string | null;
  shift: ShiftId | null;
  productionDate: string | null;
  machine: number | null;   // SAM_Log.Line_ID — which line (1/2) produced the part
}

const EMPTY_PART_INFO: PartInfoForOperator = {
  partNumber: null,
  snapRingStatus: null,
  ringInspectionStatus: null,
  processedAt: null,
  shift: null,
  productionDate: null,
  machine: null,
};

function normalizeInspectionResult(raw: string | null | undefined): 'OK' | 'FAIL' | null {
  if (raw === 'PASS') return 'OK';
  if (raw === 'FAIL') return 'FAIL';
  return null;
}

function buildPartInfo(records: SamLogRecord[]): PartInfoForOperator {
  if (records.length === 0) return EMPTY_PART_INFO;
  const last = records[records.length - 1];
  // Snap ring (= Circlip) result lives on the row that actually ran the
  // circlip step, which isn't always the latest row — same merge rule as
  // deriveState above. Treat any FAIL in the chain as FAIL.
  const hasCirclipFail = hasCirclipRejection(records);
  const circlipRow =
    records.find((r) => r.Circlip_Result === 'PASS') ??
    records.find((r) => r.Circlip_Result !== null);
  const snapRingRaw = hasCirclipFail ? 'FAIL' : (last.Circlip_Result ?? circlipRow?.Circlip_Result ?? null);

  const processedAt = serializeDateTime(last.Date_Time);
  const cls = classifyShift(processedAt);
  return {
    partNumber: pCodeOf(last.DMC),
    snapRingStatus: normalizeInspectionResult(snapRingRaw),
    ringInspectionStatus: normalizeInspectionResult(last.Ring_Result),
    processedAt,
    shift: cls?.shift ?? null,
    productionDate: cls?.productionDay ?? null,
    machine: last.Line_ID ?? null,
  };
}

// If this DMC already has a non-reject pack row, return its IST packedAt.
// Tolerant of the pack-log table being absent / not yet granted: returns null
// (treat as not-packed) so inspection-state verification still works. The
// /pack write path surfaces the real table/permission error to the operator.
async function alreadyPackedAt(dmc: string): Promise<string | null> {
  try {
    const pool = await getPool();
    const r = await pool
      .request()
      .input('dmc', dmc)
      .query(
        `SELECT TOP 1 Packed_At FROM dbo.Packed_Log_TEST
         WHERE DMC = @dmc AND Is_Reject = 0 ORDER BY Packed_At DESC`,
      );
    return r.recordset.length ? serializeDateTime(r.recordset[0].Packed_At) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live event mirror (README_DESKTOP_PACKING_PAGE.md)
//
// The Zebra POSTs one event per scan to /packing/event with the verdict it
// showed (PACKED_OK / WRONG_GRADE / ALREADY_PACKED / LOOKUP_ERROR / ...).
// We push it to an in-memory ring buffer (last MAX_EVENTS), best-effort
// persist to dbo.Packing_Events for history, and broadcast it to any
// connected SSE subscriber. The desktop /packing-live page subscribes and
// renders the same verdict the operator sees on the Zebra.
//
// Ring buffer and subscriber set are module-scoped so a single instance is
// shared across all requests. The buffer survives until the process
// restarts; for after-restart context the page falls back to
// /packing/recent which reads the same buffer (and could later be backed
// by Packing_Events for full history).
// ---------------------------------------------------------------------------

export interface PackingEvent {
  ts: string;             // ISO8601 with offset, as sent by Zebra
  device: string;         // e.g. "ZEBRA-01"
  selectedGrade: string;  // grade code the operator picked at the station
  scannedGrade: string;   // P-code parsed from the scan, or the raw scan
  dmc: string | null;     // normalized DMC key, or null if lookup failed
  result: PackingResult;
  ok: boolean;
  message: string;
}

export type PackingResult =
  | 'PACKED_OK'
  | 'WRONG_GRADE'
  | 'ALREADY_PACKED'
  | 'NOT_PROCESSED'
  | 'IN_PROCESS'
  | 'RING_REJECTED'
  | 'CIRCLIP_SCRAP'
  | 'LOOKUP_ERROR'
  | 'PALLET_FULL';

const MAX_EVENTS = 50;
const ringBuffer: PackingEvent[] = [];
type Subscriber = (ev: PackingEvent) => void;
const subscribers = new Set<Subscriber>();

// ---------------------------------------------------------------------------
// Pack-progress tracker — per-grade pallet/packing-number state, derived
// from successful packs landing on this backend. Keeps the Live Mirror
// page in sync with the Zebra station's same counters.
//
// Model mirrors the Zebra client (frontend/src/lib/packingProgress.ts):
// each grade has its own current pallet of PALLET_CAPACITY parts; when a
// pallet fills, the next OK pack opens a new one with a fresh packing
// number. Packing numbers use DDMMYYNN where NN is a per-day sequence
// shared across grades.
//
// In-memory only (resets on backend restart). For permanent counts the
// Packed_Log_TEST table is the authoritative source — the count here is
// the *current pallet*, not a lifetime total, so derivation from that
// table would require carrying the rollover history that this state
// already keeps live.
// ---------------------------------------------------------------------------

const PALLET_CAPACITY = 1080;
const BIN_CAPACITY = 36;

interface ServerGradePackState {
  packed: number;
  packingNumber: string;
}

interface ServerPackingProgress {
  byGrade: Record<string, ServerGradePackState>;
  dailySeq: number;
  dailyDate: string; // 'YYYY-MM-DD'
}

const packingProgress: ServerPackingProgress = {
  byGrade: {},
  dailySeq: 0,
  dailyDate: '',
};

function todayStringsServer(): { dateKey: string; ddmmyy: string } {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(yyyy).slice(-2);
  return { dateKey: `${yyyy}-${mm}-${dd}`, ddmmyy: `${dd}${mm}${yy}` };
}

function recordServerPack(pCode: string | null | undefined): void {
  if (!pCode) return;
  const current = packingProgress.byGrade[pCode] ?? { packed: 0, packingNumber: '' };
  const palletFull = current.packed >= PALLET_CAPACITY;
  const firstPack = !current.packingNumber;
  if (palletFull || firstPack) {
    const { dateKey, ddmmyy } = todayStringsServer();
    const seq = packingProgress.dailyDate === dateKey ? packingProgress.dailySeq + 1 : 1;
    packingProgress.dailySeq = seq;
    packingProgress.dailyDate = dateKey;
    packingProgress.byGrade[pCode] = {
      packed: 1,
      packingNumber: `${ddmmyy}${String(seq).padStart(2, '0')}`,
    };
    return;
  }
  packingProgress.byGrade[pCode] = {
    packed: current.packed + 1,
    packingNumber: current.packingNumber,
  };
}

// Per-grade serialization for the pack critical section. The pallet-full check
// reads the in-memory count, but recordServerPack only updates it AFTER the
// awaited DB insert — so two near-simultaneous packs of the same grade could
// both pass the check and push a pallet past PALLET_CAPACITY (a pallet was seen
// at 1081/1080). Chaining each grade's packs one-after-another closes that
// window. Different grades still run concurrently; the map holds <=15 entries.
const gradePackTail = new Map<string, Promise<unknown>>();
function withGradeLock<T>(pCode: string, fn: () => Promise<T>): Promise<T> {
  const prev = gradePackTail.get(pCode) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => fn());
  gradePackTail.set(pCode, result.catch(() => undefined));
  return result;
}

// ---------------------------------------------------------------------------
// Pack history — one record per successful PACKED_OK, with the packing
// number that was active for the grade at the time of the pack. Backs
// the desktop Live Mirror's "History" view: list pallet numbers (with
// search), drill into one to see every DMC scanned + packed under it.
//
// In-memory only (cap MAX_HISTORY records) — resets on backend restart.
// dbo.Packed_Log_TEST already records every pack permanently, but without
// a Packing_Number column we can't reconstruct pallet membership across
// restarts. If the DBA adds that column we can seed this on boot.
// ---------------------------------------------------------------------------

export interface PackHistoryRecord {
  dmc: string;
  grade: string;        // P-code, e.g. P234102M110
  packedAt: string;     // ISO with offset (from dbo.Packed_Log_TEST)
  packingNumber: string;
}

const MAX_HISTORY = 100_000;
const packingHistory: PackHistoryRecord[] = [];

function recordPackHistory(rec: PackHistoryRecord): void {
  packingHistory.push(rec);
  if (packingHistory.length > MAX_HISTORY) {
    packingHistory.splice(0, packingHistory.length - MAX_HISTORY);
  }
}

// ---------------------------------------------------------------------------
// Persistent history support — try once on startup to ALTER TABLE the
// Packed_Log_TEST audit table so we have a Packing_Number column. If
// the backend's SQL login lacks DDL (same posture that blocks the
// Packing_Events CREATE TABLE), this returns false and we fall back to
// the in-memory ring. The operator can run the explicit migration
// (sql/migrations/0005_packed_log_packing_number.sql) as a privileged
// login to enable persistence; subsequent backend restarts will see
// the column on the first ensure check.
// ---------------------------------------------------------------------------

let packingNumberColumnReady = false;
let packingNumberAlterAttempted = false;

async function ensurePackingNumberColumn(): Promise<boolean> {
  if (packingNumberColumnReady) return true;
  if (packingNumberAlterAttempted) return false;
  packingNumberAlterAttempted = true;
  try {
    const pool = await getPool();
    // First — does the column already exist? (Operator may have run
    // the migration manually.)
    const check = await pool.request().query(`
      SELECT 1 AS exists_flag FROM sys.columns
      WHERE Name = 'Packing_Number' AND Object_ID = OBJECT_ID('dbo.Packed_Log_TEST');
    `);
    if (check.recordset.length > 0) {
      packingNumberColumnReady = true;
      return true;
    }
    // Try to add it ourselves
    await pool.request().query(`
      ALTER TABLE dbo.Packed_Log_TEST ADD Packing_Number NVARCHAR(20) NULL;
    `);
    packingNumberColumnReady = true;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[packing] Packing_Number column not available — persistent history disabled. ' +
        'Run sql/migrations/0005_packed_log_packing_number.sql as a DDL-privileged login. ' +
        'Detail: ' + (err as Error).message,
    );
    return false;
  }
}

// Rebuild the in-memory pack-progress + history from the permanent
// Packed_Log_TEST on first use, so a backend RESTART never resets the pallet
// counts (the bug the code's earlier comments anticipated). Runs once;
// idempotent; needs the Packing_Number column. Any failure is non-fatal — it
// just falls back to the previous live-only behaviour.
let packingSeeded = false;
let packingSeedInFlight: Promise<void> | null = null;
async function ensurePackingSeeded(): Promise<void> {
  if (packingSeeded) return;
  if (packingSeedInFlight) return packingSeedInFlight;
  packingSeedInFlight = (async () => {
    try {
      const hasCol = await ensurePackingNumberColumn();
      if (!hasCol) { packingSeeded = true; return; }
      const pool = await getPool();
      // Current pallet per grade = the highest Packing_Number for that P_Code,
      // and how many OK packs it holds.
      const grp = (await pool.request().query(`
        SELECT P_Code, Packing_Number, COUNT(*) AS cnt
        FROM dbo.Packed_Log_TEST WITH (NOLOCK)
        WHERE ISNULL(Is_Reject,0)=0 AND Packing_Number IS NOT NULL AND P_Code IS NOT NULL
        GROUP BY P_Code, Packing_Number
      `)).recordset as Array<{ P_Code: string; Packing_Number: string; cnt: number }>;
      const latest: Record<string, { num: string; cnt: number }> = {};
      let maxSeqToday = 0;
      const { dateKey, ddmmyy } = todayStringsServer();
      for (const r of grp) {
        const g = String(r.P_Code); const num = String(r.Packing_Number); const cnt = Number(r.cnt);
        if (!latest[g] || num > latest[g].num) latest[g] = { num, cnt };
        if (num.startsWith(ddmmyy)) {
          const nn = parseInt(num.slice(6), 10);
          if (Number.isFinite(nn) && nn > maxSeqToday) maxSeqToday = nn;
        }
      }
      for (const [g, v] of Object.entries(latest)) {
        packingProgress.byGrade[g] = { packed: v.cnt, packingNumber: v.num };
      }
      packingProgress.dailyDate = dateKey;
      packingProgress.dailySeq = maxSeqToday;
      // History for the pallet drill-down.
      const hist = (await pool.request().query(`
        SELECT TOP (${MAX_HISTORY}) DMC, P_Code AS grade,
               CONVERT(varchar(33), Packed_At, 126) AS packedAt, Packing_Number
        FROM dbo.Packed_Log_TEST WITH (NOLOCK)
        WHERE ISNULL(Is_Reject,0)=0 AND Packing_Number IS NOT NULL
        ORDER BY Packed_At ASC
      `)).recordset as Array<{ DMC: string; grade: string; packedAt: string; Packing_Number: string }>;
      packingHistory.length = 0;
      for (const h of hist) {
        packingHistory.push({
          dmc: String(h.DMC), grade: String(h.grade || ''),
          packedAt: String(h.packedAt), packingNumber: String(h.Packing_Number),
        });
      }
      packingSeeded = true;
      // eslint-disable-next-line no-console
      console.log(`[packing] seeded from Packed_Log_TEST — grades=${Object.keys(latest).length}, history=${packingHistory.length}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[packing] seed from Packed_Log_TEST failed: ' + (err as Error).message);
      packingSeeded = true; // don't retry-loop; fall back to live-only counting
    } finally {
      packingSeedInFlight = null;
    }
  })();
  return packingSeedInFlight;
}

// Predict the packing number the upcoming pack will land under, without
// mutating state. Used so the INSERT into Packed_Log_TEST can include
// the Packing_Number BEFORE recordServerPack actually commits it.
function predictNextPackingNumber(pCode: string): string {
  const current = packingProgress.byGrade[pCode] ?? { packed: 0, packingNumber: '' };
  const palletFull = current.packed >= PALLET_CAPACITY;
  const firstPack = !current.packingNumber;
  if (palletFull || firstPack) {
    const { dateKey, ddmmyy } = todayStringsServer();
    const seq = packingProgress.dailyDate === dateKey ? packingProgress.dailySeq + 1 : 1;
    return `${ddmmyy}${String(seq).padStart(2, '0')}`;
  }
  return current.packingNumber;
}

function pushEvent(ev: PackingEvent) {
  ringBuffer.unshift(ev);
  if (ringBuffer.length > MAX_EVENTS) ringBuffer.length = MAX_EVENTS;
  for (const fn of subscribers) {
    try { fn(ev); } catch { /* don't let one bad subscriber kill the rest */ }
  }
}

// Best-effort persistence. Creates the table lazily on first success-path
// call. All errors are swallowed — the display mirror is the primary
// contract; the table is a nice-to-have for later reports. We keep a
// module-level flag so we don't probe sys.tables on every event.
let packingTableReady = false;
async function ensurePackingTable(): Promise<void> {
  if (packingTableReady) return;
  const pool = await getPool();
  await pool.request().query(`
    IF NOT EXISTS (
      SELECT 1 FROM sys.tables WHERE name = 'Packing_Events' AND schema_id = SCHEMA_ID('dbo')
    )
    CREATE TABLE dbo.Packing_Events (
      Id              BIGINT IDENTITY(1,1) PRIMARY KEY,
      Ts              DATETIME2     NOT NULL,
      Device          NVARCHAR(64)  NOT NULL,
      Selected_Grade  NVARCHAR(64)  NOT NULL,
      Scanned_Grade   NVARCHAR(64)  NOT NULL,
      DMC             NVARCHAR(255) NULL,
      Result          NVARCHAR(32)  NOT NULL,
      Ok              BIT           NOT NULL,
      Message         NVARCHAR(512) NOT NULL,
      Received_At     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
    );
    IF NOT EXISTS (
      SELECT 1 FROM sys.indexes
      WHERE name = 'IX_Packing_Events_Ts' AND object_id = OBJECT_ID('dbo.Packing_Events')
    )
    CREATE INDEX IX_Packing_Events_Ts ON dbo.Packing_Events (Ts DESC);
  `);
  packingTableReady = true;
}

async function persistPackingEvent(ev: PackingEvent): Promise<void> {
  try {
    await ensurePackingTable();
    const pool = await getPool();
    await pool
      .request()
      .input('ts', ev.ts)
      .input('device', ev.device)
      .input('selected', ev.selectedGrade)
      .input('scanned', ev.scannedGrade)
      .input('dmc', ev.dmc)
      .input('result', ev.result)
      .input('ok', ev.ok ? 1 : 0)
      .input('message', ev.message)
      .query(`
        INSERT INTO dbo.Packing_Events
          (Ts, Device, Selected_Grade, Scanned_Grade, DMC, Result, Ok, Message)
        VALUES (@ts, @device, @selected, @scanned, @dmc, @result, @ok, @message);
      `);
  } catch {
    // swallowed by design — mirror display must not depend on DB success
  }
}

// Map an arbitrary body into a fully-shaped PackingEvent. Any missing
// fields fall back to safe defaults so the ring buffer never carries
// undefined/null where a string is expected.
function coerceEvent(body: Partial<PackingEvent> | null | undefined): PackingEvent {
  const VALID_RESULTS: ReadonlySet<string> = new Set<PackingResult>([
    'PACKED_OK','WRONG_GRADE','ALREADY_PACKED','NOT_PROCESSED','IN_PROCESS',
    'RING_REJECTED','CIRCLIP_SCRAP','LOOKUP_ERROR',
  ]);
  const result = (body?.result && VALID_RESULTS.has(body.result))
    ? (body.result as PackingResult)
    : 'LOOKUP_ERROR';
  return {
    ts: typeof body?.ts === 'string' && body.ts ? body.ts : new Date().toISOString(),
    device: typeof body?.device === 'string' ? body.device : 'unknown',
    selectedGrade: typeof body?.selectedGrade === 'string' ? body.selectedGrade : '',
    scannedGrade: typeof body?.scannedGrade === 'string' ? body.scannedGrade : '',
    dmc: typeof body?.dmc === 'string' ? body.dmc : null,
    result,
    ok: body?.ok === true,
    message: typeof body?.message === 'string' ? body.message : '',
  };
}

// Server-side mirror. Called by /verify (terminal verdicts) and /pack
// (every path except reject-mode) so the desktop /packing-live page
// sees the scan even when the Zebra hasn't been updated to POST
// /packing/event itself. The mobile addendum (firing /packing/event
// directly) is still required for verdicts the server can't see:
// WRONG_GRADE and LOOKUP_ERROR are client-side decisions on the Zebra.
function mirrorServerOutcome(args: {
  req: FastifyRequest;
  dmc: string | null;
  grade: string | null;
  result: PackingResult;
  ok: boolean;
  message: string;
}) {
  const deviceHeader = args.req.headers['x-zebra-device'];
  const device =
    typeof deviceHeader === 'string' && deviceHeader.length > 0
      ? deviceHeader
      : 'ZEBRA';
  const grade = args.grade ?? '';
  const ev: PackingEvent = {
    ts: new Date().toISOString(),
    device,
    selectedGrade: grade,
    scannedGrade: grade,
    dmc: args.dmc,
    result: args.result,
    ok: args.ok,
    message: args.message,
  };
  pushEvent(ev);
  void persistPackingEvent(ev);
}

export default async function packingRoutes(app: FastifyInstance) {
  // -- VERIFY (read-only) -------------------------------------------------
  app.post<{ Body: ScanBody }>('/verify', async (req) => {
    const scan = req.body?.scan ?? '';
    try {
      const records = await fetchByScan(scan);
      if (records.length === 0) {
        const resp = {
          result: 'NOT_PROCESSED' as const, packable: false, dmc: null,
          grade: pCodeOf(scan), packedAt: null,
          message: 'Fresh part — never processed on the line.',
          ...EMPTY_PART_INFO,
        };
        mirrorServerOutcome({ req, dmc: resp.dmc, grade: resp.grade, result: 'NOT_PROCESSED', ok: false, message: resp.message });
        return resp;
      }

      const dmc = storedKey(records);
      const grade = pCodeOf(dmc, scan);
      const state = deriveState(records);
      const partInfo = buildPartInfo(records);

      const packedAt = await alreadyPackedAt(dmc);
      if (packedAt) {
        const resp = { result: 'ALREADY_PACKED' as const, packable: false, dmc, grade, packedAt, message: `This piston was already packed at ${packedAt}.`, ...partInfo };
        mirrorServerOutcome({ req, dmc, grade, result: 'ALREADY_PACKED', ok: false, message: resp.message });
        return resp;
      }

      switch (state) {
        case 'PACKED':
        case 'RING_OK':
          // Don't mirror — /pack will mirror the actual pack outcome.
          // Mirroring here would double-count successful packs.
          return { result: 'OK', packable: true, dmc, grade, packedAt: null, message: 'Verified — passed inspection.', ...partInfo };
        case 'RING_NG': {
          const msg = 'Rejected at ring inspection — needs rework.';
          mirrorServerOutcome({ req, dmc, grade, result: 'RING_REJECTED', ok: false, message: msg });
          return { result: 'RING_REJECTED', packable: false, dmc, grade, packedAt: null, message: msg, ...partInfo };
        }
        case 'CIRCLIP_SCRAP': {
          const msg = 'Scrapped at circlip inspection.';
          mirrorServerOutcome({ req, dmc, grade, result: 'CIRCLIP_SCRAP', ok: false, message: msg });
          return { result: 'CIRCLIP_SCRAP', packable: false, dmc, grade, packedAt: null, message: msg, ...partInfo };
        }
        case 'IN_PROGRESS':
        default: {
          const msg = 'Still in process — inspection not complete.';
          mirrorServerOutcome({ req, dmc, grade, result: 'IN_PROCESS', ok: false, message: msg });
          return { result: 'IN_PROCESS', packable: false, dmc, grade, packedAt: null, message: msg, ...partInfo };
        }
      }
    } catch (err) {
      req.log.error('[packing] verify failed: ' + (err as Error).message);
      const msg = "Couldn't reach the line system — retry. Don't pack unverified.";
      mirrorServerOutcome({ req, dmc: null, grade: null, result: 'LOOKUP_ERROR', ok: false, message: msg });
      return { result: 'LOOKUP_ERROR', packable: false, dmc: null, grade: null, packedAt: null, message: msg, ...EMPTY_PART_INFO };
    }
  });

  // -- PACK (write) -------------------------------------------------------
  app.post<{ Body: ScanBody }>('/pack', async (req) => {
    await ensurePackingSeeded(); // rebuild pallet counts from DB before counting a new pack
    const scan = req.body?.scan ?? '';
    const reject = req.body?.reject === true;
    try {
      const pool = await getPool();

      // REJECTED mode: accept any scan, log to the reject pile, no checks.
      if (reject) {
        const dmc = stripDmcSeparators(scan) || null;
        const ins = await pool
          .request()
          .input('dmc', dmc)
          .input('raw', scan)
          .input('grade', 'REJECT')
          .input('p', pCodeOf(scan))
          .input('res', 'REJECT_LOGGED')
          .query(
            `INSERT INTO dbo.Packed_Log_TEST (DMC, Raw_Scan, Grade, P_Code, Result, Is_Reject)
             OUTPUT INSERTED.Packed_At AS Packed_At
             VALUES (@dmc, @raw, @grade, @p, @res, 1)`,
          );
        return { result: 'PACKED_OK', ok: true, dmc, packedAt: serializeDateTime(ins.recordset[0].Packed_At), message: 'Reject logged.' };
      }

      // Normal pack: re-resolve + re-check packable, then insert.
      const records = await fetchByScan(scan);
      if (records.length === 0) {
        const msg = 'Not packable — part not found.';
        mirrorServerOutcome({ req, dmc: null, grade: pCodeOf(scan), result: 'NOT_PROCESSED', ok: false, message: msg });
        return { result: 'NOT_PACKABLE', ok: false, dmc: null, packedAt: null, message: msg };
      }
      const dmc = storedKey(records);
      const pCode = pCodeOf(dmc, scan);

      const prior = await alreadyPackedAt(dmc);
      if (prior) {
        const msg = `Already packed at ${prior}.`;
        mirrorServerOutcome({ req, dmc, grade: pCode, result: 'ALREADY_PACKED', ok: false, message: msg });
        return { result: 'ALREADY_PACKED', ok: false, dmc, packedAt: prior, message: msg };
      }

      // Serialize this grade's critical section (full-check -> insert -> count
      // update) so two concurrent same-grade packs can't both pass the
      // full-check and overshoot PALLET_CAPACITY. Different grades run free.
      return await withGradeLock(pCode ?? '', async () => {
      // Pallet-full guard — refuse to add another part to a pallet that
      // already has PALLET_CAPACITY parts. Operator must press
      // "Print & Complete" to close the current pallet first; the next
      // pack of this grade will allocate a fresh packing number.
      const pCodeForCheck = pCodeOf(records[records.length - 1].DMC, scan);
      const currentPallet = pCodeForCheck ? packingProgress.byGrade[pCodeForCheck] : undefined;
      if (currentPallet && currentPallet.packed >= PALLET_CAPACITY) {
        const fullMsg = `Pallet ${currentPallet.packingNumber} is full (${PALLET_CAPACITY}/${PALLET_CAPACITY}). Press "Print & Complete" before scanning more parts.`;
        return {
          result: 'PALLET_FULL',
          ok: false,
          dmc: storedKey(records),
          packedAt: null,
          message: fullMsg,
          pallet: {
            packingNumber: currentPallet.packingNumber,
            packed: currentPallet.packed,
            capacity: PALLET_CAPACITY,
            full: true,
          },
        };
      }

      const state = deriveState(records);
      if (state !== 'PACKED' && state !== 'RING_OK') {
        // Pick the specific reason so the supervisor mirror has a sharper
        // verdict than the generic NOT_PACKABLE we return to the Zebra.
        const specific: PackingResult =
          state === 'RING_NG' ? 'RING_REJECTED' :
          state === 'CIRCLIP_SCRAP' ? 'CIRCLIP_SCRAP' :
          'IN_PROCESS';
        const msg = 'Not packable — did not pass inspection.';
        mirrorServerOutcome({ req, dmc, grade: pCode, result: specific, ok: false, message: msg });
        return { result: 'NOT_PACKABLE', ok: false, dmc, packedAt: null, message: msg };
      }

      try {
        // Predict the packing number BEFORE recordServerPack so we can
        // persist it on the row itself. Same string the in-memory
        // tracker will allocate immediately after.
        const predictedPackingNumber = pCode ? predictNextPackingNumber(pCode) : '';
        const columnReady = await ensurePackingNumberColumn();

        const insertReq = pool
          .request()
          .input('dmc', dmc)
          .input('raw', scan)
          .input('grade', pCode)
          .input('p', pCode)
          .input('res', 'PACKED_OK');

        let ins;
        if (columnReady) {
          insertReq.input('packing', predictedPackingNumber || null);
          ins = await insertReq.query(
            `INSERT INTO dbo.Packed_Log_TEST (DMC, Raw_Scan, Grade, P_Code, Result, Is_Reject, Packing_Number)
             OUTPUT INSERTED.Packed_At AS Packed_At
             VALUES (@dmc, @raw, @grade, @p, @res, 0, @packing)`,
          );
        } else {
          ins = await insertReq.query(
            `INSERT INTO dbo.Packed_Log_TEST (DMC, Raw_Scan, Grade, P_Code, Result, Is_Reject)
             OUTPUT INSERTED.Packed_At AS Packed_At
             VALUES (@dmc, @raw, @grade, @p, @res, 0)`,
          );
        }
        const packedAt = serializeDateTime(ins.recordset[0].Packed_At);
        recordServerPack(pCode);
        const after = pCode ? packingProgress.byGrade[pCode] : null;
        if (after && packedAt) {
          recordPackHistory({
            dmc,
            grade: pCode ?? '',
            packedAt,
            packingNumber: after.packingNumber,
          });
        }
        mirrorServerOutcome({ req, dmc, grade: pCode, result: 'PACKED_OK', ok: true, message: 'OK — packed.' });
        return {
          result: 'PACKED_OK',
          ok: true,
          dmc,
          packedAt,
          message: 'OK — packed.',
          pallet: after
            ? {
                packingNumber: after.packingNumber,
                packed: after.packed,
                capacity: PALLET_CAPACITY,
                full: after.packed >= PALLET_CAPACITY,
              }
            : null,
        };
      } catch (e) {
        // Unique-index race: another pack landed first → treat as already packed.
        const num = (e as { number?: number }).number;
        if (num === 2627 || num === 2601) {
          const at = await alreadyPackedAt(dmc);
          const msg = `Already packed at ${at}.`;
          mirrorServerOutcome({ req, dmc, grade: pCode, result: 'ALREADY_PACKED', ok: false, message: msg });
          return { result: 'ALREADY_PACKED', ok: false, dmc, packedAt: at, message: msg };
        }
        throw e;
      }
      });
    } catch (err) {
      req.log.error('[packing] pack failed: ' + (err as Error).message);
      const msg = "Couldn't record the pack — retry.";
      mirrorServerOutcome({ req, dmc: null, grade: null, result: 'LOOKUP_ERROR', ok: false, message: msg });
      return { result: 'NOT_PACKABLE', ok: false, dmc: null, packedAt: null, message: msg };
    }
  });

  // -- LIVE MIRROR --------------------------------------------------------
  // The Zebra fires one of these per scan. We respond 200 immediately and
  // do the work (ring buffer push, DB write, SSE broadcast) afterward.
  app.post<{ Body: Partial<PackingEvent> }>('/packing/event', async (req) => {
    const ev = coerceEvent(req.body);
    pushEvent(ev);
    void persistPackingEvent(ev);
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>('/packing/recent', async (req) => {
    const lim = Math.max(1, Math.min(MAX_EVENTS, parseInt(req.query.limit ?? '', 10) || MAX_EVENTS));
    return ringBuffer.slice(0, lim);
  });

  // Per-grade pack progress (same shape the Zebra uses) for the Live
  // Mirror page. Cheap; the page polls this on a short interval.
  app.get('/packing/progress', async () => {
    await ensurePackingSeeded();
    return {
      byGrade: packingProgress.byGrade,
      dailySeq: packingProgress.dailySeq,
      dailyDate: packingProgress.dailyDate,
      palletCapacity: PALLET_CAPACITY,
      binCapacity: BIN_CAPACITY,
    };
  });

  // Packing history — one entry per packing number seen in this
  // session, with the count of parts packed under it and the bracketing
  // timestamps. Sorted newest-first by last pack so the History modal's
  // top entries are the most recent pallets.
  // History list — supports filtering by date range, shift, and
  // hour-of-day (same semantics as the Lists page). Reads from
  // dbo.Packed_Log_TEST when the Packing_Number column is available;
  // falls back to the in-memory ring otherwise.
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      shift?: string;
      time_from?: string;
      time_to?: string;
    };
  }>('/packing/history', async (req) => {
    await ensurePackingSeeded();
    const { from, to, shift, time_from, time_to } = req.query;

    // Set of currently-active packing numbers for the History UI's
    // Print & Complete vs View Print switch.
    const activeNumbers = new Set<string>();
    for (const st of Object.values(packingProgress.byGrade)) {
      if (st.packingNumber) activeNumbers.add(st.packingNumber);
    }

    const columnReady = await ensurePackingNumberColumn();

    // Recovery path — when Packing_Number doesn't exist yet (the
    // operator hasn't run the migration), we still read every pack
    // from Packed_Log_TEST and group them into synthetic pallets keyed
    // on (production_date, grade). One synthetic pallet per IST date +
    // P-code so the operator can at least see what was packed yesterday
    // even though the original packing numbers are lost. Synthetic
    // numbers carry an "R-" prefix to mark them as reconstructed.
    if (!columnReady) {
      try {
        const pool = await getPool();
        const r = pool.request();
        const conds: string[] = ['Is_Reject = 0', 'P_Code IS NOT NULL'];
        if (from) { conds.push('Packed_At >= @from'); r.input('from', `${from} 00:00:00`); }
        if (to)   { conds.push('Packed_At <= @to');   r.input('to',   `${to} 23:59:59.999`); }
        if (shift === 'A') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= 420');
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) <  931');
        } else if (shift === 'B') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= 931');
        } else if (shift === 'C') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) < 420');
        }
        const hhmmToMin = (s: string | undefined): number | null => {
          if (!s) return null;
          const m = /^(\d{1,2}):(\d{2})$/.exec(s);
          return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
        };
        const tfMin = hhmmToMin(time_from);
        const ttMin = hhmmToMin(time_to);
        if (tfMin !== null) {
          conds.push(`(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= ${tfMin}`);
        }
        if (ttMin !== null) {
          conds.push(`(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) <= ${ttMin}`);
        }
        const sql = `
          SELECT
            CONVERT(date, Packed_At) AS PackDate,
            P_Code,
            COUNT(*) AS Cnt,
            MIN(Packed_At) AS FirstPackedAt,
            MAX(Packed_At) AS LastPackedAt
          FROM dbo.Packed_Log_TEST
          WHERE ${conds.join(' AND ')}
          GROUP BY CONVERT(date, Packed_At), P_Code
          ORDER BY MAX(Packed_At) DESC
        `;
        const rs = await r.query(sql);
        return (rs.recordset as {
          PackDate: Date;
          P_Code: string;
          Cnt: number;
          FirstPackedAt: Date;
          LastPackedAt: Date;
        }[]).map((row) => {
          const dd = String(row.PackDate.getDate()).padStart(2, '0');
          const mm = String(row.PackDate.getMonth() + 1).padStart(2, '0');
          const yy = String(row.PackDate.getFullYear()).slice(-2);
          // Recovered ID — distinguishable from real DDMMYYNN numbers
          // and stable so the detail endpoint can re-parse it.
          const packingNumber = `R-${dd}${mm}${yy}-${row.P_Code}`;
          return {
            packingNumber,
            grade: row.P_Code,
            count: row.Cnt,
            firstPackedAt: serializeDateTime(row.FirstPackedAt) ?? '',
            lastPackedAt: serializeDateTime(row.LastPackedAt) ?? '',
            active: false, // recovered pallets are by definition closed
          };
        });
      } catch (err) {
        req.log.warn(`[packing] history recovery query failed: ${(err as Error).message}`);
        // fall through to in-memory
      }
    }

    // Try the DB path first.
    if (columnReady) {
      try {
        const pool = await getPool();
        const r = pool.request();
        const conds: string[] = [
          'Packing_Number IS NOT NULL',
          'Is_Reject = 0',
        ];
        if (from) {
          conds.push('Packed_At >= @from');
          r.input('from', `${from} 00:00:00`);
        }
        if (to) {
          conds.push('Packed_At <= @to');
          r.input('to', `${to} 23:59:59.999`);
        }
        // Shift filter — same minute-of-day boundaries as the dashboard
        // mirrors in shifts.ts. Shift C wraps midnight so we OR the
        // two halves.
        if (shift === 'A') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= 420');
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) <  931');
        } else if (shift === 'B') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= 931');
        } else if (shift === 'C') {
          conds.push('(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) < 420');
        }
        // Hour-of-day filter (operator types HH:mm). Inclusive on both
        // ends. Translates to minute-of-day for comparison.
        const hhmmToMin = (s: string | undefined): number | null => {
          if (!s) return null;
          const m = /^(\d{1,2}):(\d{2})$/.exec(s);
          if (!m) return null;
          return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        };
        const tfMin = hhmmToMin(time_from);
        const ttMin = hhmmToMin(time_to);
        if (tfMin !== null) {
          conds.push(`(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) >= ${tfMin}`);
        }
        if (ttMin !== null) {
          conds.push(`(DATEPART(HOUR, Packed_At) * 60 + DATEPART(MINUTE, Packed_At)) <= ${ttMin}`);
        }

        const sql = `
          SELECT
            Packing_Number,
            MAX(P_Code) AS Grade,
            COUNT(*)   AS Cnt,
            MIN(Packed_At) AS FirstPackedAt,
            MAX(Packed_At) AS LastPackedAt
          FROM dbo.Packed_Log_TEST
          WHERE ${conds.join(' AND ')}
          GROUP BY Packing_Number
          ORDER BY MAX(Packed_At) DESC
        `;
        const rs = await r.query(sql);
        return (rs.recordset as {
          Packing_Number: string;
          Grade: string;
          Cnt: number;
          FirstPackedAt: Date;
          LastPackedAt: Date;
        }[]).map((row) => ({
          packingNumber: row.Packing_Number,
          grade: row.Grade ?? '',
          count: row.Cnt,
          firstPackedAt: serializeDateTime(row.FirstPackedAt) ?? '',
          lastPackedAt: serializeDateTime(row.LastPackedAt) ?? '',
          active: activeNumbers.has(row.Packing_Number),
        }));
      } catch (err) {
        req.log.warn(`[packing] history DB query failed: ${(err as Error).message}`);
        // fall through to in-memory
      }
    }

    // In-memory fallback — apply the same filters we'd apply in SQL.
    type Agg = {
      packingNumber: string;
      grade: string;
      count: number;
      firstPackedAt: string;
      lastPackedAt: string;
      active: boolean;
    };
    const fromMs = from ? Date.parse(`${from}T00:00:00+05:30`) : null;
    const toMs = to ? Date.parse(`${to}T23:59:59.999+05:30`) : null;
    const hhmmToMin = (s: string | undefined): number | null => {
      if (!s) return null;
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      if (!m) return null;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    };
    const tfMin = hhmmToMin(time_from);
    const ttMin = hhmmToMin(time_to);
    const minOfDay = (iso: string): number | null => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      // Naive IST (we don't apply tz math — the timestamps already
      // carry IST offset, so getHours/getMinutes read the right value
      // on a TZ=Asia/Kolkata container).
      return d.getHours() * 60 + d.getMinutes();
    };
    const inShift = (mod: number): boolean => {
      if (shift === 'A') return mod >= 420 && mod < 931;
      if (shift === 'B') return mod >= 931;
      if (shift === 'C') return mod < 420;
      return true;
    };

    const byNum = new Map<string, Agg>();
    for (const r of packingHistory) {
      const tsMs = Date.parse(r.packedAt);
      if (fromMs !== null && tsMs < fromMs) continue;
      if (toMs !== null && tsMs > toMs) continue;
      const mod = minOfDay(r.packedAt);
      if (mod !== null) {
        if (tfMin !== null && mod < tfMin) continue;
        if (ttMin !== null && mod > ttMin) continue;
        if (!inShift(mod)) continue;
      }
      const cur = byNum.get(r.packingNumber);
      if (cur) {
        cur.count += 1;
        if (r.packedAt < cur.firstPackedAt) cur.firstPackedAt = r.packedAt;
        if (r.packedAt > cur.lastPackedAt) cur.lastPackedAt = r.packedAt;
      } else {
        byNum.set(r.packingNumber, {
          packingNumber: r.packingNumber,
          grade: r.grade,
          count: 1,
          firstPackedAt: r.packedAt,
          lastPackedAt: r.packedAt,
          active: activeNumbers.has(r.packingNumber),
        });
      }
    }
    return Array.from(byNum.values()).sort((a, b) =>
      b.lastPackedAt.localeCompare(a.lastPackedAt),
    );
  });

  // Drill-in: every DMC packed under a specific packing number, in pack
  // order (oldest first). Reads from Packed_Log_TEST when persistence
  // is on, otherwise from the in-memory ring.
  app.get<{ Params: { packingNumber: string } }>(
    '/packing/history/:packingNumber',
    async (req) => {
      await ensurePackingSeeded();
      const num = req.params.packingNumber;

      // Recovered-pallet drill-in. ID shape: R-DDMMYY-<P_Code>. Parse
      // it and re-query that day's packs for that grade. Used when the
      // Packing_Number column doesn't exist on Packed_Log_TEST yet.
      const recoveredMatch = /^R-(\d{2})(\d{2})(\d{2})-(.+)$/.exec(num);
      if (recoveredMatch) {
        const [, dd, mm, yy, pCode] = recoveredMatch;
        const yyyy = `20${yy}`;
        const isoDate = `${yyyy}-${mm}-${dd}`;
        try {
          const pool = await getPool();
          const rs = await pool
            .request()
            .input('date', isoDate)
            .input('p', pCode)
            .query(`
              SELECT DMC, P_Code, Packed_At
              FROM dbo.Packed_Log_TEST
              WHERE CONVERT(date, Packed_At) = @date
                AND P_Code = @p
                AND Is_Reject = 0
              ORDER BY Packed_At ASC
            `);
          return (rs.recordset as { DMC: string; P_Code: string; Packed_At: Date }[]).map(
            (row) => ({
              dmc: row.DMC,
              grade: row.P_Code ?? '',
              packedAt: serializeDateTime(row.Packed_At) ?? '',
            }),
          );
        } catch (err) {
          req.log.warn(`[packing] recovered detail query failed: ${(err as Error).message}`);
          return [];
        }
      }

      if (await ensurePackingNumberColumn()) {
        try {
          const pool = await getPool();
          const rs = await pool
            .request()
            .input('num', num)
            .query(`
              SELECT DMC, P_Code, Packed_At
              FROM dbo.Packed_Log_TEST
              WHERE Packing_Number = @num AND Is_Reject = 0
              ORDER BY Packed_At ASC
            `);
          return (rs.recordset as { DMC: string; P_Code: string; Packed_At: Date }[]).map(
            (row) => ({
              dmc: row.DMC,
              grade: row.P_Code ?? '',
              packedAt: serializeDateTime(row.Packed_At) ?? '',
            }),
          );
        } catch (err) {
          req.log.warn(`[packing] history detail DB query failed: ${(err as Error).message}`);
        }
      }
      return packingHistory
        .filter((r) => r.packingNumber === num)
        .map((r) => ({ dmc: r.dmc, grade: r.grade, packedAt: r.packedAt }))
        .sort((a, b) => a.packedAt.localeCompare(b.packedAt));
    },
  );

  // Mark a pallet as complete (operator pressed "Print & Complete"
  // before reaching PALLET_CAPACITY). Clears the matching grade's
  // current state so the next PACKED_OK on that grade allocates a
  // fresh pallet with a new packing number. History rows for the
  // closed pallet stay around — they're the audit trail.
  app.post<{ Params: { packingNumber: string } }>(
    '/packing/complete/:packingNumber',
    async (req) => {
      await ensurePackingSeeded();
      const num = req.params.packingNumber;
      let foundGrade: string | null = null;
      for (const [pCode, state] of Object.entries(packingProgress.byGrade)) {
        if (state.packingNumber === num) {
          foundGrade = pCode;
          break;
        }
      }
      if (!foundGrade) {
        return {
          ok: false,
          completed: false,
          message: 'Pallet not currently active — it was already closed earlier.',
        };
      }
      // Snapshot the count before we clear, so the printable label
      // can show "X parts at completion" even if the next pack lands
      // immediately after.
      const closedPacked = packingProgress.byGrade[foundGrade].packed;
      delete packingProgress.byGrade[foundGrade];
      return {
        ok: true,
        completed: true,
        packingNumber: num,
        grade: foundGrade,
        packedAtCompletion: closedPacked,
      };
    },
  );

  // Server-Sent Events stream. We hijack the reply so Fastify stops trying
  // to write a JSON body, then push `data: {...}\n\n` per new event plus a
  // 30s keepalive comment so idle proxies (nginx) don't drop the
  // connection. The desktop page reconnects automatically via EventSource.
  app.get('/packing/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    // X-Accel-Buffering=no tells nginx not to buffer this response —
    // without it the proxy holds each `data:` line until its buffer
    // fills, and the page appears frozen.
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();
    reply.hijack();

    const write = (line: string) => {
      try { reply.raw.write(line); } catch { cleanup(); }
    };
    const send: Subscriber = (ev) => write(`data: ${JSON.stringify(ev)}\n\n`);

    subscribers.add(send);
    write(':\n\n'); // initial flush so the browser knows we're alive

    const heartbeat = setInterval(() => write(':keepalive\n\n'), 30_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      subscribers.delete(send);
      try { reply.raw.end(); } catch { /* already closed */ }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // KPI strip — today's totals from the audit table (falls back to the
  // ring buffer's IST-today subset if the table isn't reachable). Cheap;
  // the page polls this on a minute timer.
  app.get('/packing/today-stats', async (req) => {
    try {
      await ensurePackingTable();
      const pool = await getPool();
      const r = await pool.request().query(`
        SELECT Result, COUNT(*) AS Cnt
        FROM dbo.Packing_Events
        WHERE CAST(Ts AT TIME ZONE 'UTC' AT TIME ZONE 'India Standard Time' AS DATE)
              = CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'India Standard Time' AS DATE)
        GROUP BY Result
      `);
      const stats: Record<string, number> = {};
      for (const row of r.recordset as { Result: string; Cnt: number }[]) {
        stats[row.Result] = row.Cnt;
      }
      // PACKED_OK from the AUTHORITATIVE permanent pack log, not the event
      // mirror — the mirror silently drops events during backend downtime
      // (e.g. a restart), which undercounts "Packed Today". Packed_Log_TEST
      // records every OK pack, so it's the true count.
      try {
        const ok = await pool.request().query(`
          SELECT COUNT(*) AS cnt FROM dbo.Packed_Log_TEST WITH (NOLOCK)
          WHERE ISNULL(Is_Reject,0) = 0
            AND CAST(Packed_At AT TIME ZONE 'UTC' AT TIME ZONE 'India Standard Time' AS DATE)
              = CAST(SYSUTCDATETIME() AT TIME ZONE 'UTC' AT TIME ZONE 'India Standard Time' AS DATE)
        `);
        stats.PACKED_OK = Number(ok.recordset[0]?.cnt ?? stats.PACKED_OK ?? 0);
      } catch { /* keep the mirror's PACKED_OK if the pack log read fails */ }
      return { source: 'db', stats };
    } catch (err) {
      req.log.warn('[packing] today-stats DB fallback: ' + (err as Error).message);
      const today = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istToday = new Date(today.getTime() + istOffset);
      const yyyy = istToday.getUTCFullYear();
      const mm = istToday.getUTCMonth();
      const dd = istToday.getUTCDate();
      const stats: Record<string, number> = {};
      for (const ev of ringBuffer) {
        const t = new Date(ev.ts);
        const tIst = new Date(t.getTime() + istOffset);
        if (
          tIst.getUTCFullYear() === yyyy &&
          tIst.getUTCMonth() === mm &&
          tIst.getUTCDate() === dd
        ) {
          stats[ev.result] = (stats[ev.result] ?? 0) + 1;
        }
      }
      return { source: 'buffer', stats };
    }
  });
}
