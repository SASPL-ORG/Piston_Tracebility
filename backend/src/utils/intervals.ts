// Pure interval algebra used by the machine-status endpoint to combine
// production cycles and downtime alarms into a Production / Down / Idle
// breakdown. All intervals are half-open [startMs, endMs) where start < end.

export type Iv = [number, number];

// Sort by start, then merge anything that overlaps or touches into a
// single interval. Output: disjoint, sorted ascending.
export function merge(ivs: Iv[]): Iv[] {
  if (ivs.length === 0) return [];
  const sorted = ivs.filter(([s, e]) => s < e).slice().sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return [];
  const out: Iv[] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) {
      // Overlap or touch — extend the running interval.
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// Trim every interval to the window [ws, we]; drop intervals that lie
// entirely outside or collapse to zero length.
export function clip(ivs: Iv[], w: Iv): Iv[] {
  const [ws, we] = w;
  if (we <= ws) return [];
  const out: Iv[] = [];
  for (const [s, e] of ivs) {
    const ns = Math.max(s, ws);
    const ne = Math.min(e, we);
    if (ns < ne) out.push([ns, ne]);
  }
  return out;
}

// a intersect b — interval set of points present in both. Both inputs
// assumed merged (disjoint, sorted). Used by machine-status to find the
// portion of each alarm that overlaps the FAULT state intervals — the
// "alarms active during faults" breakdown.
export function intersect(a: Iv[], b: Iv[]): Iv[] {
  if (a.length === 0 || b.length === 0) return [];
  const out: Iv[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [as, ae] = a[i];
    const [bs, be] = b[j];
    const lo = Math.max(as, bs);
    const hi = Math.min(ae, be);
    if (lo < hi) out.push([lo, hi]);
    // Advance whichever interval ends first; the other may still overlap
    // a later interval in the opposite list.
    if (ae < be) i++; else j++;
  }
  return out;
}

// a minus b. `b` is assumed merged (disjoint, sorted). Iterates each
// interval of a and walks b removing overlapping pieces.
export function subtract(a: Iv[], b: Iv[]): Iv[] {
  if (a.length === 0) return [];
  if (b.length === 0) return a.slice();
  const out: Iv[] = [];
  for (const [as, ae] of a) {
    let cursor = as;
    for (const [bs, be] of b) {
      if (be <= cursor) continue;       // b lies entirely before what's left of a
      if (bs >= ae) break;               // b is past a — nothing more can subtract
      if (bs > cursor) out.push([cursor, bs]);
      cursor = Math.max(cursor, be);
      if (cursor >= ae) break;
    }
    if (cursor < ae) out.push([cursor, ae]);
  }
  return out;
}

// Sum of (end - start) / 1000 over a list of intervals, rounded to whole
// seconds (windows are second-precision anyway).
export function totalSeconds(ivs: Iv[]): number {
  let ms = 0;
  for (const [s, e] of ivs) ms += e - s;
  return Math.round(ms / 1000);
}
