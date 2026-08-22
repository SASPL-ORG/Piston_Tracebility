import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, ScanLine, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { verifyScan, packScan, fetchPackingProgress } from '../lib/api';
import {
  usePackingProgress,
  computeBin,
  PALLET_CAPACITY,
  BIN_CAPACITY,
} from '../lib/packingProgress';
import {
  GRADE_GROUPS,
  GRADE_BY_PCODE,
  REJECT,
  P_CODE_RE,
} from '../lib/grades';
import PackProgressSummary from '../components/PackProgressSummary';

// ---------------------------------------------------------------------------
// PACKING VERIFICATION (README_MOBILE_SCANNER.md)
//
// 1. Operator picks the grade they are packing (or REJECTED).
// 2. Scan a piston. The P234102M### code in the DMC is checked CLIENT-SIDE
//    against the selected grade (offline, no server).
// 3. On grade match → POST /api/verify (is the part processed + passed, not
//    already packed?) → if packable, POST /api/pack (records the pack).
// 4. REJECTED mode skips the grade/verify checks and just logs every scan to
//    the reject pile via /api/pack { reject: true }.
// ---------------------------------------------------------------------------


// Operator-facing part summary returned by /verify. Carried on outcomes
// that have a real part attached, so the verdict screen can show
// snap-ring + ring-inspection status, the production date and shift in
// addition to the headline verdict.
interface PartInfo {
  dmc: string | null;
  partNumber: string | null;
  snapRingStatus: 'OK' | 'FAIL' | null;
  ringInspectionStatus: 'OK' | 'FAIL' | null;
  processedAt: string | null;
  shift: 'A' | 'B' | 'C' | null;
  productionDate: string | null;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'ready' }
  | { kind: 'checking' }
  | { kind: 'wrong_grade'; expected: string; scanned: string }
  | { kind: 'cant_read' }
  | { kind: 'ok_packed'; grade: string; part?: PartInfo; binComplete?: { bin: number } }
  | { kind: 'reject_logged' }
  | { kind: 'already_packed'; msg: string; part?: PartInfo }
  | { kind: 'do_not_pack'; msg: string; part?: PartInfo }
  | { kind: 'cant_verify'; msg: string }
  // Pallet hit PALLET_CAPACITY — operator must press Print & Complete
  // on the Live Mirror before any more scans of this grade are accepted.
  | { kind: 'pallet_full'; msg: string; packingNumber: string };

export default function Packing() {
  const [selectedValue, setSelectedValue] = useState(''); // '' | pCode | 'REJECT'
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const busyRef = useRef(false);
  const { state: packingProgress, syncFromBackend, setGradeState } = usePackingProgress();

  // Pull the backend's authoritative pallet state on every mount AND
  // every 15 s while the page is open, so the operator's counter on
  // the Zebra always matches what /packing/progress (and the Live
  // Mirror's Packing Summary) reads. Fixes the drift the operator saw
  // where the Zebra read 49 but the desktop read 7 after a backend
  // restart. Bumped from 5 s to 15 s to reduce DB polling load —
  // /pack responses still push the authoritative count on every scan,
  // so the counter is effectively live during actual work.
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      fetchPackingProgress()
        .then((r) => { if (!cancelled) syncFromBackend(r.byGrade); })
        .catch(() => { /* offline — keep last-known local state */ });
    };
    sync();
    const id = window.setInterval(sync, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [syncFromBackend]);

  const selectedGrade =
    selectedValue && selectedValue !== REJECT ? GRADE_BY_PCODE.get(selectedValue) ?? null : null;
  const isReject = selectedValue === REJECT;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // --- Audio cues --------------------------------------------------------
  const tone = useCallback((freq: number, durationMs: number, type: OscillatorType, gain: number) => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      let ctx = audioRef.current;
      if (!ctx) {
        ctx = new Ctx();
        audioRef.current = ctx;
      }
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g);
      g.connect(ctx.destination);
      const now = ctx.currentTime;
      osc.start(now);
      osc.stop(now + durationMs / 1000);
    } catch {
      /* audio is best-effort */
    }
  }, []);

  const beepError = useCallback(() => {
    tone(196, 200, 'square', 0.28);
    window.setTimeout(() => tone(196, 240, 'square', 0.28), 230);
  }, [tone]);
  const tickOk = useCallback(() => tone(1320, 70, 'sine', 0.14), [tone]);
  // Bin-complete motif — two long beeps then three short ("Beeep, Beeep,
  // Bep Bep Bep") so the operator hears, without looking, that 36 parts
  // (one bin) just landed. Distinct from the single tickOk on every pack.
  const binCompleteChime = useCallback(() => {
    tone(880, 220, 'sine', 0.2);                                   // Beeep
    window.setTimeout(() => tone(880, 220, 'sine', 0.2), 340);     // Beeep
    window.setTimeout(() => tone(1320, 90, 'square', 0.18), 740);  // Bep
    window.setTimeout(() => tone(1320, 90, 'square', 0.18), 920);  // Bep
    window.setTimeout(() => tone(1320, 90, 'square', 0.18), 1100); // Bep
  }, [tone]);

  useEffect(() => {
    focusInput();
  }, [focusInput]);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setSelectedValue(v);
    setOutcome({ kind: v ? 'ready' : 'idle' });
    if (audioRef.current?.state === 'suspended') void audioRef.current.resume();
    focusInput();
  };

  const runScan = useCallback(
    async (raw: string) => {
      if (busyRef.current) return;
      if (!selectedValue) {
        setOutcome({ kind: 'idle' });
        focusInput();
        return;
      }

      // REJECTED mode — accept any scan, log it, no grade/verify checks.
      if (selectedValue === REJECT) {
        if (!raw.trim()) {
          focusInput();
          return;
        }
        busyRef.current = true;
        setOutcome({ kind: 'checking' });
        try {
          const p = await packScan(raw, true);
          if (p.ok) {
            setOutcome({ kind: 'reject_logged' });
            tickOk();
          } else {
            setOutcome({ kind: 'cant_verify', msg: p.message });
            beepError();
          }
        } catch {
          setOutcome({ kind: 'cant_verify', msg: "Couldn't reach the line system — retry." });
          beepError();
        } finally {
          busyRef.current = false;
          focusInput();
        }
        return;
      }

      // Pallet-full guard — if the selected grade's current pallet has
      // already reached PALLET_CAPACITY, refuse the scan locally before
      // even calling the server. Keeps the operator from clearing the
      // input on a scan they thought went through.
      const palletState = packingProgress.byGrade[selectedValue];
      if (palletState && palletState.packed >= PALLET_CAPACITY) {
        setOutcome({
          kind: 'pallet_full',
          msg: `Pallet ${palletState.packingNumber} is full (${PALLET_CAPACITY}/${PALLET_CAPACITY}). Press "Print & Complete" on the desktop before scanning more parts.`,
          packingNumber: palletState.packingNumber,
        });
        beepError();
        focusInput();
        return;
      }

      // Grade mode — client-side P-code check first (offline, no server).
      const m = raw.match(P_CODE_RE);
      if (!m) {
        setOutcome({ kind: 'cant_read' });
        beepError();
        focusInput();
        return;
      }
      const pCode = m[0];
      const scannedGrade = GRADE_BY_PCODE.get(pCode);
      if (pCode !== selectedValue) {
        setOutcome({ kind: 'wrong_grade', expected: selectedGrade?.code ?? selectedValue, scanned: scannedGrade?.code ?? pCode });
        beepError();
        focusInput();
        return;
      }

      // Grade matches → server verify, then (if packable) pack.
      busyRef.current = true;
      setOutcome({ kind: 'checking' });
      try {
        const v = await verifyScan(raw);
        const part: PartInfo = {
          dmc: v.dmc,
          partNumber: v.partNumber,
          snapRingStatus: v.snapRingStatus,
          ringInspectionStatus: v.ringInspectionStatus,
          processedAt: v.processedAt,
          shift: v.shift,
          productionDate: v.productionDate,
        };
        if (v.result === 'LOOKUP_ERROR') {
          setOutcome({ kind: 'cant_verify', msg: v.message });
          beepError();
          return;
        }
        if (!v.packable) {
          if (v.result === 'ALREADY_PACKED') {
            setOutcome({ kind: 'already_packed', msg: v.message, part });
          } else {
            setOutcome({ kind: 'do_not_pack', msg: v.message, part });
          }
          beepError();
          return;
        }
        const p = await packScan(raw, false);
        if (p.result === 'PACKED_OK') {
          // Use the backend's authoritative count instead of incrementing
          // locally — that's how the operator's display stays in lockstep
          // with /packing/progress, the Live Mirror, and the Print label.
          if (p.pallet) {
            setGradeState(pCode, {
              packed: p.pallet.packed,
              packingNumber: p.pallet.packingNumber,
            });
          }
          // Every 36th part closes a bin — fire the distinct chime + banner.
          const packedNow = p.pallet?.packed ?? 0;
          const binDone = packedNow > 0 && packedNow % BIN_CAPACITY === 0;
          setOutcome({
            kind: 'ok_packed',
            grade: scannedGrade?.code ?? pCode,
            part,
            binComplete: binDone ? { bin: packedNow / BIN_CAPACITY } : undefined,
          });
          if (binDone) binCompleteChime();
          else tickOk();
        } else if (p.result === 'PALLET_FULL') {
          // Backend refused — pallet has PALLET_CAPACITY parts already.
          // Sync our display (so the count shows the true 1080/1080)
          // and lock further scans of this grade until completion.
          if (p.pallet) {
            setGradeState(pCode, {
              packed: p.pallet.packed,
              packingNumber: p.pallet.packingNumber,
            });
          }
          setOutcome({
            kind: 'pallet_full',
            msg: p.message,
            packingNumber: p.pallet?.packingNumber ?? '',
          });
          beepError();
        } else if (p.result === 'ALREADY_PACKED') {
          setOutcome({ kind: 'already_packed', msg: p.message, part });
          beepError();
        } else {
          setOutcome({ kind: 'do_not_pack', msg: p.message, part });
          beepError();
        }
      } catch {
        setOutcome({ kind: 'cant_verify', msg: "Couldn't reach the line system — retry. Don't pack unverified." });
        beepError();
      } finally {
        busyRef.current = false;
        focusInput();
      }
    },
    [selectedValue, selectedGrade, beepError, tickOk, focusInput, setGradeState, packingProgress.byGrade],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    e.preventDefault();
    const raw = inputRef.current?.value ?? '';
    if (inputRef.current) inputRef.current.value = '';
    void runScan(raw);
  };

  // --- Result band styling ----------------------------------------------
  const band = ((): { bg: string; fg: string; Icon: typeof CheckCircle2; spin?: boolean; title: string; sub: string; hint?: string } => {
    switch (outcome.kind) {
      case 'idle':
        return { bg: 'bg-slate-100', fg: 'text-slate-500', Icon: ScanLine, title: 'Select a grade to begin', sub: 'Choose a grade — or REJECTED — from the menu above.' };
      case 'ready':
        return {
          bg: 'bg-slate-50',
          fg: 'text-slate-500',
          Icon: ScanLine,
          title: 'Ready — scan a piston',
          sub: isReject ? 'Reject mode — every scan is logged to the reject pile.' : `Verifying against grade ${selectedGrade?.code}.`,
        };
      case 'checking':
        return { bg: 'bg-sky-500', fg: 'text-white', Icon: Loader2, spin: true, title: 'VERIFYING…', sub: 'Checking with the line system.' };
      case 'ok_packed':
        return { bg: 'bg-emerald-500', fg: 'text-white', Icon: CheckCircle2, title: 'OK — PACKED', sub: `Grade ${outcome.grade} — verified and packed.` };
      case 'reject_logged':
        return { bg: 'bg-emerald-600', fg: 'text-white', Icon: CheckCircle2, title: 'REJECT LOGGED', sub: 'Logged to the reject pile (grade not checked).' };
      case 'already_packed':
        return { bg: 'bg-amber-400', fg: 'text-amber-950', Icon: AlertTriangle, title: 'ALREADY PACKED', sub: outcome.msg };
      case 'do_not_pack':
        return { bg: 'bg-red-600', fg: 'text-white', Icon: XCircle, title: 'DO NOT PACK', sub: outcome.msg };
      case 'wrong_grade':
        return { bg: 'bg-red-600', fg: 'text-white', Icon: XCircle, title: 'WRONG GRADE', sub: `Expected ${outcome.expected} · Scanned ${outcome.scanned}`, hint: 'Check the piston, or reselect the grade above.' };
      case 'cant_read':
        return { bg: 'bg-amber-400', fg: 'text-amber-950', Icon: AlertTriangle, title: "CAN'T READ — RESCAN", sub: 'No part code found in that scan.', hint: 'Scan the piston again.' };
      case 'cant_verify':
        return { bg: 'bg-amber-400', fg: 'text-amber-950', Icon: AlertTriangle, title: "CAN'T VERIFY", sub: outcome.msg, hint: "Don't pack unverified." };
      case 'pallet_full':
        return {
          bg: 'bg-amber-500',
          fg: 'text-white',
          Icon: AlertTriangle,
          title: 'PALLET FULL',
          sub: outcome.msg,
          hint: `Pallet #${outcome.packingNumber} — click Print & Complete on the desktop.`,
        };
    }
  })();

  const { Icon } = band;

  // Pull the part summary off whichever outcome carries it. Only outcomes
  // that ran a real verify (do_not_pack / already_packed / ok_packed) have
  // it; everything else stays bare.
  const part: PartInfo | undefined =
    outcome.kind === 'do_not_pack' || outcome.kind === 'already_packed' || outcome.kind === 'ok_packed'
      ? outcome.part
      : undefined;

  const cornerDateLabel = formatPartDate(part?.productionDate ?? part?.processedAt ?? null);
  const cornerShiftLabel = part?.shift ? `Shift ${part.shift}` : null;

  // Pack progress for the currently selected grade (no progress shown
  // in REJECTED mode — reject scans don't roll into pallet counts).
  const selectedGradeProgress =
    !isReject && selectedGrade ? packingProgress.byGrade[selectedGrade.pCode] ?? null : null;
  const selectedBinInfo = selectedGradeProgress ? computeBin(selectedGradeProgress.packed) : null;

  return (
    <div className="flex flex-col -m-4 lg:-m-6 min-h-full">
      {/* Selected-grade bar (persists across scans) */}
      <div className="bg-white border-b border-gray-200 px-5 py-4 flex items-center gap-5 shrink-0">
        <div className="flex items-baseline gap-3">
          <span className="text-xs uppercase tracking-wider text-gray-400">Grade</span>
          <span
            className={clsx(
              'font-mono font-extrabold leading-none text-5xl sm:text-6xl',
              isReject ? 'text-red-600' : 'text-slate-900',
            )}
          >
            {isReject ? 'REJECT' : selectedGrade ? selectedGrade.code : '—'}
          </span>
          <span className="text-sm text-gray-400 font-mono">
            {isReject ? 'reject bin' : selectedGrade ? selectedGrade.pCode : 'not set'}
          </span>
        </div>
        <select
          value={selectedValue}
          onChange={handleSelect}
          className="ml-auto text-lg sm:text-xl font-semibold px-4 py-3 rounded-xl border-2 border-gray-300 bg-white text-slate-800 focus:outline-none focus:ring-4 focus:ring-blue-300 min-w-[12rem]"
        >
          <option value="">— Select grade —</option>
          <option value={REJECT}>⨯ REJECTED — reject bin</option>
          {GRADE_GROUPS.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.grades.map((g) => (
                <option key={g.pCode} value={g.pCode}>
                  {g.code} · {g.pCode}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Big glanceable result band */}
      <div
        className={clsx('relative flex-1 flex flex-col items-center justify-center text-center px-6 py-10 transition-colors', band.bg, band.fg)}
        onClick={focusInput}
      >
        {/* Date + shift chip — top-right corner, only when we have a part */}
        {(cornerDateLabel || cornerShiftLabel) && (
          <div className="absolute top-4 right-4 sm:top-5 sm:right-5 text-right leading-tight">
            {cornerDateLabel && (
              <div className="text-base sm:text-lg font-semibold opacity-90 tabular-nums">
                {cornerDateLabel}
              </div>
            )}
            {cornerShiftLabel && (
              <div className="text-sm sm:text-base font-bold uppercase tracking-wider opacity-85">
                {cornerShiftLabel}
              </div>
            )}
          </div>
        )}

        <Icon size={120} strokeWidth={1.75} className={clsx('mb-6 opacity-95', band.spin && 'animate-spin')} />
        <div className="text-6xl sm:text-7xl font-extrabold tracking-tight leading-none">{band.title}</div>
        <div className="mt-5 text-2xl sm:text-3xl font-semibold">{band.sub}</div>
        {band.hint && <div className="mt-3 text-lg sm:text-xl font-medium opacity-90">{band.hint}</div>}

        {/* Bin-complete banner — shows when a 36-part bin just closed, paired
            with the bin-complete chime. Stays until the next scan. */}
        {outcome.kind === 'ok_packed' && outcome.binComplete && (
          <div className="mt-7 px-8 py-4 rounded-2xl bg-white text-emerald-700 shadow-xl ring-2 ring-emerald-300 animate-pulse">
            <div className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              ✓ BIN {outcome.binComplete.bin} COMPLETE
            </div>
            <div className="mt-1 text-lg sm:text-xl font-semibold text-emerald-600">
              36 parts packed — start a new bin
            </div>
          </div>
        )}

        {/* Part summary — only when verify returned a real part */}
        {part && (part.partNumber || part.dmc || part.snapRingStatus || part.ringInspectionStatus) && (
          <div className="mt-8 w-full max-w-xl px-2 space-y-2 text-left sm:text-center">
            <PartRow label="Part No"        value={part.partNumber ?? '—'} mono />
            <PartRow label="DMC"            value={part.dmc ?? '—'} mono small />
            <PartRow label="Snap ring"      value={part.snapRingStatus} status />
            <PartRow label="Ring inspection" value={part.ringInspectionStatus} status />
          </div>
        )}

        {/* Bin / Pallet — for the currently-selected grade, always visible
            once a grade is chosen so the operator sees how full the current
            bin and pallet are even before the next scan lands. Also shows
            the active packing number (= pallet identifier) so the operator
            can match the on-screen counter to the printed label. */}
        {selectedGradeProgress && selectedBinInfo && (
          <div className="mt-6 w-full max-w-xl px-2 text-base sm:text-lg font-bold tabular-nums">
            <div className="flex justify-between sm:justify-center sm:gap-12">
              <span className="opacity-90">Bin {selectedBinInfo.bin}</span>
              <span>{selectedBinInfo.partsInBin}/{BIN_CAPACITY}</span>
            </div>
            <div className="flex justify-between sm:justify-center sm:gap-12 mt-1">
              <span className="opacity-90">Pallet</span>
              <span>{selectedGradeProgress.packed}/{PALLET_CAPACITY}</span>
            </div>
            {selectedGradeProgress.packingNumber && (
              <div className="flex justify-between sm:justify-center sm:gap-12 mt-1 text-sm sm:text-base font-mono">
                <span className="opacity-90">Pallet #</span>
                <span>{selectedGradeProgress.packingNumber}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pack progress summary — Packed OK Qty / Pending Qty for a Pallet
          / Packing number, one column per grade that has any activity (or
          the currently-selected grade, even at 0). Horizontal scroll on
          narrow screens. Hidden in REJECTED mode. */}
      {!isReject && (
        <PackProgressSummary
          progress={packingProgress.byGrade}
          selectedPCode={selectedGrade?.pCode ?? null}
        />
      )}

      {/* Scan input — always focused; the wedge types here and appends Enter */}
      <div className="bg-white border-t border-gray-200 px-5 py-4 shrink-0">
        <div className="relative">
          <ScanLine size={22} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            inputMode="none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onKeyDown={handleKeyDown}
            placeholder={selectedValue ? 'Scan piston DMC…' : 'Select a grade first…'}
            disabled={!selectedValue}
            className="w-full text-xl sm:text-2xl font-mono pl-12 pr-4 py-4 rounded-xl border-2 border-gray-300 focus:outline-none focus:ring-4 focus:ring-blue-300 disabled:bg-gray-100 disabled:text-gray-400"
          />
        </div>
      </div>
    </div>
  );
}

// One line of part metadata under the big verdict. Inherits the band's
// fg colour from the parent; status cells get a small OK/FAIL pill so
// the verdict is glanceable even without reading the label.
function PartRow({
  label,
  value,
  mono,
  small,
  status,
}: {
  label: string;
  value: string | 'OK' | 'FAIL' | null;
  mono?: boolean;
  small?: boolean;
  status?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 justify-between sm:justify-center">
      <span className="text-sm sm:text-base font-medium opacity-75 uppercase tracking-wider shrink-0">
        {label}
      </span>
      {status ? (
        <StatusPill value={value as 'OK' | 'FAIL' | null} />
      ) : (
        <span
          className={clsx(
            'font-semibold leading-tight break-all',
            mono && 'font-mono',
            small ? 'text-sm sm:text-base' : 'text-lg sm:text-xl',
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

// OK/FAIL pill — emerald for OK, red for FAIL, slate dash for unknown.
// White text on coloured pill is intentionally high-contrast even when
// the band itself is amber/red, so a green OK still reads as good.
function StatusPill({ value }: { value: 'OK' | 'FAIL' | null }) {
  if (!value) {
    return (
      <span className="inline-block px-3 py-0.5 rounded-md bg-slate-600/30 text-base sm:text-lg font-bold">
        —
      </span>
    );
  }
  const cls =
    value === 'OK'
      ? 'bg-emerald-600 text-white'
      : 'bg-red-700 text-white';
  return (
    <span className={clsx('inline-block px-3 py-0.5 rounded-md text-base sm:text-lg font-extrabold tracking-wide', cls)}>
      {value}
    </span>
  );
}

// Format DD-MMM-YYYY from a YYYY-MM-DD production day or an ISO timestamp.
// We use the production day when available because that's the day the
// dashboard would attribute the part to (matches what the operator sees
// on the wall display). Falls back to processedAt's date portion.
function formatPartDate(input: string | null): string | null {
  if (!input) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(input);
  if (!ymd) return null;
  const [, y, m, d] = ymd;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName = months[parseInt(m, 10) - 1] ?? m;
  return `${d}-${monthName}-${y}`;
}
