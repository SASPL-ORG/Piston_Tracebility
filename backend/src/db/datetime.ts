// Serialize a SQL `datetime` value (no stored timezone) so the wall-clock
// matches what the database holds. The mssql driver returns a JS Date
// constructed under useUTC=true, meaning the SQL wall-clock components are
// stored as the Date's UTC components. We re-tag those components with the
// host's local UTC offset so JSON consumers parse the same instant they would
// see in SSMS on this server.

function offsetSuffix(d: Date): string {
  // getTimezoneOffset returns minutes WEST of UTC; flip sign so +05:30 = +330.
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

export function serializeDateTime(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (!(value instanceof Date) || isNaN(value.getTime())) return null;

  const yyyy = value.getUTCFullYear();
  const mo = String(value.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(value.getUTCDate()).padStart(2, '0');
  const hh = String(value.getUTCHours()).padStart(2, '0');
  const mi = String(value.getUTCMinutes()).padStart(2, '0');
  const ss = String(value.getUTCSeconds()).padStart(2, '0');
  const ms = String(value.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mo}-${dd}T${hh}:${mi}:${ss}.${ms}${offsetSuffix(value)}`;
}

// Walk a recordset and rewrite Date_Time (and optionally other datetime fields).
export function serializeDateTimeFields<T extends Record<string, unknown>>(
  rows: T[],
  fields: (keyof T)[] = ['Date_Time' as keyof T],
): T[] {
  for (const row of rows) {
    for (const field of fields) {
      const v = row[field];
      if (v instanceof Date) {
        (row as Record<string, unknown>)[field as string] = serializeDateTime(v);
      }
    }
  }
  return rows;
}
