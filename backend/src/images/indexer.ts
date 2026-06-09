import { parseImagePath, ParsedImage } from './parser.js';
import { matchToSamLog } from './matcher.js';
import { moveFileToDestination } from './mover.js';
import { logAlarm } from './alarms.js';
import {
  findExistingByCounter,
  insertImageRow,
  nextPictureNo,
} from './db.js';

// Single source-file entry point. Idempotent: re-running on the same source
// file (e.g., after a restart that re-walks the incoming folder) is a no-op
// once the row exists.
export async function indexImage(filePath: string): Promise<void> {
  const parsed = await parseImagePath(filePath);
  if (!parsed) {
    await logAlarm('IMAGE_PARSE_FAIL', null, 'IMAGE', { filePath });
    return;
  }

  // Dedup: have we seen this CV-X frame before? (counter, camera, DMC)
  // tuple — counter alone collides across CV-X counter resets.
  const existing = await findExistingByCounter(
    parsed.sourceCounter,
    parsed.cameraId,
    parsed.fullDmc,
  );
  if (existing) {
    // The retry job handles pending → resolved transitions. Just leave it.
    return;
  }

  const matchResult = await matchToSamLog({
    fullDmc: parsed.fullDmc,
    inspectionType: parsed.inspectionType,
    capturedAt: parsed.capturedAt,
  });

  if (matchResult === 'PENDING') {
    // Record the file as pending. File stays in source; retry job moves it
    // when the SAM_Log row appears.
    await insertImageRow({
      dmc: parsed.fullDmc,
      inspectionType: parsed.inspectionType,
      ringCount: null,
      pictureNo: null,
      filePath: parsed.filePath,
      capturedAt: parsed.capturedAt,
      okFlag: parsed.okFlag,
      cameraId: parsed.cameraId,
      sourceCounter: parsed.sourceCounter,
      sessionFolder: parsed.sessionFolder,
      pending: true,
    });
    return;
  }

  if (matchResult === 'NO_MATCH') {
    await logAlarm('IMAGE_NO_INSPECTION_FOUND', parsed.fullDmc, 'IMAGE', {
      filePath: parsed.filePath,
      capturedAt: parsed.capturedAt.toISOString(),
      sourceCounter: parsed.sourceCounter,
    });
    // No row inserted — file remains in source for manual review.
    return;
  }

  // Resolved. Move the file and record the destination path.
  const ringCount: number | null = matchResult; // number for ring, null for circlip
  await indexResolved(parsed, ringCount);
}

// Used by both first-touch resolution and the pending-queue retry path.
export async function indexResolved(
  parsed: Pick<
    ParsedImage,
    | 'fullDmc'
    | 'inspectionType'
    | 'okFlag'
    | 'capturedAt'
    | 'cameraId'
    | 'sourceCounter'
    | 'sessionFolder'
    | 'filePath'
  >,
  ringCount: number | null,
): Promise<{ pictureNo: number; destPath: string }> {
  const pictureNo = await nextPictureNo(parsed.fullDmc, parsed.inspectionType, ringCount);
  const destPath = await moveFileToDestination({
    sourcePath: parsed.filePath,
    fullDmc: parsed.fullDmc,
    inspectionType: parsed.inspectionType,
    ringCount,
    okFlag: parsed.okFlag,
  });

  await insertImageRow({
    dmc: parsed.fullDmc,
    inspectionType: parsed.inspectionType,
    ringCount,
    pictureNo,
    filePath: destPath,
    capturedAt: parsed.capturedAt,
    okFlag: parsed.okFlag,
    cameraId: parsed.cameraId,
    sourceCounter: parsed.sourceCounter,
    sessionFolder: parsed.sessionFolder,
    pending: false,
  });
  return { pictureNo, destPath };
}
