import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import clsx from 'clsx';
import { useToolLife } from '../lib/toolLife';

interface NotificationBellProps {
  /** Optional: invoked when the operator clicks "Open Tool Life" inside the
   *  popover. The Maintenance page wires it to open the Tool Life panel. */
  onOpenToolLife?: () => void;
}

// Bell icon shown next to "Refresh Status" on the Maintenance page. The red
// numeric badge mirrors the count of triggered (Life-completed) tools that
// the operator hasn't acknowledged yet. Click → popover lists each completed
// tool by name with a message like "Snap Ring Pusher Shaft tool life completed".
export default function NotificationBell({ onOpenToolLife }: NotificationBellProps) {
  const { activeAlerts, acknowledgeAll } = useToolLife();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click. We can't use onBlur because the popover has
  // its own clickable elements; we need to ignore clicks that land inside
  // the popover itself.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const count = activeAlerts.length;
  const hasAlerts = count > 0;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'relative inline-flex items-center justify-center w-10 h-10 rounded-lg border transition-colors',
          hasAlerts
            ? 'bg-red-50 border-red-200 text-red-600 hover:bg-red-100'
            : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50',
        )}
        aria-label={hasAlerts ? `${count} tool-life alarms` : 'No alarms'}
        title={hasAlerts ? `${count} tool-life alarm${count === 1 ? '' : 's'}` : 'No alarms'}
      >
        {hasAlerts ? <BellRing size={18} /> : <Bell size={18} />}
        {hasAlerts && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-30 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-gray-500" />
              <span className="text-sm font-semibold text-gray-800">Notifications</span>
            </div>
            {hasAlerts && (
              <button
                onClick={() => {
                  acknowledgeAll();
                  setOpen(false);
                }}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          {hasAlerts ? (
            <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100">
              {activeAlerts.map((alert) => (
                <li key={alert.name} className="px-4 py-3 flex items-start gap-3">
                  <span className="mt-1 w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800">
                      <span className="font-semibold">{alert.name}</span> tool life completed
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Produced {alert.produced.toLocaleString()} / {alert.life?.toLocaleString()}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              No alarms
            </div>
          )}

          {onOpenToolLife && (
            <button
              onClick={() => {
                setOpen(false);
                onOpenToolLife();
              }}
              className="w-full px-4 py-2.5 text-xs font-medium text-blue-600 hover:bg-blue-50 border-t border-gray-100 text-center"
            >
              Open Tool Life
            </button>
          )}
        </div>
      )}
    </div>
  );
}
