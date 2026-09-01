import clsx from 'clsx';
import { PartState, PART_STATE_LABEL } from '../lib/api';

const STATE_STYLE: Record<PartState, string> = {
  // Packed = Zebra-scanned: deeper green so it visually pops over Completed
  PACKED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  // Completed = line-finished but not yet packed: lighter green
  COMPLETED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RING_OK: 'bg-teal-50 text-teal-700 border-teal-200',
  RING_NG: 'bg-red-50 text-red-700 border-red-200',
  CIRCLIP_SCRAP: 'bg-red-100 text-red-800 border-red-300',
  IN_PROGRESS: 'bg-slate-50 text-slate-600 border-slate-200',
  // Aborted = only a loading scan, never reached circlip assembly (picked/faulted
  // at loading). Amber/orange so it reads as "not a real reject, just abandoned".
  ABORTED: 'bg-amber-50 text-amber-700 border-amber-200',
};

export default function StateBadge({ state }: { state: PartState }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border',
        STATE_STYLE[state],
      )}
    >
      {PART_STATE_LABEL[state]}
    </span>
  );
}
