import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, RefreshCw } from 'lucide-react';
import {
  fetchFailures,
  formatDateTime,
  formatPlantName,
  ListFailureItem,
  ListFailuresResponse,
} from '../lib/api';

export type FailureType = 'circlip' | 'ring';

export interface FailuresModalProps {
  type: FailureType;
  // Filters carried in from the Lists page so the modal shows the
  // same slice the operator is currently looking at.
  from: string;
  to: string;
  shift: 'A' | 'B' | 'C' | 'all';
  plant: string; // '' = all plants
  // Pre-computed strings for the subtitle: "30 Days · Shift B · All
  // Plants" — the modal doesn't try to reverse-engineer the date label
  // from the from/to range, the calling page does that.
  rangeLabel: string;
  onClose: () => void;
}

const TITLE: Record<FailureType, string> = {
  circlip: 'Snap Ring Failures',
  ring: 'Ring Failures',
};

const SHIFT_LABEL: Record<'A' | 'B' | 'C' | 'all', string> = {
  A: 'Shift A',
  B: 'Shift B',
  C: 'Shift C',
  all: 'All Shifts',
};

export default function FailuresModal({
  type,
  from,
  to,
  shift,
  plant,
  rangeLabel,
  onClose,
}: FailuresModalProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<ListFailuresResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetchFailures({
        type,
        from,
        to,
        shift,
        plant: plant || undefined,
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [type, from, to, shift, plant]);

  useEffect(() => {
    load();
  }, [load]);

  // Esc closes the modal — matches the Lightbox component's pattern.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const plantLabel = plant ? formatPlantName(plant) : 'All Plants';
  const countLabel =
    data?.count != null ? `${data.count.toLocaleString()} parts` : '';
  const subtitleParts = [rangeLabel, SHIFT_LABEL[shift], plantLabel, countLabel].filter(Boolean);

  const goToPartTrace = (dmc: string | null) => {
    if (!dmc) return;
    navigate(`/part-trace?dmc=${encodeURIComponent(dmc)}`);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-[1000px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900">{TITLE[type]}</h2>
            <p className="text-xs text-gray-500 mt-1 truncate">{subtitleParts.join(' · ')}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded-md transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: '70vh' }}>
          {loading && (
            <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
              <RefreshCw size={16} className="animate-spin mr-2" />
              Loading…
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <p className="text-sm text-red-600">Failed to load. Try again.</p>
              <button
                onClick={load}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && data && data.items.length === 0 && (
            <div className="py-16 text-center text-sm text-gray-500">
              No failed parts in this range.
            </div>
          )}

          {/* Why did these fail — per-reason summary above the part list, so
              the dominant cause is visible without reading every row. */}
          {!loading && !error && data && data.reason_breakdown?.length > 0 && (
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Rejection reasons
              </div>
              <div className="flex flex-wrap gap-2">
                {data.reason_breakdown.map((r) => (
                  <span
                    key={r.reason}
                    title={`${r.count} of ${data.count} parts (${r.pct}%)`}
                    className={
                      'inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold border ' +
                      (r.reason === 'Not recorded'
                        ? 'bg-slate-100 text-slate-600 border-slate-300'
                        : 'bg-red-50 text-red-700 border-red-200')
                    }
                  >
                    {r.reason}
                    <span className="tabular-nums font-bold">{r.count}</span>
                    <span className="text-[10px] font-normal opacity-70">{r.pct}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {!loading && !error && data && data.items.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="border-b border-gray-200">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap w-16">S.No.</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Date / Time</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Plant</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">DMC</th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.items.map((row: ListFailureItem) => (
                  <tr key={row.s_no} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-2 whitespace-nowrap text-gray-500 font-medium">{row.s_no}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-600">{formatDateTime(row.date_time)}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-600">{formatPlantName(row.plant_id)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <button
                        onClick={() => goToPartTrace(row.dmc)}
                        className="text-blue-600 hover:text-blue-800 font-medium inline-flex items-center gap-1"
                      >
                        {row.dmc || '-'}
                        <ExternalLink size={12} />
                      </button>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-gray-700">
                      {row.rejection_reason || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data?.truncated && (
            <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-xs text-amber-800">
              Showing the first 1,000 failures. Narrow the date range or shift to see the rest.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 rounded-md transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
