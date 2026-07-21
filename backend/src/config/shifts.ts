// Production-shift definitions. Single source of truth for the dashboard
// and any future shift-aware logic. Times are in the SCADA box's local TZ
// (Asia/Kolkata for the current install). Changing the start times here
// changes the dashboard's whole shift-attribution behavior — do it
// deliberately.

export type ShiftId = 'A' | 'B' | 'C';

export interface ShiftDef {
  id: ShiftId;
  label: string;
  hours: string;
  // Minute-of-day half-open interval [startMin, endMin). Shift C wraps
  // midnight, so its range below uses the >=1410 OR <450 idiom in the
  // SQL CASE expression instead of an interval.
  startMin: number;
  endMin: number;
}

// Shift A: 07:30 – 15:30   (minutes 450..930)
// Shift B: 15:30 – 23:30   (minutes 930..1410)
// Shift C: 23:30 – 07:30   (minutes 1410..1440 OR 0..450 — wraps midnight)
export const SHIFTS: ShiftDef[] = [
  { id: 'A', label: 'Shift A', hours: '07:30 – 15:30', startMin: 450, endMin: 930 },
  { id: 'B', label: 'Shift B', hours: '15:30 – 23:30', startMin: 930, endMin: 1410 },
  { id: 'C', label: 'Shift C', hours: '23:30 – 07:30', startMin: 1410, endMin: 450 },
];

// The start of Shift A = the start of a production day. Used for date-range
// boundaries (07:30 → next-day 07:30) and for the "today" rollover rule.
export const PRODUCTION_DAY_START_MIN = 450;
export const PRODUCTION_DAY_START_HHMM = '07:30:00';

// --- Per-timestamp shift classification (JS mirror of the dashboard) -------
//
// The dashboard attributes parts to shifts in SQL via SHIFT_CASE_SQL
// (backend/src/db/state.ts) using a 07:00 production-day boundary, NOT the
// nominal 07:30 in SHIFTS above. To keep per-part pages (e.g. the packing
// station) attributing a part to *exactly* the same shift + production date
// the dashboard would, this mirrors those SQL boundaries — deliberately, not
// the SHIFTS table:
//   Shift A: 07:00–15:30   ([420, 931))
//   Shift B: 15:31–23:59   ([931, 1440))
//   Shift C: 00:00–06:59   ([0, 420))  → rolls back to the previous date
// If SHIFT_CASE_SQL ever changes, change these two constants in lockstep.
export const SHIFT_A_START_MIN = 420;
export const SHIFT_B_START_MIN = 931;

export interface ShiftClassification {
  shift: ShiftId;
  productionDay: string; // 'YYYY-MM-DD'
}

// Reads the wall-clock fields out of a backend ISO string
// (YYYY-MM-DDTHH:mm:ss±ZZ:ZZ) WITHOUT any timezone conversion, so the shift
// matches what the operator sees on the dashboard regardless of viewer locale.
export function classifyShift(iso: string | null | undefined): ShiftClassification | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const minuteOfDay = Number(hh) * 60 + Number(mi);

  let shift: ShiftId;
  if (minuteOfDay >= SHIFT_A_START_MIN && minuteOfDay < SHIFT_B_START_MIN) shift = 'A';
  else if (minuteOfDay >= SHIFT_B_START_MIN) shift = 'B';
  else shift = 'C';

  // Pre-07:00 readings are Shift C's post-midnight tail — they belong to the
  // previous production date (the day whose window [date 07:00, date+1 07:00)
  // contains them).
  const productionDay =
    minuteOfDay < SHIFT_A_START_MIN ? previousDate(y, mo, d) : `${y}-${mo}-${d}`;

  return { shift, productionDay };
}

function previousDate(y: string, mo: string, d: string): string {
  // UTC arithmetic so the day rollover can't be perturbed by the host TZ.
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
