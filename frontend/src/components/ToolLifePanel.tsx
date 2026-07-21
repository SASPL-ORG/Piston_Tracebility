import { useState } from 'react';
import { X, RotateCcw, AlertOctagon, CheckCircle, Hourglass, Lock, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { useToolLife, ToolLifeRow } from '../lib/toolLife';
import { useAdminAuth } from '../lib/adminAuth';

interface ToolLifePanelProps {
  onClose?: () => void;
}

function StatusPill({ row }: { row: ToolLifeRow }) {
  if (row.life === null) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-500">
        <Hourglass size={12} />
        NOT SET
      </span>
    );
  }
  if (row.completed) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700">
        <AlertOctagon size={12} />
        COMPLETED
      </span>
    );
  }
  const pct = row.life > 0 ? (row.produced / row.life) * 100 : 0;
  if (pct >= 80) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700">
        <AlertOctagon size={12} />
        NEAR EOL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
      <CheckCircle size={12} />
      OK
    </span>
  );
}

function LifeInput({
  row,
  onSet,
}: {
  row: ToolLifeRow;
  onSet: (life: number | null) => void;
}) {
  const [draft, setDraft] = useState<string>(row.life !== null ? String(row.life) : '');
  const { isAdmin, requireAdmin } = useAdminAuth();

  const commit = () => {
    const trimmed = draft.trim();
    const apply = () => {
      if (trimmed === '') {
        if (row.life !== null) onSet(null);
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        setDraft(row.life !== null ? String(row.life) : '');
        return;
      }
      onSet(Math.floor(n));
    };

    // If the operator left the value unchanged, don't pop the modal —
    // tab-out / click-away shouldn't ask for a password.
    const currentRowValue = row.life !== null ? String(row.life) : '';
    if (trimmed === currentRowValue) return;

    if (isAdmin) {
      apply();
    } else {
      requireAdmin(apply);
      // Revert the visible draft until login succeeds — apply() will
      // reset it via the row.life propagation if the action goes through.
      setDraft(row.life !== null ? String(row.life) : '');
    }
  };

  return (
    <input
      type="number"
      min={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="—"
      className="w-24 px-2 py-1 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-right"
    />
  );
}

export default function ToolLifePanel({ onClose }: ToolLifePanelProps) {
  const { rows, setLife, resetTool } = useToolLife();
  const { isAdmin, requireAdmin } = useAdminAuth();
  const setCount = rows.filter((r) => r.life !== null).length;
  const alertCount = rows.filter((r) => r.completed).length;

  const guardedReset = (name: string) => {
    if (isAdmin) resetTool(name);
    else requireAdmin(() => resetTool(name));
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="w-1 h-6 bg-blue-600 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-800">Tool Life</h2>
          <span className="text-xs text-gray-500">
            {setCount} configured · {alertCount} completed
          </span>
          {isAdmin ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700">
              <ShieldCheck size={11} /> Admin unlocked
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500">
              <Lock size={11} /> Admin required to edit
            </span>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md"
            aria-label="Close Tool Life panel"
          >
            <X size={18} />
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500">
        Enter <span className="font-medium">Life in Quantity</span> for any spare you want to track. The system
        counts new parts produced from the moment you set the value and reports
        <span className="font-medium"> Quantity Left</span>. When it reaches zero, an alarm is raised.
      </p>

      <div className="overflow-hidden rounded-lg border border-gray-200">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Spare</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Life in Quantity</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Produced</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Quantity Left</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Reset</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr
                  key={row.name}
                  className={clsx(
                    'transition-colors',
                    row.completed ? 'bg-red-50/40' : 'hover:bg-gray-50/50',
                  )}
                >
                  <td className="px-4 py-3 font-medium text-gray-800">{row.name}</td>
                  <td className="px-4 py-3 text-right">
                    <LifeInput row={row} onSet={(v) => setLife(row.name, v)} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600 tabular-nums">
                    {row.life !== null ? row.produced.toLocaleString() : '—'}
                  </td>
                  <td
                    className={clsx(
                      'px-4 py-3 text-right tabular-nums font-semibold',
                      row.completed ? 'text-red-700' : 'text-gray-800',
                    )}
                  >
                    {row.left !== null ? row.left.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3"><StatusPill row={row} /></td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => guardedReset(row.name)}
                      disabled={row.life === null}
                      title={isAdmin ? 'Clear Life in Quantity' : 'Admin login required to reset'}
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
