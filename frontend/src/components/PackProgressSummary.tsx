import clsx from 'clsx';
import { ALL_GRADES, type GradeDef } from '../lib/grades';
import { pendingForPallet, type GradePackState } from '../lib/packingProgress';

// Production-Summary-style table with three rows (Packed OK Qty /
// Pending Qty for a Pallet / Packing number). One column per grade
// that has any activity, plus the currently-selected grade (even at 0)
// when one is provided. Selected column gets a blue accent so the
// operator can read it at a glance.
//
// Shared between the Zebra Packing.tsx (passes a real selectedPCode)
// and the desktop PackingMonitor.tsx (passes null — no selection on
// the supervisor view).

export interface PackProgressSummaryProps {
  progress: Record<string, GradePackState>;
  selectedPCode: string | null;
  // Visual variants — the Zebra screen wedges this between two white
  // strips and wants flush borders; the desktop renders it inside a
  // card with its own header. Default 'flush' matches the Zebra.
  variant?: 'flush' | 'card';
}

export default function PackProgressSummary({
  progress,
  selectedPCode,
  variant = 'flush',
}: PackProgressSummaryProps) {
  const activePCodes = new Set<string>();
  for (const [pCode, st] of Object.entries(progress)) {
    if (st.packed > 0 || st.packingNumber) activePCodes.add(pCode);
  }
  if (selectedPCode) activePCodes.add(selectedPCode);

  const cols = ALL_GRADES.filter((g) => activePCodes.has(g.pCode));

  if (cols.length === 0) {
    return (
      <div
        className={clsx(
          variant === 'card'
            ? 'rounded-xl border border-gray-200 bg-white px-5 py-6 shadow-sm'
            : 'bg-white border-t border-gray-200 px-5 py-3 shrink-0',
          'text-center text-sm text-slate-500',
        )}
      >
        No parts packed yet — select a grade and scan to begin.
      </div>
    );
  }

  return (
    <div
      className={clsx(
        variant === 'card'
          ? 'rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden'
          : 'bg-white border-t border-gray-200 shrink-0',
        'overflow-x-auto',
      )}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-10">
              Pack progress
            </th>
            {cols.map((g) => {
              const isSel = g.pCode === selectedPCode;
              return (
                <th
                  key={g.pCode}
                  className={clsx(
                    'px-3 py-2 text-center border-l border-gray-200',
                    isSel ? 'bg-blue-50' : 'bg-gray-50',
                  )}
                >
                  <div className={clsx('font-extrabold text-base leading-tight', isSel && 'text-blue-700')}>
                    {g.code}
                  </div>
                  <div className="text-[10px] font-mono text-gray-500">{g.pCode}</div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="text-slate-800">
          <SummaryRow
            label="Packed OK Qty"
            cols={cols}
            progress={progress}
            selectedPCode={selectedPCode}
            valueFor={(st) => (st ? String(st.packed) : '0')}
            highlightSelected
          />
          <SummaryRow
            label="Pending Qty for a Pallet"
            cols={cols}
            progress={progress}
            selectedPCode={selectedPCode}
            valueFor={(st) => String(pendingForPallet(st?.packed ?? 0))}
          />
          <SummaryRow
            label="Packing number"
            cols={cols}
            progress={progress}
            selectedPCode={selectedPCode}
            valueFor={(st) => (st?.packingNumber ? st.packingNumber : '—')}
            mono
          />
        </tbody>
      </table>
    </div>
  );
}

function SummaryRow({
  label,
  cols,
  progress,
  selectedPCode,
  valueFor,
  mono,
  highlightSelected,
}: {
  label: string;
  cols: GradeDef[];
  progress: Record<string, GradePackState>;
  selectedPCode: string | null;
  valueFor: (st: GradePackState | undefined) => string;
  mono?: boolean;
  highlightSelected?: boolean;
}) {
  return (
    <tr className="border-b border-gray-100">
      <td className="px-3 py-2 font-medium text-slate-700 whitespace-nowrap sticky left-0 bg-white z-10">
        {label}
      </td>
      {cols.map((g) => {
        const st = progress[g.pCode];
        const isSel = g.pCode === selectedPCode;
        return (
          <td
            key={g.pCode}
            className={clsx(
              'px-3 py-2 text-center border-l border-gray-100 tabular-nums',
              mono && 'font-mono',
              isSel && highlightSelected && 'bg-blue-50 font-extrabold text-blue-700',
              isSel && !highlightSelected && 'bg-blue-50/60',
            )}
          >
            {valueFor(st)}
          </td>
        );
      })}
    </tr>
  );
}
