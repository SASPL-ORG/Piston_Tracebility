import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';

// The Master Data catalog: 10 reference master pieces operators run through
// CV-X to validate the inspection station. Source of truth is dbo.Master_Data
// (migration 0003_master_data_and_image_index.sql). Use the seed file
// backend/sql/seeds/master_data.sql to populate the DMCs operator-side.
//
// The frontend contract is unchanged from the previous in-code SEED_ROWS
// version — `identification`, `inspection_type`, `expected_per_attempt`
// fields still appear on the wire; backend maps from the new DB columns.

interface CatalogItem {
  id: number;
  dmc: string;
  identification: string;
}

interface InspectionAttempt {
  attempt_no: number;
  session_folder: string;
  captured_at: string;
  images: {
    id: number;
    picture_no: number;
    ok_flag: number;
    camera_id: string | null;
    captured_at: string;
  }[];
}

interface MasterInspectionResponse {
  catalog: CatalogItem;
  inspection_type: 'CIRCLIP' | 'RING';
  expected_per_attempt: number;
  attempts: InspectionAttempt[];
}

interface MasterRow {
  id: number;
  name: string;
  dmc: string;
  inspection_type: 'CIRCLIP' | 'RING';
  images_per_attempt: number;
}

export default async function masterDataRoutes(app: FastifyInstance) {
  // GET /master-data/catalog
  // The 10 master pieces in id order. Inactive rows (active = 0) are hidden
  // so an operator can soft-disable a master without renumbering ids — the
  // UI's id-based navigation routes stay stable.
  app.get('/master-data/catalog', async () => {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id, name, dmc, inspection_type, images_per_attempt
      FROM dbo.Master_Data
      WHERE active = 1
      ORDER BY id ASC
    `);
    const items: CatalogItem[] = (result.recordset as MasterRow[]).map((r) => ({
      id: r.id,
      dmc: r.dmc,
      identification: r.name,
    }));
    return items;
  });

  // GET /master-data/catalog/:id — single catalog row, used by the per-day
  // inspection page header.
  app.get<{ Params: { id: string } }>('/master-data/catalog/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      reply.status(400);
      return { error: 'Invalid catalog id' };
    }
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', id)
      .query(`
        SELECT id, name, dmc, inspection_type, images_per_attempt
        FROM dbo.Master_Data
        WHERE id = @id AND active = 1
      `);
    if (result.recordset.length === 0) {
      reply.status(404);
      return { error: 'Catalog item not found' };
    }
    const r = result.recordset[0] as MasterRow;
    const item: CatalogItem = { id: r.id, dmc: r.dmc, identification: r.name };
    return item;
  });

  // GET /master-data/inspection?id=<catalogId>&date=<YYYY-MM-DD>
  //
  // Returns the catalog row + the list of CV-X capture sessions for that
  // master on the given calendar day (IST). Each session is one "Attempt"
  // card on the page.
  //
  // Two important filters:
  //   - is_master = 1   — only rows the matcher routed through the master
  //                       bypass land here; production captures of any
  //                       other DMC never bleed in.
  //   - AT TIME ZONE 'India Standard Time' on captured_at — the column is
  //                       stored UTC by the mssql driver; we need the
  //                       IST calendar day, not the UTC one, or rows from
  //                       18:30+ IST get attributed to the next day.
  app.get<{ Querystring: { id?: string; date?: string } }>(
    '/master-data/inspection',
    async (req, reply) => {
      const idParam = req.query.id;
      const dateParam = req.query.date;
      const id = idParam ? parseInt(idParam, 10) : NaN;
      if (!Number.isFinite(id)) {
        reply.status(400);
        return { error: 'id (catalog id) query param required' };
      }
      if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        reply.status(400);
        return { error: 'date query param required as YYYY-MM-DD' };
      }
      const pool = await getPool();

      const catalogResult = await pool
        .request()
        .input('id', id)
        .query(`
          SELECT id, name, dmc, inspection_type, images_per_attempt
          FROM dbo.Master_Data
          WHERE id = @id AND active = 1
        `);
      if (catalogResult.recordset.length === 0) {
        reply.status(404);
        return { error: 'Catalog item not found' };
      }
      const m = catalogResult.recordset[0] as MasterRow;
      const catalog: CatalogItem = { id: m.id, dmc: m.dmc, identification: m.name };

      const imagesResult = await pool
        .request()
        .input('dmc', m.dmc)
        .input('type', m.inspection_type)
        .input('date', dateParam)
        .query(`
          SELECT id, session_folder, picture_no, ok_flag, camera_id, captured_at
          FROM dbo.Image_Index
          WHERE DMC = @dmc
            AND inspection_type = @type
            AND is_master = 1
            AND pending_match = 0
            AND CAST(captured_at AT TIME ZONE 'UTC'
                     AT TIME ZONE 'India Standard Time' AS DATE) = @date
          ORDER BY captured_at ASC, picture_no ASC
        `);

      // One "attempt" = images_per_attempt consecutive captures, ordered by
      // capture time. A Snap Ring master is 1 image/attempt, so EACH capture
      // becomes its own attempt card with its own timestamp; a Ring master is
      // 25/attempt, so every 25 images form one attempt. This is more accurate
      // than grouping by CV-X session_folder, which bundles multiple operator
      // trials (run minutes apart) into a single card. Rows already arrive
      // ordered by captured_at ASC, picture_no ASC.
      const perAttempt = Math.max(1, m.images_per_attempt || 1);
      const rows = imagesResult.recordset as {
        id: number;
        session_folder: string | null;
        picture_no: number;
        ok_flag: boolean | number | null;
        camera_id: string | null;
        captured_at: Date;
      }[];
      const attempts: InspectionAttempt[] = [];
      for (let i = 0; i < rows.length; i += perAttempt) {
        const chunk = rows.slice(i, i + perAttempt);
        attempts.push({
          attempt_no: attempts.length + 1,
          session_folder: chunk[0].session_folder ?? '__no_session__',
          captured_at: chunk[0].captured_at.toISOString(),
          images: chunk.map((r) => ({
            id: r.id,
            picture_no: r.picture_no,
            ok_flag: r.ok_flag === true || r.ok_flag === 1 ? 1 : 0,
            camera_id: r.camera_id,
            captured_at: r.captured_at.toISOString(),
          })),
        });
      }

      const response: MasterInspectionResponse = {
        catalog,
        inspection_type: m.inspection_type,
        expected_per_attempt: m.images_per_attempt,
        attempts,
      };
      return response;
    },
  );
}
