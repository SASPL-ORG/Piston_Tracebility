import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  PackageSearch,
  Wifi,
  WifiOff,
  History as HistoryIcon,
} from 'lucide-react';
import clsx from 'clsx';
import {
  fetchPackingRecent,
  fetchPackingTodayStats,
  type PackingEvent,
  type PackingResult,
  type PackingTodayStats,
} from '../lib/api';
import PackingSummaryMatrix from '../components/PackingSummaryMatrix';
import PackingHistoryModal from '../components/PackingHistoryModal';

// ---------------------------------------------------------------------------
// PACKING — LIVE MIRROR (README_DESKTOP_PACKING_PAGE.md)
//
// Read-only supervisor view. The Zebra station POSTs each verdict it shows
// to /api/packing/event; this page subscribes to /api/packing/stream (SSE)
// and re-renders the same verdict. If the SSE channel fails we fall back
// to polling /packing/recent every 2s — same data, slower latency, so the
// page is never visibly broken even if a proxy or VPN drops streaming.
// ---------------------------------------------------------------------------

const VERDICT_STYLE: Record<
  PackingResult,
  { bg: string; fg: string; Icon: typeof CheckCircle2; title: string }
> = {
  PACKED_OK:       { bg: 'bg-emerald-500', fg: 'text-white',       Icon: CheckCircle2,  title: 'OK — PACKED' },
  WRONG_GRADE:     { bg: 'bg-red-600',     fg: 'text-white',       Icon: XCircle,       title: 'WRONG GRADE' },
  ALREADY_PACKED:  { bg: 'bg-amber-400',   fg: 'text-amber-950',   Icon: AlertTriangle, title: 'ALREADY PACKED' },
  NOT_PROCESSED:   { bg: 'bg-red-600',     fg: 'text-white',       Icon: XCircle,       title: 'DO NOT PACK' },
  IN_PROCESS:      { bg: 'bg-red-600',     fg: 'text-white',       Icon: XCircle,       title: 'DO NOT PACK' },
  RING_REJECTED:   { bg: 'bg-red-600',     fg: 'text-white',       Icon: XCircle,       title: 'DO NOT PACK' },
  CIRCLIP_SCRAP:   { bg: 'bg-red-600',     fg: 'text-white',       Icon: XCircle,       title: 'DO NOT PACK' },
  LOOKUP_ERROR:    { bg: 'bg-amber-400',   fg: 'text-amber-950',   Icon: AlertTriangle, title: "CAN'T VERIFY" },
};

function rowTint(result: PackingResult): string {
  switch (result) {
    case 'PACKED_OK':      return 'bg-emerald-50';
    case 'WRONG_GRADE':
    case 'NOT_PROCESSED':
    case 'IN_PROCESS':
    case 'RING_REJECTED':
    case 'CIRCLIP_SCRAP':  return 'bg-red-50';
    case 'ALREADY_PACKED':
    case 'LOOKUP_ERROR':   return 'bg-amber-50';
  }
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // 24-h IST clock, no date — the recent log is by definition recent.
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return iso;
  }
}

export default function PackingMonitor() {
  const [events, setEvents] = useState<PackingEvent[]>([]);
  const [stats, setStats] = useState<PackingTodayStats | null>(null);
  const [streamUp, setStreamUp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  // Deep-link support: scanning the QR on a printed pallet label loads
  // this page with ?pallet=<packingNumber>. Auto-open the History modal
  // and jump straight to that pallet's detail view.
  const [searchParams, setSearchParams] = useSearchParams();
  const palletFromUrl = searchParams.get('pallet');
  useEffect(() => {
    if (palletFromUrl) setHistoryOpen(true);
  }, [palletFromUrl]);
  const handleHistoryClose = () => {
    setHistoryOpen(false);
    // Drop the ?pallet= query param so refreshing doesn't immediately
    // re-open the modal, and so the URL bar stays clean afterward.
    if (palletFromUrl) {
      const next = new URLSearchParams(searchParams);
      next.delete('pallet');
      setSearchParams(next, { replace: true });
    }
  };
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  const prepend = useCallback((ev: PackingEvent) => {
    setEvents((prev) => [ev, ...prev].slice(0, 50));
  }, []);

  // Initial load + once-a-minute KPI refresh
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchPackingRecent(50);
        if (!cancelled) {
          setEvents(r);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    const refreshStats = () => {
      fetchPackingTodayStats()
        .then((s) => { if (!cancelled) setStats(s); })
        .catch(() => {});
    };
    refreshStats();
    const statsTimer = window.setInterval(refreshStats, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(statsTimer);
    };
  }, []);

  // SSE subscribe; on error fall back to 2s polling so the page is never
  // visibly broken.
  useEffect(() => {
    let stopped = false;
    let backoff = 1000;

    const startPolling = () => {
      if (pollRef.current !== null) return;
      pollRef.current = window.setInterval(async () => {
        try {
          const latest = await fetchPackingRecent(50);
          if (stopped) return;
          // Whole-list replace; cheap and avoids tracking "last seen" cursor.
          setEvents(latest);
        } catch {
          /* keep trying */
        }
      }, 2000);
    };
    const stopPolling = () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const connect = () => {
      if (stopped) return;
      const es = new EventSource('/api/packing/stream');
      esRef.current = es;
      es.onopen = () => {
        if (stopped) return;
        setStreamUp(true);
        stopPolling();
        backoff = 1000;
      };
      es.onmessage = (msg) => {
        if (stopped) return;
        try {
          const ev = JSON.parse(msg.data) as PackingEvent;
          prepend(ev);
        } catch {
          /* ignore malformed payload */
        }
      };
      es.onerror = () => {
        if (stopped) return;
        setStreamUp(false);
        es.close();
        esRef.current = null;
        // Polling keeps the UI alive while we wait, then exponential
        // backoff before re-trying SSE.
        startPolling();
        window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();

    return () => {
      stopped = true;
      esRef.current?.close();
      esRef.current = null;
      stopPolling();
    };
  }, [prepend]);

  const latest = events[0] ?? null;
  const latestStyle = latest ? VERDICT_STYLE[latest.result] : null;
  const LatestIcon = latestStyle?.Icon ?? PackageSearch;

  const kpis = useMemo(() => {
    const s = stats?.stats ?? {};
    const packed = s.PACKED_OK ?? 0;
    const wrong = s.WRONG_GRADE ?? 0;
    const doNotPack =
      (s.NOT_PROCESSED ?? 0) +
      (s.IN_PROCESS ?? 0) +
      (s.RING_REJECTED ?? 0) +
      (s.CIRCLIP_SCRAP ?? 0);
    const cantVerify = (s.LOOKUP_ERROR ?? 0) + (s.ALREADY_PACKED ?? 0);
    return { packed, wrong, doNotPack, cantVerify };
  }, [stats]);

  return (
    <div className="space-y-5">
      {/* Title bar */}
      <div className="flex items-center gap-3">
        <div className="w-1 h-7 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-semibold text-slate-800">Packing — Live Mirror</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
            title="Browse past pallet packing numbers"
          >
            <HistoryIcon size={14} />
            History
          </button>
          <div className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 bg-white">
            {streamUp ? (
              <>
                <Wifi size={14} className="text-emerald-600" />
                <span className="text-emerald-700">Live</span>
              </>
            ) : (
              <>
                <WifiOff size={14} className="text-amber-600" />
                <span className="text-amber-700">Polling fallback</span>
              </>
            )}
          </div>
        </div>
      </div>

      {historyOpen && (
        <PackingHistoryModal
          onClose={handleHistoryClose}
          initialPackingNumber={palletFromUrl ?? undefined}
        />
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Hero — latest scan */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {!latest ? (
          <div className="flex flex-col items-center justify-center text-center px-6 py-12 text-slate-500">
            <PackageSearch size={56} strokeWidth={1.5} className="mb-3 opacity-60" />
            <div className="text-lg font-semibold">
              {loading ? 'Loading…' : 'Waiting for the first scan…'}
            </div>
            <div className="text-sm mt-1">Mirrors the verdict shown at the Zebra station.</div>
          </div>
        ) : (
          <div className={clsx('flex flex-col px-6 py-8 transition-colors', latestStyle?.bg, latestStyle?.fg)}>
            <div className="flex items-center gap-5">
              <LatestIcon size={88} strokeWidth={1.75} className="opacity-95 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-5xl md:text-6xl font-extrabold tracking-tight leading-none">
                  {latestStyle?.title}
                </div>
                <div className="mt-3 text-xl md:text-2xl font-medium opacity-95 break-words">
                  {latest.message || '—'}
                </div>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm md:text-base">
              <HeroField label="Selected grade" value={latest.selectedGrade || '—'} />
              <HeroField label="Scanned" value={latest.scannedGrade || '—'} mono />
              <HeroField label="DMC" value={latest.dmc ?? '—'} mono className="md:col-span-1 truncate" />
              <HeroField label="At" value={`${formatTs(latest.ts)} · ${latest.device}`} />
            </div>
          </div>
        )}
      </div>

      {/* KPI strip — today */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile label="Packed today" value={kpis.packed} tone="emerald" />
        <KpiTile label="Wrong grade" value={kpis.wrong} tone="red" />
        <KpiTile label="Do not pack" value={kpis.doNotPack} tone="red" />
        <KpiTile label="Already / Can't verify" value={kpis.cantVerify} tone="amber" />
      </div>

      {/* Packing Summary — full Production-Summary-style matrix with all
          15 grades, EGR / N EGR / CNG groups, Total row + Total column.
          Self-polls /api/packing/progress every 3 s. */}
      <PackingSummaryMatrix />

      {/* Recent scans log */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">Recent scans</h2>
            <span className="text-xs text-gray-500 ml-auto">newest first · last {events.length}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Time</th>
                <th className="px-4 py-3 text-left">DMC</th>
                <th className="px-4 py-3 text-left">Selected</th>
                <th className="px-4 py-3 text-left">Scanned</th>
                <th className="px-4 py-3 text-left">Verdict</th>
                <th className="px-4 py-3 text-left">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                    {loading ? 'Loading…' : 'No scans yet.'}
                  </td>
                </tr>
              ) : (
                events.map((ev, i) => (
                  <tr key={`${ev.ts}-${i}`} className={clsx(rowTint(ev.result))}>
                    <td className="px-4 py-2.5 font-mono text-slate-700 whitespace-nowrap">{formatTs(ev.ts)}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-700 break-all max-w-xs">{ev.dmc ?? '—'}</td>
                    <td className="px-4 py-2.5 font-semibold text-slate-800">{ev.selectedGrade || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-700">{ev.scannedGrade || '—'}</td>
                    <td className="px-4 py-2.5">
                      <VerdictPill result={ev.result} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{ev.message}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function HeroField({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col gap-0.5 min-w-0', className)}>
      <span className="text-[10px] md:text-xs uppercase tracking-wider opacity-75">{label}</span>
      <span className={clsx('font-semibold leading-tight truncate', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'red' | 'amber';
}) {
  const tones = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    red:     'border-red-200 bg-red-50 text-red-800',
    amber:   'border-amber-200 bg-amber-50 text-amber-900',
  } as const;
  return (
    <div className={clsx('rounded-xl border px-4 py-3 shadow-sm', tones[tone])}>
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-extrabold leading-none mt-1">{value}</div>
    </div>
  );
}

function VerdictPill({ result }: { result: PackingResult }) {
  const map: Record<PackingResult, { label: string; cls: string }> = {
    PACKED_OK:      { label: 'PACKED',         cls: 'bg-emerald-100 text-emerald-800' },
    WRONG_GRADE:    { label: 'WRONG GRADE',    cls: 'bg-red-100 text-red-800' },
    ALREADY_PACKED: { label: 'ALREADY PACKED', cls: 'bg-amber-100 text-amber-900' },
    NOT_PROCESSED:  { label: 'NOT PROCESSED',  cls: 'bg-red-100 text-red-800' },
    IN_PROCESS:     { label: 'IN PROCESS',     cls: 'bg-red-100 text-red-800' },
    RING_REJECTED:  { label: 'RING REJECTED',  cls: 'bg-red-100 text-red-800' },
    CIRCLIP_SCRAP:  { label: 'CIRCLIP SCRAP',  cls: 'bg-red-100 text-red-800' },
    LOOKUP_ERROR:   { label: "CAN'T VERIFY",   cls: 'bg-amber-100 text-amber-900' },
  };
  const m = map[result];
  return (
    <span className={clsx('inline-block px-2 py-0.5 text-xs font-semibold rounded', m.cls)}>
      {m.label}
    </span>
  );
}
