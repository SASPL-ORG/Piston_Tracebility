import { useState, useEffect } from 'react';
import { format, subDays } from 'date-fns';
import { RefreshCw, Wrench, AlertTriangle, CheckCircle, AlertOctagon, Bell, Gauge } from 'lucide-react';
import clsx from 'clsx';
import { fetchMaintenanceStatus, fetchMaintenanceHistory, MaintenanceComponent } from '../lib/api';
import AlarmsPanel from '../components/AlarmsPanel';
import ToolLifePanel from '../components/ToolLifePanel';
import NotificationBell from '../components/NotificationBell';

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; icon: typeof CheckCircle }> = {
    OK: { bg: 'bg-emerald-100 text-emerald-700', text: 'OK', icon: CheckCircle },
    WARNING: { bg: 'bg-amber-100 text-amber-700', text: 'WARNING', icon: AlertTriangle },
    ALARM: { bg: 'bg-red-100 text-red-700', text: 'ALARM', icon: AlertOctagon },
  };
  const c = config[status] || config.OK;
  const Icon = c.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold', c.bg)}>
      <Icon size={12} />
      {c.text}
    </span>
  );
}

function UsageBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{value.toLocaleString()} / {max.toLocaleString()}</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-all duration-500', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function getBarColor(value: number, max: number): string {
  const pct = max > 0 ? (value / max) * 100 : 0;
  if (pct >= 80) return 'bg-red-500';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export default function Maintenance() {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showAlarmsPanel, setShowAlarmsPanel] = useState(false);
  const [showToolLifePanel, setShowToolLifePanel] = useState(false);
  const [components, setComponents] = useState<MaintenanceComponent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [history, setHistory] = useState<MaintenanceComponent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFrom, setHistoryFrom] = useState(format(subDays(new Date(), 30), 'yyyy-MM-dd'));
  const [historyTo, setHistoryTo] = useState(format(new Date(), 'yyyy-MM-dd'));

  const loadStatus = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchMaintenanceStatus();
      setComponents(data);
      if (data.length > 0 && !selectedComponent) {
        setSelectedComponent(data[0].component_name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load maintenance status');
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async (comp: string) => {
    setHistoryLoading(true);
    try {
      const data = await fetchMaintenanceHistory(comp, historyFrom, historyTo);
      setHistory(data);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  useEffect(() => {
    if (selectedComponent) loadHistory(selectedComponent);
  }, [selectedComponent, historyFrom, historyTo]);

  const formatDate = (v: string) => {
    try { return format(new Date(v), 'dd/MM/yyyy, h:mm:ss a'); } catch { return v; }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 bg-blue-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-900">Maintenance Module</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Tools menu: PLC alarms today + extension point for future operator tools */}
          <div className="relative">
            <button
              onClick={() => setToolsOpen((v) => !v)}
              onBlur={() => setTimeout(() => setToolsOpen(false), 150)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition-colors"
            >
              <Wrench size={16} />
              Tools
            </button>
            {toolsOpen && (
              <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
                <button
                  onMouseDown={(e) => {
                    // onMouseDown fires before the button's onBlur, so the
                    // dropdown is still open when we read intent.
                    e.preventDefault();
                    setToolsOpen(false);
                    setShowAlarmsPanel(true);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 inline-flex items-center gap-2"
                >
                  <Bell size={14} className="text-red-500" />
                  PLC Alarms
                </button>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setToolsOpen(false);
                    setShowToolLifePanel(true);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-100 inline-flex items-center gap-2"
                >
                  <Gauge size={14} className="text-blue-600" />
                  Tool Life
                </button>
              </div>
            )}
          </div>
          <button
            onClick={loadStatus}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh Status
          </button>
          <NotificationBell onOpenToolLife={() => setShowToolLifePanel(true)} />
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* Inline tool panels — shown when the user picks a tool from the Tools menu */}
      {showAlarmsPanel && <AlarmsPanel onClose={() => setShowAlarmsPanel(false)} />}
      {showToolLifePanel && <ToolLifePanel onClose={() => setShowToolLifePanel(false)} />}

      {/* Current Component Status */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-1 h-6 bg-blue-600 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-800">Current Component Status</h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw size={28} className="animate-spin text-blue-500" />
          </div>
        ) : components.length === 0 ? (
          <div className="text-center py-12">
            <Wrench size={48} className="mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500">No maintenance components found</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {components.map((comp) => (
              <div
                key={comp.component_name}
                onClick={() => setSelectedComponent(comp.component_name)}
                className={clsx(
                  'border rounded-xl p-5 cursor-pointer transition-all hover:shadow-md',
                  selectedComponent === comp.component_name
                    ? 'border-blue-400 ring-2 ring-blue-100 bg-blue-50/30'
                    : 'border-gray-200 hover:border-gray-300'
                )}
              >
                {/* Component header */}
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-800 text-sm">{comp.component_name}</h3>
                  <StatusBadge status={comp.status} />
                </div>

                {/* Usage bar */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-gray-500 mb-1 uppercase tracking-wide">Usage</p>
                  <UsageBar
                    value={comp.usage_value}
                    max={comp.usage_max}
                    color={getBarColor(comp.usage_value, comp.usage_max)}
                  />
                </div>

                {/* Time info */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Time</p>
                  <p className="text-sm text-gray-700">{comp.time_value} / {comp.time_max}</p>
                </div>

                {/* Timestamp */}
                <p className="text-xs text-gray-400 mt-2">{formatDate(comp.ts)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History section */}
      {selectedComponent && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">History: {selectedComponent}</h2>
          </div>

          {/* Date filters */}
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 font-medium">From:</label>
              <input
                type="date"
                value={historyFrom}
                onChange={(e) => setHistoryFrom(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 font-medium">To:</label>
              <input
                type="date"
                value={historyTo}
                onChange={(e) => setHistoryTo(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* History table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Timestamp</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Usage</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {historyLoading ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : history.length > 0 ? (
                  history.map((h, i) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDate(h.ts)}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {h.usage_value} / {h.usage_max} ({((h.usage_value / h.usage_max) * 100).toFixed(1)}%)
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{h.time_value} / {h.time_max}</td>
                      <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={h.status} /></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No history records found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
