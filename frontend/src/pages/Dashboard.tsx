import { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { Package, CheckCircle, XCircle, AlertTriangle, Percent, RefreshCw, Clock, RotateCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import {
  fetchDashboard,
  DashboardResponse,
  PartState,
  PART_STATE_LABEL,
  ProductionGranularity,
  SHIFT_HOURS,
} from '../lib/api';

const STATE_COLORS: Record<PartState, string> = {
  PACKED: '#10b981', // green
  RING_OK: '#14b8a6', // teal
  IN_PROGRESS: '#f59e0b', // amber
  RING_NG: '#ef4444', // red
  CIRCLIP_SCRAP: '#b91c1c', // deeper red
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
  const today = format(new Date(), 'yyyy-MM-dd');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchDashboard(from, to);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        <button
          onClick={loadData}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filters — single-machine install, no plant filter */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <DateRangePicker
          from={from}
          to={to}
          plant=""
          plants={[]}
          onChange={(f, t) => handleDateChange(f, t)}
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* KPI Cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-4 auto-rows-fr">
          <KpiCard title="Total Parts" value={data.kpis.total.toLocaleString()} icon={Package} color="blue" subtitle="Distinct parts" />
          <KpiCard title="Passed" value={data.kpis.passed.toLocaleString()} icon={CheckCircle} color="green" subtitle="Packed + Ring OK" />
          <KpiCard title="Circlip Fail" value={data.kpis.circlip_fail.toLocaleString()} icon={XCircle} color="red" subtitle="Scrapped" />
          <KpiCard title="Ring Fail" value={data.kpis.ring_fail.toLocaleString()} icon={AlertTriangle} color="amber" subtitle="Ring rejected" />
          <KpiCard title="In Progress" value={data.kpis.in_progress.toLocaleString()} icon={Clock} color="purple" subtitle="Ring not yet recorded" />
          <KpiCard title="Reinspected" value={data.kpis.reinspected.toLocaleString()} icon={RotateCw} color="indigo" subtitle="Multi-attempt parts" />
          <KpiCard title="Pass Rate" value={`${data.kpis.pass_rate}%`} icon={Percent} color="slate" subtitle="Overall yield" />
        </div>
      )}

      {/* Shift breakdown */}
      {data && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h3 className="text-base font-semibold text-gray-800">Shift Summary</h3>
            <span className="text-xs text-gray-400">within the selected date range</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 text-left">Shift</th>
                  <th className="px-3 py-2 text-left">Hours</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right">Passed</th>
                  <th className="px-3 py-2 text-right">Circlip Fail</th>
                  <th className="px-3 py-2 text-right">Ring Fail</th>
                  <th className="px-3 py-2 text-right">In Progress</th>
                  <th className="px-3 py-2 text-right">Reinspected</th>
                  <th className="px-3 py-2 text-right">Pass Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.shift_breakdown.map((s) => (
                  <tr key={s.shift} className="hover:bg-gray-50/50">
                    <td className="px-3 py-2 font-semibold text-gray-800">Shift {s.shift}</td>
                    <td className="px-3 py-2 text-gray-500 font-mono text-xs">{SHIFT_HOURS[s.shift]}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-900">{s.total.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{s.passed.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-red-700">{s.circlip_fail.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-amber-700">{s.ring_fail.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-purple-700">{s.in_progress.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-indigo-700">{s.reinspected.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-900">{s.pass_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Charts */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Production breakdown — adaptive bucketing, three colors */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-gray-800">Production Breakdown</h3>
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
