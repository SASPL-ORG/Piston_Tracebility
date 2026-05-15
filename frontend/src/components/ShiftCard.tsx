import { Clock } from 'lucide-react';
import { ShiftBreakdownItem } from '../lib/api';

// One per-shift summary card. Matches the visual weight of the main KPI
// tiles — same border / shadow / padding — but stacks seven KPIs vertically
// in a compact list so three cards fit side-by-side on the dashboard.
export default function ShiftCard({ data }: { data: ShiftBreakdownItem }) {
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: 'Total Parts', value: data.total.toLocaleString(), tone: 'text-gray-900 font-semibold' },
    { label: 'Passed', value: data.passed.toLocaleString(), tone: 'text-emerald-700' },
    { label: 'Circlip Fail', value: data.circlip_fail.toLocaleString(), tone: 'text-red-700' },
    { label: 'Ring Fail', value: data.ring_fail.toLocaleString(), tone: 'text-amber-700' },
    { label: 'In Progress', value: data.in_progress.toLocaleString(), tone: 'text-purple-700' },
    { label: 'Reinspected', value: data.reinspected.toLocaleString(), tone: 'text-indigo-700' },
    { label: 'Pass Rate', value: `${data.pass_rate}%`, tone: 'text-gray-900 font-semibold' },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-blue-50">
          <Clock size={14} className="text-blue-600" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-gray-800 leading-tight">{data.label}</span>
          <span className="text-[11px] font-mono text-gray-400 leading-tight">{data.hours}</span>
        </div>
      </div>
      <div className="border-t border-gray-100 pt-3 space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{r.label}</span>
            <span className={r.tone}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
