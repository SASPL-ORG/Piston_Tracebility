import { useEffect, useState } from 'react';
import clsx from 'clsx';
import {
  GRADE_MATRIX,
  GRADE_MATRIX_FLAT,
  MATRIX_CATEGORY_BG,
  MATRIX_CATEGORY_BORDER,
} from '../lib/grades';
import { fetchPackingProgress, type PackingProgressResponse } from '../lib/api';

// Packing Summary matrix for the Dashboard — same column structure as
// the Lists page's Production Summary (EGR / N EGR / CNG with ISG /
// N ISG sub-categories, all 15 grade variants), but with packing-
// specific rows: Packed OK Qty, Pending Qty for Pallet, Pallet Number,
// Total. Right-side Total column rolls each row across grades; the
// bottom Total row sums Packed + Pending per grade (= pallet capacity
// for any grade that has an open pallet).
//
// Polls /api/packing/progress every 3 s. The state is in-memory on the
// backend so it resets on backend restart — see the Pack progress
// section on the Live Mirror for the same caveat.

const PALLET_CAPACITY = 1080;

export default function PackingSummaryMatrix() {
  const [progress, setProgress] = useState<PackingProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchPackingProgress()
        .then((p) => {
          if (cancelled) return;
          setProgress(p);
          setLoading(false);
          setError('');
        })
        .catch((e) => {
          if (cancelled) return;
          setError((e as Error).message);
          setLoading(false);
        });
    };
    refresh();
    // Poll every 10s instead of 3s — the SSE event stream still pushes
    // instant updates on each scan, this timer just catches drift.
    const id = window.setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const byGrade = progress?.byGrade ?? {};

  // Per-grade derived values
  const packedFor = (pCode: string) => byGrade[pCode]?.packed ?? 0;
  const pendingFor = (pCode: string) => {
    const st = byGrade[pCode];
    if (!st) return 0;
    return Math.max(0, PALLET_CAPACITY - st.packed);
  };
  const pkNumFor = (pCode: string) => byGrade[pCode]?.packingNumber || '';

  // Row totals (right Total column)
  const totalPacked  = GRADE_MATRIX_FLAT.reduce((acc, c) => acc + packedFor(c.grade.pCode), 0);
  const totalPending = GRADE_MATRIX_FLAT.reduce((acc, c) => acc + pendingFor(c.grade.pCode), 0);

  // Bottom Total row per grade: Packed + Pending = pallet capacity when
  // a pallet is open for that grade, 0 otherwise. Same value as the right
  // Total cell on this row.
  const totalRowFor = (pCode: string) => packedFor(pCode) + pendingFor(pCode);
  const grandTotal = totalPacked + totalPending;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 bg-blue-600 rounded-full" />
          <h3 className="text-base font-semibold text-gray-800">Packing Summary</h3>
        </div>
        <span className="text-xs text-gray-400">
          {error ? (
            <span className="text-red-600">{error}</span>
          ) : loading ? (
            'Loading…'
          ) : (
            <>
              Packed total: <span className="font-medium text-gray-700 tabular-nums">{totalPacked.toLocaleString()}</span>
              {' · '}
              Pallet capacity: <span className="font-mono text-gray-700">{PALLET_CAPACITY}</span>
            </>
          )}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="text-center border-collapse text-xs">
          <thead>
            {/* Category row — colspan group for EGR / N EGR / CNG */}
            <tr>
              <th
                rowSpan={4}
                className="px-3 py-2 bg-gray-50 border border-gray-200 text-left text-gray-500 font-medium"
              >
                Category
              </th>
              {GRADE_MATRIX.map((cat) => {
                const span = cat.subs.reduce((n, s) => n + s.grades.length, 0);
                return (
                  <th
                    key={`cat-${cat.label}`}
                    colSpan={span}
                    className={clsx(
                      'px-3 py-2 font-semibold text-gray-700 border',
                      MATRIX_CATEGORY_BG[cat.label],
                      MATRIX_CATEGORY_BORDER[cat.label],
                    )}
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
              {GRADE_MATRIX.flatMap((cat) =>
                cat.subs.map((sub, idx) => (
                  <th
                    key={`sub-${cat.label}-${sub.label}-${idx}`}
                    colSpan={sub.grades.length}
                    className={clsx(
                      'px-3 py-1.5 font-medium text-gray-600 border',
                      MATRIX_CATEGORY_BG[cat.label],
                      MATRIX_CATEGORY_BORDER[cat.label],
                    )}
                  >
                    {sub.label || ' '}
                  </th>
                )),
              )}
            </tr>
            {/* Grade row */}
            <tr>
              {GRADE_MATRIX_FLAT.map(({ grade }) => (
                <th key={`grade-${grade.pCode}`} className="px-3 py-1.5 font-semibold text-gray-700 bg-gray-50 border border-gray-200">
                  {grade.code}
                </th>
              ))}
            </tr>
            {/* P-code row */}
            <tr>
              {GRADE_MATRIX_FLAT.map(({ grade }) => (
                <th key={`pcode-${grade.pCode}`} className="px-3 py-1.5 font-mono text-[10px] text-gray-500 bg-gray-50 border border-gray-200">
                  {grade.pCode}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {/* Packed OK Qty */}
            <tr>
              <td className="px-3 py-2 border border-gray-200 text-left font-medium text-gray-700 whitespace-nowrap">
                Packed OK Qty
              </td>
              {GRADE_MATRIX_FLAT.map(({ grade }) => {
                const v = packedFor(grade.pCode);
                return (
                  <td
                    key={`packed-${grade.pCode}`}
                    className={clsx(
                      'px-3 py-2 border border-gray-200 tabular-nums',
                      v > 0 ? 'text-gray-900 font-semibold' : 'text-gray-300',
                    )}
                  >
                    {v.toLocaleString()}
                  </td>
                );
              })}
              <td className="px-3 py-2 border border-gray-200 bg-gray-50 font-semibold text-gray-800 tabular-nums">
                {totalPacked.toLocaleString()}
              </td>
            </tr>
            {/* Pending Qty for Pallet */}
            <tr>
              <td className="px-3 py-2 border border-gray-200 text-left font-medium text-gray-700 whitespace-nowrap">
                Pending Qty for Pallet
              </td>
              {GRADE_MATRIX_FLAT.map(({ grade }) => {
                const v = pendingFor(grade.pCode);
                const isActive = !!byGrade[grade.pCode];
                return (
                  <td
                    key={`pending-${grade.pCode}`}
                    className={clsx(
                      'px-3 py-2 border border-gray-200 tabular-nums',
                      isActive ? 'text-gray-900 font-semibold' : 'text-gray-300',
                    )}
                  >
                    {v.toLocaleString()}
                  </td>
                );
              })}
              <td className="px-3 py-2 border border-gray-200 bg-gray-50 font-semibold text-gray-800 tabular-nums">
                {totalPending.toLocaleString()}
              </td>
            </tr>
            {/* Pallet Number */}
            <tr>
              <td className="px-3 py-2 border border-gray-200 text-left font-medium text-gray-700 whitespace-nowrap">
                Pallet Number
              </td>
              {GRADE_MATRIX_FLAT.map(({ grade }) => {
                const v = pkNumFor(grade.pCode);
                return (
                  <td
                    key={`pkno-${grade.pCode}`}
                    className={clsx(
                      'px-3 py-2 border border-gray-200 font-mono',
                      v ? 'text-gray-900 font-semibold' : 'text-gray-300',
                    )}
                  >
                    {v || '—'}
                  </td>
                );
              })}
              {/* Right Total cell for Pallet Number isn't meaningful as a
                  number — show a dash so the column structure is consistent. */}
              <td className="px-3 py-2 border border-gray-200 bg-gray-50 text-gray-400">
                —
              </td>
            </tr>
            {/* Bottom Total row — Packed + Pending per grade (= 1080 when a
                pallet is open). Mirrors the Production Summary's column-
                total row pattern. */}
            <tr className="bg-gray-100">
              <td className="px-3 py-2 border border-gray-200 text-left font-semibold text-gray-800">
                Total
              </td>
              {GRADE_MATRIX_FLAT.map(({ grade }) => {
                const v = totalRowFor(grade.pCode);
                return (
                  <td
                    key={`total-${grade.pCode}`}
                    className={clsx(
                      'px-3 py-2 border border-gray-200 tabular-nums',
                      v > 0 ? 'text-gray-900 font-bold' : 'text-gray-300',
                    )}
                  >
                    {v.toLocaleString()}
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
  );
}
