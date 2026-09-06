import { useCallback, useEffect, useState } from 'react';
import { useSessionState } from '../lib/useSessionState';
import { format } from 'date-fns';
import DemoModeControl from '../components/DemoModeControl';
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
import MachineSelector from '../components/MachineSelector';
import MachineTimeline from '../components/MachineTimeline';
import {
  fetchMachineStatus,
  fetchPlants,
  formatHMS,
  MachineStatusResponse,
  MachineTrack,
  LineScope,
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

interface KpiCardProps {
  title: string;
  subtitle?: string;
  hms: string;
  pct: number;
  greyed?: boolean;
  color: 'green' | 'amber' | 'grey' | 'red';
  icon: LucideIcon;
}

function KpiCard({ title, subtitle, hms, pct, greyed, color, icon: Icon }: KpiCardProps) {
  const palette = greyed
    ? 'bg-gray-50 text-gray-500 border-gray-200'
    : {
        green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        amber: 'bg-amber-50 text-amber-700 border-amber-200',
        grey: 'bg-gray-50 text-gray-700 border-gray-200',
        red: 'bg-red-50 text-red-700 border-red-200',
      }[color];
  const pillIcon = greyed
    ? 'bg-gray-400'
    : { green: 'bg-emerald-500', amber: 'bg-amber-500', grey: 'bg-gray-500', red: 'bg-red-500' }[color];
  return (
    <div className={clsx('rounded-xl border p-4 shadow-sm', palette)}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
          {subtitle && <p className="text-[10px] opacity-70 mt-0.5">{subtitle}</p>}
        </div>
        <div className={clsx('p-1.5 rounded-md', pillIcon)}>
          <Icon size={14} className="text-white" />
        </div>
      </div>
      <p className="text-2xl font-bold font-mono tabular-nums leading-none">{hms}</p>
      <p className="text-xs font-medium mt-1.5 opacity-80">{pct.toFixed(1)}%</p>
    </div>
  );
}

// One machine's full section: KPIs + utilisation + timeline + alarms.
function TrackSection({
  track,
  windowStartMs,
  windowEndMs,
}: {
  track: MachineTrack;
  windowStartMs: number;
  windowEndMs: number;
}) {
  const greyed = !track.stateSignalPresent;
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Machine heading */}
      <div className="px-5 py-3 border-b border-gray-200 bg-gray-50/60 flex items-center gap-3">
        <div className="w-1.5 h-6 bg-blue-600 rounded-full" />
        <h2 className="text-lg font-bold text-gray-900">Machine {track.line}</h2>
        <span className="text-xs text-gray-500">
          {track.partsProcessed.toLocaleString()} parts · {track.goodParts.toLocaleString()} good
          {' · '}monitored {formatHMS(track.monitoredSeconds)} of {formatHMS(track.windowSeconds)}
        </span>
        {track.invariantOk === false && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800">
            <AlertTriangle size={11} /> Data inconsistency
          </span>
        )}
      </div>

      <div className="p-5 space-y-5">
        {greyed && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
            <WifiOff size={18} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="text-sm text-amber-900">
              <p className="font-semibold">No machine-state signal in this window</p>
              <p className="text-xs mt-0.5">
                The PLC's Running / Fault / Idle bits aren't reaching{' '}
                <code className="font-mono bg-amber-100 px-1 rounded">dbo.Machine_State</code> for Machine{' '}
                {track.line} in this window.
              </p>
            </div>
          </div>
        )}

        {!greyed && track.monitoredSeconds < track.windowSeconds * 0.9 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
            Per-machine tracking covers <b>{formatHMS(track.monitoredSeconds)}</b> of this window — earlier
            time isn't split by machine yet (line tagging was enabled part-way through). Percentages below are
            of the monitored time. Full days are covered from here on.
          </div>
        )}

        {/* KPI tiles: Production / Hold / Idle / Down */}
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <KpiCard title="Production" hms={formatHMS(track.production.seconds)} pct={track.production.pct} greyed={greyed} color="green" icon={Activity} />
          <KpiCard title="Machine / Alarm hold" hms={formatHMS(track.machineHold.seconds)} pct={track.machineHold.pct} greyed={greyed} color="amber" icon={Hand} />
          <KpiCard title="Idle" hms={formatHMS(track.idle.seconds)} pct={track.idle.pct} greyed={greyed} color="grey" icon={PauseCircle} />
          <KpiCard title="Down" subtitle="= hold + idle" hms={formatHMS(track.down.seconds)} pct={track.down.pct} greyed={greyed} color="red" icon={ZapOff} />
        </div>

        {/* Utilisation bar */}
        {!greyed && (
          <div className="flex w-full h-6 rounded-lg overflow-hidden border border-gray-200" title="Production · Hold · Idle">
            <div className="bg-emerald-500 flex items-center justify-center text-[10px] font-bold text-white" style={{ width: `${track.production.pct}%` }}>
              {track.production.pct >= 8 && `${track.production.pct.toFixed(0)}%`}
            </div>
            <div className="bg-amber-500 flex items-center justify-center text-[10px] font-bold text-white" style={{ width: `${track.machineHold.pct}%` }}>
              {track.machineHold.pct >= 8 && `${track.machineHold.pct.toFixed(0)}%`}
            </div>
            <div className="bg-gray-400 flex items-center justify-center text-[10px] font-bold text-white" style={{ width: `${track.idle.pct}%` }}>
              {track.idle.pct >= 8 && `${track.idle.pct.toFixed(0)}%`}
            </div>
          </div>
        )}

        {/* Timeline — when producing / idle / stopped, with exact times */}
        <div>
          <p className="text-sm font-semibold text-gray-800 mb-2">Timeline</p>
          <MachineTimeline
            segments={track.segments}
            stops={track.stops}
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
          />
        </div>

        {/* Alarms in fault */}
        <div>
          <p className="text-sm font-semibold text-gray-800 mb-1">Alarms in window</p>
          <p className="text-xs text-gray-500 mb-2">
            Duration in fault = time the alarm was ON while the PLC reported FAULT.
          </p>
          <div className="overflow-x-auto rounded-md border border-gray-100">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[11px] uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2 text-left font-semibold">Alarm</th>
                  <th className="px-3 py-2 text-right font-semibold">Occurrences</th>
                  <th className="px-3 py-2 text-right font-semibold">Duration in fault</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {track.topAlarms.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-500 text-sm">No alarms overlapped a fault in this window.</td></tr>
                ) : (
                  track.topAlarms.map((a) => (
                    <tr key={a.alarm} className="hover:bg-gray-50/50">
                      <td className="px-3 py-1.5 text-gray-800">{a.alarm}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{a.occurrences.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-700">{formatHMS(a.seconds)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MachineStatus() {
  const today = format(new Date(), 'yyyy-MM-dd');
  const [from, setFrom] = useSessionState('machineStatus/from', today);
  const [to, setTo] = useSessionState('machineStatus/to', today);
  const [plant, setPlant] = useSessionState('machineStatus/plant', '');
  const [plants, setPlants] = useState<string[]>([]);
  const [shift, setShift] = useSessionState<ShiftScope>('machineStatus/shift', 'all');
  const [hourFrom, setHourFrom] = useSessionState('machineStatus/hourFrom', '');
  const [hourTo, setHourTo] = useSessionState('machineStatus/hourTo', '');
  // Machine selector shares the app-wide key so it carries across pages.
  const [line, setLine] = useSessionState<LineScope>('app/line', 'all');
  const [data, setData] = useState<MachineStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchPlants().then(setPlants).catch(() => {});
  }, []);

  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError('');
      try {
        const r = await fetchMachineStatus({
          from,
          to,
          plant: plant || undefined,
          shift: shift === 'all' ? undefined : shift,
          hourFrom: hourFrom || undefined,
          hourTo: hourTo || undefined,
          line: line === 'all' ? undefined : line,
        });
        setData(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
        setData(null);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [from, to, plant, shift, hourFrom, hourTo, line],
  );

  useEffect(() => { loadData(); }, [loadData]);

  // Live background refresh every 30s (no spinner flicker) — status page.
  useEffect(() => {
    const id = setInterval(() => loadData(true), 30_000);
    return () => clearInterval(id);
  }, [loadData]);

  const onShiftClick = (next: ShiftScope) => {
    setShift(next);
    const preset = SHIFT_PRESETS[next];
    setHourFrom(preset.from);
    setHourTo(preset.to);
  };
  const onHourFromChange = (v: string) => { setHourFrom(v); setShift(matchingShift(v, hourTo)); };
  const onHourToChange = (v: string) => { setHourTo(v); setShift(matchingShift(hourFrom, v)); };
  const handleDateChange = (newFrom: string, newTo: string, newPlant: string) => {
    setFrom(newFrom); setTo(newTo); setPlant(newPlant);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-1 h-8 bg-blue-600 rounded-full" />
          <h1 className="text-2xl font-bold text-gray-900">Machine Status</h1>
          {data?.filtersIgnored && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800"
              title="Shift / hour filters were dropped because the date range spans multiple days."
            >
              <AlertTriangle size={11} /> Multi-day: shift/hour ignored
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DemoModeControl />
          <button
            onClick={() => loadData()}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 space-y-3">
        <DateRangePicker from={from} to={to} plant={plant} plants={plants} onChange={handleDateChange} />
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-gray-500 font-medium">Machine:</label>
          <MachineSelector value={line} onChange={setLine} />
          <span className="w-px h-6 bg-gray-200" />
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
            <input type="time" value={hourFrom} onChange={(e) => onHourFromChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 font-medium">To hour:</label>
            <input type="time" value={hourTo} onChange={(e) => onHourToChange(e.target.value)}
              className="px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {loading && !data ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center text-gray-400">Loading…</div>
      ) : data && data.tracks.length > 0 ? (
        <div className="space-y-6">
          <p className="text-xs text-gray-500">
            Window: <span className="font-mono text-gray-700">{formatHMS(data.window.totalSeconds)}</span>
            {' · '}each machine shown dedicatedly. Timeline hover shows exact start/end times.
          </p>
          {data.tracks.map((t) => (
            <TrackSection key={t.line} track={t} windowStartMs={data.window.startMs} windowEndMs={data.window.endMs} />
          ))}
        </div>
      ) : (
        !error && <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center text-gray-500">No data for this window.</div>
      )}
    </div>
  );
}
