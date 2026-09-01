import clsx from 'clsx';
import { LineScope } from '../lib/api';

// Machine 1 / Machine 2 / Both toggle. Filters every view on the page to a
// single machine line (SAM_Log.Line_ID) or shows both combined. Styled to
// match the Shift toggle. Selection is persisted per-app (shared session key)
// so switching machine on the Dashboard carries over to Lists.
const OPTIONS: { value: LineScope; label: string }[] = [
  { value: 'all', label: 'Both' },
  { value: '1', label: 'Machine 1' },
  { value: '2', label: 'Machine 2' },
];

export default function MachineSelector({
  value,
  onChange,
}: {
  value: LineScope;
  onChange: (v: LineScope) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-slate-200 bg-white p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={clsx(
            'px-3 py-1.5 text-sm font-medium rounded transition-colors',
            value === opt.value
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
