import { useCallback, useEffect, useState } from 'react';
import { useSessionState } from '../lib/useSessionState';
import { format } from 'date-fns';
import {
  Activity,
  AlertTriangle,
  PauseCircle,
  RefreshCw,
  ZapOff,
  Hand,
  LucideIcon,
  WifiOff,
} from 'lucide-react';
import clsx from 'clsx';
import DateRangePicker from '../components/DateRangePicker';
import {
  fetchMachineStatus,
  fetchPlants,
  formatHMS,
  MachineStatusResponse,
  ShiftScope,
} from '../lib/api';

// Same shift preset windows the rest of the app uses (lists.ts / failures modal).
const SHIFT_PRESETS: Record<ShiftScope, { from: string; to: string }> = {
  all: { from: '', to: '' },
  A: { from: '07:00', to: '15:30' },
  B: { from: '15:31', to: '23:59' },
  C: { from: '00:00', to: '06:59' },
};
const SHIFT_BUTTONS: { value: ShiftScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'A', label: 'Shift A' },
  { value: 'B', label: 'Shift B' },
  { value: 'C', label: 'Shift C' },
];

function matchingShift(from: string, to: string): ShiftScope {
  if (!from && !to) return 'all';
  for (const id of ['A', 'B', 'C'] as const) {
    const p = SHIFT_PRESETS[id];
    if (p.from === from && p.to === to) return id;
  }
  return 'all';
}

function isCurrentWindow(toDate: string): boolean {
  const today = format(new Date(), 'yyyy-MM-dd');
  return toDate >= today;
}

interface KpiCardProps {
  title: string;
  subtitle?: string;
  hms: string;
  pct: number;
  loading: boolean;
  greyed?: boolean;          // true when stateSignalPresent === false
  color: 'green' | 'amber' | 'grey' | 'red';
  icon: LucideIcon;
}

function KpiCard({ title, subtitle, hms, pct, loading, greyed, color, icon: Icon }: KpiCardProps) {
  const palette = greyed
    ? 'bg-gray-50 text-gray-500 border-gray-200'
    : {
        green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        amber: 'bg-amber-50 text-amber-700 border-amber-200',
        grey:  'bg-gray-50 text-gray-700 border-gray-200',
        red:   'bg-red-50 text-red-700 border-red-200',
      }[color];
  const pillIcon = greyed
    ? 'bg-gray-400'
    : { green: 'bg-emerald-500', amber: 'bg-amber-500', grey: 'bg-gray-500', red: 'bg-red-500' }[color];
  return (
    <div className={clsx('rounded-xl border p-5 shadow-sm', palette)}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
          {subtitle && <p className="text-[10px] opacity-70 mt-0.5">{subtitle}</p>}
        </div>
        <div className={clsx('p-1.5 rounded-md', pillIcon)}>
          <Icon size={14} className="text-white" />
        </div>
      </div>
      {loading ? (
        <div className="h-9 w-32 bg-white/60 rounded animate-pulse" />
      ) : (
        <p className="text-3xl font-bold font-mono tabular-nums leading-none">{hms}</p>
      )}
      {loading ? (
        <div className="h-3 w-12 bg-white/60 rounded mt-2 animate-pulse" />
      ) : (
        <p className="text-xs font-medium mt-1.5 opacity-80">{pct.toFixed(1)}%</p>
      )}
    </div>
  );
}

export default function MachineStatus() {
  const today = format(new Date(), 'yyyy-MM-dd');
  // Filter state persists in sessionStorage so navigating to other pages
  // and back keeps the operator's selection — same pattern as Lists. Fresh
  // tab → defaults to today. Reset is explicit via the Today/7-Days/etc.
  // chips (they call the setters with the new dates, which sessionStorage
  // then captures). Transient response state (data/loading/error/plants)
  // stays in plain useState because it's recomputed on every load.
  const [from, setFrom] = useSessionState('machineStatus/from', today);
  const [to, setTo] = useSessionState('machineStatus/to', today);
  const [plant, setPlant] = useSessionState('machineStatus/plant', '');
  const [plants, setPlants] = useState<string[]>([]);
  const [shift, setShift] = useSessionState<ShiftScope>('machineStatus/shift', 'all');
  const [hourFrom, setHourFrom] = useSessionState('machineStatus/hourFrom', '');
  const [hourTo, setHourTo] = useSessionState('machineStatus/hourTo', '');
  const [data, setData] = useState<MachineStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchPlants().then(setPlants).catch(() => {});
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetchMachineStatus({
        from,
        to,
        plant: plant || undefined,
        shift: shift === 'all' ? undefined : shift,
        hourFrom: hourFrom || undefined,
        hourTo: hourTo || undefined,
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, plant, shift, hourFrom, hourTo]);

  useEffect(() => { loadData(); }, [loadData]);

  const onShiftClick = (next: ShiftScope) => {
    setShift(next);
    const preset = SHIFT_PRESETS[next];
    setHourFrom(preset.from);
    setHourTo(preset.to);
  };
  const onHourFromChange = (v: string) => {
    setHourFrom(v);
    setShift(matchingShift(v, hourTo));
  };
  const onHourToChange = (v: string) => {
    setHourTo(v);
    setShift(matchingShift(hourFrom, v));
  };

  const handleDateChange = (newFrom: string, newTo: string, newPlant: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setPlant(newPlant);
  };

  const live = data ? isCurrentWindow(to) : false;
  const windowSpanLabel = data
    ? `${formatHMS(data.window.totalSeconds)}${live ? ' so far' : ''}`
    : '—';
  const greyed = data ? !data.stateSignalPresent : false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-1 h-8 bg-blue-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-900">Machine Status</h1>
          {data?.invariantOk === false && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800">
              <AlertTriangle size={11} /> Data inconsistency
            </span>
          )}
          {data?.filtersIgnored && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800"
              title="Shift / hour filters were dropped because the date range spans multiple days."
            >
              <AlertTriangle size={11} /> Multi-day: shift/hour ignored
            </span>
          )}
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

      {/* Filter bar — same idioms as Lists */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        <DateRangePicker from={from} to={to} plant={plant} plants={plants} onChange={handleDateChange} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-500 font-medium">Shift:</label>
          <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
            {SHIFT_BUTTONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onShiftClick(opt.value)}
                className={clsx(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  shift === opt.value ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">From hour:</label>
            <input
              type="time"
              value={hourFrom}
              onChange={(e) => onHourFromChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">To hour:</label>
            <input
              type="time"
              value={hourTo}
              onChange={(e) => onHourToChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* No-state-signal banner — surfaces when the PLC + Node-RED
          state stream hasn't published any rows in the selected window.
          The cards still render (greyed) so the operator can see the
          window/parts context, but we don't fake a 100% Idle reading. */}
      {data && !data.stateSignalPresent && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
          <WifiOff size={18} className="text-amber-700 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold">Machine state signal not available yet</p>
            <p className="text-xs mt-0.5">
              The PLC's Running / Fault / Idle bits aren't reaching{' '}
              <code className="font-mono bg-amber-100 px-1 rounded">dbo.Machine_State</code> for this
              window. Production / Hold / Idle totals are shown as zero until the state stream
              comes online; parts and alarms are unaffected.
            </p>
          </div>
        </div>
      )}

      {/* KPI Cards — four, including Down as the rolled-up red card */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          title="Production"
          hms={formatHMS(data?.production.seconds ?? 0)}
          pct={data?.production.pct ?? 0}
          loading={loading && !data}
          greyed={greyed}
          color="green"
          icon={Activity}
        />
        <KpiCard
          title="Machine / Alarm hold"
          hms={formatHMS(data?.machineHold.seconds ?? 0)}
          pct={data?.machineHold.pct ?? 0}
          loading={loading && !data}
          greyed={greyed}
          color="amber"
          icon={Hand}
        />
        <KpiCard
          title="Idle"
          hms={formatHMS(data?.idle.seconds ?? 0)}
          pct={data?.idle.pct ?? 0}
          loading={loading && !data}
          greyed={greyed}
          color="grey"
          icon={PauseCircle}
        />
        <KpiCard
          title="Down"
          subtitle="= hold + idle"
          hms={formatHMS(data?.down.seconds ?? 0)}
          pct={data?.down.pct ?? 0}
          loading={loading && !data}
          greyed={greyed}
          color="red"
          icon={ZapOff}
        />
      </div>

      {/* Utilisation bar — three primary segments sum to 100%; Down is
          shown in the legend so the operator sees the roll-up but it
          isn't double-counted in the bar. */}
      {data && data.window.totalSeconds > 0 && data.stateSignalPresent && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">Utilisation</h2>
          </div>
          <div
            className="flex w-full h-7 rounded-lg overflow-hidden border border-gray-200"
            title="Production · Machine / Alarm hold · Idle"
          >
            <div
              className="bg-emerald-500 flex items-center justify-center text-[10px] font-bold text-white"
              style={{ width: `${data.production.pct}%`, minWidth: data.production.pct > 0 ? '8px' : 0 }}
            >
              {data.production.pct >= 6 && `${data.production.pct.toFixed(1)}%`}
            </div>
            <div
              className="bg-amber-500 flex items-center justify-center text-[10px] font-bold text-white"
              style={{ width: `${data.machineHold.pct}%`, minWidth: data.machineHold.pct > 0 ? '8px' : 0 }}
            >
              {data.machineHold.pct >= 6 && `${data.machineHold.pct.toFixed(1)}%`}
            </div>
            <div
              className="bg-gray-400 flex items-center justify-center text-[10px] font-bold text-white"
              style={{ width: `${data.idle.pct}%`, minWidth: data.idle.pct > 0 ? '8px' : 0 }}
            >
              {data.idle.pct >= 6 && `${data.idle.pct.toFixed(1)}%`}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-3 text-xs">
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Production {data.production.pct.toFixed(1)}%</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-amber-500" /> Machine / Alarm hold {data.machineHold.pct.toFixed(1)}%</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-gray-400" /> Idle {data.idle.pct.toFixed(1)}%</span>
            <span className="inline-flex items-center gap-1.5 text-gray-500"><span className="w-2.5 h-2.5 rounded-sm bg-red-500" /> Down {data.down.pct.toFixed(1)}% (hold + idle)</span>
          </div>
        </div>
      )}

      {/* Alarms-during-faults table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">Alarms in window</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Alarms that transitioned ON within this window. <b>Duration in fault</b> = time the
            alarm was ON while the PLC reported FAULT. Stuck-on background signals (ON since
            before the window) are excluded. When alarms genuinely overlap each other, the sum
            across distinct alarms can exceed total Machine / Alarm hold.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Alarm</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Occurrences</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Duration in fault</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && !data ? (
                <tr><td colSpan={3} className="px-4 py-12 text-center text-gray-400">Loading…</td></tr>
              ) : !data || data.topAlarms.length === 0 ? (
                <tr><td colSpan={3} className="px-4 py-10 text-center text-gray-500 text-sm">
                  {data && !data.stateSignalPresent
                    ? 'No alarm-in-fault data — state signal not available.'
                    : 'No alarms overlapped a fault in this window.'}
                </td></tr>
              ) : (
                data.topAlarms.map((a) => (
                  <tr key={a.alarm} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-4 py-2 text-gray-800">{a.alarm}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700">{a.occurrences.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-gray-700">{formatHMS(a.seconds)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      {data && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-500 pb-2">
          <span className="inline-flex items-center gap-1.5"><Activity size={12} /> Parts processed: <span className="font-mono text-gray-700">{data.partsProcessed.toLocaleString()}</span></span>
          <span>Good: <span className="font-mono text-gray-700">{data.goodParts.toLocaleString()}</span></span>
          <span>Window: <span className="font-mono text-gray-700">{windowSpanLabel}</span></span>
          <span className="text-gray-400 italic">v3 reads PLC state bits directly; idle absorbs logging gaps + power-off.</span>
        </div>
      )}
    </div>
  );
}
