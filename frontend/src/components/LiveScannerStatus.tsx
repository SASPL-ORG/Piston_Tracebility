import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { PackageSearch } from 'lucide-react';
import { ALL_GRADES, GRADE_GROUPS } from '../lib/grades';
import {
  PALLET_CAPACITY,
  BIN_CAPACITY,
  computeBin,
  pendingForPallet,
} from '../lib/packingProgress';
import { fetchPackingProgress, type PackingProgressResponse } from '../lib/api';

// Live Scanner Status — a 1:1 mirror of what each Zebra packing gun shows
// on its Bin / Pallet counter, so the supervisor's dashboard reads the
// EXACT same numbers as the operator's handheld. It uses the same source
// (/api/packing/progress) and the same computeBin() math as the Zebra's
// Packing.tsx, so the two cannot drift by construction — the confusion
// where the gun read one number and the dashboard's "Packed today" KPI
// read another was two different metrics (pallet-to-date vs today-only),
// not a sync bug. This surfaces the pallet-to-date number the gun shows.
//
// One card per grade with an open pallet (packed > 0 or a packing number
// allocated), in canonical grade order so it lines up with the Packing
// Summary matrix below. Polls every 3 s; the progress endpoint returns
// in-memory backend state, so polling is cheap.

const CATEGORY_BY_PCODE = new Map<string, string>(
  GRADE_GROUPS.flatMap((g) => g.grades.map((gr) => [gr.pCode, g.category] as const)),
);

export default function LiveScannerStatus() {
  const [progress, setProgress] = useState<PackingProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchPackingProgress()
        .then((p) => {
          if (cancelled) return;
          setProgress(p);
          setLoading(false);
          setStale(false);
        })
        .catch(() => {
          if (cancelled) return;
          setLoading(false);
          setStale(true); // keep last-known numbers on screen, just flag them
        });
    };
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const byGrade = progress?.byGrade ?? {};

  // Active = grade has an open pallet. Canonical order matches the matrix.
  const activeGrades = ALL_GRADES.filter((g) => {
    const st = byGrade[g.pCode];
    return !!(st && (st.packed > 0 || st.packingNumber));
  });

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <div className="w-1 h-6 bg-emerald-600 rounded-full" />
        <h2 className="text-lg font-semibold text-gray-800">Live Scanner Status</h2>
        <PackageSearch className="w-4 h-4 text-emerald-600" />
        <span className="text-xs text-gray-500 ml-auto">
          {stale ? 'reconnecting…' : 'mirrors each Zebra gun · updates live'}
        </span>
      </div>

      {activeGrades.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-center text-sm text-slate-500 shadow-sm">
          {loading ? 'Loading…' : 'No open pallets — scan on a gun to begin.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeGrades.map((g) => {
            const st = byGrade[g.pCode]!;
            const { bin, partsInBin } = computeBin(st.packed);
            const pending = pendingForPallet(st.packed);
            const pct = Math.min(100, Math.round((st.packed / PALLET_CAPACITY) * 100));
            const full = st.packed >= PALLET_CAPACITY;
            return (
              <div
                key={g.pCode}
                className={clsx(
                  'rounded-xl border bg-white shadow-sm px-5 py-4',
                  full ? 'border-amber-300' : 'border-gray-200',
                )}
              >
                <div className="flex items-baseline justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xl font-extrabold text-gray-900">{g.code}</span>
                    <span className="text-xs text-gray-400">{CATEGORY_BY_PCODE.get(g.pCode)}</span>
                  </div>
                  <span className="font-mono text-xs text-gray-500">
                    #{st.packingNumber || '—'}
                  </span>
                </div>

                <div className="mt-2 flex items-baseline gap-2 tabular-nums">
                  <span className="text-sm text-gray-500">Pallet</span>
                  <span className="text-3xl font-extrabold leading-none text-gray-900">
                    {st.packed.toLocaleString()}
                  </span>
                  <span className="text-sm text-gray-500">
                    / {PALLET_CAPACITY.toLocaleString()}
                  </span>
                  <span className="ml-auto text-xs text-gray-400">
                    {pending.toLocaleString()} to fill
                  </span>
                </div>

                {/* pallet fill bar */}
                <div className="mt-2 h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className={clsx(
                      'h-full rounded-full',
                      full ? 'bg-amber-500' : 'bg-emerald-500',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="mt-2 flex items-center justify-between text-sm tabular-nums">
                  <span className="text-gray-500">
                    Bin <span className="font-bold text-gray-800">{bin}</span>
                  </span>
                  <span className="text-gray-500">
                    <span className="font-bold text-gray-800">{partsInBin}</span> / {BIN_CAPACITY}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
