import { FastifyInstance } from 'fastify';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { getPool } from '../db/connection.js';
import { getImageConfig } from '../images/config.js';
import { serializeDateTime } from '../db/datetime.js';
import { deleteImageRow } from '../images/db.js';
import type {
  PartImagesResponse,
  PartImagesSummaryResponse,
  ImageGroup,
  ImageItem,
  ImageGroupSummary,
  PendingImageItem,
} from '../types/index.js';

interface DmcParams {
  dmc: string;
}

interface IdParams {
  id: string;
}

function expectedFor(type: 'CIRCLIP' | 'RING'): number {
  const cfg = getImageConfig();
  return type === 'RING' ? cfg.expectedRingPictures : cfg.expectedCirclipPictures;
}

// Only DMCs present in SAM_Log are real parts. Image_Index rows referencing
// unknown DMCs (filename-parsed orphans, stale data) are excluded from the
// public read paths.
async function dmcExistsInSamLog(dmc: string): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('dmc', dmc)
    .query(`SELECT TOP 1 1 AS hit FROM dbo.SAM_Log WHERE DMC = @dmc`);
  return result.recordset.length > 0;
}

// Group rows by (inspection_type, ring_count). Order: CIRCLIP first, then
// rings by ring_count ASC. Within a group, picture_no ASC.
function buildGroups(rows: ImageRow[]): ImageGroup[] {
  const map = new Map<string, ImageGroup>();
  for (const r of rows) {
    const key = `${r.inspection_type}|${r.ring_count ?? 'null'}`;
    let group = map.get(key);
    if (!group) {
      group = {
        inspection_type: r.inspection_type,
        ring_count: r.ring_count,
        expected: expectedFor(r.inspection_type),
        indexed: 0,
        images: [],
      };
      map.set(key, group);
    }
    const item: ImageItem = {
      id: r.id,
      picture_no: r.picture_no ?? 0,
      ok_flag: r.ok_flag === 1 ? 1 : 0,
      camera_id: r.camera_id ?? '',
      captured_at: serializeDateTime(r.captured_at),
    };
    group.images.push(item);
    group.indexed++;
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.inspection_type !== b.inspection_type) {
      return a.inspection_type === 'CIRCLIP' ? -1 : 1;
    }
    return (a.ring_count ?? 0) - (b.ring_count ?? 0);
  });
}

interface ImageRow {
  id: number;
  inspection_type: 'CIRCLIP' | 'RING';
  ring_count: number | null;
  picture_no: number | null;
  ok_flag: number | null;
  camera_id: string | null;
  captured_at: Date | string | null;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

export default async function imageRoutes(app: FastifyInstance) {
  // Full grouped response with thumbnails-worth of metadata.
  app.get<{ Params: DmcParams }>('/part/:dmc/images', async (req, reply) => {
    const { dmc } = req.params;
    if (!(await dmcExistsInSamLog(dmc))) {
      reply.status(404);
      return { error: `DMC not found: ${dmc}` };
    }
    const pool = await getPool();

    const result = await pool
      .request()
      .input('dmc', dmc)
      .query(`
        SELECT id, inspection_type, ring_count, picture_no, ok_flag, camera_id, captured_at
        FROM dbo.Image_Index
        WHERE DMC = @dmc AND pending_match = 0
        ORDER BY
          CASE WHEN inspection_type = 'CIRCLIP' THEN 0 ELSE 1 END,
          ring_count ASC,
          picture_no ASC
      `);

    const groups = buildGroups(result.recordset);
    const response: PartImagesResponse = { dmc, groups };
    return response;
  });

  // Lightweight version — just counts per group.
  app.get<{ Params: DmcParams }>('/part/:dmc/images/summary', async (req, reply) => {
    const { dmc } = req.params;
    if (!(await dmcExistsInSamLog(dmc))) {
      reply.status(404);
      return { error: `DMC not found: ${dmc}` };
    }
    const pool = await getPool();

    const result = await pool
      .request()
      .input('dmc', dmc)
      .query(`
        SELECT inspection_type, ring_count, COUNT(*) AS indexed
        FROM dbo.Image_Index
        WHERE DMC = @dmc AND pending_match = 0
        GROUP BY inspection_type, ring_count
        ORDER BY
          CASE WHEN inspection_type = 'CIRCLIP' THEN 0 ELSE 1 END,
          ring_count ASC
      `);

    const groups: ImageGroupSummary[] = result.recordset.map(
      (r: { inspection_type: 'CIRCLIP' | 'RING'; ring_count: number | null; indexed: number }) => ({
        inspection_type: r.inspection_type,
        ring_count: r.ring_count,
        expected: expectedFor(r.inspection_type),
        indexed: r.indexed,
      }),
    );
    const response: PartImagesSummaryResponse = { dmc, groups };
    return response;
  });

  // Streams the file. 404s + drops the orphan row if the file is gone.
  app.get<{ Params: IdParams }>('/image/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      reply.status(400);
      return { error: 'Invalid image id' };
    }

    const pool = await getPool();
    // Only serve the file if its DMC is a real part in SAM_Log.
    const result = await pool
      .request()
      .input('id', id)
      .query(`
        SELECT i.file_path
        FROM dbo.Image_Index i
        WHERE i.id = @id
          AND i.pending_match = 0
          AND EXISTS (SELECT 1 FROM dbo.SAM_Log s WHERE s.DMC = i.DMC)
      `);

    if (result.recordset.length === 0) {
      reply.status(404);
      return { error: `Image ${id} not found` };
    }

    const filePath: string = result.recordset[0].file_path;
    let size: number;
    try {
      const stat = await fs.stat(filePath);
      size = stat.size;
    } catch {
      // Orphan row — file gone from disk. Drop the row and 404.
      await deleteImageRow(id).catch(() => undefined);
      reply.status(404);
      return { error: `Image ${id} file missing on disk` };
    }

    reply.header('Content-Type', contentTypeFor(filePath));
    reply.header('Content-Length', size);
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(createReadStream(filePath));
  });

  // Diagnostic: pending rows. Useful when SAM_Log isn't being written.
  app.get('/admin/images/pending', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id, DMC, inspection_type, captured_at, source_counter,
             camera_id, ok_flag, session_folder, file_path
      FROM dbo.Image_Index
      WHERE pending_match = 1
      ORDER BY captured_at ASC
    `);

    const items: PendingImageItem[] = result.recordset.map(
      (r: {
        id: number;
        DMC: string;
        inspection_type: 'CIRCLIP' | 'RING';
        captured_at: Date | string | null;
        source_counter: number | null;
        camera_id: string | null;
        ok_flag: number | null;
        session_folder: string | null;
        file_path: string;
      }) => ({
        id: r.id,
        DMC: r.DMC,
        inspection_type: r.inspection_type,
        captured_at: serializeDateTime(r.captured_at),
        source_counter: r.source_counter,
        camera_id: r.camera_id,
        ok_flag: r.ok_flag,
        session_folder: r.session_folder,
        file_path: r.file_path,
      }),
    );
    return { count: items.length, items };
  });
}
