// Resolves the date / shift / hour-of-day filter inputs into a single
// contiguous [start, end] window in IST wall-clock terms. Mirrors the
// SHIFT_WINDOWS / buildTimeOfDayWhere semantics that lists.ts already
// uses, so a "Today + Shift A" pick on Machine Status spans the exact
// same minutes the Lists table would show.
//
// SAM_Log + vw_machine_* datetimes are wall-clock in IST without a TZ
// tag (the PLC writes them that way), so we deliberately do NOT convert
// here — we just build a Date by stitching the IST date with the
// chosen hour:minute. The mssql driver bound on `Date` then reads as
// the same wall-clock instant the views compare against.

export type Shift = 'A' | 'B' | 'C';

// Minute-of-day half-open windows. Match the SQL inclusive-BETWEEN
// semantics in backend/src/routes/lists.ts (A: 07:00–15:30, B:
// 15:31–23:59, C: 00:00–06:59) — the +1 on the upper bound below makes
// them half-open in JS (15:31 → 931 is the first minute NOT in A).
const SHIFT_HALF_OPEN: Record<Shift, { startMin: number; endMin: number }> = {
  A: { startMin: 420,  endMin: 931 },   // 07:00 → 15:31  (covers 15:30)
  B: { startMin: 931,  endMin: 1440 },  // 15:31 → 24:00  (covers 23:59)
  C: { startMin: 0,    endMin: 420 },   // 00:00 → 07:00  (covers 06:59)
};

// 07:00 — production-day boundary used by the dashboard / lists / summary
// when no shift or hour filter narrows the window further.
const PRODUCTION_DAY_START_MIN = 420;

export interface MachineWindowInputs {
  from?: string;        // 'YYYY-MM-DD'
  to?: string;          // 'YYYY-MM-DD'
  shift?: string;       // 'A' | 'B' | 'C' | 'all'
  hourFrom?: string;    // 'HH:mm'
  hourTo?: string;      // 'HH:mm'
}

export interface ResolvedWindow {
  start: Date;
  end: Date;
  // `true` when the user picked shift/hour but a multi-day date range
  // forced us to ignore them — the route logs this and the response
  // surfaces it via `invariantOk = true` (not a violation, just info).
  filtersIgnored: boolean;
}

function parseHourMin(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

// 'YYYY-MM-DD' + minute-of-day → Date built from the IST wall-clock
// representation. We assemble locally so the resulting Date's epoch
// matches the same instant the SQL views compare against (server is
// TZ=Asia/Kolkata, see docker-compose.yml).
function buildLocalDate(dateStr: string, minOfDay: number): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const hh = Math.floor(minOfDay / 60);
  const mm = minOfDay % 60;
  return new Date(y, (mo as number) - 1, d, hh, mm, 0, 0);
}

function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (mo as number) - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function todayIst(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function resolveMachineWindow(inputs: MachineWindowInputs): ResolvedWindow {
  const today = todayIst();
  const from = inputs.from || today;
  const to = inputs.to || today;
  const sameDay = from === to;

  const shiftRaw = (inputs.shift ?? '').toUpperCase();
  const shift: Shift | null =
    shiftRaw === 'A' || shiftRaw === 'B' || shiftRaw === 'C' ? (shiftRaw as Shift) : null;

  const hourFromMin = parseHourMin(inputs.hourFrom);
  const hourToMin = parseHourMin(inputs.hourTo);
  const hasHourFilter = hourFromMin !== null && hourToMin !== null;

  let startMin = PRODUCTION_DAY_START_MIN;
  let endMin = PRODUCTION_DAY_START_MIN; // production-day default: same minute, next day
  let startDate = from;
  let endDate = addDays(to, 1); // next-day 07:00 for production-day default
  let filtersIgnored = false;

  if (sameDay) {
    if (hasHourFilter) {
      startMin = hourFromMin!;
      // Inclusive-minute semantic on the upper bound, matches Lists.
      endMin = hourToMin! + 1;
      startDate = from;
      endDate = (endMin > 1440 ? addDays(from, 1) : from);
      if (endMin > 1440) endMin -= 1440;
    } else if (shift) {
      const win = SHIFT_HALF_OPEN[shift];
      startMin = win.startMin;
      endMin = win.endMin;
      startDate = from;
      endDate = (endMin >= 1440 ? addDays(from, 1) : from);
      if (endMin >= 1440) endMin -= 1440;
    }
    // else: production-day defaults already set above.
  } else if (shift || hasHourFilter) {
    // Multi-day window: shift/hour filters would yield multiple disjoint
    // sub-windows. v1 falls back to the full production-day span and
    // notes that the filters were dropped.
    filtersIgnored = true;
  }

  const start = buildLocalDate(startDate, startMin);
  let end = buildLocalDate(endDate, endMin);

  // Clamp end to now so we never claim Idle time for the future.
  const now = new Date();
  if (end > now) end = now;

  return { start, end, filtersIgnored };
}

// Build the IST-offset ISO string used in the response window field —
// the SCADA box is TZ=Asia/Kolkata so getTimezoneOffset() already gives
// the right offset. Centralised here so the route stays tidy.
export function formatIstIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  // Render the actual offset the box reports — usually +05:30 in IST,
  // but if someone ever runs the container in UTC this stays honest.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(offMin) / 60));
  const offM = pad(Math.abs(offMin) % 60);
  return `${y}-${mo}-${da}T${hh}:${mi}:${ss}${sign}${offH}:${offM}`;
}
