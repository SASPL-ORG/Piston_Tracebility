import { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, Download, ExternalLink, X } from 'lucide-react';
import clsx from 'clsx';
import DateRangePicker from './DateRangePicker';
import Pagination from './Pagination';
import {
  fetchAlarms,
  formatDateTime,
  getAlarmsExportUrl,
  AlarmListItem,
  PaginatedResponse,
  AlarmStatus,
} from '../lib/api';

type StatusFilter = 'all' | AlarmStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ON', label: 'ON' },
  { value: 'OFF', label: 'OFF' },
];

const COLUMNS = [
  { key: 'LogTime', label: 'Log Time' },
  { key: 'BatchID', label: 'Batch ID (DMC)' },
  { key: 'Alarm', label: 'Alarm' },
  { key: 'Status', label: 'Status' },
];

function StatusBadge({ value }: { value: AlarmStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide',
        value === 'ON' ? 'bg-red-500 text-white' : 'bg-gray-400 text-white',
      )}
    >
      {value}
    </span>
  );
}

interface AlarmsPanelProps {
  /** Optional handler shown as a close (X) button in the header. */
  onClose?: () => void;
}

export default function AlarmsPanel({ onClose }: AlarmsPanelProps) {
  const navigate = useNavigate();
  const today = format(new Date(), 'yyyy-MM-dd');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [batch, setBatch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('LogTime');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [data, setData] = useState<PaginatedResponse<AlarmListItem> | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchAlarms({
        from,
        to,
        status,
        batch: batch || undefined,
        page,
        size: 50,
        sort,
        order,
      });
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, status, batch, page, sort, order]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDateChange = (newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setPage(1);
  };

  const handleSort = (col: string) => {
    if (sort === col) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(col);
      setOrder('desc');
    }
    setPage(1);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 bg-red-500 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-800">PLC Alarms</h2>
          {data && (
            <span className="text-xs text-gray-500">
              {data.total.toLocaleString()} total
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={getAlarmsExportUrl({ from, to, status, batch: batch || undefined, sort, order })}
            target="_blank"
            rel="noopener noreferrer"
            className={clsx(
              'inline-flex items-center gap-2 px-3.5 py-1.5 text-sm font-medium rounded-md transition-colors',
              data && data.total > 0
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-gray-200 text-gray-400 pointer-events-none',
            )}
            title="Export the filtered alarms to a spreadsheet (CSV — opens in Excel / Google Sheets)"
          >
            <Download size={14} />
            Export
          </a>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md"
              aria-label="Close PLC alarms panel"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <DateRangePicker
          from={from}
          to={to}
          plant=""
          plants={[]}
          onChange={(f, t) => handleDateChange(f, t)}
          todayOverride={today}
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">Status:</label>
            <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { setStatus(opt.value); setPage(1); }}
                  className={clsx(
                    'px-3 py-1.5 text-xs font-medium transition-colors',
                    status === opt.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <input
            type="text"
            placeholder="Search BatchID / DMC..."
            value={batch}
            onChange={(e) => { setBatch(e.target.value); setPage(1); }}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none whitespace-nowrap"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      <ArrowUpDown size={12} className={sort === col.key ? 'text-blue-600' : 'text-gray-300'} />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              ) : data && data.data.length > 0 ? (
                data.data.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatDateTime(row.logTime)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {row.batchId ? (
                        <button
                          onClick={() => navigate(`/part-trace?dmc=${encodeURIComponent(row.batchId!)}`)}
                          className="text-blue-600 hover:text-blue-800 font-mono text-xs inline-flex items-center gap-1"
                          title="Open this DMC in Part Trace"
                        >
                          {row.batchId}
                          <ExternalLink size={12} />
                        </button>
                      ) : (
                        <span className="text-gray-400 italic">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-800 font-medium">{row.alarm}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusBadge value={row.status} /></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-gray-400">
                    No alarms in the selected window
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="px-4 border-t border-gray-200">
            <Pagination page={data.page} totalPages={data.total_pages} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
