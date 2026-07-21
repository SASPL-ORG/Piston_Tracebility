import { useEffect, useRef, useState } from 'react';
import { Filter } from 'lucide-react';
import clsx from 'clsx';

export interface ColumnFilterOption {
  value: string;
  label: string;
}

interface ColumnFilterProps {
  options: ColumnFilterOption[];
  // Currently selected values. Empty array = no filter (show all).
  selected: string[];
  onChange: (next: string[]) => void;
  // Optional label shown at the top of the dropdown.
  title?: string;
}

// Click-to-open multi-select filter chip used inside table header cells.
// Closes on outside click. Selected count shown as a small badge next to
// the funnel icon when at least one option is active.
export default function ColumnFilter({ options, selected, onChange, title }: ColumnFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const active = selected.length > 0;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={clsx(
          'inline-flex items-center justify-center w-6 h-6 rounded-md border transition-colors',
          active
            ? 'border-blue-500 bg-blue-50 text-blue-700'
            : 'border-transparent text-gray-400 hover:bg-gray-100 hover:text-gray-700',
        )}
        title={active ? `${selected.length} selected — click to edit` : 'Filter'}
      >
        <Filter size={12} />
        {active && (
          <span className="absolute -top-1 -right-1 bg-blue-600 text-white text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-30 overflow-hidden">
          {title && (
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-400 font-semibold border-b border-gray-100">
              {title}
            </div>
          )}
          <div className="max-h-60 overflow-y-auto py-1">
            {options.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.value)}
                    className="rounded text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
          {active && (
            <div className="border-t border-gray-100 px-3 py-1.5 flex justify-end">
              <button
                onClick={() => onChange([])}
                className="text-xs text-gray-500 hover:text-gray-800"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
