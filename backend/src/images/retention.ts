import { promises as fs } from 'fs';
import { getImageConfig } from './config.js';
import { findExpiredImages, deleteImageRow } from './db.js';
import { logAlarm } from './alarms.js';

// Deletes rows + files older than IMAGE_RETENTION_DAYS. File-missing-on-disk
// is non-fatal — drop the orphan row regardless. Logs a single summary alarm.
export async function runRetention(): Promise<{
  deleted: number;
  fileErrors: number;
}> {
  const cfg = getImageConfig();
  const expired = await findExpiredImages(cfg.retentionDays);

  let deleted = 0;
  let fileErrors = 0;

  for (const row of expired) {
    try {
      await fs.unlink(row.file_path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') fileErrors++;
    }
    try {
      await deleteImageRow(row.id);
      deleted++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[images] retention row delete failed for id', row.id, (err as Error).message);
    }
  }

  await logAlarm('IMAGE_RETENTION_RUN', null, 'IMAGE', {
    retentionDays: cfg.retentionDays,
    deleted,
    fileErrors,
  });
  return { deleted, fileErrors };
}
