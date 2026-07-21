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

// Admin auth — gates Tool Life edit/reset actions on the Maintenance
// page. State lives ONLY in component memory; we deliberately don't
// persist to localStorage / sessionStorage so closing the tab forces a
// fresh login. A short in-process window (5 minutes by default) keeps
// the admin from re-entering creds on every keystroke when they're in
// the middle of configuring multiple tools, while still expiring on
// idle.
const SESSION_TTL_MS = 5 * 60 * 1000;

interface AdminAuthContextValue {
  // `true` while we hold a non-expired admin session in memory.
  isAdmin: boolean;
  // Run `action` if currently authed; otherwise pop the login modal,
  // and only run on successful submit. Cancels (no-op) if the operator
  // dismisses the modal.
  requireAdmin: (action: () => void) => void;
  // Imperatively clears the session (mostly for the "Log out" affordance,
  // which we don't render today but might soon).
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

// Wire the modal display to context — the provider keeps modal state.
interface PendingAction {
  run: () => void;
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [authedUntil, setAuthedUntil] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  // Tick on a timer so the UI updates the moment the session expires
  // even if the user is idle. Re-evaluating isAdmin every second is
  // negligible cost.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const isAdmin = authedUntil !== null && Date.now() < authedUntil;

  const requireAdmin = useCallback(
    (action: () => void) => {
      if (authedUntil !== null && Date.now() < authedUntil) {
        action();
        return;
      }
      setError('');
      setPending({ run: action });
    },
    [authedUntil],
  );

  const logout = useCallback(() => setAuthedUntil(null), []);

  const close = useCallback(() => {
    setPending(null);
    setError('');
    setSubmitting(false);
  }, []);

  const submit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const username = usernameRef.current?.value ?? '';
      const password = passwordRef.current?.value ?? '';
      setError('');
      setSubmitting(true);
      try {
        const res = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) {
          setAuthedUntil(Date.now() + SESSION_TTL_MS);
          const pendingAction = pending;
          // Close first so React can dismiss the modal before the
          // action runs (the action may itself open another modal).
          close();
          pendingAction?.run();
        } else if (res.status === 503) {
          setError('Admin auth is not configured on the server.');
          setSubmitting(false);
        } else {
          setError('Invalid username or password.');
          setSubmitting(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed');
        setSubmitting(false);
      }
    },
    [pending, close],
  );

  // Focus the username field when the modal opens.
  useEffect(() => {
    if (pending) {
      // requestAnimationFrame to let the input render before focusing.
      requestAnimationFrame(() => usernameRef.current?.focus());
    }
  }, [pending]);

  // Esc dismisses the modal.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  const ctx = useMemo<AdminAuthContextValue>(
    () => ({ isAdmin, requireAdmin, logout }),
    [isAdmin, requireAdmin, logout],
  );

  return (
    <AdminAuthContext.Provider value={ctx}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
          onClick={close}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-1 h-6 bg-blue-600 rounded-full" />
              <h2 className="text-lg font-semibold text-gray-900">Admin login required</h2>
            </div>
            <p className="text-xs text-gray-500">
              This action affects the Tool Life configuration. Enter the
              administrator credentials to continue.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
                <input
                  ref={usernameRef}
                  type="text"
                  autoComplete="username"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="admin"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                <input
                  ref={passwordRef}
                  type="password"
                  autoComplete="current-password"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {error && (
                <p className="text-xs text-red-600">{error}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={close}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-100 rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors"
              >
                {submitting ? 'Verifying…' : 'Log in'}
              </button>
            </div>
          </form>
        </div>
      )}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AdminAuthContextValue {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used within AdminAuthProvider');
  return ctx;
}
