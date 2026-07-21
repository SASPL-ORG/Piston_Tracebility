import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchToolLifeProducedSince } from './api';

// Fixed catalog of consumable spares the operator wants to monitor. Order
// matches the Tool Life.xlsx the customer maintains. If the list ever
// grows, append rather than reorder so persisted localStorage entries
// stay associated with the right tool.
export const TOOL_LIFE_CATALOG: string[] = [
  'Snap Ring Pusher Shaft',
  'Snap Ring Holder Shaft',
  'Snap Ring Slider',
  'Expander Ring Opening Jaws',
  'Expander Ring Pusher',
  'Expander Ring Top Plates',
  'Rail Ring Opening Jaws',
  'Rail Ring Pusher',
  'Rail Ring Top Plates',
  'Top Ring Pusher',
  'Top Ring Plates',
  '2nd Ring Pusher',
  '2nd Ring Plates',
];

// Per-tool persisted config. `setAtIso` is captured the moment the operator
// types a value, so produced-since counts only the parts made afterwards.
// `acknowledgedAt` lets the operator dismiss the bell badge for a triggered
// tool without resetting Life-in-Quantity (the row still shows COMPLETED
// in the panel until they reset).
//
// `plcSignalledAt` remembers the FIRST time we relayed an exhaustion
// signal to the PLC for this tool. Set the moment produced >= life so
// the per-15-s poll never re-fires on the same exhaustion event; cleared
// when the operator resets or changes Life. Backend has a 60-s dedupe
// guard too, but this avoids a useless round-trip every cycle.
export interface ToolLifeConfig {
  life: number;
  setAtIso: string;
  acknowledgedAt?: string;
  plcSignalledAt?: string;
}

interface ToolLifeStore {
  configs: Record<string, ToolLifeConfig>;
  produced: Record<string, number>;
}

const STORAGE_KEY = 'piston.toolLife.v1';
const POLL_INTERVAL_MS = 15_000;

function loadStorage(): Record<string, ToolLifeConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ToolLifeConfig>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveStorage(configs: Record<string, ToolLifeConfig>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
  } catch {
    // Quota exceeded or storage disabled — silently drop. The next save
    // attempt will retry.
  }
}

export interface ToolLifeRow {
  name: string;
  life: number | null;
  setAtIso: string | null;
  produced: number;
  left: number | null;
  completed: boolean;
  acknowledged: boolean;
}

interface ToolLifeContextValue {
  rows: ToolLifeRow[];
  activeAlerts: ToolLifeRow[];   // completed AND not yet acknowledged
  setLife: (name: string, life: number | null) => void;
  acknowledgeAll: () => void;
  resetTool: (name: string) => void;
}

const ToolLifeContext = createContext<ToolLifeContextValue | null>(null);

export function ToolLifeProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<ToolLifeStore>(() => ({
    configs: loadStorage(),
    produced: {},
  }));
  const storeRef = useRef(store);
  storeRef.current = store;

  const setLife = useCallback((name: string, life: number | null) => {
    setStore((prev) => {
      const next: Record<string, ToolLifeConfig> = { ...prev.configs };
      if (life === null || !Number.isFinite(life) || life <= 0) {
        delete next[name];
      } else {
        const existing = prev.configs[name];
        // If the operator types the same Life again, keep the existing
        // setAt so produced-since isn't artificially reset; otherwise
        // start a fresh window.
        if (existing && existing.life === life) {
          next[name] = existing;
        } else {
          next[name] = { life, setAtIso: new Date().toISOString() };
        }
      }
      saveStorage(next);
      const nextProduced = { ...prev.produced };
      if (!(name in next)) delete nextProduced[name];
      return { configs: next, produced: nextProduced };
    });
  }, []);

  const acknowledgeAll = useCallback(() => {
    setStore((prev) => {
      const nowIso = new Date().toISOString();
      const next: Record<string, ToolLifeConfig> = {};
      for (const [name, cfg] of Object.entries(prev.configs)) {
        const left = cfg.life - (prev.produced[name] ?? 0);
        if (left <= 0) next[name] = { ...cfg, acknowledgedAt: nowIso };
        else next[name] = cfg;
      }
      saveStorage(next);
      return { ...prev, configs: next };
    });
  }, []);

  const resetTool = useCallback((name: string) => {
    setStore((prev) => {
      const next = { ...prev.configs };
      delete next[name];
      saveStorage(next);
      const nextProduced = { ...prev.produced };
      delete nextProduced[name];
      return { configs: next, produced: nextProduced };
    });
  }, []);

  // Background poll: for every tool that has Life configured, fetch the
  // produced-since count from the backend. We share one effect for all
  // tools and re-poll every 15s; this is cheap because the SQL is just a
  // COUNT(DISTINCT DMC) on an indexed column.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const configs = storeRef.current.configs;
      const names = Object.keys(configs);
      if (names.length === 0) return;
      const results = await Promise.all(
        names.map(async (name) => {
          try {
            const { count } = await fetchToolLifeProducedSince(configs[name].setAtIso);
            return [name, count] as const;
          } catch {
            return [name, storeRef.current.produced[name] ?? 0] as const;
          }
        }),
      );
      if (cancelled) return;
      setStore((prev) => {
        const nextProduced: Record<string, number> = { ...prev.produced };
        const nextConfigs: Record<string, ToolLifeConfig> = { ...prev.configs };
        const toNotify: { name: string; quantityLeft: number }[] = [];
        for (const [name, count] of results) {
          if (!(name in prev.configs)) continue;
          nextProduced[name] = count;
          const cfg = prev.configs[name];
          // Exhaustion edge: produced crossed life AND we haven't yet
          // signalled the PLC for THIS configuration. Stamping the
          // ISO into the persisted config makes this one-shot per
          // (tool, life-value) — a Reset clears it, a re-set with a
          // different number clears it too (via setLife).
          if (count >= cfg.life && !cfg.plcSignalledAt) {
            const nowIso = new Date().toISOString();
            nextConfigs[name] = { ...cfg, plcSignalledAt: nowIso };
            toNotify.push({ name, quantityLeft: Math.max(0, cfg.life - count) });
          }
        }
        if (toNotify.length > 0) {
          // Fire-and-forget: the backend logs success/failure; we
          // don't want a flaky NR webhook to wedge the polling loop.
          for (const t of toNotify) {
            fetch('/api/tool-life/notify-exhausted', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tool_name: t.name, quantity_left: t.quantityLeft }),
            }).catch(() => {
              // Network blip — the next poll won't re-trigger because
              // plcSignalledAt is now stamped. Operator can manually
              // Reset+Re-Set to retry if PLC didn't actually stop.
            });
          }
          saveStorage(nextConfigs);
        }
        return { configs: nextConfigs, produced: nextProduced };
      });
    };
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const value = useMemo<ToolLifeContextValue>(() => {
    const rows: ToolLifeRow[] = TOOL_LIFE_CATALOG.map((name) => {
      const cfg = store.configs[name];
      if (!cfg) {
        return {
          name,
          life: null,
          setAtIso: null,
          produced: 0,
          left: null,
          completed: false,
          acknowledged: false,
        };
      }
      const produced = store.produced[name] ?? 0;
      const left = Math.max(0, cfg.life - produced);
      const completed = produced >= cfg.life;
      return {
        name,
        life: cfg.life,
        setAtIso: cfg.setAtIso,
        produced,
        left,
        completed,
        acknowledged: completed && !!cfg.acknowledgedAt,
      };
    });
    const activeAlerts = rows.filter((r) => r.completed && !r.acknowledged);
    return { rows, activeAlerts, setLife, acknowledgeAll, resetTool };
  }, [store, setLife, acknowledgeAll, resetTool]);

  return <ToolLifeContext.Provider value={value}>{children}</ToolLifeContext.Provider>;
}

export function useToolLife(): ToolLifeContextValue {
  const ctx = useContext(ToolLifeContext);
  if (!ctx) {
    throw new Error('useToolLife must be used within ToolLifeProvider');
  }
  return ctx;
}
