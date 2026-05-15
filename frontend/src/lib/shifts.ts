// Production-shift definitions (frontend mirror of backend/src/config/shifts.ts).
// Keep these two files in sync — the dashboard's display and the backend's
// query logic both rely on them.

export type ShiftId = 'A' | 'B' | 'C';

export interface ShiftDef {
  id: ShiftId;
  label: string;
  hours: string;
}

export const SHIFTS: ShiftDef[] = [
  { id: 'A', label: 'Shift A', hours: '07:30 – 15:30' },
  { id: 'B', label: 'Shift B', hours: '15:30 – 23:30' },
  { id: 'C', label: 'Shift C', hours: '23:30 – 07:30' },
];

// Minute-of-day at which a new production day starts (07:30).
export const PRODUCTION_DAY_START_MIN = 7 * 60 + 30;

// Returns the production date as a yyyy-MM-dd string. Before 07:30 the
// production date is yesterday's calendar date — because Shift C from the
// previous day is still in progress. After 07:30 the date rolls over.
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
