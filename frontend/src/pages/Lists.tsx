import { useState, useEffect, useCallback } from 'react';
import { format, subDays } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { Download, ArrowUpDown, ExternalLink } from 'lucide-react';
import DateRangePicker from '../components/DateRangePicker';
import Pagination from '../components/Pagination';
import ResultBadge from '../components/ResultBadge';
import { fetchList, fetchPlants, getExportUrl, SamLogRecord, PaginatedResponse } from '../lib/api';

const TYPE_OPTIONS = [
  { value: 'all', label: 'All Results' },
  { value: 'pass', label: 'Pass Only' },
  { value: 'fail', label: 'Fail Only' },
  { value: 'circlip_fail', label: 'Circlip Fail' },
  { value: 'ring_fail', label: 'Ring Fail' },
];

const COLUMNS = [
  { key: 'Date_Time', label: 'Date / Time' },
  { key: 'Plant_Id', label: 'Plant' },
  { key: 'DMC', label: 'DMC' },
  { key: 'Circlip_Result', label: 'Circlip' },
  { key: 'Circlip_Time', label: 'Circlip Time' },
  { key: 'Ring_Result', label: 'Ring' },
  { key: 'Ring_Time', label: 'Ring Time' },
  { key: 'Ring_Count', label: 'Ring Count' },
  { key: 'Unloading_Time', label: 'Unload Time' },
  { key: 'Result', label: 'Result' },
];

export default function Lists() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [plant, setPlant] = useState('');
  const [plants, setPlants] = useState<string[]>([]);
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('Date_Time');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [data, setData] = useState<PaginatedResponse<SamLogRecord> | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchList({ type, from, to, plant: plant || undefined, page, size: 50, sort, order, search: search || undefined });
      setData(result);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [type, from, to, plant, page, sort, order, search]);

  useEffect(() => { fetchPlants().then(setPlants).catch(() => {}); }, []);
  useEffect(() => { loadData(); }, [loadData]);

  const handleDateChange = (newFrom: string, newTo: string, newPlant: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setPlant(newPlant);
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

  const formatDate = (v: string | null) => {
    if (!v) return '-';
    try { return format(new Date(v), 'dd-MM-yyyy HH:mm:ss'); } catch { return v; }
  };

  const exportUrl = getExportUrl({ type, from, to, plant: plant || undefined, sort, order });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-8 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-bold text-gray-900">Production Lists</h1>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">Type:</label>
            <select
              value={type}
              onChange={(e) => { setType(e.target.value); setPage(1); }}
              className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <DateRangePicker from={from} to={to} plant={plant} plants={plants} onChange={handleDateChange} />
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search DMC..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
          />
          <a
            href={exportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors ml-auto"
          >
            <Download size={14} />
            Export CSV
          </a>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
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
                <tr><td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
              ) : data && data.data.length > 0 ? (
                data.data.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">{formatDate(row.Date_Time)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-600">{row.Plant_Id || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <button
                        onClick={() => navigate(`/part-trace?dmc=${encodeURIComponent(row.DMC || '')}`)}
                        className="text-blue-600 hover:text-blue-800 font-medium inline-flex items-center gap-1"
                      >
                        {row.DMC || '-'}
                        <ExternalLink size={12} />
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><ResultBadge value={row.Circlip_Result} /></td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-500">{row.Circlip_Time || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><ResultBadge value={row.Ring_Result} /></td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-500">{row.Ring_Time || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-500">{row.Ring_Count ?? '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-gray-500">{row.Unloading_Time || '-'}</td>
                    <td className="px-4 py-3 whitespace-nowrap"><ResultBadge value={row.Result} /></td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={COLUMNS.length} className="px-4 py-12 text-center text-gray-400">No records found</td></tr>
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
