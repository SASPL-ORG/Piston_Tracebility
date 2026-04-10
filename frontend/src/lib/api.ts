const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

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

export interface DashboardKpis {
  total: number;
  passed: number;
  circlip_fail: number;
  ring_fail: number;
  overall_fail: number;
  pass_rate: number;
}

export interface HourlyBreakdown {
  hour: string;
  passed: number;
  failed: number;
}

export interface PlantBreakdown {
  plant_id: string;
  total: number;
  passed: number;
}

export interface DashboardResponse {
  kpis: DashboardKpis;
  hourly_breakdown: HourlyBreakdown[];
  plant_breakdown: PlantBreakdown[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  size: number;
  total_pages: number;
}

export interface PartResponse {
  dmc: string;
  total_records: number;
  records: SamLogRecord[];
}

export function fetchDashboard(from: string, to: string, plant?: string): Promise<DashboardResponse> {
  const params = new URLSearchParams({ from, to });
  if (plant) params.set('plant', plant);
  return fetchJson(`/dashboard?${params}`);
}

export function fetchPlants(): Promise<string[]> {
  return fetchJson('/plants');
}

export interface ListParams {
  type?: string;
  from?: string;
  to?: string;
  plant?: string;
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
  search?: string;
}

export function fetchList(params: ListParams): Promise<PaginatedResponse<SamLogRecord>> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== '') searchParams.set(key, String(val));
  });
  return fetchJson(`/list?${searchParams}`);
}

export function fetchPart(dmc: string): Promise<PartResponse> {
  return fetchJson(`/part/${encodeURIComponent(dmc)}`);
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
