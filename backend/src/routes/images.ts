import { FastifyInstance } from 'fastify';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getPool } from '../db/connection.js';
import { getImageConfig } from '../images/config.js';
import { serializeDateTime } from '../db/datetime.js';
import { deleteImageRow } from '../images/db.js';
import { stripDmcSeparators, DMC_SEPARATOR_CHARS } from '../db/state.js';
import { getHideBeforeCached } from '../utils/hideState.js';
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

// Only DMCs present in SAM_Log are real parts. Returns the CANONICAL
// stored DMC (with separators exactly as SAM_Log has them) so the
// caller can use that form when querying Image_Index — avoids a
// mismatch when the operator navigates in with a separator-dropped
// variant (e.g. "...0411DB67" instead of the stored "...0411-DB67"),
// which happens whenever a URL loses the hyphen.
async function resolveCanonicalDmc(dmc: string): Promise<string | null> {
  const pool = await getPool();
  // "Demo hide" cutoff — while active, a part dated before the cutoff is not a
  // resolvable part here either, so the Images page hides it just like Part
  // Trace / Lists (keeps demo mode consistent). Validated 'YYYY-MM-DD HH:mm:ss'
  // so the literal is safe.
  const hideBefore = getHideBeforeCached();
  const hide = hideBefore ? ` AND Date_Time >= '${hideBefore}'` : '';

  // 1. Exact match first — the common case.
  const exact = await pool
    .request()
    .input('dmc', dmc)
    .query(`SELECT TOP 1 DMC FROM dbo.SAM_Log WITH (NOLOCK) WHERE DMC = @dmc${hide}`);
  if (exact.recordset.length > 0) return exact.recordset[0].DMC ?? dmc;

  // 2. Separator-insensitive fallback — strip separators from both sides
  //    and compare the residue. Same character set the packing scanner
  //    uses in fetchByScan. Guards the case where the caller passed a
  //    DMC missing an internal '-' (Part Trace fuzzy-matched but its
  //    "View Images" link inherited the malformed URL).
  const norm = stripDmcSeparators(dmc);
  if (!norm) return null;
  const reduced = await pool
    .request()
    .input('norm', norm)
    .input('seps', DMC_SEPARATOR_CHARS)
    .query(`
      SELECT TOP 1 DMC FROM dbo.SAM_Log WITH (NOLOCK)
      WHERE REPLACE(TRANSLATE(DMC, @seps, REPLICATE(CHAR(1), LEN(@seps))), CHAR(1), '') = @norm${hide}
    `);
  return reduced.recordset.length > 0 ? reduced.recordset[0].DMC ?? null : null;
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
      // BIT columns come back from mssql as booleans, not 0/1 — so
      // `r.ok_flag === 1` was always false and every image showed as OK.
      ok_flag: r.ok_flag ? 1 : 0,
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
  // Optional ?date=YYYY-MM-DD restricts the result to images captured on
  // that specific calendar day (interpreted in the SQL server's local
  // timezone — same convention as captured_at). Used by the Master Data
  // page so each day's inspection of a recurring master piece is shown
  // on its own page.
  app.get<{
    Params: DmcParams;
    Querystring: { date?: string; inspection_type?: string };
  }>(
    '/part/:dmc/images',
    async (req, reply) => {
      const { dmc } = req.params;
      const dateParam = req.query.date;
      const inspTypeParam = req.query.inspection_type;
      const dateFilterActive = !!dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam);

      const canonicalDmc = await resolveCanonicalDmc(dmc);
      if (!canonicalDmc) {
        // Brief asks: log the lookup on every request so future debugging
        // takes 30 seconds via `docker logs`, not an hour. Even on 404.
        req.log.info(
          `[images] lookup dmc='${dmc}' inspection_type='${inspTypeParam ?? ''}' ` +
            `date='${dateParam ?? ''}' → 404 (not in SAM_Log)`,
        );
        reply.status(404);
        return { error: `DMC not found: ${dmc}` };
      }
      const pool = await getPool();
      const request = pool.request().input('dmc', canonicalDmc);
      if (dateFilterActive) request.input('date', dateParam);

      const result = await request.query(`
        SELECT id, inspection_type, ring_count, picture_no, ok_flag, camera_id, captured_at
        FROM dbo.Image_Index WITH (NOLOCK)
        WHERE DMC = @dmc AND pending_match = 0
          ${dateFilterActive ? 'AND CAST(captured_at AS DATE) = @date' : ''}
        ORDER BY
          CASE WHEN inspection_type = 'CIRCLIP' THEN 0 ELSE 1 END,
          ring_count ASC,
          picture_no ASC
      `);

      const groups = buildGroups(result.recordset);
      req.log.info(
        `[images] lookup dmc='${dmc}' canonical='${canonicalDmc}' inspection_type='${inspTypeParam ?? ''}' ` +
          `date='${dateParam ?? ''}' → ${result.recordset.length} rows, ${groups.length} groups`,
      );
      const response: PartImagesResponse = { dmc: canonicalDmc, groups };
      return response;
    },
  );

  // Lightweight version — just counts per group.
  app.get<{ Params: DmcParams }>('/part/:dmc/images/summary', async (req, reply) => {
    const { dmc } = req.params;
    const canonicalDmc = await resolveCanonicalDmc(dmc);
    if (!canonicalDmc) {
      req.log.info(`[images] summary dmc='${dmc}' → 404 (not in SAM_Log)`);
      reply.status(404);
      return { error: `DMC not found: ${dmc}` };
    }
    const pool = await getPool();

    const result = await pool
      .request()
      .input('dmc', canonicalDmc)
      .query(`
        SELECT inspection_type, ring_count, COUNT(*) AS indexed
        FROM dbo.Image_Index WITH (NOLOCK)
        WHERE DMC = @dmc AND pending_match = 0
        GROUP BY inspection_type, ring_count
        ORDER BY
          CASE WHEN inspection_type = 'CIRCLIP' THEN 0 ELSE 1 END,
          ring_count ASC
      `);
    req.log.info(
      `[images] summary dmc='${dmc}' → ${result.recordset.length} groups`,
    );

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
    // Only serve the file if its DMC is a real part in SAM_Log. Master images
    // (calibration/reference) are always servable; part images additionally
    // respect the "demo hide" cutoff so hidden parts' bytes aren't served.
    const hideBefore = getHideBeforeCached();
    const hide = hideBefore ? ` AND s.Date_Time >= '${hideBefore}'` : '';
    const result = await pool
      .request()
      .input('id', id)
      .query(`
        SELECT i.file_path
        FROM dbo.Image_Index i WITH (NOLOCK)
        WHERE i.id = @id
          AND i.pending_match = 0
          AND (
            i.is_master = 1
            OR EXISTS (SELECT 1 FROM dbo.SAM_Log s WITH (NOLOCK) WHERE s.DMC = i.DMC${hide})
          )
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
    // Image bytes never change once indexed — file is uniquely keyed by its
    // Image_Index id, which is monotonic and never reused. Long, immutable
    // cache keeps the second view of any part instant.
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('ETag', `"img-${id}"`);
    return reply.send(createReadStream(filePath));
  });

  // Thumbnail variant of /image/:id. Grid views (Image Viewer, Part Trace
  // attempts) request this; lightbox view falls back to the full-res route.
  // First request generates the thumb lazily and caches it under
  // <outputPath>/__thumbs/<id>.jpg; subsequent requests stream the cached
  // file directly. ~20 KB per thumb vs ~1-3 MB per source image.
  app.get<{ Params: IdParams }>('/image/:id/thumb', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      reply.status(400);
      return { error: 'Invalid image id' };
    }

    const cfg = getImageConfig();
    const thumbDir = path.join(cfg.outputPath, '__thumbs');
    const thumbPath = path.join(thumbDir, `${id}.jpg`);

    // Fast path: thumb already cached.
    try {
      const stat = await fs.stat(thumbPath);
      reply.header('Content-Type', 'image/jpeg');
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      reply.header('ETag', `"thumb-${id}"`);
      return reply.send(createReadStream(thumbPath));
    } catch {
      // Not cached yet — fall through to generate.
    }

    // Look up source file via the same SAM_Log existence check used by /image.
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', id)
      .query(`
        SELECT i.file_path
        FROM dbo.Image_Index i WITH (NOLOCK)
        WHERE i.id = @id
          AND i.pending_match = 0
          AND (
            i.is_master = 1
            OR EXISTS (SELECT 1 FROM dbo.SAM_Log s WITH (NOLOCK) WHERE s.DMC = i.DMC)
          )
      `);
    if (result.recordset.length === 0) {
      reply.status(404);
      return { error: `Image ${id} not found` };
    }
    const sourcePath: string = result.recordset[0].file_path;

    // Generate the thumb. 320x320 "inside" fit means no upscaling and the
    // longer edge maxes at 320 — plenty for tile grids; quality=75 strikes
    // the standard size/perceived-quality balance.
    let buffer: Buffer;
    try {
      buffer = await sharp(sourcePath)
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('ENOENT') || msg.includes('Input file is missing')) {
        // Orphan row — source file gone. Mirror the main route's behavior.
        await deleteImageRow(id).catch(() => undefined);
        reply.status(404);
        return { error: `Image ${id} file missing on disk` };
      }
      // Unexpected sharp error — fall back to streaming the source so the
      // user still sees something, but log it for diagnosis.
      req.log.error({ err, id, sourcePath }, '[images] thumb generation failed');
      reply.header('Content-Type', contentTypeFor(sourcePath));
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(createReadStream(sourcePath));
    }

    // Cache to disk. Failure to cache isn't fatal — we already have the
    // thumb in memory and can serve this request; next request will retry.
    try {
      await fs.mkdir(thumbDir, { recursive: true });
      await fs.writeFile(thumbPath, buffer);
    } catch (err) {
      req.log.warn({ err, thumbPath }, '[images] thumb cache write failed');
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', buffer.length);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('ETag', `"thumb-${id}"`);
    return reply.send(buffer);
  });

  // Diagnostic: live snapshot of the in-process worker pool. Reveals
  // whether files are sitting in `pending` (workers stuck), `inFlightPaths`
  // (workers crashed mid-process), or all workers are `parked` (idle).
  app.get('/admin/images/processor-state', async () => {
    const { getProcessorState } = await import('../images/watcher.js');
    return getProcessorState();
  });

  // Diagnostic: pending rows. Useful when SAM_Log isn't being written.
  app.get('/admin/images/pending', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id, DMC, inspection_type, captured_at, source_counter,
             camera_id, ok_flag, session_folder, file_path
      FROM dbo.Image_Index WITH (NOLOCK)
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
        ok_flag: boolean | number | null;
        session_folder: string | null;
        file_path: string;
      }) => ({
        id: r.id,
        DMC: r.DMC,
        inspection_type: r.inspection_type,
        captured_at: serializeDateTime(r.captured_at),
        source_counter: r.source_counter,
        camera_id: r.camera_id,
        // Normalize the BIT column to 0/1 (mssql returns boolean).
        ok_flag: r.ok_flag == null ? null : r.ok_flag ? 1 : 0,
        session_folder: r.session_folder,
        file_path: r.file_path,
      }),
    );
    return { count: items.length, items };
  });
}
