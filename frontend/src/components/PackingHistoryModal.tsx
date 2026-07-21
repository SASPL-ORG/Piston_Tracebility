import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Search, ChevronLeft, ChevronRight, Loader2, Inbox, Printer } from 'lucide-react';
import clsx from 'clsx';
import {
  fetchPackingHistory,
  fetchPackingHistoryDetail,
  completePackingPallet,
  type PackingHistoryEntry,
  type PackingHistoryDetail,
  type PackingHistoryFilters,
} from '../lib/api';
import { GRADE_BY_PCODE } from '../lib/grades';
import { format } from 'date-fns';

// Packing history modal — opened from the "History" button on the Live
// Mirror page. Two views inside a single dialog:
//   1. List of every pallet packing number from this backend session,
//      with a search box that filters by substring (case-insensitive).
//   2. Drill-in for a selected packing number, listing every DMC packed
//      under it in pack order.
// The "← Back" arrow returns to the list. The outer X dismisses the
// whole modal.

interface PackingHistoryModalProps {
  onClose: () => void;
  // If set (e.g. ?pallet=29062601 in the URL after scanning a QR on a
  // printed label), auto-jump to that pallet's detail view once the
  // history list has loaded. Falls back to "0 parts" if the pallet
  // isn't in the current backend session's memory.
  initialPackingNumber?: string;
}

export default function PackingHistoryModal({
  onClose,
  initialPackingNumber,
}: PackingHistoryModalProps) {
  const [list, setList] = useState<PackingHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PackingHistoryEntry | null>(null);
  const [detail, setDetail] = useState<PackingHistoryDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeMsg, setCompleteMsg] = useState<string | null>(null);
  // Filter state — defaults to "today only". Operator can broaden to a
  // date range, narrow by shift, or scope to a specific hour-of-day
  // window (mirrors the Lists page filter shape).
  const today = format(new Date(), 'yyyy-MM-dd');
  const [filters, setFilters] = useState<PackingHistoryFilters>({
    from: today,
    to: today,
    shift: 'all',
    time_from: '',
    time_to: '',
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPackingHistory(filters)
      .then((rows) => {
        if (cancelled) return;
        setList(rows);
        setLoading(false);
        setError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  // Deep-link auto-jump: when the modal was opened with a target pallet
  // number (from ?pallet=... in the URL), skip the list view and load
  // the detail view directly. If we can find the matching entry in the
  // history list, use it (proper count + grade). Otherwise synthesize
  // a stub — the detail view's own fetch will populate the rows.
  useEffect(() => {
    if (!initialPackingNumber || loading || selected) return;
    const found = list.find((e) => e.packingNumber === initialPackingNumber);
    setSelected(
      found ?? {
        packingNumber: initialPackingNumber,
        grade: '',
        count: 0,
        firstPackedAt: '',
        lastPackedAt: '',
        active: false,
      },
    );
  }, [initialPackingNumber, list, loading, selected]);

  useEffect(() => {
    if (!selected) {
      setDetail([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetchPackingHistoryDetail(selected.packingNumber)
      .then((rows) => {
        if (!cancelled) setDetail(rows);
      })
      .catch(() => {
        if (!cancelled) setDetail([]);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((e) => e.packingNumber.toLowerCase().includes(q));
  }, [list, search]);

  // Close on Escape — minor polish so the dialog feels native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onClose]);

  // "Print & Complete" — close the active pallet for its grade (so the
  // next pack of that grade allocates a fresh packing number) AND open
  // a print-friendly label page in a new tab.
  //
  // CRITICAL: window.open must run SYNCHRONOUSLY from the click event
  // — otherwise browsers (post any `await`) classify it as a non-user-
  // initiated popup, block it, and fall back to navigating the CURRENT
  // tab. That's why the History button was "disappearing": the user's
  // tab was redirected to the print page instead of opening a new one.
  // We grab the new window first, kick off the API call, and surface a
  // clear "allow popups" message if the browser still refused.
  const handlePrintAndComplete = () => {
    if (!selected) return;
    const printUrl = `/packing/print/${encodeURIComponent(selected.packingNumber)}`;
    const printWindow = window.open(printUrl, '_blank', 'noopener');
    setCompleting(true);
    setCompleteMsg(null);
    completePackingPallet(selected.packingNumber)
      .then((r) => {
        if (r.completed) {
          setCompleteMsg(
            `Pallet ${r.packingNumber} marked complete — next ${gradeLabel(r.grade ?? '')} pack will start a new pallet.`,
          );
        } else {
          setCompleteMsg(r.message ?? 'Pallet was already closed.');
        }
        if (!printWindow) {
          setCompleteMsg(
            (prev) =>
              (prev ? prev + ' ' : '') +
              'Pop-up was blocked — allow pop-ups for this site to see the print label.',
          );
        }
      })
      .catch((e: unknown) => {
        setCompleteMsg(`Failed to close pallet: ${(e as Error).message}`);
      })
      .finally(() => {
        setCompleting(false);
      });
  };

  const gradeLabel = (pCode: string) => GRADE_BY_PCODE.get(pCode)?.code ?? pCode;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-200">
          {selected && (
            <button
              onClick={() => { setSelected(null); setCompleteMsg(null); }}
              className="flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-800"
            >
              <ChevronLeft size={16} />
              Back
            </button>
          )}
          <div className="w-1 h-6 bg-blue-600 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-800 flex-1">
            {selected ? (
              <>
                Pallet{' '}
                <span className="font-mono">{selected.packingNumber}</span>
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({selected.count} {selected.count === 1 ? 'part' : 'parts'} · grade {gradeLabel(selected.grade)})
                </span>
              </>
            ) : (
              'Packing History'
            )}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="p-6 text-center text-red-700 text-sm">{error}</div>
          ) : selected ? (
            <DetailList rows={detail} loading={detailLoading} />
          ) : (
            <>
              <div className="p-4 border-b border-gray-100 sticky top-0 bg-white z-10 space-y-3">
                <FilterRow filters={filters} setFilters={setFilters} />
                <div className="relative">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search pallet number (e.g. 290626)…"
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
              </div>
              <ListView
                rows={filtered}
                loading={loading}
                gradeLabel={gradeLabel}
                onSelect={(e) => setSelected(e)}
              />
            </>
          )}
        </div>

        {/* Action bar (detail view only). When the pallet is still
            ACTIVE (operator hasn't completed it yet), show
            "Print & Complete" — that closes it on the backend AND opens
            the printable label. After completion, the same row's button
            switches to "View Print" so the operator can re-print the
            label any number of times without re-closing anything. */}
        {selected && (
          <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center gap-3">
            {completeMsg && (
              <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                {completeMsg}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => { setSelected(null); setCompleteMsg(null); }}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-100"
              >
                Back to pallets
              </button>
              {selected.active ? (
                <button
                  onClick={handlePrintAndComplete}
                  disabled={completing}
                  className={clsx(
                    'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold text-white',
                    'bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed',
                  )}
                  title="Mark this pallet complete and open the printable label"
                >
                  <Printer size={16} />
                  {completing ? 'Closing…' : 'Print & Complete'}
                </button>
              ) : (
                <button
                  onClick={() =>
                    window.open(
                      `/packing/print/${encodeURIComponent(selected.packingNumber)}`,
                      '_blank',
                      'noopener',
                    )
                  }
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold text-white bg-blue-600 hover:bg-blue-700"
                  title="Re-open the printable label — pallet is already closed"
                >
                  <Printer size={16} />
                  View Print
                </button>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-gray-200 text-[11px] text-gray-400 bg-gray-50">
          History is kept in backend memory and resets on container restart.
          The Packed_Log_TEST table stores every pack permanently.
        </div>
      </div>
    </div>
  );
}

function ListView({
  rows,
  loading,
  gradeLabel,
  onSelect,
}: {
  rows: PackingHistoryEntry[];
  loading: boolean;
  gradeLabel: (pCode: string) => string;
  onSelect: (e: PackingHistoryEntry) => void;
}) {
  if (loading) {
    return (
      <div className="p-10 flex items-center justify-center text-gray-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 flex flex-col items-center justify-center text-gray-400">
        <Inbox size={32} strokeWidth={1.5} className="mb-2 opacity-60" />
        <div className="text-sm">No pallets yet.</div>
        <div className="text-xs mt-1">Scan a piston on the Zebra to start the first pallet.</div>
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
          <th className="px-4 py-2.5 text-left">Pallet number</th>
          <th className="px-4 py-2.5 text-left">Grade</th>
          <th className="px-4 py-2.5 text-right">Parts</th>
          <th className="px-4 py-2.5 text-left">First pack</th>
          <th className="px-4 py-2.5 text-left">Last pack</th>
          <th className="px-4 py-2.5"></th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((e) => (
          <tr
            key={e.packingNumber}
            onClick={() => onSelect(e)}
            className="cursor-pointer hover:bg-blue-50 transition-colors"
          >
            <td className="px-4 py-2.5 font-mono font-semibold text-slate-800">
              {e.packingNumber}
            </td>
            <td className="px-4 py-2.5 font-semibold text-slate-700">
              {gradeLabel(e.grade)}{' '}
              <span className="text-xs font-mono text-gray-400 ml-1">{e.grade}</span>
            </td>
            <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-800">
              {e.count}
            </td>
            <td className="px-4 py-2.5 text-slate-600 text-xs tabular-nums whitespace-nowrap">
              {formatTs(e.firstPackedAt)}
            </td>
            <td className="px-4 py-2.5 text-slate-600 text-xs tabular-nums whitespace-nowrap">
              {formatTs(e.lastPackedAt)}
            </td>
            <td className="px-2 py-2.5 text-gray-400">
              <ChevronRight size={16} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DetailList({ rows, loading }: { rows: PackingHistoryDetail[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="p-10 flex items-center justify-center text-gray-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-gray-400">
        No parts found for this pallet.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider sticky top-0">
          <th className="px-4 py-2.5 text-left w-10">#</th>
          <th className="px-4 py-2.5 text-left">DMC (2D barcode)</th>
          <th className="px-4 py-2.5 text-left whitespace-nowrap">Packed at</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r, i) => (
          <tr key={`${r.dmc}-${i}`} className={clsx(i % 2 === 0 ? 'bg-white' : 'bg-gray-50/30')}>
            <td className="px-4 py-2 text-gray-400 tabular-nums">{i + 1}</td>
            <td className="px-4 py-2 font-mono text-xs break-all">
              {/* Each DMC links to the Part Trace page for that piston —
                  navigation also dismisses the modal because the route
                  changes from /packing-live to /part-trace. */}
              <Link
                to={`/part-trace?dmc=${encodeURIComponent(r.dmc)}`}
                className="text-blue-600 hover:text-blue-800 hover:underline"
                title="Open this part's full traceability details"
              >
                {r.dmc}
              </Link>
            </td>
            <td className="px-4 py-2 text-xs tabular-nums text-slate-600 whitespace-nowrap">
              {formatTs(r.packedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FilterRow({
  filters,
  setFilters,
}: {
  filters: PackingHistoryFilters;
  setFilters: (f: PackingHistoryFilters) => void;
}) {
  const today = format(new Date(), 'yyyy-MM-dd');
  const now = new Date();
  const presetFrom = (kind: 'today' | '7d' | '30d' | 'month'): string => {
    if (kind === 'today') return today;
    if (kind === '7d') {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return format(d, 'yyyy-MM-dd');
    }
    if (kind === '30d') {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return format(d, 'yyyy-MM-dd');
    }
    // month
    return format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
  };
  const applyPreset = (kind: 'today' | '7d' | '30d' | 'month') => {
    setFilters({ ...filters, from: presetFrom(kind), to: today });
  };
  // Detect which preset is currently active by matching the From/To
  // pair against the preset's expected range. All four chips share the
  // same highlight rule so the active one is always visually obvious.
  const matches = (kind: 'today' | '7d' | '30d' | 'month'): boolean =>
    filters.to === today && filters.from === presetFrom(kind);
  const isToday = matches('today');
  const is7d = matches('7d');
  const is30d = matches('30d');
  const isMonth = matches('month');
  const chipCls = (active: boolean) =>
    clsx(
      'px-3 py-1.5 text-xs font-semibold rounded-md border',
      active
        ? 'bg-blue-600 text-white border-blue-600'
        : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50',
    );

  const shiftBtn = (s: 'all' | 'A' | 'B' | 'C', label: string) => (
    <button
      key={s}
      onClick={() => setFilters({ ...filters, shift: s })}
      className={clsx(
        'px-3 py-1.5 text-xs font-semibold rounded-md border',
        (filters.shift ?? 'all') === s
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => applyPreset('today')} className={chipCls(isToday)}>Today</button>
        <button onClick={() => applyPreset('7d')} className={chipCls(is7d)}>7 Days</button>
        <button onClick={() => applyPreset('30d')} className={chipCls(is30d)}>30 Days</button>
        <button onClick={() => applyPreset('month')} className={chipCls(isMonth)}>This Month</button>
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-gray-500">From:</span>
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            className="text-xs px-2 py-1 border border-gray-200 rounded-md"
          />
          <span className="text-xs text-gray-500 ml-1">To:</span>
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            className="text-xs px-2 py-1 border border-gray-200 rounded-md"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Shift:</span>
        {shiftBtn('all', 'All')}
        {shiftBtn('A', 'Shift A')}
        {shiftBtn('B', 'Shift B')}
        {shiftBtn('C', 'Shift C')}
        <div className="flex items-center gap-1 ml-2">
          <span className="text-xs text-gray-500">From hour:</span>
          <input
            type="time"
            value={filters.time_from ?? ''}
            onChange={(e) => setFilters({ ...filters, time_from: e.target.value })}
            className="text-xs px-2 py-1 border border-gray-200 rounded-md"
          />
          <span className="text-xs text-gray-500 ml-1">To hour:</span>
          <input
            type="time"
            value={filters.time_to ?? ''}
            onChange={(e) => setFilters({ ...filters, time_to: e.target.value })}
            className="text-xs px-2 py-1 border border-gray-200 rounded-md"
          />
        </div>
      </div>
    </div>
  );
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return iso;
  }
}
