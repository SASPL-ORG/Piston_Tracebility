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

export interface ListQueryParams {
  type: 'all' | 'pass' | 'fail' | 'circlip_fail' | 'ring_fail';
  from: string;
  to: string;
  plant?: string;
  page: number;
  size: number;
  sort: string;
  order: 'asc' | 'desc';
}
