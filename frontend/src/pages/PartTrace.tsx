import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, CheckCircle, XCircle, Hash, Activity, RotateCw, Cpu, Image as ImageIcon, FileDown } from 'lucide-react';
import clsx from 'clsx';
import ResultBadge from '../components/ResultBadge';
import StateBadge from '../components/StateBadge';
import {
  fetchPart,
  formatDateTime,
  formatTimestamp,
  partTracePdfUrl,
  PART_STATE_LABEL,
  PartResponse,
  SamLogRecord,
} from '../lib/api';

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: typeof Activity;
  color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="flex items-center gap-3">
        <div className={clsx('p-2 rounded-lg', color)}>
          <Icon size={18} className="text-white" />
        </div>
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
          <p className="text-lg font-bold text-gray-900">{value}</p>
        </div>
      </div>
    </div>
  );
}

export default function PartTrace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dmc, setDmc] = useState(searchParams.get('dmc') || '');
  const [searchedDmc, setSearchedDmc] = useState(searchParams.get('dmc') || '');
  const [response, setResponse] = useState<PartResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const doSearch = async (value: string) => {
    if (!value.trim()) return;
    setSearchedDmc(value.trim());
    setSearchParams({ dmc: value.trim() });
    setLoading(true);
    setError('');
    setSearched(true);
    try {
      const result = await fetchPart(value.trim());
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load part data');
      setResponse(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const dmcParam = searchParams.get('dmc');
    if (dmcParam) {
      setDmc(dmcParam);
      doSearch(dmcParam);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(dmc);
  };

  const records: SamLogRecord[] = response?.records ?? [];
  const summary = response?.summary;
  const alarms = response?.alarms ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-8 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-bold text-gray-900">Part Traceability</h1>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={dmc}
              onChange={(e) => setDmc(e.target.value)}
              placeholder="Enter DMC serial number..."
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !dmc.trim()}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Search
          </button>
        </form>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-4 rounded-xl text-sm">{error}</div>
      )}

      {!loading && searched && summary && records.length > 0 && (
        <>
          {/* Current State */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-1 h-6 bg-blue-600 rounded-full" />
              <h2 className="text-lg font-semibold text-gray-800">Current State</h2>
              <a
                href={partTracePdfUrl(searchedDmc)}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 transition-colors"
                title="Download Part Trace report as PDF"
              >
                <FileDown size={14} />
                Download PDF
              </a>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-y-4 gap-x-8">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Serial:</span>
                <span className="text-sm font-mono font-semibold text-gray-900 break-all">{searchedDmc}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">State:</span>
                <StateBadge state={summary.state} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Plant:</span>
                <span className="text-sm font-medium text-gray-800">{summary.latest.Plant_Id || '-'}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Ring Attempts:</span>
                <span className="text-sm font-medium text-gray-800">{summary.total_attempts}</span>
                {summary.reinspected && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    <RotateCw size={10} />
                    Reinspected
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Circlip Status:</span>
                <ResultBadge value={summary.latest.Circlip_Result} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Ring Status:</span>
                <ResultBadge value={summary.latest.Ring_Result} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">First Seen:</span>
                <span className="text-sm text-gray-800">{formatDateTime(summary.first_seen)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Last Seen:</span>
                <span className="text-sm text-gray-800">{formatDateTime(summary.last_seen)}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-28 shrink-0">Unload Time:</span>
                <span className="text-sm text-gray-800">{formatTimestamp(summary.latest.Unloading_Time)}</span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Total Records" value={response.total_records} icon={Hash} color="bg-blue-500" />
            <StatCard label="Ring Attempts" value={summary.total_attempts} icon={Activity} color="bg-amber-500" />
            <StatCard
              label="Reinspected"
              value={summary.reinspected ? 'Yes' : 'No'}
              icon={RotateCw}
              color={summary.reinspected ? 'bg-indigo-500' : 'bg-slate-400'}
            />
            <StatCard
              label="Final State"
              value={PART_STATE_LABEL[summary.state]}
              icon={summary.state === 'PACKED' || summary.state === 'RING_OK' ? CheckCircle : XCircle}
              color={summary.state === 'PACKED' || summary.state === 'RING_OK' ? 'bg-emerald-500' : 'bg-red-500'}
            />
          </div>

          {/* Inspection Attempts — one row per attempt, ordered by Ring_Count ASC. */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-1 h-6 bg-blue-600 rounded-full" />
              <h2 className="text-lg font-semibold text-gray-800">Inspection Attempts</h2>
            </div>
            <div className="space-y-2">
              {records.map((record, i) => {
                const hasCirclip = record.Circlip_Result !== null;
                const hasRing = record.Ring_Result !== null;
                return (
                  <div key={i} className="space-y-2">
                    {hasCirclip && (
                      <div
                        className={clsx(
                          'flex flex-wrap items-center gap-4 px-5 py-3 rounded-lg border-l-4',
                          record.Circlip_Result === 'PASS'
                            ? 'border-l-emerald-500 bg-emerald-50/50'
                            : 'border-l-red-500 bg-red-50/50',
                        )}
                      >
                        <span className="text-xs font-bold text-gray-700 bg-gray-200 px-2.5 py-1 rounded uppercase tracking-wide">
                          Circlip
                        </span>
                        <span className="text-xs text-gray-500">Attempt 1</span>
                        <span
                          className={clsx(
                            'text-sm font-bold',
                            record.Circlip_Result === 'PASS' ? 'text-emerald-700' : 'text-red-700',
                          )}
                        >
                          {record.Circlip_Result}
                        </span>
                        <span className="text-xs text-gray-500">Time: {formatDateTime(record.Date_Time)}</span>
                        <Link
                          to={`/images?dmc=${encodeURIComponent(searchedDmc)}&inspection_type=CIRCLIP`}
                          className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          <ImageIcon size={12} />
                          View Images
                        </Link>
                      </div>
                    )}
                    {hasRing && (
                      <div
                        className={clsx(
                          'flex flex-wrap items-center gap-4 px-5 py-3 rounded-lg border-l-4',
                          record.Ring_Result === 'PASS'
                            ? 'border-l-emerald-500 bg-emerald-50/50'
                            : 'border-l-red-500 bg-red-50/50',
                        )}
                      >
                        <span className="text-xs font-bold text-gray-700 bg-gray-200 px-2.5 py-1 rounded uppercase tracking-wide">
                          Ring
                        </span>
                        <span className="text-xs text-gray-500">Attempt {record.Ring_Count ?? 1}</span>
                        <span
                          className={clsx(
                            'text-sm font-bold',
                            record.Ring_Result === 'PASS' ? 'text-emerald-700' : 'text-red-700',
                          )}
                        >
                          {record.Ring_Result}
                        </span>
                        <span className="text-xs text-gray-500">Time: {formatDateTime(record.Date_Time)}</span>
                        <Link
                          to={`/images?dmc=${encodeURIComponent(searchedDmc)}&inspection_type=RING&attempt=${record.Ring_Count ?? 1}`}
                          className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          <ImageIcon size={12} />
                          View Images
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Alarm History — PLC alarm edges (ON/OFF) recorded for this DMC
              while it was the active part. Rendered between Inspection
              Attempts and Event Timeline, styled to match the former. */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-1 h-6 bg-blue-600 rounded-full" />
              <h2 className="text-lg font-semibold text-gray-800">Alarm History</h2>
            </div>
            {alarms.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">
                No alarms recorded during this part's processing.
              </p>
            ) : (
              <div className="space-y-2">
                {alarms.map((a) => (
                  <div
                    key={a.id}
                    className={clsx(
                      'flex flex-wrap items-center gap-4 px-5 py-3 rounded-lg border-l-4',
                      a.status === 'ON'
                        ? 'border-l-red-500 bg-red-50/50'
                        : 'border-l-gray-400 bg-gray-50/50',
                    )}
                  >
                    <span
                      className={clsx(
                        'text-xs font-bold px-2.5 py-1 rounded uppercase tracking-wide',
                        a.status === 'ON'
                          ? 'bg-red-500 text-white'
                          : 'bg-gray-400 text-white',
                      )}
                    >
                      {a.status}
                    </span>
                    <span className="text-sm font-bold text-gray-800">{a.alarm}</span>
                    <span className="text-xs text-gray-500 ml-auto">
                      Time: {formatDateTime(a.logTime)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Event Timeline */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-1 h-6 bg-blue-600 rounded-full" />
              <h2 className="text-lg font-semibold text-gray-800">Event Timeline</h2>
            </div>
            <div className="relative">
              <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-blue-200" />
              <div className="space-y-4">
                {records.map((record, i) => {
                  const isPass = record.Result === 'PASS';
                  return (
                    <div key={i} className="relative flex gap-4 pl-3">
                      <div
                        className={clsx(
                          'relative z-10 w-7 h-7 rounded-full flex items-center justify-center shrink-0',
                          isPass ? 'bg-emerald-500' : 'bg-red-500',
                        )}
                      >
                        {isPass ? <CheckCircle size={14} className="text-white" /> : <XCircle size={14} className="text-white" />}
                      </div>
                      <div className="flex-1 bg-gray-50 rounded-lg border border-gray-200 p-4 -mt-1">
                        <div className="flex flex-wrap items-center gap-3 mb-2">
                          <span className="text-xs text-gray-400">{formatDateTime(record.Date_Time)}</span>
                          <span className="text-xs font-bold text-gray-600 bg-gray-200 px-2 py-0.5 rounded">{record.Plant_Id}</span>
                          <ResultBadge value={record.Result} />
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div>
                            <span className="text-gray-400">Circlip:</span>{' '}
                            <span
                              className={clsx(
                                'font-semibold',
                                record.Circlip_Result === 'PASS'
                                  ? 'text-emerald-600'
                                  : record.Circlip_Result === 'FAIL'
                                    ? 'text-red-600'
                                    : 'text-gray-400',
                              )}
                            >
                              {record.Circlip_Result || '-'}
                            </span>
                            {record.Circlip_Time && (
                              <span className="text-gray-400"> ({formatTimestamp(record.Circlip_Time)})</span>
                            )}
                          </div>
                          <div>
                            <span className="text-gray-400">Ring:</span>{' '}
                            <span
                              className={clsx(
                                'font-semibold',
                                record.Ring_Result === 'PASS'
                                  ? 'text-emerald-600'
                                  : record.Ring_Result === 'FAIL'
                                    ? 'text-red-600'
                                    : 'text-gray-400',
                              )}
                            >
                              {record.Ring_Result || '-'}
                            </span>
                            {record.Ring_Time && (
                              <span className="text-gray-400"> ({formatTimestamp(record.Ring_Time)})</span>
                            )}
                          </div>
                          <div>
                            <span className="text-gray-400">Ring Count:</span>{' '}
                            <span className="font-semibold text-gray-700">{record.Ring_Count ?? '-'}</span>
                          </div>
                          <div>
                            <span className="text-gray-400">Unload:</span>{' '}
                            <span className="font-semibold text-gray-700">{formatTimestamp(record.Unloading_Time)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {!loading && searched && records.length === 0 && !error && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <Search size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600">No Records Found</h3>
          <p className="text-sm text-gray-400 mt-1">No entries found for DMC: {searchedDmc}</p>
        </div>
      )}

      {!searched && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <Cpu size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600">Search for a Part</h3>
          <p className="text-sm text-gray-400 mt-1">Enter a DMC serial number above to view its full traceability history</p>
        </div>
      )}
    </div>
  );
}
