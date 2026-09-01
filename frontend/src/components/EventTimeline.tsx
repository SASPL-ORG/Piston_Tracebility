import clsx from 'clsx';
import { CheckCircle, XCircle, AlertTriangle, Circle, PackageCheck } from 'lucide-react';
import { EventTimelineStep, formatDateTime } from '../lib/api';

// Visual treatment for each event type — checkpoints get a colored
// filled node + timestamp + status badge; intermediate stations get a
// small hollow gray node and just a label; conditional events (rejection
// conveyors) get an amber filled node + "DEVIATION" label.

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  OK:        { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'OK' },
  FAIL:      { bg: 'bg-red-100',     text: 'text-red-800',     label: 'FAIL' },
  COMPLETED: { bg: 'bg-blue-100',    text: 'text-blue-800',    label: 'COMPLETED' },
};

function CheckpointNode({ step }: { step: EventTimelineStep }) {
  const isFail = step.status === 'FAIL';
  const isCompleted = step.status === 'COMPLETED';
  const isOk = step.status === 'OK';
  const ringColor = isFail
    ? 'bg-red-500'
    : isCompleted
      ? 'bg-blue-500'
      : isOk
        ? 'bg-emerald-500'
        : 'bg-gray-400';
  const Icon = isFail ? XCircle : isCompleted ? PackageCheck : CheckCircle;
  return (
    <div className={clsx('relative z-10 w-9 h-9 rounded-full flex items-center justify-center shrink-0 shadow-sm', ringColor)}>
      <Icon size={18} className="text-white" />
    </div>
  );
}

function IntermediateNode() {
  return (
    <div className="relative z-10 w-9 h-9 flex items-center justify-center shrink-0">
      <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 bg-white" />
    </div>
  );
}

function ConditionalNode() {
  return (
    <div className="relative z-10 w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-amber-500 shadow-sm">
      <AlertTriangle size={16} className="text-white" />
    </div>
  );
}

function CheckpointBody({ step }: { step: EventTimelineStep }) {
  const status = step.status ?? 'OK';
  const styles = STATUS_STYLES[status] ?? STATUS_STYLES.OK;
  return (
    <div className="flex-1 -mt-0.5 pb-1">
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <span className="text-sm font-semibold text-gray-800">{step.label}</span>
        <span
          className={clsx(
            'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide',
            styles.bg,
            styles.text,
          )}
        >
          {styles.label}
        </span>
        {step.attempts != null && step.attempts > 1 && (
          <span className="text-xs text-gray-500">After {step.attempts} attempts</span>
        )}
      </div>
      {step.timestamp && (
        <p className="text-xs text-gray-500">{formatDateTime(step.timestamp)}</p>
      )}
      {step.reason && (
        <p className="text-xs text-red-700 mt-1">
          <span className="font-medium">Reason:</span> {step.reason}
        </p>
      )}
    </div>
  );
}

function IntermediateBody({ step }: { step: EventTimelineStep }) {
  return (
    <div className="flex-1 -mt-0.5 pb-1">
      <p className="text-sm text-gray-500">{step.label}</p>
      {step.substations && step.substations.length > 0 && (
        <ul className="mt-1.5 space-y-1 pl-3 border-l border-gray-200 ml-1">
          {step.substations.map((sub) => {
            const done = sub.status === 'OK';
            const failed = sub.status === 'FAIL';
            return (
              <li key={sub.label} className="flex items-center gap-2 text-xs">
                {done ? (
                  <CheckCircle size={11} className="text-emerald-500 shrink-0" />
                ) : failed ? (
                  <XCircle size={11} className="text-red-500 shrink-0" />
                ) : (
                  <Circle size={6} className="text-gray-300 fill-gray-300 shrink-0 mx-[2.5px]" />
                )}
                <span className={clsx(done ? 'text-gray-700' : failed ? 'text-red-700 font-medium' : 'text-gray-500')}>
                  {sub.label}
                </span>
                {sub.timestamp && (
                  <span className="text-gray-400 tabular-nums">· {formatDateTime(sub.timestamp)}</span>
                )}
                {failed && sub.reason && <span className="text-red-500">· {sub.reason}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ConditionalBody({ step }: { step: EventTimelineStep }) {
  return (
    <div className="flex-1 -mt-0.5 pb-1">
      <div className="flex flex-wrap items-center gap-3 mb-0.5">
        <span className="text-sm font-medium text-gray-700">{step.label}</span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800">
          Deviation
        </span>
      </div>
      <p className="text-xs text-gray-500">Part diverted off the happy path.</p>
    </div>
  );
}

interface EventTimelineProps {
  steps: EventTimelineStep[];
}

export default function EventTimeline({ steps }: EventTimelineProps) {
  if (steps.length === 0) {
    return (
      <p className="text-sm text-gray-500 py-2">No events recorded for this part.</p>
    );
  }

  return (
    <div className="relative">
      {/* Continuous vertical spine — aligned with the centre of the node icons. */}
      <div className="absolute left-[18px] top-2 bottom-2 w-0.5 bg-gray-200" />
      <ol className="space-y-3">
        {steps.map((step) => {
          const isCheckpoint = step.type === 'checkpoint';
          return (
            <li
              key={step.step}
              className={clsx(
                'relative flex gap-3 items-start',
                isCheckpoint ? 'pt-1' : 'pt-0',
              )}
            >
              {step.type === 'checkpoint' && <CheckpointNode step={step} />}
              {step.type === 'intermediate' && <IntermediateNode />}
              {step.type === 'conditional' && <ConditionalNode />}
              {step.type === 'checkpoint' && <CheckpointBody step={step} />}
              {step.type === 'intermediate' && <IntermediateBody step={step} />}
              {step.type === 'conditional' && <ConditionalBody step={step} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
