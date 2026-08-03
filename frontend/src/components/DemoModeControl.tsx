import { EyeOff } from 'lucide-react';
import { useHideState } from '../lib/hideState';
import { useAdminAuth } from '../lib/adminAuth';

// Demo-mode control — reversible, display-only hide of ALL historical data
// (Dashboard, Lists, Part Trace). The toggle is GLOBAL; this button is the
// single place it's operated from (the Machine Status page). Hide requires the
// admin login; reveal forces a FRESH credential entry (force: true) so data
// can never be un-hidden by a stray click.
export default function DemoModeControl() {
  const { hidden, hide, reveal } = useHideState();
  const { requireAdmin } = useAdminAuth();

  if (!hidden) {
    return (
      <button
        onClick={() => requireAdmin(() => void hide())}
        className="flex items-center justify-center p-1.5 text-slate-500 border border-slate-200 rounded-md hover:bg-slate-100 hover:text-slate-700 transition-colors"
        aria-label="Hide data (demo mode)"
      >
        <EyeOff size={16} />
      </button>
    );
  }

  return (
    <button
      onClick={() => requireAdmin(() => void reveal(), { force: true })}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200 transition-colors"
      title="Exit demo mode and restore all data (admin login required)"
    >
      <EyeOff size={14} />
      Demo
    </button>
  );
}
