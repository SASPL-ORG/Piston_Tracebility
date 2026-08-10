import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import {
  CATALOG_START_DATE,
  fetchMasterDataCatalog,
  formatMasterDataDate,
  MasterDataItem,
} from '../lib/api';

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Build a list of YYYY-MM-DD strings from `from` to `to` inclusive,
// newest first. If `to` is before `from` returns an empty list.
function datesInRange(from: string, to: string): string[] {
  if (!from || !to || from > to) return [];
  const out: string[] = [];
  const start = new Date(from + 'T00:00:00');
  const cursor = new Date(to + 'T00:00:00');
  while (cursor >= start) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

export default function MasterData() {
  const navigate = useNavigate();
  const today = useMemo(() => todayIso(), []);
  const [from, setFrom] = useState<string>(CATALOG_START_DATE);
  const [to, setTo] = useState<string>(today);
  const dates = useMemo(() => datesInRange(from, to), [from, to]);
  // Each date row is independently collapsible. Tracked by ISO date string.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<MasterDataItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCatalog = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchMasterDataCatalog();
      setCatalog(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load catalog');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCatalog(); }, []);

  // Drop expansion state for dates no longer in the visible range. Keeps
  // memory small and avoids "ghost" expansions if the user widens later.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set<string>();
      for (const d of dates) if (prev.has(d)) next.add(d);
      return next;
    });
  }, [dates]);

  const toggle = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 bg-blue-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-900">Master Data</h1>
        </div>
        <button
          onClick={loadCatalog}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* Date range picker — no longer renders pills below. The dates
          themselves are rendered as collapsible rows further down. */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">Dates</h2>
          </div>
          <div className="h-6 w-px bg-gray-200 hidden sm:block" />
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">From:</label>
            <input
              type="date"
              value={from}
              min={CATALOG_START_DATE}
              max={today}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">To:</label>
            <input
              type="date"
              value={to}
              min={from || CATALOG_START_DATE}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => { setFrom(CATALOG_START_DATE); setTo(today); }}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-md hover:bg-gray-50 hover:border-gray-300"
            title="Reset to full catalog range"
          >
            Reset
          </button>
        </div>
      </div>

      {/* One collapsible row per date in the range. Newest first. */}
      {dates.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center text-sm text-gray-400 italic">
          No dates in the selected range
        </div>
      ) : (
        <div className="space-y-3">
          {dates.map((d) => {
            const isOpen = expanded.has(d);
            return (
              <div
                key={d}
                className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
              >
                <button
                  onClick={() => toggle(d)}
                  aria-expanded={isOpen}
                  className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-gray-50/60 transition-colors text-left"
                >
                  <span className="inline-flex items-center gap-3">
                    <div className="w-1 h-6 bg-blue-600 rounded-full" />
                    <h2 className="text-lg font-semibold text-gray-800">
                      {formatMasterDataDate(d)}
                    </h2>
                  </span>
                  <ChevronDown
                    size={20}
                    className={clsx(
                      'text-gray-400 transition-transform duration-200',
                      isOpen ? 'rotate-0' : '-rotate-90',
                    )}
                  />
                </button>
                {isOpen && (
                  <div className="border-t border-gray-200">
                    {loading ? (
                      <div className="flex items-center justify-center py-10">
                        <RefreshCw size={24} className="animate-spin text-blue-500" />
                      </div>
                    ) : catalog.length === 0 ? (
                      <div className="text-center py-10 text-gray-400 text-sm">
                        No master pieces in catalog
                      </div>
                    ) : (
                      <ul className="divide-y divide-gray-100">
                        {catalog.map((item, i) => (
                          <li key={item.id}>
                            <button
                              onClick={() => navigate(`/master-data/${d}/${item.id}`)}
                              className="w-full px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors text-left"
                            >
                              <span className="inline-flex items-center gap-3">
                                <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-blue-50 text-blue-700 text-xs font-bold">
                                  {i + 1}
                                </span>
                                <span className="text-gray-800 text-sm font-medium">{item.identification}</span>
                              </span>
                              <ChevronRight size={16} className="text-gray-400" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
