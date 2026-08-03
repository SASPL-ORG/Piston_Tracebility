import { ReactNode, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, List, Search, Image, Activity, Wrench, Database, Package, Menu, X } from 'lucide-react';
import clsx from 'clsx';
import { useToolLife } from '../lib/toolLife';

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
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto bg-gray-50 p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
