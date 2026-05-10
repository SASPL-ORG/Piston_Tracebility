import { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  color: 'blue' | 'green' | 'red' | 'amber' | 'purple' | 'indigo' | 'slate';
}

const colorMap = {
  blue: { bg: 'bg-blue-50', icon: 'text-blue-600', border: 'border-blue-100' },
  green: { bg: 'bg-emerald-50', icon: 'text-emerald-600', border: 'border-emerald-100' },
  red: { bg: 'bg-red-50', icon: 'text-red-600', border: 'border-red-100' },
  amber: { bg: 'bg-amber-50', icon: 'text-amber-600', border: 'border-amber-100' },
  purple: { bg: 'bg-purple-50', icon: 'text-purple-600', border: 'border-purple-100' },
  indigo: { bg: 'bg-indigo-50', icon: 'text-indigo-600', border: 'border-indigo-100' },
  slate: { bg: 'bg-slate-50', icon: 'text-slate-600', border: 'border-slate-100' },
};

export default function KpiCard({ title, value, subtitle, icon: Icon, color }: KpiCardProps) {
  const colors = colorMap[color];

  return (
    <div className={clsx('bg-white rounded-xl border shadow-sm p-5 h-full flex flex-col', colors.border)}>
      <div className="flex items-start justify-between gap-3">
        {/* Reserve two lines worth of vertical space for the title so cards
            with one-word titles align with cards whose titles wrap. */}
        <p className="text-sm font-medium text-gray-500 uppercase tracking-wide leading-tight min-h-[2.5rem]">
          {title}
        </p>
        <div className={clsx('p-3 rounded-lg shrink-0', colors.bg)}>
          <Icon size={22} className={colors.icon} />
        </div>
      </div>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-gray-400 min-h-[1rem]">{subtitle}</p>}
    </div>
  );
}
