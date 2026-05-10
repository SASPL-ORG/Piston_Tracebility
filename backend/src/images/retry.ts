import { promises as fs } from 'fs';
import { matchToSamLog } from './matcher.js';
import { moveFileToDestination } from './mover.js';
import {
  findPendingImages,
  PendingImageRow,
  nextPictureNo,
  updateResolvedRow,
  clearPendingNoMatch,
  deleteImageRow,
} from './db.js';
import { logAlarm } from './alarms.js';

// Walks pending rows and tries to match each against SAM_Log. Resolved rows
// have their files moved and metadata filled in; expired rows have the
// pending flag cleared and an IMAGE_NO_INSPECTION_FOUND alarm raised.
//
// The job is sequential per row (next-picture-no would race otherwise) but
// returns aggregate counts so callers can log a tidy summary.
export async function runPendingRetry(): Promise<{
  resolved: number;
  expired: number;
  stillPending: number;
  errors: number;
}> {
  const pending = await findPendingImages();
  let resolved = 0;
  let expired = 0;
  let stillPending = 0;
  let errors = 0;

  for (const row of pending) {
    try {
      const result = await processPendingRow(row);
      if (result === 'resolved') resolved++;
      else if (result === 'expired') expired++;
      else stillPending++;
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.error('[images] retry failed for id', row.id, (err as Error).message);
    }
  }
  return { resolved, expired, stillPending, errors };
}

type RowOutcome = 'resolved' | 'expired' | 'still_pending';

async function processPendingRow(row: PendingImageRow): Promise<RowOutcome> {
  // Source file may have been deleted by hand; if so the pending row is
  // stale — drop it.
  try {
    await fs.access(row.file_path);
  } catch {
    await deleteImageRow(row.id);
    return 'expired';
  }

  const matchResult = await matchToSamLog({
    fullDmc: row.DMC,
    inspectionType: row.inspection_type,
    capturedAt: row.captured_at,
  });

  if (matchResult === 'PENDING') return 'still_pending';

  if (matchResult === 'NO_MATCH') {
    await logAlarm('IMAGE_NO_INSPECTION_FOUND', row.DMC, 'IMAGE', {
      id: row.id,
      filePath: row.file_path,
      capturedAt: row.captured_at.toISOString?.() ?? String(row.captured_at),
    });
    await clearPendingNoMatch(row.id);
    return 'expired';
  }

  // Resolved — move file and update row in place.
  const ringCount: number | null = matchResult;
  const pictureNo = await nextPictureNo(row.DMC, row.inspection_type, ringCount);
  const destPath = await moveFileToDestination({
    sourcePath: row.file_path,
    fullDmc: row.DMC,
    inspectionType: row.inspection_type,
    ringCount,
    okFlag: row.ok_flag === 1 ? 1 : 0,
  });
  await updateResolvedRow(row.id, ringCount, pictureNo, destPath);
  return 'resolved';
}
