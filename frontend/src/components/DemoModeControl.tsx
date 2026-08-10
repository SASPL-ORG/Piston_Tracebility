import { EyeOff } from 'lucide-react';
import { useHideState } from '../lib/hideState';
import { useAdminAuth } from '../lib/adminAuth';

// Demo-mode control — reversible, display-only hide of ALL historical data
// (Dashboard, Lists, Part Trace, Images). The toggle is GLOBAL; this button is
// the single place it's operated from (the Machine Status page). BOTH entering
// and exiting demo mode force a fresh admin login (force: true) — you can never
// switch modes without entering the password.
export default function DemoModeControl() {
  const { hidden, hide, reveal } = useHideState();
  const { requireAdmin } = useAdminAuth();

  if (!hidden) {
    return (
      <button
        onClick={() => requireAdmin(() => void hide(), { force: true })}
        className="flex items-center justify-center p-1.5 text-slate-500 border border-slate-200 rounded-md hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Enter demo mode (admin login required)"
      >
        <EyeOff size={16} />
      </button>
    );
  }

  return (
    <button
      onClick={() => requireAdmin(() => void reveal(), { force: true })}
      className="flex items-center justify-center p-1.5 text-amber-700 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200 transition-colors"
      title="Exit demo mode and restore all data (admin login required)"
      aria-label="Exit demo mode (admin login required)"
    >
      <EyeOff size={16} />
    </button>
  );
}
