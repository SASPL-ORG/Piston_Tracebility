import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

// Client mirror of the backend "demo hide" cutoff. Polls the state endpoint so
// the app-wide banner stays in sync even if another operator toggles it, and
// exposes hide()/reveal() for the Layout control. The actual gating (admin
// login) is layered on top by the caller via useAdminAuth().requireAdmin.
interface HideStateValue {
  hidden: boolean;
  hideBefore: string | null;
  hide: () => Promise<void>;
  reveal: () => Promise<void>;
  refresh: () => Promise<void>;
}

const HideStateContext = createContext<HideStateValue | null>(null);

export function HideStateProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const [hideBefore, setHideBefore] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/dashboard/state');
      if (!r.ok) return;
      const d = (await r.json()) as { hidden?: boolean; hideBefore?: string | null };
      setHidden(!!d.hidden);
      setHideBefore(d.hideBefore ?? null);
    } catch {
      // Network blip — keep the last known state rather than flapping.
    }
  }, []);

  const hide = useCallback(async () => {
    await fetch('/api/admin/dashboard/hide', { method: 'POST' });
    await refresh();
  }, [refresh]);

  const reveal = useCallback(async () => {
    await fetch('/api/admin/dashboard/reveal', { method: 'POST' });
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const value = useMemo<HideStateValue>(
    () => ({ hidden, hideBefore, hide, reveal, refresh }),
    [hidden, hideBefore, hide, reveal, refresh],
  );

  return <HideStateContext.Provider value={value}>{children}</HideStateContext.Provider>;
}

export function useHideState(): HideStateValue {
  const ctx = useContext(HideStateContext);
  if (!ctx) throw new Error('useHideState must be used within HideStateProvider');
  return ctx;
}
