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
