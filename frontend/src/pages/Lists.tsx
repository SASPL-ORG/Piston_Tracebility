import { useState, useEffect, useCallback } from 'react';
import { format, subDays, parseISO, startOfMonth } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, RotateCw, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import DateRangePicker from '../components/DateRangePicker';
import { getProductionDate } from '../lib/shifts';
import { GRADE_GROUPS } from '../lib/grades';
import Pagination from '../components/Pagination';
import ResultBadge from '../components/ResultBadge';
import StateBadge from '../components/StateBadge';
import ColumnFilter from '../components/ColumnFilter';
import FailuresModal, { FailureType } from '../components/FailuresModal';
import {
  fetchList,
  fetchListSummary,
  fetchPlants,
  getExportUrl,
  formatDateTime,
  formatPlantName,
  ListSummaryResponse,
  PART_STATE_LABEL,
  PartListItem,
  PartState,
  PaginatedResponse,
  ListType,
  ShiftScope,
  LineScope,
} from '../lib/api';
import { useSessionState } from '../lib/useSessionState';
import MachineSelector from '../components/MachineSelector';

// A part sits in IN_PROGRESS until a ring result is written. If the ring
// station never records one (part pulled off the line, line stopped mid-cycle,
// or the PLC/Node-RED write was lost) it stays IN_PROGRESS forever and quietly
// inflates the count. Flagging the old ones keeps them visually distinct from
// parts that are genuinely mid-inspection right now.
const STALE_IN_PROGRESS_HOURS = 2;

function isStaleInProgress(row: PartListItem): boolean {
  if (row.state !== 'IN_PROGRESS' || !row.Date_Time) return false;
  const ts = new Date(row.Date_Time).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > STALE_IN_PROGRESS_HOURS * 3600_000;
}

const TYPE_OPTIONS: { value: ListType; label: string }[] = [
  { value: 'all', label: 'All Results' },
  { value: 'passed', label: 'Passed' },
  { value: 'circlip_scrap', label: 'Snap Ring Scrap' },
  { value: 'ring_rejected', label: 'Ring Rejected' },
  // Single Re-Inspection entry — covers parts saved by either snap-ring
  // OR ring re-inspection. The two sub-types are no longer separately
  // selectable from the dropdown.
  { value: 'reinspected', label: 'Re-Inspection' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'aborted', label: 'Aborted' },
  { value: 'packed', label: 'Completed' },
];

// Column-filter option lists — these must match the backend's allow-list
// (STATE_VALUES, RESULT_VALUES in backend/src/routes/lists.ts).
const STATE_FILTER_OPTIONS = (['PACKED', 'RING_OK', 'RING_NG', 'CIRCLIP_SCRAP', 'IN_PROGRESS', 'ABORTED'] as PartState[]).map(
  (s) => ({ value: s, label: PART_STATE_LABEL[s] }),
);
const RESULT_FILTER_OPTIONS = [
  { value: 'PASS', label: 'PASS' },
  { value: 'FAIL', label: 'FAIL' },
  { value: 'BLANK', label: 'No Result' },
];

// Shift presets — must mirror SHIFTS in frontend/src/lib/shifts.ts and the
// SHIFT_CASE_SQL boundaries on the backend. Clicking a shift button fills
// the From/To hour inputs with the corresponding window; the operator can
// then narrow further (e.g. 08:00–10:00 inside Shift A).
const SHIFT_PRESETS: Record<ShiftScope, { from: string; to: string }> = {
  all: { from: '', to: '' },
  A: { from: '07:00', to: '15:30' },
  B: { from: '15:31', to: '23:59' },
  C: { from: '00:00', to: '06:59' },
};
const SHIFT_BUTTONS: { value: ShiftScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'A', label: 'Shift A' },
  { value: 'B', label: 'Shift B' },
  { value: 'C', label: 'Shift C' },
];

// After the operator edits the From/To inputs, figure out which shift
// button (if any) still matches. Lets us keep the highlight in sync so
// "Shift A" stays lit when From/To equals 07:00/15:30 and goes "All"
// (un-highlighted) when both inputs are empty. Custom time windows
// inside a shift drop the highlight — there's no false claim of
// "this is Shift A" when it's really 08:00–10:00.
function matchingShift(from: string, to: string): ShiftScope {
  if (!from && !to) return 'all';
  for (const id of ['A', 'B', 'C'] as const) {
    const p = SHIFT_PRESETS[id];
    if (p.from === from && p.to === to) return id;
  }
  return 'all';
}

// Human label for the active date range — fuels the modal subtitle
// ("Today · Shift B · All Plants · 46 parts"). Recognises the four
// DateRangePicker presets; falls back to a literal "from → to" range
// for custom selections.
function dateRangeLabel(from: string, to: string): string {
  // Anchor on the production date (07:00 rollover) and mirror
  // DateRangePicker's preset math exactly, so the label matches what the
  // chips actually select — including before 07:00, when "today" is still
  // the previous calendar date.
  const today = getProductionDate();
  if (from === today && to === today) return 'Today';
  const sevenAgo = format(subDays(parseISO(today), 7), 'yyyy-MM-dd');
  if (from === sevenAgo && to === today) return '7 Days';
  const thirtyAgo = format(subDays(parseISO(today), 30), 'yyyy-MM-dd');
  if (from === thirtyAgo && to === today) return '30 Days';
  const monthStart = format(startOfMonth(parseISO(today)), 'yyyy-MM-dd');
  if (from === monthStart && to === today) return 'This Month';
  return `${from} → ${to}`;
}

// Production Summary matrix — column structure mirrors the customer's
// Production Dashboard.xlsx template. Each cell maps a 4-char DMC
// variant code (the chars after 'P234102') to a grade label, grouped
// by category and sub-category.
interface SummaryCell { code: string; grade: string }
interface SummarySubCategory { label: string; cells: SummaryCell[] }
interface SummaryCategory { label: string; subs: SummarySubCategory[] }
const SUMMARY_COLUMNS: SummaryCategory[] = [
  {
    label: 'EGR',
    subs: [
      { label: 'N ISG', cells: [
        { code: 'M100', grade: 'A' }, { code: 'M110', grade: 'B' }, { code: 'M120', grade: 'C' },
      ] },
      { label: 'ISG', cells: [
        { code: 'M150', grade: 'AS' }, { code: 'M160', grade: 'BS' }, { code: 'M170', grade: 'CS' },
      ] },
    ],
  },
  {
    label: 'N EGR',
    subs: [
      { label: 'N ISG', cells: [
        { code: 'M400', grade: 'AG' }, { code: 'M410', grade: 'BG' }, { code: 'M420', grade: 'CG' },
      ] },
      { label: 'ISG', cells: [
        { code: 'M450', grade: 'AL' }, { code: 'M460', grade: 'BL' }, { code: 'M470', grade: 'CL' },
      ] },
    ],
  },
  {
    label: 'CNG',
    subs: [
      { label: '', cells: [
        { code: 'MZA0', grade: 'AN' }, { code: 'MZB0', grade: 'BN' }, { code: 'MZC0', grade: 'CN' },
      ] },
    ],
  },
];
const CATEGORY_BG: Record<string, string> = {
  'EGR': 'bg-blue-50',
  'N EGR': 'bg-amber-50',
  'CNG': 'bg-emerald-50',
};
const CATEGORY_BORDER: Record<string, string> = {
  'EGR': 'border-blue-200',
  'N EGR': 'border-amber-200',
  'CNG': 'border-emerald-200',
};

// Row labels for the matrix. Order and labels mirror the Excel template
// (skipping the duplicate "Snap Ring Fail" row at template row 13,
// which we treat as a typo). The bucket id matches the backend's
// SUMMARY_BUCKET_CASE output so we can look counts up directly.
// `failureType` (when set) marks the row label as clickable — opening
// the FailuresModal for that failure category. The other rows stay
// non-clickable per the brief.
const SUMMARY_ROWS: { bucket: string; label: string; failureType?: FailureType }[] = [
  { bucket: 'passed',                label: 'Passed' },
  { bucket: 'circlip_fail',          label: 'Snap Ring Fail', failureType: 'circlip' },
  { bucket: 'ring_fail',             label: 'Ring Fail',      failureType: 'ring' },
  { bucket: 'in_progress',           label: 'In Progress' },
  { bucket: 'aborted',               label: 'Aborted' },
  { bucket: 'circlip_reinspected',   label: 'Snap Ring Re-Inspection' },
  { bucket: 'ring_reinspected',      label: 'Ring Re-Inspection' },
];

// Flattened column order — used both for header rendering and for
// looking up per-cell counts in the same order in the data rows.
const SUMMARY_FLAT_CODES: { code: string; grade: string; category: string }[] =
  SUMMARY_COLUMNS.flatMap((cat) =>
    cat.subs.flatMap((sub) => sub.cells.map((c) => ({ ...c, category: cat.label }))),
  );

// Age of an IN_PROGRESS row = how long it's been in progress, measured from
// when the part was LOADED (Loading_Time) to now, in minutes. Returns null
// for terminal states (only in-progress rows carry an age — packed,
// ring-rejected, etc. are already resolved).
//
// Falls back to Circlip_Time then Date_Time for pre-Loading_Time rows.
// Previously this measured from Circlip_Time and returned null when there
// was none — so a part loaded but never circlip-inspected (the exact stale
// case, and the one you most want an age for) showed a blank age. Parsed as
// browser-local wall-clock; the SCADA PC runs on IST, matching the stored
// value. Rows older than STUCK_THRESHOLD_MIN indicate the part never
// progressed — physically pulled off the line, a manual/trial run, or a lost
// PLC/Node-RED event.
const STUCK_THRESHOLD_MIN = 60;
function ageMinutes(row: PartListItem): number | null {
  if (row.state !== 'IN_PROGRESS') return null;
  const ref = row.Loading_Time ?? row.Circlip_Time ?? row.Date_Time;
  if (!ref) return null;
  const t = new Date(ref).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
}
function formatAge(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function Lists() {
  const navigate = useNavigate();
  // Production date (07:00 rollover), matching the Dashboard — so "Today" on
  // both pages means the same production day, even in the 00:00–07:00 window.
  const today = getProductionDate();
  // All filter state lives in sessionStorage so the operator's
  // selections survive navigating to Dashboard / Part Trace / Images
  // and back. Reset only happens when the user clicks "Reset filters",
  // or when the browser tab is closed. The keys are namespaced under
  // 'lists/' so they don't collide with any future page state.
  const [from, setFrom] = useSessionState('lists/from', today);
  const [to, setTo] = useSessionState('lists/to', today);
  const [plant, setPlant] = useSessionState('lists/plant', '');
  // Machine/line selector — shared session key with the Dashboard.
  const [line, setLine] = useSessionState<LineScope>('app/line', 'all');
  const [plants, setPlants] = useState<string[]>([]);
  const [type, setType] = useSessionState<ListType>('lists/type', 'all');
  const [page, setPage] = useSessionState('lists/page', 1);
  const size = 50;
  // sort isn't exposed in the UI anymore — default Date_Time DESC stays put.
  const [data, setData] = useState<PaginatedResponse<PartListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useSessionState('lists/search', '');
  const [pcode, setPcode] = useSessionState('lists/pcode', ''); // part-number filter (P-code)
  // Column-level filters; empty = no constraint.
  const [stateFilter, setStateFilter] = useSessionState<string[]>('lists/stateFilter', []);
  const [circlipFilter, setCirclipFilter] = useSessionState<string[]>('lists/circlipFilter', []);
  const [ringFilter, setRingFilter] = useSessionState<string[]>('lists/ringFilter', []);
  // Shift + hour-of-day filter. `shift` is the currently-highlighted
  // preset (purely visual); `timeFrom`/`timeTo` are the actual values
  // sent to the backend. Editing the time inputs may invalidate the
  // shift selection (handled via matchingShift below).
  const [shift, setShift] = useSessionState<ShiftScope>('lists/shift', 'all');
  const [timeFrom, setTimeFrom] = useSessionState('lists/timeFrom', '');
  const [timeTo, setTimeTo] = useSessionState('lists/timeTo', '');
  // Production Summary matrix — refetched alongside the table whenever
  // date/plant/time window changes. Type / column filters intentionally
  // don't reload the summary (it's a fixed view of the slice).
  const [summary, setSummary] = useState<ListSummaryResponse | null>(null);
  // Failures modal — open when the operator clicks "Snap Ring Fail" or
  // "Ring Fail" in the Production Summary. `null` = closed.
  const [failuresOpen, setFailuresOpen] = useState<FailureType | null>(null);
  // Force a re-render every 60 s so the Age column reflects the current
  // clock without needing a full data refetch. Ages tick up on their
  // own; stuck rows stay red without user action.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchList({
        type,
        from,
        to,
        plant: plant || undefined,
        line: line === 'all' ? undefined : line,
        page,
        size,
        sort: 'Date_Time',
        order: 'desc',
        search: search || undefined,
        pcode: pcode || undefined,
        state: stateFilter.length ? stateFilter.join(',') : undefined,
        circlip: circlipFilter.length ? circlipFilter.join(',') : undefined,
        ring: ringFilter.length ? ringFilter.join(',') : undefined,
        time_from: timeFrom || undefined,
        time_to: timeTo || undefined,
      });
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [type, from, to, plant, line, page, search, pcode, stateFilter, circlipFilter, ringFilter, timeFrom, timeTo]);

  useEffect(() => {
    fetchPlants().then(setPlants).catch(() => {});
  }, []);
  useEffect(() => {
    loadData();
  }, [loadData]);
  // Reload Production Summary on the dimensional filters only. Plant +
  // date range + hour window define the slice; type/state/column
  // filters narrow the table but leave the summary untouched.
  useEffect(() => {
    let cancelled = false;
    fetchListSummary({
      from,
      to,
      plant: plant || undefined,
      line: line === 'all' ? undefined : line,
      time_from: timeFrom || undefined,
      time_to: timeTo || undefined,
    })
      .then((s) => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [from, to, plant, line, timeFrom, timeTo]);

  const handleDateChange = (newFrom: string, newTo: string, newPlant: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setPlant(newPlant);
    setPage(1);
  };

  // Column-filter setters reset to page 1 so the user lands on the first match.
  const onStateChange = (next: string[]) => { setStateFilter(next); setPage(1); };
  const onCirclipChange = (next: string[]) => { setCirclipFilter(next); setPage(1); };
  const onRingChange = (next: string[]) => { setRingFilter(next); setPage(1); };

  // Shift button click → fill the hour inputs with that shift's window.
  // "All" clears the time-of-day filter entirely. Editing the time inputs
  // afterwards keeps the visual shift highlight in sync via matchingShift.
  const onShiftClick = (next: ShiftScope) => {
    setShift(next);
    const preset = SHIFT_PRESETS[next];
    setTimeFrom(preset.from);
    setTimeTo(preset.to);
    setPage(1);
  };
  const onTimeFromChange = (v: string) => {
    setTimeFrom(v);
    setShift(matchingShift(v, timeTo));
    setPage(1);
  };
  const onTimeToChange = (v: string) => {
    setTimeTo(v);
    setShift(matchingShift(timeFrom, v));
    setPage(1);
  };

  // Active when anything beyond the default (date range + "all" type) is set.
  // Date pickers/presets are intentionally NOT cleared — those represent the
  // visible window, not a filter on top of it.
  const filtersActive =
    type !== 'all' ||
    !!plant ||
    !!search ||
    !!pcode ||
    stateFilter.length > 0 ||
    circlipFilter.length > 0 ||
    ringFilter.length > 0 ||
    !!timeFrom ||
    !!timeTo;

  const resetFilters = () => {
    setType('all');
    setPlant('');
    setSearch('');
    setPcode('');
    setStateFilter([]);
    setCirclipFilter([]);
    setRingFilter([]);
    setShift('all');
    setTimeFrom('');
    setTimeTo('');
    setPage(1);
  };

  // Pivot summary entries into a 2-D lookup: bucket -> code -> count.
  // Also compute row totals (per bucket), column totals (per code), and
  // the grand total. These let the matrix render the "Total" column and
  // "Total" row from the same source of truth.
  //
  // Backend's `passed` is now INCLUSIVE of re-inspection — so the
  // re-inspection rows are SUBSETS of passed, not exclusive buckets.
  // Column totals and grand total skip them to avoid double-counting;
  // the rows still render their subset counts in the body.
  const REINSPECTION_BUCKETS = new Set(['circlip_reinspected', 'ring_reinspected']);
  const summaryPivot = new Map<string, Map<string, number>>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();
  let grandTotal = 0;
  for (const e of summary?.entries ?? []) {
    if (!summaryPivot.has(e.bucket)) summaryPivot.set(e.bucket, new Map());
    summaryPivot.get(e.bucket)!.set(e.part_code, e.count);
    rowTotals.set(e.bucket, (rowTotals.get(e.bucket) ?? 0) + e.count);
    if (!REINSPECTION_BUCKETS.has(e.bucket)) {
      colTotals.set(e.part_code, (colTotals.get(e.part_code) ?? 0) + e.count);
      grandTotal += e.count;
    }
  }
  // Some part codes the backend returns may not be in our 15-cell
  // template (e.g. a new variant). Surface the count so it's never
  // silently dropped.
  const mappedCodes = new Set(SUMMARY_FLAT_CODES.map((c) => c.code));
  const unmappedTotal = Array.from(colTotals.entries())
    .filter(([code]) => !mappedCodes.has(code))
    .reduce((sum, [, n]) => sum + n, 0);

  const exportUrl = getExportUrl({
    type,
    from,
    to,
    plant: plant || undefined,
    line: line === 'all' ? undefined : line,
    sort: 'Date_Time',
    order: 'desc',
    pcode: pcode || undefined,
    state: stateFilter.length ? stateFilter.join(',') : undefined,
    circlip: circlipFilter.length ? circlipFilter.join(',') : undefined,
    ring: ringFilter.length ? ringFilter.join(',') : undefined,
    time_from: timeFrom || undefined,
    time_to: timeTo || undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-8 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-bold text-gray-900">Production Lists</h1>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">Type:</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as ListType);
                setPage(1);
              }}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <DateRangePicker from={from} to={to} plant={plant} plants={plants} onChange={handleDateChange} todayOverride={getProductionDate()} />
        </div>
        {/* Machine / line selector — filters the whole page to Machine 1,
            Machine 2, or both combined. Shared with the Dashboard. */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">Machine:</label>
          <MachineSelector value={line} onChange={(v) => { setLine(v); setPage(1); }} />
        </div>
        {/* Shift + hour window. Clicking a shift fills the From/To inputs
            with that shift's bounds; the operator can then narrow further
            (e.g. 08:00–10:00 inside Shift A). The actual filter is the
            From/To window — shift is a preset, not a separate param. */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-500 font-medium">Shift:</label>
          <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
            {SHIFT_BUTTONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onShiftClick(opt.value)}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  shift === opt.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">From hour:</label>
            <input
              type="time"
              value={timeFrom}
              onChange={(e) => onTimeFromChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">To hour:</label>
            <input
              type="time"
              value={timeTo}
              onChange={(e) => onTimeToChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {(timeFrom || timeTo) && (
            <button
              onClick={() => onShiftClick('all')}
              title="Clear hour window"
              className="text-xs font-medium text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
            >
              Clear hour
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={pcode}
            onChange={(e) => { setPcode(e.target.value); setPage(1); }}
            title="Filter by part number (model)"
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="">All part numbers</option>
            {GRADE_GROUPS.map((g) => (
              <optgroup key={g.category} label={g.category}>
                {g.grades.map((gr) => (
                  <option key={gr.pCode} value={gr.pCode}>{gr.pCode} ({gr.code})</option>
                ))}
              </optgroup>
            ))}
          </select>
          <input
            type="text"
            placeholder="Search DMC..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
          />
          {filtersActive && (
            <button
              onClick={resetFilters}
              title="Clear all active filters"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 hover:border-gray-300 hover:text-gray-800 transition-colors"
            >
              <RotateCcw size={13} />
              Reset filters
            </button>
          )}
          <a
            href={exportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors ml-auto"
          >
            <Download size={14} />
            Export CSV
          </a>
        </div>
      </div>

      {/* Production Summary — 6-bucket × 15-variant matrix matching the
          customer's Production Dashboard.xlsx template. Scope is
          date+plant+hour window (the type/column filters narrow the
          table below but leave this view untouched). */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-gray-800">Production Summary</h3>
          <span className="text-xs text-gray-400">
            Total: <span className="font-medium text-gray-700 tabular-nums">{grandTotal.toLocaleString()}</span>
            {unmappedTotal > 0 && (
              <>
                {' · '}Unmapped variants:{' '}
                <span className="font-medium text-amber-600 tabular-nums">{unmappedTotal.toLocaleString()}</span>
              </>
            )}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-center border-collapse text-xs">
            <thead>
              {/* Category row */}
              <tr>
                <th className="px-3 py-2 bg-gray-50 border border-gray-200 text-left text-gray-500 font-medium" rowSpan={4}>
                  Category
                </th>
                {SUMMARY_COLUMNS.map((cat) => {
                  const span = cat.subs.reduce((n, sub) => n + sub.cells.length, 0);
                  return (
                    <th
                      key={`cat-${cat.label}`}
                      colSpan={span}
                      className={clsx('px-3 py-2 font-semibold text-gray-700 border', CATEGORY_BG[cat.label], CATEGORY_BORDER[cat.label])}
                    >
                      {cat.label}
                    </th>
                  );
                })}
                <th rowSpan={4} className="px-3 py-2 bg-gray-100 border border-gray-200 text-gray-700 font-semibold">
                  Total
                </th>
              </tr>
              {/* Sub-category row */}
              <tr>
                {SUMMARY_COLUMNS.flatMap((cat) =>
                  cat.subs.map((sub, subIdx) => (
                    <th
                      key={`sub-${cat.label}-${sub.label}-${subIdx}`}
                      colSpan={sub.cells.length}
                      className={clsx('px-3 py-1.5 font-medium text-gray-600 border', CATEGORY_BG[cat.label], CATEGORY_BORDER[cat.label])}
                    >
                      {sub.label || ' '}
                    </th>
                  )),
                )}
              </tr>
              {/* Grade row */}
              <tr>
                {SUMMARY_FLAT_CODES.map((c) => (
                  <th
                    key={`grade-${c.code}`}
                    className="px-3 py-1.5 font-semibold text-gray-700 bg-gray-50 border border-gray-200"
                  >
                    {c.grade}
                  </th>
                ))}
              </tr>
              {/* Part-code row */}
              <tr>
                {SUMMARY_FLAT_CODES.map((c) => (
                  <th
                    key={`code-${c.code}`}
                    className="px-3 py-1.5 font-mono text-[10px] text-gray-500 bg-gray-50 border border-gray-200"
                  >
                    P234102{c.code}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map((row) => {
                const rowTotal = rowTotals.get(row.bucket) ?? 0;
                const isClickable = !!row.failureType;
                return (
                  <tr key={row.bucket}>
                    <td className="px-3 py-2 border border-gray-200 text-left font-medium text-gray-700 whitespace-nowrap">
                      {isClickable ? (
                        <button
                          onClick={() => row.failureType && setFailuresOpen(row.failureType)}
                          className="text-blue-600 hover:text-blue-800 hover:underline cursor-pointer font-medium"
                          title="Show failed parts with rejection reasons"
                        >
                          {row.label}
                        </button>
                      ) : (
                        row.label
                      )}
                    </td>
                    {SUMMARY_FLAT_CODES.map((c) => {
                      const count = summaryPivot.get(row.bucket)?.get(c.code) ?? 0;
                      return (
                        <td
                          key={`${row.bucket}-${c.code}`}
                          className={clsx(
                            'px-3 py-2 border border-gray-200 tabular-nums',
                            count > 0 ? 'text-gray-900 font-semibold' : 'text-gray-300',
                          )}
                        >
                          {count.toLocaleString()}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 border border-gray-200 bg-gray-50 font-semibold text-gray-800 tabular-nums">
                      {rowTotal.toLocaleString()}
                    </td>
                  </tr>
                );
              })}
              {/* Totals row */}
              <tr className="bg-gray-100">
                <td className="px-3 py-2 border border-gray-200 text-left font-semibold text-gray-800">
                  Total
                </td>
                {SUMMARY_FLAT_CODES.map((c) => {
                  const colTotal = colTotals.get(c.code) ?? 0;
                  return (
                    <td
                      key={`total-${c.code}`}
                      className={clsx(
                        'px-3 py-2 border border-gray-200 tabular-nums font-semibold',
                        colTotal > 0 ? 'text-gray-800' : 'text-gray-300',
                      )}
                    >
                      {colTotal.toLocaleString()}
                    </td>
                  );
                })}
                <td className="px-3 py-2 border border-gray-200 bg-gray-200 font-bold text-gray-900 tabular-nums">
                  {grandTotal.toLocaleString()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-16">S.No.</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Date / Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Plant</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">DMC</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    State
                    <ColumnFilter title="Filter by state" options={STATE_FILTER_OPTIONS} selected={stateFilter} onChange={onStateChange} />
                  </span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    Snap Ring
                    <ColumnFilter title="Filter by Snap Ring" options={RESULT_FILTER_OPTIONS} selected={circlipFilter} onChange={onCirclipChange} />
                  </span>
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap" title="Snap-ring images matched from CV-X">Snap Ring Images</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Snap Ring Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    Ring
                    <ColumnFilter title="Filter by ring" options={RESULT_FILTER_OPTIONS} selected={ringFilter} onChange={onRingChange} />
                  </span>
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap" title="Ring images matched from CV-X (all attempts)">Ring Images</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Ring Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Attempts</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Unload Time</th>
                <th
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap"
                  title="Time since Snap Ring inspection — only shown for In-Progress rows. Red = stuck (Ring event never recorded)."
                >
                  Age
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={14} className="px-4 py-12 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              ) : data && data.data.length > 0 ? (
                data.data.map((row, i) => {
                  const sno = (data.page - 1) * data.size + i + 1;
                  const age = ageMinutes(row);
                  const isStuck = age !== null && age > STUCK_THRESHOLD_MIN;
                  return (
                    <tr
                      key={i}
                      className={clsx(
                        'transition-colors',
                        isStuck ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50/50',
                      )}
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-gray-500 font-medium">{sno}</td>
                      {/* Show the part's loading time (its true start), not the
                          last-modified Date_Time which lands after circlip.
                          Falls back to Date_Time for pre-feature rows. */}
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatDateTime(row.Loading_Time ?? row.Date_Time)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatPlantName(row.Plant_Id)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => navigate(`/part-trace?dmc=${encodeURIComponent(row.DMC || '')}`)}
                            className="text-blue-600 hover:text-blue-800 font-medium inline-flex items-center gap-1"
                          >
                            {row.DMC || '-'}
                            <ExternalLink size={12} />
                          </button>
                          {row.reinspected && (
                            <span
                              title={`${row.total_attempts} ring attempts`}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200"
                            >
                              <RotateCw size={10} />
                              Reinspected
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <StateBadge state={row.state} />
                          {isStaleInProgress(row) && (
                            <span
                              title={`No ring result recorded for over ${STALE_IN_PROGRESS_HOURS} hours - this part is not actively being inspected`}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"
                            >
                              Stale
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <ResultBadge value={row.Circlip_Result} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">
                        <ImageCountCell
                          count={row.circlip_image_count}
                          expected={row.Circlip_Result === 'PASS' || row.Circlip_Result === 'FAIL' ? 1 : 0}
                          dmc={row.DMC}
                        />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-500">{formatDateTime(row.Circlip_Time)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <ResultBadge value={row.Ring_Result} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">
                        <ImageCountCell
                          count={row.ring_image_count}
                          expected={row.Ring_Result === 'PASS' || row.Ring_Result === 'FAIL' ? 25 * row.total_attempts : 0}
                          dmc={row.DMC}
                        />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-500">{formatDateTime(row.Ring_Time)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-700 font-medium">{row.total_attempts}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-500">{formatDateTime(row.Unloading_Time)}</td>
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {age === null ? (
                          <span className="text-gray-300">-</span>
                        ) : (
                          <span
                            className={clsx(
                              age > STUCK_THRESHOLD_MIN
                                ? 'text-red-700 font-bold'
                                : age > 15
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-gray-600',
                            )}
                            title={
                              age > STUCK_THRESHOLD_MIN
                                ? 'Stuck — no Ring event recorded. Check the line for this piston.'
                                : `${age} min since Snap Ring inspection`
                            }
                          >
                            {formatAge(age)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={14} className="px-4 py-12 text-center text-gray-400">
                    No records found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="px-4 border-t border-gray-200">
            <Pagination page={data.page} totalPages={data.total_pages} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </div>

      {failuresOpen && (
        <FailuresModal
          type={failuresOpen}
          from={from}
          to={to}
          shift={shift}
          plant={plant}
          timeFrom={timeFrom}
          timeTo={timeTo}
          rangeLabel={dateRangeLabel(from, to)}
          onClose={() => setFailuresOpen(null)}
        />
      )}
    </div>
  );
}

// Image-count cell for the Snap Ring Images / Ring Images columns.
// Colouring rules:
//   • count === 0 & expected === 0 → dash (no inspection ran, nothing
//     was ever supposed to exist)
//   • count === 0 & expected > 0   → red "0" — CV-X should have
//     produced images but the indexer has none. Fastest way to spot a
//     silent CV-X or matcher failure at a glance.
//   • 0 < count < expected         → amber — partial capture (some
//     shots missed, some matched)
//   • count >= expected            → green tint — happy path
// Click-through goes to the Image Viewer for the DMC.
function ImageCountCell({
  count,
  expected,
  dmc,
}: {
  count: number;
  expected: number;
  dmc: string | null;
}) {
  if (expected === 0 && count === 0) {
    return <span className="text-gray-300">-</span>;
  }
  const tone =
    count === 0
      ? 'text-red-700 font-bold'
      : count < expected
        ? 'text-amber-700 font-semibold'
        : 'text-emerald-700 font-semibold';
  const label = expected > 0 ? `${count}/${expected}` : `${count}`;
  const inner = (
    <span className={tone} title={`${count} of ${expected} expected images`}>
      {label}
    </span>
  );
  if (!dmc) return inner;
  return (
    <a
      href={`/images?dmc=${encodeURIComponent(dmc)}`}
      className="hover:underline"
      onClick={(e) => {
        // Same-tab navigation so browser back returns the operator to
        // the exact list scroll position.
        e.preventDefault();
        window.location.href = `/images?dmc=${encodeURIComponent(dmc)}`;
      }}
    >
      {inner}
    </a>
  );
}
