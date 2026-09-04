import { useState, useEffect, useCallback } from 'react';
import { Package, CheckCircle, XCircle, AlertTriangle, Percent, RefreshCw, Clock, RotateCw, Ban, Images as ImagesIcon } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import clsx from 'clsx';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import MachineSelector from '../components/MachineSelector';
import { useSessionState } from '../lib/useSessionState';
import {
  fetchDashboard,
  fetchHealth,
  HealthResponse,
  DashboardResponse,
  PartState,
  PART_STATE_LABEL,
  ProductionGranularity,
  ShiftScope,
  LineScope,
} from '../lib/api';
import { getProductionDate, SHIFTS } from '../lib/shifts';

const SHIFT_OPTIONS: { value: ShiftScope; label: string }[] = [
  { value: 'all', label: 'All' },
  ...SHIFTS.map((s) => ({ value: s.id, label: s.label })),
];

const STATE_COLORS: Record<PartState, string> = {
  PACKED: '#059669',       // deeper green — Zebra-packed
  COMPLETED: '#34d399',    // lighter green — line-finished, not yet packed
  RING_OK: '#14b8a6',      // teal
  IN_PROGRESS: '#f59e0b',  // amber
  RING_NG: '#ef4444',      // red
  CIRCLIP_SCRAP: '#b91c1c',// deeper red
  ABORTED: '#f97316',      // orange — loading-only, never reached circlip
};

function formatBucketTick(value: string, granularity: ProductionGranularity): string {
  // Backend emits 'yyyy-MM-dd HH:00' for hour or 'yyyy-MM-dd' for day/week.
  if (granularity === 'hour') return value.slice(11, 16); // HH:00
  // day or week: dd-MM
  return `${value.slice(8, 10)}-${value.slice(5, 7)}`;
}

function granularityLabel(g: ProductionGranularity): string {
  if (g === 'hour') return 'hourly';
  if (g === 'day') return 'daily';
  return 'weekly';
}

export default function Dashboard() {
  // Production-date anchor: before 07:30 in the morning this resolves to
  // yesterday's calendar date, because Shift C from the previous day is
  // still in progress and the operator expects to see its production.
  const today = getProductionDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  // Shift scope composes with the date filter — they're independent. Default
  // 'all' shows the full date range unscoped; A/B/C narrows every widget on
  // the page to that shift's window within the date range.
  const [shift, setShift] = useState<ShiftScope>('all');
  // Machine/line selector — shared session key so it carries across to Lists.
  const [line, setLine] = useSessionState<LineScope>('app/line', 'all');
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Image-pipeline health pill — polled alongside the dashboard refresh.
  const [imgHealth, setImgHealth] = useState<HealthResponse['imageWatcher'] | null>(null);
  const loadHealth = useCallback(async () => {
    try {
      const h = await fetchHealth();
      setImgHealth(h.imageWatcher);
    } catch {
      /* health pill is non-critical; ignore failures */
    }
  }, []);

  // Background refresh — same call as `loadData` but doesn't toggle the
  // page-level "loading" spinner. The Dashboard is meant to feel live;
  // we don't want the visible state to flicker every 30 s.
  const loadDataSilent = useCallback(async () => {
    try {
      const result = await fetchDashboard(from, to, { shift, line });
      setData(result);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, [from, to, shift, line]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchDashboard(from, to, { shift, line });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [from, to, shift, line]);

  useEffect(() => {
    loadData();
    loadHealth();
  }, [loadData, loadHealth]);

  // Auto-refresh every 30 s — Dashboard only. Skips when the tab is
  // backgrounded so we don't burn cycles for an unseen view, and skips
  // when a foreground load is already in flight. Only Dashboard does
  // this; Lists / Part Trace / Images intentionally do NOT auto-refresh
  // so they don't disrupt the operator's filter selections mid-task.
  const AUTO_REFRESH_MS = 30_000;
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (loading) return;
      void loadDataSilent();
      void loadHealth();
    };
    const id = window.setInterval(tick, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadDataSilent, loadHealth, loading]);

  const handleDateChange = (newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
  };

  const stateData = (data?.state_breakdown ?? []).map((s) => ({
    name: PART_STATE_LABEL[s.state],
    value: s.count,
    state: s.state,
    color: STATE_COLORS[s.state],
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 bg-blue-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-900">Production Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Image-pipeline pile-up pill: green when clear, amber when images
              are backlogged waiting for their inspection rows. */}
          {imgHealth && imgHealth.pendingImages !== null && (
            <span
              title={
                imgHealth.backlogged
                  ? `${imgHealth.pendingImages} images waiting for their inspection row — the line is producing images faster than rows are being written (check Node-RED / PLC).`
                  : `Image pipeline healthy — ${imgHealth.pendingImages} images pending match.`
              }
              className={clsx(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border',
                imgHealth.backlogged
                  ? 'bg-amber-50 text-amber-700 border-amber-300'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200',
              )}
            >
              <ImagesIcon size={13} />
              {imgHealth.backlogged
                ? `Images backlogged: ${imgHealth.pendingImages}`
                : 'Images OK'}
            </span>
          )}
          <span className="text-xs text-gray-400 hidden sm:inline">Auto-refreshing every 30s</span>
          <button
            onClick={loadData}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters — date range + shift scope. Shift filter composes with
          (does not change) the date range. The today override anchors all
          date presets on the production-date rollover (07:30). */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        <DateRangePicker
          from={from}
          to={to}
          plant=""
          plants={[]}
          onChange={(f, t) => handleDateChange(f, t)}
          todayOverride={today}
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">Machine:</label>
          <MachineSelector value={line} onChange={setLine} />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-medium">Shift:</label>
          <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
            {SHIFT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setShift(opt.value)}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  shift === opt.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* KPI Cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-4 auto-rows-fr">
          <KpiCard title="Total Parts" value={data.kpis.total.toLocaleString()} icon={Package} color="blue" subtitle="Distinct parts" />
          <KpiCard title="Passed" value={data.kpis.passed.toLocaleString()} icon={CheckCircle} color="green" subtitle="Final OK" />
          <KpiCard title="Snap Ring Fail" value={data.kpis.circlip_fail.toLocaleString()} icon={XCircle} color="red" subtitle="Final fail (not saved)" />
          <KpiCard title="Ring Fail" value={data.kpis.ring_fail.toLocaleString()} icon={AlertTriangle} color="amber" subtitle="Final fail (not saved)" />
          <KpiCard title="In Progress" value={data.kpis.in_progress.toLocaleString()} icon={Clock} color="purple" subtitle="Ring not yet recorded" />
          <KpiCard title="DMC OK" value={data.kpis.aborted.toLocaleString()} icon={Ban} color="orange" subtitle="Loading scan only — never reached circlip" />
          <KpiCard title="Snap Ring Re-inspection" value={data.kpis.circlip_reinspected.toLocaleString()} icon={RotateCw} color="indigo" subtitle="Saved by re-inspection" />
          <KpiCard title="Ring Re-inspection" value={data.kpis.ring_reinspected.toLocaleString()} icon={RotateCw} color="indigo" subtitle="Saved by re-inspection" />
          <KpiCard title="Pass Rate" value={`${data.kpis.pass_rate}%`} icon={Percent} color="slate" subtitle="Overall yield" />
        </div>
      )}

      {/* Charts */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Production breakdown — adaptive bucketing, three colors */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-800">Production Summary</h3>
              <span className="text-xs text-gray-400">{granularityLabel(data.granularity)}</span>
            </div>
            {data.production_breakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={data.production_breakdown}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(v: string) => formatBucketTick(v, data.granularity)}
                    fontSize={12}
                    tick={{ fill: '#6b7280' }}
                    minTickGap={8}
                  />
                  <YAxis fontSize={12} tick={{ fill: '#6b7280' }} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={(v: string) => v}
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                  />
                  <Legend />
                  <Bar dataKey="passed" stackId="a" fill="#10b981" name="Passed" />
                  <Bar dataKey="in_progress" stackId="a" fill="#f59e0b" name="In Progress" />
                  <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[320px] flex items-center justify-center text-gray-400">No data for selected period</div>
            )}
          </div>

          {/* State distribution — replaces single-plant donut */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-base font-semibold text-gray-800 mb-4">State Distribution</h3>
            {stateData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={stateData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={95}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {stateData.map((d) => (
                        <Cell key={d.state} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string) => [value, name]}
                      contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-3 space-y-1.5">
                  {stateData.map((d) => (
                    <div key={d.state} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="text-gray-600">{d.name}</span>
                      </div>
                      <span className="font-medium text-gray-800">{d.value}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="h-[240px] flex items-center justify-center text-gray-400">No data</div>
            )}
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={32} className="animate-spin text-blue-500" />
        </div>
      )}
    </div>
  );
}
