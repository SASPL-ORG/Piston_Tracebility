const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ---- Health / image-pipeline pile-up signal --------------------------------
export interface HealthResponse {
  status: 'ok' | 'degraded';
  imageWatcher: {
    running: boolean;
    pendingImages: number | null; // images waiting for their inspection row
    backlogged: boolean; // pending over the warn threshold
  };
}

export async function fetchHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>('/health');
}

export type PartState =
  | 'PACKED'      // Zebra-scanned + recorded in Packed_Log_TEST
  | 'COMPLETED'   // Line says inspection-finished, but operator hasn't packed yet
  | 'RING_OK'
  | 'RING_NG'
  | 'CIRCLIP_SCRAP'
  | 'IN_PROGRESS'
  | 'ABORTED';    // Only a loading scan; never reached circlip assembly (picked/faulted at loading)

export interface SamLogRecord {
  Date_Time: string | null;
  Plant_Id: string | null;
  DMC: string | null;
  // Permanent loading-scan time (NULL on pre-feature rows). Optional because
  // not every query selects it. Wall-clock string, like the other *_Time cols.
  Loading_Time?: string | null;
  Circlip_Result: string | null;
  Circlip_Time: string | null;
  Ring_Result: string | null;
  Ring_Time: string | null;
  Ring_Count: number | null;
  Unloading_Time: string | null;
  Result: string | null;
}

export interface PartListItem extends SamLogRecord {
  state: PartState;
  reinspected: boolean;
  total_attempts: number;
  circlip_rejection_reason: string | null;
  ring_rejection_reason: string | null;
  // Counts of matched Image_Index rows per inspection type. Zero when
  // CV-X didn't capture or the indexer never matched.
  circlip_image_count: number;
  ring_image_count: number;
}

export interface ListFailureItem {
  s_no: number;
  date_time: string | null;
  plant_id: string | null;
  dmc: string | null;
  rejection_reason: string | null;
}

export interface FailureReasonBreakdownItem {
  reason: string;
  count: number;
  pct: number;
}

export interface ListFailuresResponse {
  type: 'circlip' | 'ring';
  count: number;
  reason_breakdown: FailureReasonBreakdownItem[];
  truncated?: boolean;
  filters_applied: {
    from: string | null;
    to: string | null;
    shift: 'A' | 'B' | 'C' | 'all';
    plant: string;
  };
  items: ListFailureItem[];
}

export interface FailuresQuery {
  type: 'circlip' | 'ring';
  from?: string;
  to?: string;
  shift?: 'A' | 'B' | 'C' | 'all';
  plant?: string;
  time_from?: string; // 'HH:mm' — the Lists page From-hour
  time_to?: string;   // 'HH:mm' — the Lists page To-hour
}

export function fetchFailures(params: FailuresQuery): Promise<ListFailuresResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '') searchParams.set(key, String(val));
  });
  return fetchJson(`/lists/failures?${searchParams}`);
}

export interface DashboardKpis {
  total: number;
  passed: number;
  circlip_fail: number;
  ring_fail: number;
  in_progress: number;
  aborted: number;
  circlip_reinspected: number;
  ring_reinspected: number;
  pass_rate: number;
}

export type ProductionGranularity = 'hour' | 'day' | 'week';

export interface ProductionBucket {
  bucket: string;
  passed: number;
  in_progress: number;
  failed: number;
}

export interface StateBreakdownItem {
  state: PartState;
  count: number;
}

export type ShiftId = 'A' | 'B' | 'C';
export type ShiftScope = 'all' | ShiftId;

export interface DashboardResponse {
  kpis: DashboardKpis;
  granularity: ProductionGranularity;
  production_breakdown: ProductionBucket[];
  state_breakdown: StateBreakdownItem[];
}

// Lists-page Production Summary matrix. One entry per (bucket, part_code)
// cell; the frontend pivots into the 6-bucket × 15-code grid.
export type ListSummaryBucket =
  | 'passed'
  | 'circlip_fail'
  | 'ring_fail'
  | 'in_progress'
  | 'aborted'
  | 'circlip_reinspected'
  | 'ring_reinspected';

export interface ListSummaryEntry {
  bucket: string;
  part_code: string;
  count: number;
}

export interface ListSummaryResponse {
  entries: ListSummaryEntry[];
}

export interface ListSummaryParams {
  from?: string;
  to?: string;
  plant?: string;
  // Machine/line selector: '1' | '2' | undefined (all lines).
  line?: string;
  time_from?: string;
  time_to?: string;
}

export function fetchListSummary(params: ListSummaryParams): Promise<ListSummaryResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '') searchParams.set(key, String(val));
  });
  return fetchJson(`/summary?${searchParams}`);
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  size: number;
  total_pages: number;
}

export interface PartTraceSummary {
  state: PartState;
  total_attempts: number;
  reinspected: boolean;
  latest: SamLogRecord;
  first_seen: string | null;
  last_seen: string | null;
}

export type AlarmStatus = 'ON' | 'OFF';

export interface AlarmEvent {
  id: number;
  logTime: string | null;
  alarm: string;
  status: AlarmStatus;
}

export interface AlarmListItem {
  id: number;
  logTime: string | null;
  batchId: string | null;
  alarm: string;
  status: AlarmStatus;
}

export interface AlarmListParams {
  from?: string;
  to?: string;
  status?: 'ON' | 'OFF' | 'all';
  batch?: string;
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
}

export function fetchAlarms(params: AlarmListParams): Promise<PaginatedResponse<AlarmListItem>> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '' && val !== 'all') searchParams.set(key, String(val));
  });
  return fetchJson(`/alarms?${searchParams}`);
}

export type EventTimelineStepType = 'checkpoint' | 'intermediate' | 'conditional';
export type EventTimelineStepStatus = 'OK' | 'FAIL' | 'COMPLETED';

// One of the 5 ring-assembly sub-stations (St10-14) under "Ring Assembly
// Station". status is 'OK'/'FAIL' once Node-RED logs that station's
// Part-Complete for the DMC; 'PENDING' until the piston clears it.
export interface EventTimelineSubStation {
  label: string;
  timestamp?: string | null;
  status?: 'OK' | 'FAIL' | 'PENDING';
  reason?: string | null;
}

export interface EventTimelineStep {
  step: number;
  label: string;
  type: EventTimelineStepType;
  timestamp?: string | null;
  status?: EventTimelineStepStatus;
  reason?: string | null;
  attempts?: number;
  substations?: EventTimelineSubStation[];
}

export interface PartResponse {
  dmc: string;
  total_records: number;
  records: SamLogRecord[];
  summary: PartTraceSummary;
  alarms: AlarmEvent[];
  event_timeline: EventTimelineStep[];
}

export function fetchDashboard(
  from: string,
  to: string,
  options?: { plant?: string; shift?: ShiftScope; line?: LineScope },
): Promise<DashboardResponse> {
  const params = new URLSearchParams({ from, to });
  if (options?.plant) params.set('plant', options.plant);
  if (options?.shift && options.shift !== 'all') params.set('shift', options.shift);
  if (options?.line && options.line !== 'all') params.set('line', options.line);
  return fetchJson(`/dashboard?${params}`);
}

export function fetchPlants(): Promise<string[]> {
  return fetchJson('/plants');
}

// Machine/line selector. 'all' = both machines combined; '1'/'2' = one machine.
export type LineScope = 'all' | '1' | '2';

export interface LineInfo {
  line_id: number;
  parts: number;
  last_seen: string | null;
}

// Distinct machine lines that actually have data — used to decide whether to
// show the Machine toggle at all (a single-machine install won't).
export function fetchLines(): Promise<LineInfo[]> {
  return fetchJson('/lines');
}

// Customer-facing name for a machine line. Mirrors formatPlantName's intent.
export function formatLineName(lineId: number | string): string {
  return `Machine ${lineId}`;
}

export type ListType =
  | 'all'
  | 'passed'
  | 'circlip_scrap'
  | 'ring_rejected'
  // Single union bucket — covers both snap-ring AND ring re-inspection.
  | 'reinspected'
  | 'in_progress'
  | 'aborted'
  | 'packed';

export interface ListParams {
  type?: ListType;
  from?: string;
  to?: string;
  plant?: string;
  // Machine/line selector: '1' | '2' | undefined (all lines).
  line?: string;
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
  search?: string;
  // Part-number filter — a P-code (e.g. 'P234102M100'); narrows to that variant.
  pcode?: string;
  // Column-level filters (comma-separated lists of values, validated server-side).
  state?: string;
  circlip?: string;
  ring?: string;
  // Hour-of-day window (HH:mm). Both empty/absent => no time-of-day filter.
  // A shift selection on the UI is just a preset that fills these.
  time_from?: string;
  time_to?: string;
}

export function fetchList(params: ListParams): Promise<PaginatedResponse<PartListItem>> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '') searchParams.set(key, String(val));
  });
  return fetchJson(`/list?${searchParams}`);
}

export function fetchPart(dmc: string): Promise<PartResponse> {
  return fetchJson(`/part/${encodeURIComponent(dmc)}`);
}

// ---- Machine Status -------------------------------------------------------

// v3 — PLC publishes mutually-exclusive state bits, so the cards map
// directly: production ← RUNNING, machineHold ← FAULT, idle ← IDLE
// (+ logging gaps), down = machineHold + idle.
export interface MachineStatusResponse {
  window: { from: string; to: string; totalSeconds: number };
  stateSignalPresent: boolean;
  production: { seconds: number; pct: number };
  machineHold: { seconds: number; pct: number };
  idle: { seconds: number; pct: number };
  down: { seconds: number; pct: number };
  partsProcessed: number;
  goodParts: number;
  topAlarms: { alarm: string; occurrences: number; seconds: number }[];
  invariantOk: boolean;
  filtersIgnored?: boolean;
}

export interface MachineStatusQuery {
  from?: string;
  to?: string;
  shift?: 'A' | 'B' | 'C' | 'all';
  plant?: string;
  hourFrom?: string;
  hourTo?: string;
}

export function fetchMachineStatus(params: MachineStatusQuery): Promise<MachineStatusResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '' && val !== 'all') searchParams.set(key, String(val));
  });
  return fetchJson(`/machine-status?${searchParams}`);
}

// Shared HH:MM:SS formatter — used by the Machine Status KPI cards and
// the topAlarms table. Negative seconds clamp to "00:00:00".
export function formatHMS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

// Reduce a DMC value to its canonical, separator-free core so a scan and the
// stored key compare equal regardless of how the separators are represented.
// THIS IS THE SINGLE SOURCE for the scan↔stored mapping; the backend lookup
// reduces the stored DMC with the identical character set (see
// reduceDmcSql / the packing-summary route).
//
// Calibrated on the live Zebra (2026-06-17): Android Chrome keeps the raw
// ISO/IEC 15434 control bytes in the field — the scan arrives as
//   [)> <RS 1E> 06 <GS 1D> VTH16 <GS> P234102M110 <GS> T…578 <GS> DB73 <GS> <RS> <EOT 04>
// whereas Node-RED stores those separators rewritten to printable '.' (RS) and
// '-' (GS), dropping the trailing GS/RS/EOT — confirmed byte-for-byte against
//   [)>.06-VTH16-P234102M110-T260516N501AC8A1578-DB73   (UNICODE 46='.', 45='-')
//
// Rather than translate one representation into the other, we delete every
// separator from BOTH sides and compare the remainder. Stripped set:
//   - all C0 control chars 0x00–0x1F (covers EOT 0x04, FS 0x1C, GS 0x1D,
//     RS 0x1E, US 0x1F, plus TAB/CR/LF and the wedge's trailing Enter) and
//     DEL 0x7F
//   - space 0x20
//   - the printable separators Node-RED writes: '.' and '-'
// Everything else is preserved, so the "[)>06" message header and the
// alphanumeric payload survive identically on both sides. The payload fields
// here contain no literal '.'/'-', so deleting them is lossless for this data.
export function normalizeScannedDmc(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x20\x7f.\-]/g, '');
}

export function partTracePdfUrl(dmc: string): string {
  return `${BASE_URL}/part/${encodeURIComponent(dmc)}/report.pdf`;
}

// --- Packing verification + pack signal (README_MOBILE_SCANNER.md) -------
// Forward the RAW scanned string (control bytes intact) in a JSON body — JSON
// escaping handles the control chars; never URL-encode the scan into a path.
// Normalization + SAM_Log matching happen server-side (single source of truth).
// Uses the same /api proxy as everything else (same-origin → no CORS);
// override the origin via VITE_API_BASE_URL if the SCADA API ever moves.
export type VerifyResult =
  | 'OK'
  | 'ALREADY_PACKED'
  | 'NOT_PROCESSED'
  | 'IN_PROCESS'
  | 'RING_REJECTED'
  | 'CIRCLIP_SCRAP'
  | 'LOOKUP_ERROR';

export interface VerifyResponse {
  result: VerifyResult;
  packable: boolean;
  dmc: string | null;
  grade: string | null;
  packedAt: string | null;
  message: string;
  // Part summary fields shown on the verdict screen. Populated whenever
  // the part exists in SAM_Log; null for NOT_PROCESSED and LOOKUP_ERROR.
  partNumber: string | null;
  snapRingStatus: 'OK' | 'FAIL' | null;
  ringInspectionStatus: 'OK' | 'FAIL' | null;
  processedAt: string | null;
  shift: 'A' | 'B' | 'C' | null;
  productionDate: string | null;
}

export async function verifyScan(scan: string): Promise<VerifyResponse> {
  const res = await fetch(`${BASE_URL}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scan }),
  });
  if (!res.ok) throw new Error(`verify failed: ${res.status}`);
  return res.json();
}

export interface PackResponse {
  result: 'PACKED_OK' | 'ALREADY_PACKED' | 'NOT_PACKABLE' | 'PALLET_FULL';
  ok: boolean;
  dmc: string | null;
  packedAt: string | null;
  message: string;
  // Backend-authoritative pallet state for the grade just packed.
  // Present on PACKED_OK and PALLET_FULL so the scanner can sync its
  // local counter to the server's count of record.
  pallet?: {
    packingNumber: string;
    packed: number;
    capacity: number;
    full: boolean;
  } | null;
}

export async function packScan(scan: string, reject = false): Promise<PackResponse> {
  const res = await fetch(`${BASE_URL}/pack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scan, reject }),
  });
  if (!res.ok) throw new Error(`pack failed: ${res.status}`);
  return res.json();
}

// Live-mirror types — what the desktop /packing-live page consumes from
// the backend ring buffer. Mirrors what the Zebra displayed at the
// station so the desktop supervisor sees the same verdict.
export type PackingResult =
  | 'PACKED_OK'
  | 'WRONG_GRADE'
  | 'ALREADY_PACKED'
  | 'NOT_PROCESSED'
  | 'IN_PROCESS'
  | 'RING_REJECTED'
  | 'CIRCLIP_SCRAP'
  | 'LOOKUP_ERROR';

export interface PackingEvent {
  ts: string;
  device: string;
  selectedGrade: string;
  scannedGrade: string;
  dmc: string | null;
  result: PackingResult;
  ok: boolean;
  message: string;
}

export async function fetchPackingRecent(limit = 50): Promise<PackingEvent[]> {
  const res = await fetch(`${BASE_URL}/packing/recent?limit=${limit}`);
  if (!res.ok) throw new Error(`packing/recent failed: ${res.status}`);
  return res.json();
}

export interface PackingTodayStats {
  source: 'db' | 'buffer';
  stats: Partial<Record<PackingResult, number>>;
}

export async function fetchPackingTodayStats(): Promise<PackingTodayStats> {
  const res = await fetch(`${BASE_URL}/packing/today-stats`);
  if (!res.ok) throw new Error(`packing/today-stats failed: ${res.status}`);
  return res.json();
}

// Per-grade pack progress as tracked by the backend (in-memory, resets
// on backend restart). Same shape the Zebra's local store uses, so the
// shared PackProgressSummary component renders it identically.
export interface PackingProgressResponse {
  byGrade: Record<string, { packed: number; packingNumber: string }>;
  dailySeq: number;
  dailyDate: string;
  palletCapacity: number;
  binCapacity: number;
}

export async function fetchPackingProgress(): Promise<PackingProgressResponse> {
  const res = await fetch(`${BASE_URL}/packing/progress`);
  if (!res.ok) throw new Error(`packing/progress failed: ${res.status}`);
  return res.json();
}

// Pack history — list of all packing numbers seen in this backend
// session, with metadata. In-memory on the server; resets on backend
// restart (caveat surfaced in the History modal footer).
export interface PackingHistoryEntry {
  packingNumber: string;
  grade: string;          // P-code
  count: number;
  firstPackedAt: string;
  lastPackedAt: string;
  // True if this packing number is still the active pallet for its
  // grade — operator hasn't pressed Print & Complete yet. Drives the
  // History modal's bottom button (Print & Complete vs View Print).
  active: boolean;
}

export interface PackingHistoryDetail {
  dmc: string;
  grade: string;
  packedAt: string;
}

export interface PackingHistoryFilters {
  from?: string;       // 'YYYY-MM-DD'
  to?: string;         // 'YYYY-MM-DD'
  shift?: 'A' | 'B' | 'C' | 'all';
  time_from?: string;  // 'HH:mm'
  time_to?: string;    // 'HH:mm'
}

export async function fetchPackingHistory(
  filters: PackingHistoryFilters = {},
): Promise<PackingHistoryEntry[]> {
  const q = new URLSearchParams();
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  if (filters.shift && filters.shift !== 'all') q.set('shift', filters.shift);
  if (filters.time_from) q.set('time_from', filters.time_from);
  if (filters.time_to) q.set('time_to', filters.time_to);
  const qs = q.toString();
  const url = qs ? `${BASE_URL}/packing/history?${qs}` : `${BASE_URL}/packing/history`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`packing/history failed: ${res.status}`);
  return res.json();
}

export async function fetchPackingHistoryDetail(
  packingNumber: string,
): Promise<PackingHistoryDetail[]> {
  const res = await fetch(
    `${BASE_URL}/packing/history/${encodeURIComponent(packingNumber)}`,
  );
  if (!res.ok) throw new Error(`packing/history detail failed: ${res.status}`);
  return res.json();
}

export interface PackingCompleteResponse {
  ok: boolean;
  completed: boolean;
  packingNumber?: string;
  grade?: string;
  packedAtCompletion?: number;
  message?: string;
}

export async function completePackingPallet(
  packingNumber: string,
): Promise<PackingCompleteResponse> {
  // Send {} as the body so Fastify's content-type parser is happy — a
  // bare POST with no body returns 415 Unsupported Media Type.
  const res = await fetch(
    `${BASE_URL}/packing/complete/${encodeURIComponent(packingNumber)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  if (!res.ok) throw new Error(`packing/complete failed: ${res.status}`);
  return res.json();
}

// Maintenance types
export interface MaintenanceComponent {
  id?: number;
  ts: string;
  component_name: string;
  usage_value: number;
  usage_max: number;
  time_value: number;
  time_max: number;
  status: string;
  payload_json?: string;
}

export function fetchMaintenanceStatus(): Promise<MaintenanceComponent[]> {
  return fetchJson('/maintenance/status');
}

// Tool Life: returns the count of distinct DMCs produced in SAM_Log since the
// given timestamp. The UI captures `now` when the operator enters a Life-in-
// Quantity for a tool and then polls this to compute Quantity Left.
export function fetchToolLifeProducedSince(tsIso: string): Promise<{ count: number }> {
  return fetchJson(`/tool-life/produced-since?ts=${encodeURIComponent(tsIso)}`);
}

export function fetchMaintenanceHistory(component: string, from?: string, to?: string): Promise<MaintenanceComponent[]> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return fetchJson(`/maintenance/history/${encodeURIComponent(component)}?${params}`);
}

// License
export interface LicenseStatus {
  licensed: boolean;
  client?: string;
  activated_at?: string;
}

export function fetchLicenseStatus(): Promise<LicenseStatus> {
  return fetchJson('/license/status');
}

export async function activateLicense(key: string): Promise<{ success: boolean; error?: string; client?: string }> {
  const res = await fetch(`${BASE_URL}/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return res.json();
}

export function getExportUrl(params: ListParams): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '') searchParams.set(key, String(val));
  });
  return `${BASE_URL}/export?${searchParams}`;
}

// Download URL for the PLC Alarms export (CSV, opens in Excel / Sheets). Same
// filters as the alarms list; 'all' status is omitted (no filter).
export function getAlarmsExportUrl(params: {
  from?: string;
  to?: string;
  status?: string;
  batch?: string;
  sort?: string;
  order?: string;
}): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '' && val !== 'all') searchParams.set(key, String(val));
  });
  return `${BASE_URL}/alarms/export?${searchParams}`;
}

// Display helpers ---------------------------------------------------------

// Read the wall-clock components from a backend ISO string (YYYY-MM-DDTHH:MM:SS+ZZ:ZZ)
// without converting to the browser's timezone, so the display matches what
// SSMS would show on the SCADA box regardless of viewer locale.
export function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  // Accept both the serialized ISO form (…T…) and the PLC/server wall-clock
  // form (…space…, e.g. Loading_Time '2026-07-28 15:09:30'), so every
  // timeline timestamp formats as DD-MM-YYYY regardless of source column.
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${d}-${mo}-${y} ${h}:${mi}:${s}`;
}

export const PART_STATE_LABEL: Record<PartState, string> = {
  PACKED: 'Packed',
  COMPLETED: 'Completed',
  RING_OK: 'Ring OK',
  RING_NG: 'Ring Rejected',
  CIRCLIP_SCRAP: 'Snap Ring Scrap',
  IN_PROGRESS: 'In Progress',
  ABORTED: 'DMC OK',
};

// Display-time rename of the customer's plant. The DB column SAM_Log.Plant_Id
// still holds the raw value ('Sam Plant'), but everywhere in the UI we show
// the customer-facing label. Add more entries here if multi-plant rolls out.
const PLANT_DISPLAY_NAME: Record<string, string> = {
  'Sam Plant': 'IPL Ring Assembly Machine - 2',
};
export function formatPlantName(raw: string | null | undefined): string {
  if (!raw) return '-';
  return PLANT_DISPLAY_NAME[raw] ?? raw;
}

// PLC-emitted timestamp strings (Circlip_Time, Ring_Time, Unloading_Time) are
// passed through as-is — no unit suffix.
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

// ---- Images ------------------------------------------------------------

export interface ImageItem {
  id: number;
  picture_no: number;
  ok_flag: 0 | 1;
  camera_id: string;
  captured_at: string | null;
}

export interface ImageGroup {
  inspection_type: 'CIRCLIP' | 'RING';
  ring_count: number | null;
  expected: number;
  indexed: number;
  images: ImageItem[];
}

export interface PartImagesResponse {
  dmc: string;
  groups: ImageGroup[];
}

export interface ImageGroupSummary {
  inspection_type: 'CIRCLIP' | 'RING';
  ring_count: number | null;
  expected: number;
  indexed: number;
}

export interface PartImagesSummaryResponse {
  dmc: string;
  groups: ImageGroupSummary[];
}

export function fetchPartImages(dmc: string, date?: string): Promise<PartImagesResponse> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return fetchJson(`/part/${encodeURIComponent(dmc)}/images${q}`);
}

export function fetchPartImagesSummary(dmc: string): Promise<PartImagesSummaryResponse> {
  return fetchJson(`/part/${encodeURIComponent(dmc)}/images/summary`);
}

export function imageSrc(id: number): string {
  return `${BASE_URL}/image/${id}`;
}

// Use for grid tiles and any non-zoomed display. Backend generates and
// caches a ~20 KB thumbnail (vs ~1-3 MB source). Lightbox / full-screen
// views should still use `imageSrc` to get the original.
export function imageThumbSrc(id: number): string {
  return `${BASE_URL}/image/${id}/thumb`;
}

// Master Data ----------------------------------------------------------------

export interface MasterDataItem {
  id: number;
  dmc: string;
  identification: string;
}

// The date range shown in the UI is built client-side as a list from
// CATALOG_START_DATE to today, newest first. Today's date is always the
// first pill; future dates never appear.
export const CATALOG_START_DATE = '2026-06-13';

export function buildMasterDataDateList(today: Date = new Date()): string[] {
  const start = new Date(CATALOG_START_DATE + 'T00:00:00');
  const dates: string[] = [];
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (cursor >= start) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates;
}

export function formatMasterDataDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function fetchMasterDataCatalog(): Promise<MasterDataItem[]> {
  return fetchJson('/master-data/catalog');
}

export function fetchMasterDataCatalogItem(id: number): Promise<MasterDataItem> {
  return fetchJson(`/master-data/catalog/${id}`);
}

// Per-day inspection view for one master piece.
export interface MasterInspectionAttempt {
  attempt_no: number;
  session_folder: string;
  captured_at: string;          // ISO of the earliest image in the attempt
  images: ImageItem[];
}

export interface MasterInspectionResponse {
  catalog: MasterDataItem;
  inspection_type: 'CIRCLIP' | 'RING';
  expected_per_attempt: number;
  attempts: MasterInspectionAttempt[];
}

export function fetchMasterInspection(
  id: number,
  date: string,
): Promise<MasterInspectionResponse> {
  return fetchJson(`/master-data/inspection?id=${id}&date=${encodeURIComponent(date)}`);
}

// Time-only formatter used by the inspection page so a stack of attempts
// from the same day reads cleanly (HH:MM:SS).
export function formatTimeOnly(iso: string | null): string {
  if (!iso) return '-';
  const m = iso.match(/T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : iso;
}

export function groupKey(group: { inspection_type: string; ring_count: number | null }): string {
  return `${group.inspection_type}-${group.ring_count ?? 'na'}`;
}

export function groupTitle(group: { inspection_type: string; ring_count: number | null }): string {
  if (group.inspection_type === 'CIRCLIP') return 'Snap Ring Inspection';
  return `Ring Attempt ${group.ring_count ?? 1}`;
}

// Reserved for true millisecond durations. No callers today; here so future code
// does not fall back to formatTimestamp + ' ms'.
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '-';
  return `${ms} ms`;
}
