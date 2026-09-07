import { useMemo } from 'react';
import clsx from 'clsx';
import { MachineStateSegment, MachineStop } from '../lib/api';

// Colors for the three PLC states, shared by the band and the stop list.
const STATE_STYLE: Record<string, { bar: string; dot: string; label: string }> = {
  RUNNING: { bar: 'bg-emerald-500', dot: 'bg-emerald-500', label: 'Producing' },
  FAULT: { bar: 'bg-red-500', dot: 'bg-red-500', label: 'Fault / Hold' },
  IDLE: { bar: 'bg-gray-300', dot: 'bg-gray-400', label: 'Idle' },
};

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

// Compact duration: "2h 5m", "3m 40s", "45s".
function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Axis ticks: evenly spaced clock labels across the window.
function axisTicks(startMs: number, endMs: number, count = 6): number[] {
  if (endMs <= startMs) return [];
  const step = (endMs - startMs) / count;
  return Array.from({ length: count + 1 }, (_, i) => startMs + step * i);
}

export default function MachineTimeline({
  segments,
  stops,
  windowStartMs,
  windowEndMs,
}: {
  segments: MachineStateSegment[];
  stops: MachineStop[];
  windowStartMs: number;
  windowEndMs: number;
}) {
  const span = Math.max(1, windowEndMs - windowStartMs);
  const ticks = useMemo(() => axisTicks(windowStartMs, windowEndMs), [windowStartMs, windowEndMs]);

  return (
    <div>
      {/* The band */}
      <div className="relative w-full h-8 rounded-md overflow-hidden border border-gray-200 bg-gray-50">
        {segments.map((s, i) => {
          const left = ((s.startMs - windowStartMs) / span) * 100;
          const width = ((s.endMs - s.startMs) / span) * 100;
          if (width <= 0) return null;
          const style = STATE_STYLE[s.state] ?? STATE_STYLE.IDLE;
          return (
            <div
              key={i}
              className={clsx('absolute top-0 h-full', style.bar)}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.15)}%` }}
              title={`${style.label}  ${fmtClock(s.startMs)} – ${fmtClock(s.endMs)}  (${fmtDur(
                (s.endMs - s.startMs) / 1000,
              )})`}
            />
          );
        })}
      </div>

      {/* Time axis */}
      <div className="relative w-full h-4 mt-1">
        {ticks.map((t, i) => (
          <span
            key={i}
            className="absolute text-[10px] text-gray-400 tabular-nums -translate-x-1/2"
            style={{ left: `${((t - windowStartMs) / span) * 100}%` }}
          >
            {fmtClock(t).slice(0, 5)}
          </span>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
        {Object.entries(STATE_STYLE).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={clsx('w-2.5 h-2.5 rounded-sm', v.dot)} /> {v.label}
          </span>
        ))}
      </div>

      {/* Stop list — exactly when the machine was not producing, newest first */}
      <div className="mt-4">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">
          Stops &amp; idle periods ({stops.length})
        </p>
        <p className="text-[11px] text-gray-400 mb-2">
          All faults, plus idle periods over 1 minute (short inter-cycle idles are hidden).
        </p>
        {stops.length === 0 ? (
          <p className="text-sm text-gray-500">No stops in this window — machine ran continuously.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-md border border-gray-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50">
                <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2 text-left font-semibold">Type</th>
                  <th className="px-3 py-2 text-left font-semibold">Stopped at</th>
                  <th className="px-3 py-2 text-left font-semibold">Resumed at</th>
                  <th className="px-3 py-2 text-right font-semibold">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {stops.map((s, i) => {
                  const style = STATE_STYLE[s.state] ?? STATE_STYLE.IDLE;
                  const ongoing = s.endMs >= windowEndMs - 1000;
                  return (
                    <tr key={i} className="hover:bg-gray-50/50">
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={clsx('w-2 h-2 rounded-full', style.dot)} />
                          {style.label}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono tabular-nums text-gray-700">{fmtClock(s.startMs)}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums text-gray-700">
                        {ongoing ? <span className="text-gray-400 italic">ongoing</span> : fmtClock(s.endMs)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-700">{fmtDur(s.seconds)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
