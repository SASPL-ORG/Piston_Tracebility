import type { PartState } from '../db/state.js';

export type { PartState };

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

// One row per DMC: the latest row plus per-DMC aggregates and classified state.
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
  bucket: string; // 'yyyy-MM-dd HH:00' for hour, 'yyyy-MM-dd' for day or week-start
  passed: number;
  in_progress: number;
  failed: number;
}

export interface StateBreakdownItem {
  state: PartState;
  count: number;
}

export type ShiftId = 'A' | 'B' | 'C';

export interface DashboardResponse {
  kpis: DashboardKpis;
  granularity: ProductionGranularity;
  production_breakdown: ProductionBucket[];
  state_breakdown: StateBreakdownItem[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  size: number;
  total_pages: number;
}

export type ListType =
  | 'all'
  | 'passed'
  | 'circlip_scrap'
  | 'ring_rejected'
  | 'reinspected'
  | 'in_progress'
  | 'packed';

export interface ListQueryParams {
  type: ListType;
  from: string;
  to: string;
  plant?: string;
  page: number;
  size: number;
  sort: string;
  order: 'asc' | 'desc';
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

export interface PartTraceResponse {
  dmc: string;
  total_records: number;
  records: SamLogRecord[];
  summary: PartTraceSummary;
  alarms: AlarmEvent[];
}

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

export interface PendingImageItem {
  id: number;
  DMC: string;
  inspection_type: 'CIRCLIP' | 'RING';
  captured_at: string | null;
  source_counter: number | null;
  camera_id: string | null;
  ok_flag: number | null;
  session_folder: string | null;
  file_path: string;
}
