// Production-shift definitions (frontend mirror of backend/src/db/state.ts).
// Keep in sync — the dashboard's display and the backend's query logic both
// rely on these boundaries.
//
// Shift timings CHANGED on 2026-09-08. Classification/filters are DATE-AWARE so
// past records keep the OLD shifts and today onward uses the NEW shifts:
//   OLD (before 2026-09-08): A 07:00–15:30, B 15:31–23:59, C 00:00–06:59
//   NEW (2026-09-08 onward):  A 08:00–16:30, B 16:30–00:30 (wraps), C 00:30–08:00
// The production-day boundary moved 07:00 → 08:00 on the same date.

export type ShiftId = 'A' | 'B' | 'C';

export interface ShiftDef {
  id: ShiftId;
  label: string;
  hours: string;
}

// Current (new) shift labels — shown in legends/tooltips.
export const SHIFTS: ShiftDef[] = [
  { id: 'A', label: 'Shift A', hours: '08:00 – 16:30' },
  { id: 'B', label: 'Shift B', hours: '16:30 – 00:30' },
  { id: 'C', label: 'Shift C', hours: '00:30 – 08:00' },
];

export const SHIFT_RULE_CHANGE_DATE = '2026-09-08';

// Shift → From/To hour preset a shift button fills into the hour window.
// Date-dependent so clicking "Shift A" on a past date filters the old window.
export type ShiftPreset = { from: string; to: string };
type PresetMap = Record<'all' | ShiftId, ShiftPreset>;

const OLD_SHIFT_PRESETS: PresetMap = {
  all: { from: '', to: '' },
  A: { from: '07:00', to: '15:30' },
  B: { from: '15:31', to: '23:59' },
  C: { from: '00:00', to: '06:59' },
};
const NEW_SHIFT_PRESETS: PresetMap = {
  all: { from: '', to: '' },
  A: { from: '08:00', to: '16:30' },
  B: { from: '16:30', to: '00:30' }, // wraps midnight; bindListRange rolls the end +1 day
  C: { from: '00:30', to: '08:00' },
};

// Presets for the selected date. 'YYYY-MM-DD' compares lexicographically.
export function shiftPresetsFor(dateStr: string): PresetMap {
  return dateStr >= SHIFT_RULE_CHANGE_DATE ? NEW_SHIFT_PRESETS : OLD_SHIFT_PRESETS;
}

// Minute-of-day at which a new production day starts. Moved 07:00 → 08:00 with
// the new shifts (aligned to the new Shift A start).
export const PRODUCTION_DAY_START_MIN = 8 * 60;

// Returns the production date as a yyyy-MM-dd string. Before the production-day
// start the date is yesterday's — the previous day's Shift C is still running.
export function getProductionDate(now: Date = new Date()): string {
  const min = now.getHours() * 60 + now.getMinutes();
  const d = new Date(now);
  if (min < PRODUCTION_DAY_START_MIN) {
    d.setDate(d.getDate() - 1);
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
