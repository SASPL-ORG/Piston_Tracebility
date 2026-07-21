import { parseImagePath, ParsedImage } from './parser.js';
import { matchToSamLog } from './matcher.js';
import { moveFileToDestination, moveMasterFileToDestination } from './mover.js';
import { logAlarm } from './alarms.js';
import {
  findExistingByCounter,
  findMasterByDmc,
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

  // Dedup: have we seen this CV-X frame before? Keyed on
  // (session_folder, counter, camera, DMC) — counter resets per session
  // burst, so a multi-attempt part has the same (counter, camera, DMC)
  // in two different sessions. session_folder breaks the tie.
  const existing = await findExistingByCounter(
    parsed.sourceCounter,
    parsed.cameraId,
    parsed.fullDmc,
    parsed.sessionFolder,
  );
  if (existing) {
    // The retry job handles pending → resolved transitions. Just leave it.
    return;
  }

  // Master-piece bypass — masters never pass through the loading station,
  // so they're never in SAM_Log; the ±15-min matchToSamLog window would
  // always fail and quarantine the file. Look up dbo.Master_Data FIRST;
  // if this DMC is on the master catalog, route to indexMaster and skip
  // matchToSamLog entirely.
  const master = await findMasterByDmc(parsed.fullDmc);
  if (master) {
    if (master.inspection_type !== parsed.inspectionType) {
      // Camera/master mismatch is a soft warning (logAlarm) — we still
      // accept the file because the camera mapping is the authoritative
      // signal for inspection_type. Operator may have run a snap-ring
      // master through the ring camera by mistake; we'd rather index
      // it than throw it on the floor.
      await logAlarm('MASTER_CAMERA_MISMATCH', parsed.fullDmc, 'IMAGE', {
        expected: master.inspection_type,
        got: parsed.inspectionType,
        filePath: parsed.filePath,
      });
    }
    await indexMaster(parsed);
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

// Master-piece flow: move into the MASTER/<inspection>/<session>/<OK|NG>/
// subtree under <output>/<DMC>, then insert a row with is_master=1 and
// pending_match=0. ring_count stays NULL (masters don't have ring attempts);
// picture_no is set to the source counter so per-session ordering on the
// page is stable across re-indexes.
export async function indexMaster(
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
): Promise<{ destPath: string }> {
  const destPath = await moveMasterFileToDestination({
    sourcePath: parsed.filePath,
    fullDmc: parsed.fullDmc,
    inspectionType: parsed.inspectionType,
    sessionFolder: parsed.sessionFolder,
    okFlag: parsed.okFlag,
  });

  await insertImageRow({
    dmc: parsed.fullDmc,
    inspectionType: parsed.inspectionType,
    ringCount: null,
    pictureNo: parsed.sourceCounter,
    filePath: destPath,
    capturedAt: parsed.capturedAt,
    okFlag: parsed.okFlag,
    cameraId: parsed.cameraId,
    sourceCounter: parsed.sourceCounter,
    sessionFolder: parsed.sessionFolder,
    pending: false,
    isMaster: true,
  });

  // Visible in `docker logs traceability-backend` alongside the existing
  // [images] scan/processor lines so the operator can confirm masters
  // are landing through this branch and not getting quarantined.
  // eslint-disable-next-line no-console
  console.log(
    `[images] indexed master capture dmc='${parsed.fullDmc}' type=${parsed.inspectionType} ` +
      `session=${parsed.sessionFolder} ok=${parsed.okFlag === 0 ? 'OK' : 'NG'}`,
  );

  return { destPath };
}
