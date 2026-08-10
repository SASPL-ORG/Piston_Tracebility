import cron, { ScheduledTask } from 'node-cron';
import { startImageWatcher, stopImageWatcher } from './watcher.js';
import { runPendingRetry } from './retry.js';
import { runRetention } from './retention.js';

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

let retryJob: ScheduledTask | null = null;
let retentionJob: ScheduledTask | null = null;
let retryRunning = false;
let retentionRunning = false;

export async function startImageSubsystem(log: Logger): Promise<void> {
  // The image processor owns its own scan loop, worker pool, and watchdog —
  // see backend/src/images/watcher.ts for the architecture rationale.
  await startImageWatcher((m) => log.info(m));

  // Pending-queue retry: every 10 seconds (6-field cron). Re-entrancy
  // guarded. Resolves rows that were inserted as PENDING because the
  // SAM_Log row hadn't appeared yet — at 10-sec cadence a circlip image
  // whose PLC row arrives within ~60 sec is resolved well before the
  // operator notices.
  retryJob = cron.schedule('*/10 * * * * *', async () => {
    if (retryRunning) return;
    retryRunning = true;
    try {
      const r = await runPendingRetry();
      if (r.resolved > 0 || r.expired > 0 || r.errors > 0) {
        log.info(
          `[images] retry: resolved=${r.resolved} expired=${r.expired} ` +
            `stillPending=${r.stillPending} errors=${r.errors}`,
        );
      }
    } catch (err) {
      log.error(`[images] retry job failed: ${(err as Error).message}`);
    } finally {
      retryRunning = false;
    }
  });

  // Retention sweep: daily at 02:00 server time.
  retentionJob = cron.schedule('0 2 * * *', async () => {
    if (retentionRunning) return;
    retentionRunning = true;
    try {
      const r = await runRetention();
      log.info(`[images] retention: deleted=${r.deleted} fileErrors=${r.fileErrors}`);
    } catch (err) {
      log.error(`[images] retention job failed: ${(err as Error).message}`);
    } finally {
      retentionRunning = false;
    }
  });

  log.info('[images] subsystem started (retry: every 1m, retention: daily 02:00)');
}

export async function stopImageSubsystem(): Promise<void> {
  if (retryJob) {
    retryJob.stop();
    retryJob = null;
  }
  if (retentionJob) {
    retentionJob.stop();
    retentionJob = null;
  }
  await stopImageWatcher();
}
