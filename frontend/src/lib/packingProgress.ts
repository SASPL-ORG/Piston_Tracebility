import { useCallback, useEffect, useState } from 'react';

// Persistent per-grade pack tracking for the Zebra packing station.
//
// Model: each grade (by P-code) has its own *current pallet*. A pallet
// holds PALLET_CAPACITY parts (1080 = 30 bins × 36). When a pallet fills
// up the next OK pack closes it, allocates a new packing number, and the
// counter restarts at 1 in the new pallet. Switching grades does NOT
// touch the previous grade's state — its counter stays where it was, so
// coming back to it later resumes from the same count in the same pallet.
//
// Packing number format: DDMMYYNN, where NN is a per-day sequence shared
// across grades. So if A's first pallet of 21 June 2026 gets 21062601,
// the next NEW pallet (whether B or another A pallet after rollover)
// gets 21062602. The sequence resets at midnight (first allocation of a
// new calendar day starts back at 01).
//
// Persistence: window.localStorage under PACKING_PROGRESS_KEY. Survives
// page reloads and tab closes — the only thing that resets it is an
// explicit resetGrade() call (no UI for that yet) or the operator
// clearing browser storage.

export const PALLET_CAPACITY = 1080;
export const BIN_CAPACITY = 36;
const PACKING_PROGRESS_KEY = 'packing/progress/v1';

export interface GradePackState {
  packed: number;          // count in the CURRENT pallet (0..PALLET_CAPACITY)
  packingNumber: string;   // the current pallet's number (DDMMYYNN)
}

export interface PackingProgressState {
  byGrade: Record<string, GradePackState>;
  dailySeq: number;        // last-issued NN for dailyDate
  dailyDate: string;       // 'YYYY-MM-DD' the dailySeq applies to
}

const EMPTY_STATE: PackingProgressState = { byGrade: {}, dailySeq: 0, dailyDate: '' };

function todayStrings(): { dateKey: string; ddmmyy: string } {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(yyyy).slice(-2);
  return { dateKey: `${yyyy}-${mm}-${dd}`, ddmmyy: `${dd}${mm}${yy}` };
}

function loadState(): PackingProgressState {
  if (typeof window === 'undefined') return EMPTY_STATE;
  try {
    const raw = window.localStorage.getItem(PACKING_PROGRESS_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<PackingProgressState>;
    return {
      byGrade: parsed.byGrade ?? {},
      dailySeq: parsed.dailySeq ?? 0,
      dailyDate: parsed.dailyDate ?? '',
    };
  } catch {
    return EMPTY_STATE;
  }
}

function saveState(state: PackingProgressState): void {
  try {
    window.localStorage.setItem(PACKING_PROGRESS_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode — in-memory state still works for the session.
  }
}

// Allocate the next packing number, mutating only dailySeq/dailyDate on
// the returned state. Caller composes this into a full state update.
function allocateNextPackingNumber(state: PackingProgressState): {
  packingNumber: string;
  dailySeq: number;
  dailyDate: string;
} {
  const { dateKey, ddmmyy } = todayStrings();
  const seq = state.dailyDate === dateKey ? state.dailySeq + 1 : 1;
  return {
    packingNumber: `${ddmmyy}${String(seq).padStart(2, '0')}`,
    dailySeq: seq,
    dailyDate: dateKey,
  };
}

export interface UsePackingProgressResult {
  state: PackingProgressState;
  recordPack: (pCode: string) => void;
  resetGrade: (pCode: string) => void;
  // Overwrite the byGrade map from the backend's authoritative state
  // (called by Packing.tsx on mount and after each /pack response so
  // the Zebra's counter never drifts from what the server has).
  syncFromBackend: (byGrade: Record<string, GradePackState>) => void;
  // Apply a single grade's updated state from a /pack response.
  setGradeState: (pCode: string, state: GradePackState) => void;
}

export function usePackingProgress(): UsePackingProgressResult {
  const [state, setState] = useState<PackingProgressState>(() => loadState());

  useEffect(() => {
    saveState(state);
  }, [state]);

  const recordPack = useCallback((pCode: string) => {
    if (!pCode) return;
    setState((prev) => {
      const current = prev.byGrade[pCode] ?? { packed: 0, packingNumber: '' };
      const needsNewPallet = current.packed >= PALLET_CAPACITY || !current.packingNumber;
      if (needsNewPallet) {
        const alloc = allocateNextPackingNumber(prev);
        return {
          byGrade: {
            ...prev.byGrade,
            [pCode]: { packed: 1, packingNumber: alloc.packingNumber },
          },
          dailySeq: alloc.dailySeq,
          dailyDate: alloc.dailyDate,
        };
      }
      return {
        ...prev,
        byGrade: {
          ...prev.byGrade,
          [pCode]: { packed: current.packed + 1, packingNumber: current.packingNumber },
        },
      };
    });
  }, []);

  const resetGrade = useCallback((pCode: string) => {
    setState((prev) => {
      if (!(pCode in prev.byGrade)) return prev;
      const next = { ...prev.byGrade };
      delete next[pCode];
      return { ...prev, byGrade: next };
    });
  }, []);

  const syncFromBackend = useCallback(
    (byGrade: Record<string, GradePackState>) => {
      setState((prev) => ({ ...prev, byGrade: { ...byGrade } }));
    },
    [],
  );

  const setGradeState = useCallback((pCode: string, gs: GradePackState) => {
    setState((prev) => ({
      ...prev,
      byGrade: { ...prev.byGrade, [pCode]: gs },
    }));
  }, []);

  return { state, recordPack, resetGrade, syncFromBackend, setGradeState };
}

// Pure helpers — kept out of the hook so they're easy to use in render
// without re-renders and easy to unit-test if we ever add tests.

export function computeBin(packed: number): { bin: number; partsInBin: number } {
  if (packed <= 0) return { bin: 1, partsInBin: 0 };
  const bin = Math.ceil(packed / BIN_CAPACITY);
  const partsInBin = packed - (bin - 1) * BIN_CAPACITY;
  return { bin, partsInBin };
}

export function pendingForPallet(packed: number): number {
  return Math.max(0, PALLET_CAPACITY - packed);
}
