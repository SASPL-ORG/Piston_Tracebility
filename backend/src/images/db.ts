// SQL helpers for the image subsystem. All queries are inline so the schema
// dependency is visible at the call site.
import { getPool } from '../db/connection.js';

export interface ExistingImageRow {
  id: number;
  pending_match: number;
  file_path: string;
  ring_count: number | null;
  picture_no: number | null;
}

export interface PendingImageRow {
  id: number;
  DMC: string;
  inspection_type: 'CIRCLIP' | 'RING';
  captured_at: Date;
  source_counter: number | null;
  file_path: string;
  camera_id: string | null;
  // mssql returns BIT columns as JS booleans (not 0/1). Callers must
  // coerce via `row.ok_flag ? 1 : 0` rather than strict-equality on a number.
  ok_flag: boolean | null;
  session_folder: string | null;
}

// Has this CV-X frame been indexed already? Keyed on the global counter +
// camera + DMC. The counter alone isn't enough: CV-X resets it on machine
// restart / storage clear, so a fresh counter=27 from today would collide
// with last week's counter=27 for a different part. Adding DMC makes the
// triple uniquely identify one image.
export async function findExistingByCounter(
  sourceCounter: number,
  cameraId: string,
  dmc: string,
): Promise<ExistingImageRow | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('counter', sourceCounter)
    .input('cam', cameraId)
    .input('dmc', dmc)
    .query(`
      SELECT TOP 1 id, pending_match, file_path, ring_count, picture_no
      FROM dbo.Image_Index
      WHERE source_counter = @counter AND camera_id = @cam AND DMC = @dmc
      ORDER BY id ASC
    `);
  return result.recordset[0] ?? null;
}

// Next picture number within a (DMC, inspection_type, ring_count) attempt.
// Treats ring_count=NULL (circlip) as its own bucket.
export async function nextPictureNo(
  dmc: string,
  inspectionType: 'CIRCLIP' | 'RING',
  ringCount: number | null,
): Promise<number> {
  const pool = await getPool();
  const req = pool.request().input('dmc', dmc).input('type', inspectionType);
  if (ringCount === null) {
    req.input('rc', null);
  } else {
    req.input('rc', ringCount);
  }
  const result = await req.query(`
    SELECT ISNULL(MAX(picture_no), 0) + 1 AS next_no
    FROM dbo.Image_Index
    WHERE DMC = @dmc
      AND inspection_type = @type
      AND ((ring_count = @rc) OR (ring_count IS NULL AND @rc IS NULL))
      AND pending_match = 0
  `);
  return result.recordset[0].next_no;
}

export interface InsertRowArgs {
  dmc: string;
  inspectionType: 'CIRCLIP' | 'RING';
  ringCount: number | null;
  pictureNo: number | null;
  filePath: string;
  capturedAt: Date;
  okFlag: 0 | 1;
  cameraId: string;
  sourceCounter: number;
  sessionFolder: string;
  pending: boolean;
}

export async function insertImageRow(args: InsertRowArgs): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('dmc', args.dmc)
    .input('type', args.inspectionType)
    .input('rc', args.ringCount)
    .input('pno', args.pictureNo)
    .input('path', args.filePath)
    .input('cap', args.capturedAt)
    .input('ok', args.okFlag)
    .input('cam', args.cameraId)
    .input('counter', args.sourceCounter)
    .input('session', args.sessionFolder)
    .input('pending', args.pending ? 1 : 0)
    .query(`
      INSERT INTO dbo.Image_Index (
        DMC, inspection_type, ring_count, picture_no, file_path,
        captured_at, ok_flag, camera_id, source_counter, session_folder,
        pending_match, indexed_at
      )
      OUTPUT INSERTED.id
      VALUES (
        @dmc, @type, @rc, @pno, @path,
        @cap, @ok, @cam, @counter, @session,
        @pending, SYSDATETIME()
      )
    `);
  return result.recordset[0].id;
}

export async function updateResolvedRow(
  id: number,
  ringCount: number | null,
  pictureNo: number,
  newFilePath: string,
): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('id', id)
    .input('rc', ringCount)
    .input('pno', pictureNo)
    .input('path', newFilePath)
    .query(`
      UPDATE dbo.Image_Index
      SET ring_count = @rc, picture_no = @pno, file_path = @path, pending_match = 0
      WHERE id = @id
    `);
}

export async function findPendingImages(): Promise<PendingImageRow[]> {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT id, DMC, inspection_type, captured_at, source_counter, file_path,
           camera_id, ok_flag, session_folder
    FROM dbo.Image_Index
    WHERE pending_match = 1
    ORDER BY captured_at ASC
  `);
  return result.recordset;
}

export interface RetentionRow {
  id: number;
  file_path: string;
}

export async function findExpiredImages(retentionDays: number): Promise<RetentionRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('days', retentionDays)
    .query(`
      SELECT id, file_path
      FROM dbo.Image_Index
      WHERE captured_at < DATEADD(day, -@days, SYSDATETIME())
    `);
  return result.recordset;
}

export async function deleteImageRow(id: number): Promise<void> {
  const pool = await getPool();
  await pool.request().input('id', id).query(`DELETE FROM dbo.Image_Index WHERE id = @id`);
}
