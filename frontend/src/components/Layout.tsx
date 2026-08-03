import { ReactNode, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, List, Search, Image, Activity, Wrench, Database, Package, Menu, X, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import { useToolLife } from '../lib/toolLife';
import { useHideState } from '../lib/hideState';
import { useAdminAuth } from '../lib/adminAuth';
import { formatDateTime } from '../lib/api';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/lists', label: 'Lists', icon: List },
  { to: '/part-trace', label: 'Part Trace', icon: Search },
  { to: '/packing-live', label: 'Packing', icon: Package },
  { to: '/images', label: 'Images', icon: Image },
  { to: '/machine-status', label: 'Machine Status', icon: Activity },
  { to: '/maintenance', label: 'Maintenance', icon: Wrench },
  { to: '/master-data', label: 'Master Data', icon: Database },
];

export default function Layout({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { activeAlerts } = useToolLife();
  const alertCount = activeAlerts.length;
  const { hidden, hideBefore, hide, reveal } = useHideState();
  const { requireAdmin } = useAdminAuth();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed lg:static inset-y-0 left-0 z-50 w-64 bg-slate-900 text-white flex flex-col transition-transform duration-200',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Logo area */}
        <div className="flex items-center justify-center px-5 py-5 border-b border-slate-700/50">
          <div className="bg-white rounded-xl p-3">
            <img src="/logo.png" alt="Symbiotic Automation Systems" className="h-16 object-contain" />
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const showBadge = item.to === '/maintenance' && alertCount > 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-slate-700/60 text-white'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  )
                }
              >
                <item.icon size={20} />
                <span className="flex-1">{item.label}</span>
                {showBadge && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                    {alertCount > 9 ? '9+' : alertCount}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-700/50">
          <p className="text-xs text-slate-500">Piston Traceability v2.0</p>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-4 lg:px-6">
          <button
            className="lg:hidden p-2 rounded-md hover:bg-gray-100"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <h2 className="text-lg font-semibold text-slate-800">Piston Traceability</h2>

          {/* Demo-mode control — reversible, display-only hide of historical
              data. Gated behind the same admin login as Tool Life. */}
          <div className="ml-auto">
            {!hidden ? (
              <button
                onClick={() => requireAdmin(() => void hide())}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-100 transition-colors"
                title="Temporarily hide all existing data (demo mode). Nothing is deleted; reveal brings it all back."
              >
                <EyeOff size={14} />
                Hide data
              </button>
            ) : (
              <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-700 bg-amber-100 border border-amber-300 rounded-md">
                <EyeOff size={14} />
                Demo mode
              </span>
            )}
          </div>
        </header>

        {/* App-wide banner while historical data is hidden, so it's never a
            surprise that the dashboard looks empty. */}
        {hidden && (
          <div className="bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-center gap-3 lg:px-6">
            <EyeOff size={18} className="text-amber-600 shrink-0" />
            <p className="text-sm text-amber-800 flex-1">
              <span className="font-semibold">Demo mode — historical data hidden.</span>{' '}
              Showing only production from {hideBefore ? formatDateTime(hideBefore) : 'the cutoff'} onward.
              New parts still record live; nothing has been deleted.
            </p>
            <button
              onClick={() => requireAdmin(() => void reveal())}
              className="shrink-0 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors"
            >
              Reveal all data
            </button>
          </div>
        )}

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-gray-50 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
