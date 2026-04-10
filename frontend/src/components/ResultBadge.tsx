import clsx from 'clsx';

export default function ResultBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-300">-</span>;

  const isPASS = value === 'PASS';
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold',
        isPASS ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
      )}
    >
      {value}
    </span>
  );
}
