import { useState, useEffect, useCallback } from 'react';
import { format } from 'date-fns';
import { Package, CheckCircle, XCircle, AlertTriangle, Percent, RefreshCw, Clock, RotateCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import KpiCard from '../components/KpiCard';
import DateRangePicker from '../components/DateRangePicker';
import { fetchDashboard, fetchPlants, DashboardResponse } from '../lib/api';

const PIE_COLORS = ['#10b981', '#ef4444', '#f59e0b', '#6366f1', '#8b5cf6'];

export default function Dashboard() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [plant, setPlant] = useState('');
  const [plants, setPlants] = useState<string[]>([]);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchDashboard(from, to, plant || undefined);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [from, to, plant]);

  useEffect(() => {
    fetchPlants().then(setPlants).catch(() => {});
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDateChange = (newFrom: string, newTo: string, newPlant: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setPlant(newPlant);
  };

  const pieData = data?.plant_breakdown.map((p) => ({
    name: p.plant_id,
    value: p.total,
    passed: p.passed,
  })) || [];

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

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
        <DateRangePicker from={from} to={to} plant={plant} plants={plants} onChange={handleDateChange} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* KPI Cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-4">
          <KpiCard title="Total Parts" value={data.kpis.total.toLocaleString()} icon={Package} color="blue" subtitle="Distinct parts" />
          <KpiCard title="Passed" value={data.kpis.passed.toLocaleString()} icon={CheckCircle} color="green" subtitle="Packed + Ring OK" />
          <KpiCard title="Circlip Fail" value={data.kpis.circlip_fail.toLocaleString()} icon={XCircle} color="red" subtitle="Scrapped" />
          <KpiCard title="Ring Fail" value={data.kpis.ring_fail.toLocaleString()} icon={AlertTriangle} color="amber" subtitle="Ring rejected" />
          <KpiCard title="In Progress" value={data.kpis.in_progress.toLocaleString()} icon={Clock} color="purple" subtitle="Ring not yet recorded" />
          <KpiCard title="Reinspected" value={data.kpis.reinspected.toLocaleString()} icon={RotateCw} color="indigo" subtitle="Multi-attempt parts" />
          <KpiCard title="Pass Rate" value={`${data.kpis.pass_rate}%`} icon={Percent} color="slate" subtitle="Overall yield" />
        </div>
      )}

      {/* Charts */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Hourly production chart */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-base font-semibold text-gray-800 mb-4">Production Breakdown</h3>
            {data.hourly_breakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={data.hourly_breakdown}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(v: string) => v.slice(11, 16)}
                    fontSize={12}
                    tick={{ fill: '#6b7280' }}
                  />
                  <YAxis fontSize={12} tick={{ fill: '#6b7280' }} />
                  <Tooltip
                    labelFormatter={(v: string) => v}
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                  />
                  <Legend />
                  <Bar dataKey="passed" stackId="a" fill="#10b981" name="Passed" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[320px] flex items-center justify-center text-gray-400">No data for selected period</div>
            )}
          </div>

          {/* Plant breakdown */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-base font-semibold text-gray-800 mb-4">Plant Breakdown</h3>
            {pieData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={3}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${value}`}
                    >
                      {pieData.map((_, index) => (
                        <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-3 space-y-2">
                  {data.plant_breakdown.map((p, i) => (
                    <div key={p.plant_id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                        <span className="text-gray-600">{p.plant_id}</span>
                      </div>
                      <span className="font-medium text-gray-800">{p.total} ({p.passed} passed)</span>
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
