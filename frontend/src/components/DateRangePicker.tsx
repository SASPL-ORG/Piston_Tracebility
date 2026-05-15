import { format, subDays, startOfMonth, parseISO } from 'date-fns';

interface DateRangePickerProps {
  from: string;
  to: string;
  plant: string;
  plants: string[];
  onChange: (from: string, to: string, plant: string) => void;
  // Optional override for what "today" means. Dashboard passes
  // getProductionDate() so "Today" / "7 Days" / "This Month" all anchor on
  // the production-date rollover (07:30 boundary). Default = calendar today.
  todayOverride?: string;
}

interface Preset {
  label: string;
  getRange: (todayIso: string) => { from: string; to: string };
}

const presets: Preset[] = [
  {
    label: 'Today',
    getRange: (t) => ({ from: t, to: t }),
  },
  {
    label: '7 Days',
    getRange: (t) => ({ from: format(subDays(parseISO(t), 7), 'yyyy-MM-dd'), to: t }),
  },
  {
    label: '30 Days',
    getRange: (t) => ({ from: format(subDays(parseISO(t), 30), 'yyyy-MM-dd'), to: t }),
  },
  {
    label: 'This Month',
    getRange: (t) => ({ from: format(startOfMonth(parseISO(t)), 'yyyy-MM-dd'), to: t }),
  },
];

export default function DateRangePicker({ from, to, plant, plants, onChange, todayOverride }: DateRangePickerProps) {
  const today = todayOverride ?? format(new Date(), 'yyyy-MM-dd');
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Presets */}
      <div className="flex gap-1">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              const r = p.getRange(today);
              onChange(r.from, r.to, plant);
            }}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="h-6 w-px bg-gray-200 hidden sm:block" />

      {/* Date inputs */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 font-medium">From:</label>
        <input
          type="date"
          value={from}
          onChange={(e) => onChange(e.target.value, to, plant)}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500 font-medium">To:</label>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange(from, e.target.value, plant)}
          className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      {/* Plant filter */}
      {plants.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">Plant:</label>
          <select
            value={plant}
            onChange={(e) => onChange(from, to, e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          >
            <option value="">All Plants</option>
            {plants.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
