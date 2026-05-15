const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export type PartState = 'PACKED' | 'RING_OK' | 'RING_NG' | 'CIRCLIP_SCRAP' | 'IN_PROGRESS';

export interface SamLogRecord {
  Date_Time: string | null;
  Plant_Id: string | null;
  DMC: string | null;
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
}

export interface DashboardKpis {
  total: number;
  passed: number;
  circlip_fail: number;
  ring_fail: number;
  in_progress: number;
  reinspected: number;
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

export interface ShiftBreakdownItem {
  shift: ShiftId;
  label: string;
  hours: string;
  total: number;
  passed: number;
  circlip_fail: number;
  ring_fail: number;
  in_progress: number;
  reinspected: number;
  pass_rate: number;
}

export interface DashboardResponse {
  kpis: DashboardKpis;
  granularity: ProductionGranularity;
  production_breakdown: ProductionBucket[];
  state_breakdown: StateBreakdownItem[];
  shift_breakdown: ShiftBreakdownItem[];
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

export interface PartResponse {
  dmc: string;
  total_records: number;
  records: SamLogRecord[];
  summary: PartTraceSummary;
}

export function fetchDashboard(from: string, to: string, plant?: string): Promise<DashboardResponse> {
  const params = new URLSearchParams({ from, to });
  if (plant) params.set('plant', plant);
  return fetchJson(`/dashboard?${params}`);
}

export function fetchPlants(): Promise<string[]> {
  return fetchJson('/plants');
}

export type ListType =
  | 'all'
  | 'passed'
  | 'circlip_scrap'
  | 'ring_rejected'
  | 'reinspected'
  | 'in_progress'
  | 'packed';

export interface ListParams {
  type?: ListType;
  from?: string;
  to?: string;
  plant?: string;
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
  search?: string;
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

export function partTracePdfUrl(dmc: string): string {
  return `${BASE_URL}/part/${encodeURIComponent(dmc)}/report.pdf`;
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

// Display helpers ---------------------------------------------------------

// Read the wall-clock components from a backend ISO string (YYYY-MM-DDTHH:MM:SS+ZZ:ZZ)
// without converting to the browser's timezone, so the display matches what
// SSMS would show on the SCADA box regardless of viewer locale.
export function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${d}-${mo}-${y} ${h}:${mi}:${s}`;
}

export const PART_STATE_LABEL: Record<PartState, string> = {
  PACKED: 'Packed',
  RING_OK: 'Ring OK',
  RING_NG: 'Ring Rejected',
  CIRCLIP_SCRAP: 'Circlip Scrap',
  IN_PROGRESS: 'In Progress',
};

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

export function fetchPartImages(dmc: string): Promise<PartImagesResponse> {
  return fetchJson(`/part/${encodeURIComponent(dmc)}/images`);
}

export function fetchPartImagesSummary(dmc: string): Promise<PartImagesSummaryResponse> {
  return fetchJson(`/part/${encodeURIComponent(dmc)}/images/summary`);
}

export function imageSrc(id: number): string {
  return `${BASE_URL}/image/${id}`;
}

export function groupKey(group: { inspection_type: string; ring_count: number | null }): string {
  return `${group.inspection_type}-${group.ring_count ?? 'na'}`;
}

export function groupTitle(group: { inspection_type: string; ring_count: number | null }): string {
  if (group.inspection_type === 'CIRCLIP') return 'Circlip Inspection';
  return `Ring Attempt ${group.ring_count ?? 1}`;
}

// Reserved for true millisecond durations. No callers today; here so future code
// does not fall back to formatTimestamp + ' ms'.
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '-';
  return `${ms} ms`;
}
