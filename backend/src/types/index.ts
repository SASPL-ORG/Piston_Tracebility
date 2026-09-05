import type { PartState } from '../db/state.js';

export type { PartState };

export interface SamLogRecord {
  Date_Time: string | null;
  Plant_Id: string | null;
  DMC: string | null;
  // Permanent loading-scan time, written once at row creation and never
  // overwritten (unlike Date_Time). NULL on rows created before the
  // Loading_Time feature. Optional because not every query selects it and
  // pre-feature rows lack it. Stored as a wall-clock string like the other
  // *_Time columns, not a serialized datetime.
  Loading_Time?: string | null;
  Circlip_Result: string | null;
  Circlip_Time: string | null;
  Ring_Result: string | null;
  Ring_Time: string | null;
  Ring_Count: number | null;
  Unloading_Time: string | null;
  Result: string | null;
  // Machine / production line (1 or 2). Present on multi-line installs;
  // NULL on single-line data. `SELECT *` queries surface it for line-aware
  // views (dashboard/lists filter, packing "which machine made this part").
  Line_ID?: number | null;
}

// One row per DMC: the latest row plus per-DMC aggregates and classified
// state. The rejection-reason columns (NR-stamped on rising edge events:
// 'PASS', 'Recipe mismatch', 'Groove anodizing missing', 'Abnormal part',
// 'Already processed' — pre-migration rows are NULL) are surfaced
// snake_case for downstream consumers; the raw PLC column names stay
// internal to SQL.
export interface PartListItem extends SamLogRecord {
  state: PartState;
  reinspected: boolean;
  total_attempts: number;
  circlip_rejection_reason: string | null;
  ring_rejection_reason: string | null;
  // Image counts sourced from dbo.Image_Index (matched rows only, all
  // attempts). circlip_image_count counts CIRCLIP captures; ring counts
  // every RING capture across all attempts. Zero when CV-X either did
  // not capture or the indexer failed to match — useful for spotting
  // inspections that ran but produced no images.
  circlip_image_count: number;
  ring_image_count: number;
}

// Single failure row in the /lists/failures response.
export interface ListFailureItem {
  s_no: number;
  date_time: string | null;
  plant_id: string | null;
  dmc: string | null;
  rejection_reason: string | null;
}

// One row of the "why did these fail" summary shown above the drill-down
// list. Sorted by count descending so the dominant cause is first.
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

// One (bucket, part_code) cell in the Lists-page Production Summary
// matrix. Bucket is the KPI category from the dashboard's partitioning;
// part_code is the 4-char variant id (M100, MZA0, ...).
export type ListSummaryBucket =
  | 'passed'
  | 'circlip_fail'
  | 'ring_fail'
  | 'in_progress'
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
  // Union of snap-ring and ring re-inspection — the dropdown shows a
  // single "Re-Inspection" entry; the two sub-buckets are no longer
  // separately selectable from the UI.
  | 'reinspected'
  | 'in_progress'
  | 'aborted'
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

// One row in the global Alarms list. Same fields as the per-part
// AlarmEvent but with the BatchID included (the per-part panel hides it
// because the DMC is already in the page header).
export interface AlarmListItem {
  id: number;
  logTime: string | null;
  batchId: string | null;
  alarm: string;
  status: AlarmStatus;
}

// Event Timeline — the 13-station journey of a part through the line.
// Built from the SAM_Log rows for the DMC plus deterministic visibility
// rules (event_timeline_brief.md). 4 of the events are real PLC
// checkpoints (3, 7, 13, 15); the rest are deterministic intermediate
// stations rendered by name when the part progressed past them.
export type EventTimelineStepType = 'checkpoint' | 'intermediate' | 'conditional';
export type EventTimelineStepStatus = 'OK' | 'FAIL' | 'COMPLETED';

// One of the 5 physical ring-assembly sub-stations (St10-14) shown under
// the "Ring Assembly Station" timeline node. `status` is 'OK'/'FAIL' once
// Node-RED has logged that station's Part-Complete for the DMC
// (dbo.Station_Events); 'PENDING' until the piston has cleared it.
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
  // Event 13 only — total ring inspection attempts (latest row's Ring_Count).
  attempts?: number;
  // Event 10 only — the 5 ring-assembly sub-stations listed under it, each
  // with its own live completion status.
  substations?: EventTimelineSubStation[];
}

export interface PartTraceResponse {
  dmc: string;
  total_records: number;
  records: SamLogRecord[];
  summary: PartTraceSummary;
  alarms: AlarmEvent[];
  event_timeline: EventTimelineStep[];
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
