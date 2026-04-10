import { format, subDays, startOfMonth } from 'date-fns';

interface DateRangePickerProps {
  from: string;
  to: string;
  plant: string;
  plants: string[];
  onChange: (from: string, to: string, plant: string) => void;
}

const presets = [
  { label: 'Today', getRange: () => ({ from: format(new Date(), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }) },
  { label: '7 Days', getRange: () => ({ from: format(subDays(new Date(), 7), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }) },
  { label: '30 Days', getRange: () => ({ from: format(subDays(new Date(), 30), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }) },
  { label: 'This Month', getRange: () => ({ from: format(startOfMonth(new Date()), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }) },
];

export default function DateRangePicker({ from, to, plant, plants, onChange }: DateRangePickerProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Presets */}
      <div className="flex gap-1">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              const r = p.getRange();
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
