# Piston Traceability — System State

**Date**: 2026-05-11
**Author of this document**: outgoing build session (handoff to whoever picks this up next)
**Branch**: `claude/nice-tesla-4371fa` (pushed to `origin`, PR not yet opened)

This document describes what's currently built, deployed, and verified — and what isn't. Read it end to end before touching anything. Pay particular attention to §7 (State of the build), §8 (Known issues), and §11 (Open questions); the rest is reference.

---

## 1. Overview

**What it is.** An on-premise traceability and quality-record application for a piston-assembly line at Symbiotic's customer (the SCADA box runs all three containers locally, against a SQL Server on the same machine). The app displays per-part production state, multi-attempt inspection history, and Keyence CV-X images, all anchored to a **DMC** (Data Matrix Code) printed on each part.

**Pipeline position.** The app sits at the end of this chain:

```
PLC (Siemens) ─┐
               ├─→ Node-RED ─→ SQL Server (SAM database) ─┐
CV-X cameras ──┘                                          │
                                                          ├─→ This app (read-only DB consumer)
CV-X cameras ─→ D:\Keyence - CVX (file system) ──────────┘
```

PLC drives the line and emits status events; Node-RED transforms them and writes rows to `dbo.SAM_Log`. CV-X cameras independently drop image files into `D:\Keyence - CVX\`. The backend in this app is a **read-only consumer of `SAM_Log`** and a **mover/indexer of CV-X files**. It does not write to SAM_Log itself.

**What is NOT this app's job.**
- Triggering the PLC, talking to the PLC over OPC UA / S7 / Modbus / etc. The app has no PLC link.
- Configuring CV-X. CV-X is configured independently to write `<DMC_SUFFIX>_<flag>_CAM<n>_<counter>.jpg` to `D:\Keyence - CVX\`.
- Writing inspection results. Node-RED owns the `SAM_Log` writes.
- Reading barcodes or driving cameras. Image arrival is event-driven from CV-X's own file output.
- Generating production reports or running QA workflows beyond what the UI presents.

---

## 2. Architecture

### Stack

- **Backend**: TypeScript, Fastify 5, `mssql` 11 driver, `chokidar` 4 (file watcher), `node-cron` 3 (scheduled jobs), `pdfkit` 0.15 (PDF rendering). Node 20 alpine.
- **Frontend**: TypeScript, React 18, Vite 6, React Router 6, Recharts 2, Tailwind 3, `date-fns` 4, `lucide-react` icons. Built into a static bundle served by nginx alpine.
- **Reverse proxy**: nginx alpine in front of both, exposing only port 8080.
- **Database**: MS SQL Server (database `SAM`).

### Containers (three)

| Container | Image (local tag) | Inside-network port | Host-exposed port | Purpose |
|---|---|---|---|---|
| `traceability-backend` | `nice-tesla-4371fa-backend` | 3000 | none | Fastify API + image subsystem |
| `traceability-ui` | `nice-tesla-4371fa-ui` | 80 | none | nginx-alpine serving the static React bundle |
| `traceability-nginx` | `nginx:alpine` | 80 | **8080** | Reverse proxy in front of both |

All three are on the docker network `nice-tesla-4371fa_traceability-network`. Only `traceability-nginx` is reachable from outside Docker (port 8080).

### nginx routing (`nginx/default.conf`)

```
/api/*  → http://backend:3000/*     (the /api prefix is stripped before forwarding)
/api    → 301 redirect to /api/
/*      → http://ui:80/             (the React SPA)
```

**Gotcha**: nginx resolves its upstream DNS at config-load time and caches the IP. After a `docker-compose up -d --build backend` recreates the backend container, the backend gets a new IP and nginx returns 502 until nginx is also restarted. Workaround used during dev: `docker-compose restart nginx` after every backend rebuild. A `resolver` directive or `set` + `proxy_pass $var` pattern would fix this permanently — not done.

### Repo layout

```
.
├── README.md                       Customer-facing install guide
├── docker-compose.yml              The three services + volume mounts + env passthrough
├── env.template                    Source of truth for env variables
├── start.bat / stop.bat / load-images.bat   Windows-side launcher scripts
├── build-release.bat               Release packaging (existence, not state)
├── nginx/default.conf              Reverse-proxy config
├── data/license/license.json       Activation file (gitignored)
├── tools/generate-license.ts       Stand-alone tool to mint license keys (not part of the app)
├── backend/
│   ├── Dockerfile                  Two-stage: tsc → dist + node --omit=dev
│   ├── package.json
│   ├── tsconfig.json
│   ├── sql/0001_image_index_columns.sql   Idempotent schema migration
│   └── src/
│       ├── main.ts                 App bootstrap + license middleware + image subsystem startup
│       ├── db/
│       │   ├── connection.ts       Singleton mssql pool
│       │   ├── state.ts            classifyState() + STATE_CASE_SQL + buildLatestPerDmcCte() + bindFilterInputs()
│       │   └── datetime.ts         serializeDateTime() — re-tags wall-clock with host offset
│       ├── images/
│       │   ├── config.ts           getImageConfig() — env-driven settings, cached
│       │   ├── parser.ts           Filename regex → ParsedImage
│       │   ├── matcher.ts          matchToSamLog() — asymmetric ±tolerance, latest Ring_Time wins
│       │   ├── mover.ts            EXDEV-safe move + sanitizeForWindowsFs
│       │   ├── db.ts               SQL helpers (insert, update, dedup-by-counter, pending scan, retention scan)
│       │   ├── indexer.ts          Per-file orchestrator: parse → dedup → match → move + insert (or pending)
│       │   ├── watcher.ts          chokidar watcher with serialized indexImage queue
│       │   ├── retry.ts            Pending-queue retry job — moves on resolve, deletes row on NO_MATCH
│       │   ├── retention.ts        365-day FIFO sweep
│       │   ├── alarms.ts           logAlarm() → dbo.Alarm_Log (best-effort)
│       │   └── index.ts            startImageSubsystem() — watcher + cron schedules
│       ├── license/license.ts      HMAC-based file-token license check
│       ├── reports/partTracePdf.ts pdfkit renderer for /part/:dmc/report.pdf
│       ├── routes/
│       │   ├── health.ts           GET /health
│       │   ├── license.ts          /license/status, /license/activate
│       │   ├── dashboard.ts        /dashboard, /plants
│       │   ├── lists.ts            /list, /export (CSV)
│       │   ├── parts.ts            /part/:dmc, /part/:dmc/report.pdf
│       │   ├── images.ts           /part/:dmc/images, /summary, /image/:id, /admin/images/pending
│       │   └── maintenance.ts      /maintenance/status, /maintenance/history/:component (placeholder)
│       └── types/index.ts          Shared response types
└── frontend/
    ├── Dockerfile                  Two-stage: vite build → nginx-alpine
    ├── nginx.conf                  SPA fallback (serves index.html for unknown paths)
    ├── package.json
    └── src/
        ├── App.tsx                 Router + license gate
        ├── main.tsx                Entry
        ├── lib/api.ts              Typed fetch wrappers, URL helpers, formatDateTime/formatTimestamp, PART_STATE_LABEL
        ├── components/
        │   ├── Layout.tsx          Sidebar shell
        │   ├── DateRangePicker.tsx Presets + From/To + optional Plant filter
        │   ├── Pagination.tsx      Generic
        │   ├── KpiCard.tsx         Equal-height KPI tile
        │   ├── ResultBadge.tsx     PASS/FAIL chip
        │   ├── StateBadge.tsx      5-state chip (uses PART_STATE_LABEL)
        │   ├── ImageGroupView.tsx  Group header + OK/NG filter + lazy thumbnail grid + OK/NG counts
        │   ├── Lightbox.tsx        Modal with Esc + ←/→ + download
        │   └── SymbioticLogo.tsx
        └── pages/
            ├── Dashboard.tsx       7 KPIs + Production Breakdown (3-color, adaptive bucket) + State Distribution donut
            ├── Lists.tsx           Paginated table, today/today default, 7 type filters, CSV export
            ├── PartTrace.tsx       Current State card + summary stats + multi-attempt cards + Event Timeline + Download PDF
            ├── Images.tsx          Search-or-deep-link → grouped thumbnails + lightbox
            ├── Maintenance.tsx     Placeholder UI for a table that doesn't exist in DB (see §7)
            └── LicenseActivation.tsx
```

### End-to-end data flow

**Per-part read path** (UI → SQL):

1. User opens `/part-trace?dmc=…`. Frontend `fetchPart(dmc)` hits `/api/part/<urlEncoded(dmc)>`.
2. Backend executes `SELECT * FROM dbo.SAM_Log WHERE DMC = @dmc ORDER BY ISNULL(Ring_Count, 0) ASC, Date_Time ASC`.
3. `serializeDateTimeFields` rewrites every `Date_Time` (a Date object from mssql) to an ISO string with the host local offset.
4. `classifyState(latest, hasCirclipFail)` derives `state`. Response includes `records[]` + `summary`.

**Per-image flow** (CV-X → disk → DB):

1. CV-X writes a new `.jpg` file to `D:\Keyence - CVX\<session>\CAM<n>\<judgment>\<filename>`.
2. chokidar (running inside backend container, polling every 1 s by default) fires `add`.
3. `indexImage(filePath)` is enqueued on a single Promise chain (serialized to avoid `nextPictureNo` races).
4. `parseImagePath` validates the filename (`<DMC_SUFFIX>_<flag>_CAM<n>_<10digits>.<jpg|bmp>`), reads `fs.stat().mtime` as `capturedAt`, derives `inspectionType` from CAM number.
5. `findExistingByCounter(sourceCounter, cameraId)` checks if we've seen this CV-X frame already; if so, skip.
6. `matchToSamLog` queries `dbo.SAM_Log` for a row with `Ring_Time` (or `Circlip_Time`) where `capturedAt - <PRE_TOLERANCE> ≤ Ring_Time ≤ capturedAt + <TOLERANCE>`. Picks the **latest** matching `Ring_Time`. CIRCLIP path is symmetric ±tolerance.
7. **Resolved** (number for RING, null for CIRCLIP) → `nextPictureNo` → `moveFileToDestination` → `insertImageRow(pending=false)` with the destination path.
8. **PENDING** (no match yet, age < 15 min) → `insertImageRow(pending=true)` with the source path; file stays in source.
9. **NO_MATCH** (no match, age ≥ 15 min) → `logAlarm(IMAGE_NO_INSPECTION_FOUND)`, no row inserted, file stays in source.

The retry cron (every minute) walks pending rows and re-runs the matcher; resolved rows are updated and moved, expired rows are **deleted** outright (to keep the unique index UQ_Image_Resolved consistent — see §10).

---

## 3. Database

Database: `SAM`. Application login: `Sam_Piston` (in production env) — needs `SELECT` on `SAM_Log`, `SELECT/INSERT/UPDATE/DELETE` on `Image_Index`, `INSERT` on `Alarm_Log`. Verify with the query in §6 of `README.md`.

The actual SQL Server is reached from inside containers via `host.docker.internal\SQLEXPRESS` (production `.env` setting). From the host directly use `.\SQLEXPRESS` or `localhost\SQLEXPRESS`.

### Tables actually present in `dbo` (verified live)

```
Alarm_Log
Alarm_Log_backup_20260508
Image_Index
SAM_Log
SAM_Log_backup_20260508
```

The two `_backup_20260508` tables are leftovers from a prior DB clear — they're not used by the app and can be dropped if you want a clean schema.

### `dbo.SAM_Log` (verified live)

```
Date_Time         datetime         NULL        — server local time, set by Node-RED on insert
Plant_Id          nvarchar(50)     NULL        — effectively the machine ID; in this install always 'Sam Plant'
DMC               nvarchar(50)     NULL        — full DMC including the static prefix '[)>.06-VTH16-P234102'
Circlip_Result    nvarchar(50)     NULL        — 'PASS' / 'FAIL'; NULL on re-inspection rows
Circlip_Time      nvarchar(50)     NULL        — PLC-formatted wall-clock string in IST, no TZ info
Ring_Result       nvarchar(50)     NULL        — 'PASS' / 'FAIL'; NULL until the first ring attempt is logged
Ring_Time         nvarchar(50)     NULL        — PLC-formatted wall-clock string in IST, no TZ info
Ring_Count        int              NULL        — 0 on a fresh-only-circlip row; 1..N on each ring attempt
Unloading_Time    nvarchar(50)     NULL        — Only set on the row of the successful pack
Result            nvarchar(50)     NULL        — Mirror of the latest Ring_Result; overwritten on pack

Indexes:
  UQ_SAMLog_DMC_RingCount  UNIQUE(DMC, Ring_Count)
  IX_SAMLog_DMC            (DMC)
  IX_SAMLog_DateTime       (Date_Time)
```

**Multi-row-per-DMC model** (critical to understand):

- A part with DMC `X` produces **one row per ring inspection attempt**, plus a circlip-only first row when ring inspection hasn't happened yet.
- Row 0 (`Ring_Count = 0`): `Circlip_Result` set, `Ring_Result` NULL. Created when circlip station finishes.
- Row 1 (`Ring_Count = 1`): `Circlip_Result` NULL (the circlip data is on row 0), `Ring_Result` populated. Created when ring station finishes its first attempt. May also have `Unloading_Time` set if pack succeeded.
- Rows 2..N: reinspection attempts. Same shape as row 1, with higher `Ring_Count`.
- The composite unique key `(DMC, Ring_Count)` guarantees one row per DMC per attempt.
- "Latest row" = the row with `MAX(Ring_Count)` for that DMC.
- `Unloading_Time` is only on the latest row, and only if the pack at that ring attempt succeeded.
- "Circlip-scrap" parts only ever produce row 0 with `Circlip_Result='FAIL'` — they never reach the ring station.

**Five-state classification** (defined in `backend/src/db/state.ts`):

| State | Definition (against the latest row + `has_circlip_fail` over any row) |
|---|---|
| `CIRCLIP_SCRAP` | Any row had `Circlip_Result = 'FAIL'` |
| `PACKED` | Latest `Ring_Result = 'PASS'` and `Unloading_Time` is non-empty |
| `RING_OK` | Latest `Ring_Result = 'PASS'` and `Unloading_Time` is NULL |
| `RING_NG` | Latest `Ring_Result = 'FAIL'` |
| `IN_PROGRESS` | None of the above (circlip pass logged, ring not yet attempted) |

Two equivalent implementations are kept aligned:
- `classifyState(row, hasCirclipFail)` in TS — used by single-DMC paths.
- `STATE_CASE_SQL` constant — a SQL `CASE` fragment used by aggregate queries (dashboard / lists / export). Expects `p.has_circlip_fail`, `l.Ring_Result`, `l.Unloading_Time` aliases in scope.

There is **one canonical source of truth** for what makes a part PASS. Every KPI, chart, donut, list filter, and export goes through this classifier — there is no other place in the code that compares `Result = 'PASS'`.

### `dbo.Alarm_Log` (verified live)

```
id              bigint           NOT NULL    — identity PK
ts              datetime2        NOT NULL    — set by app to SYSDATETIME() at insert
alarm_code      nvarchar(50)     NOT NULL    — e.g. 'IMAGE_PARSE_FAIL', 'IMAGE_NO_INSPECTION_FOUND', 'IMAGE_RETENTION_RUN'
DMC             nvarchar(50)     NULL
source          nvarchar(50)     NULL        — currently always 'IMAGE'
payload_json    nvarchar(MAX)    NULL        — JSON.stringified context (filePath, capturedAt, etc.)

Indexes:
  PK on id
  IX_Alarm_TS   (ts)
  IX_Alarm_DMC  (DMC)
```

The image subsystem is currently the only writer. `logAlarm()` is best-effort: errors are swallowed and logged to `console.error` so the indexer never dies on alarm-write failure.

### `dbo.Image_Index` (verified live, post-migration)

```
id                bigint           NOT NULL    — identity PK
DMC               nvarchar(50)     NOT NULL    — full DMC (with static prefix)
inspection_type   nvarchar(20)     NOT NULL    — 'CIRCLIP' or 'RING'
ring_count        int              NULL        — NULL for CIRCLIP; the matched Ring_Count for RING
picture_no        int              NULL        — 1..N within (DMC, type, ring_count); NULL on pending rows
file_path         nvarchar(500)    NOT NULL    — DESTINATION path on resolve; SOURCE path while pending
captured_at       datetime2        NOT NULL    — file mtime, true UTC instant from fs.stat
indexed_at        datetime2        NOT NULL    — SYSDATETIME() at insert
ok_flag           bit              NULL        — 0 = OK, 1 = NG, from the filename flag (mssql returns this as JS boolean — see §8)
camera_id         nvarchar(20)     NULL        — 'CAM1' or 'CAM2'
source_counter    bigint           NULL        — the 10-digit global counter from the CV-X filename
session_folder   nvarchar(50)      NULL        — the parent yymmdd_hhmmss folder name (informational only)
pending_match     bit              NOT NULL    — 1 while waiting for a matching SAM_Log row; 0 once resolved

Indexes:
  PK on id
  UQ_Image_Resolved   UNIQUE(DMC, inspection_type, ring_count, picture_no)
                      FILTER: pending_match = 0 AND picture_no IS NOT NULL
  IX_Image_DMC        (DMC)
  IX_Image_Captured   (captured_at)
  IX_Image_Pending    (pending_match)        FILTER: pending_match = 1
  IX_Image_DMC_Type_Attempt   (DMC, inspection_type, ring_count)
```

The filtered unique index `UQ_Image_Resolved` only applies to fully-resolved rows. The migration replaced an earlier broad `UQ_Image` constraint that included pending rows and crashed the retry job on multi-pending-per-DMC scenarios. See §10.

### Views

`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA='dbo'` returns **zero rows**. There are no views in `dbo`. The brief refers to a `latestPerDMC` view — that does not exist as a view; it's implemented as a **CTE-generating helper** (`buildLatestPerDmcCte` in `backend/src/db/state.ts`) emitted inline into every read query that needs it.

### Stored procedures

`SELECT name FROM sys.procedures WHERE SCHEMA_NAME(schema_id)='dbo'` returns **zero rows**. The brief asks for `sp_help` on `dbo.sp_record_ring_attempt` — **that procedure does not exist**. If it was supposed to exist (perhaps Node-RED was meant to call it for SAM_Log inserts), it was never created. Currently Node-RED writes to `SAM_Log` directly. **Flag for the next owner** to confirm with Symbiotic / Node-RED maintainer whether a stored proc was planned.

### Schema migration (`backend/sql/0001_image_index_columns.sql`)

Idempotent SQL Server script. Run on the `SAM` DB before the first deploy and on every upgrade that ships schema changes. What it does:

1. Adds (if missing) `captured_at, ok_flag, camera_id, source_counter, session_folder, pending_match` to `Image_Index`.
2. Makes `picture_no` nullable (pending rows have no picture number yet).
3. Drops the original `UQ_Image` unique constraint and recreates it as the filtered `UQ_Image_Resolved` index.
4. Creates the three new helper indexes.

All `IF EXISTS` / `IF NOT EXISTS` guarded — safe to re-run.

Permissions also need to be granted at install time (see step 3 in `README.md`):

```sql
USE SAM;
GRANT INSERT ON dbo.Alarm_Log TO Sam_Piston;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Image_Index TO Sam_Piston;
```

---

## 4. Backend

### Bootstrap (`backend/src/main.ts`)

1. Loads `.env` via `dotenv/config`.
2. Creates a Fastify instance with `pino` JSON logging.
3. Adds an `onRequest` hook that 403s every URL except those starting with `/license` or `/health` when `isLicenseActive()` is false. The license token lives at `/data/license/license.json` (bind-mounted from `./data/license/`).
4. Registers all 7 route groups.
5. Tests the DB pool with `SELECT 1`; logs success or the error.
6. If DB is up, calls `startImageSubsystem(log)` — starts chokidar and schedules the retry (1 min) and retention (daily 02:00) cron jobs.
7. Listens on `0.0.0.0:${PORT || 3000}`.
8. `SIGINT` / `SIGTERM` → stops the subsystem, closes the pool, exits.

### Route inventory

> All paths below are the in-app paths. The public URL prefix is `/api` (nginx strips it before forwarding).

#### `routes/health.ts`

- **`GET /health`** → `{ status: 'ok'|'degraded', db: 'connected'|'disconnected', timestamp: ISO }`. Hits the DB pool with `SELECT 1`. Excluded from the license gate.

#### `routes/license.ts`

- **`GET /license/status`** → `{ licensed, client?, activated_at? }`.
- **`POST /license/activate`** body `{ key }` → activates and writes `/data/license/license.json`. HMAC-signed key format `<clientId>.<sha256>`.

#### `routes/dashboard.ts`

- **`GET /dashboard?from&to&plant`** — three SQL queries against the latest-per-DMC CTE:
  - KPIs (Total Parts, Passed, Circlip Fail, Ring Fail, In Progress, Reinspected, Pass Rate)
  - `production_breakdown`: time buckets (granularity picked from range — `hour` for ≤1 day, `day` for 2–31 days, `week` for >31 days) with three counts per bucket (passed / in_progress / failed)
  - `state_breakdown`: COUNT(DISTINCT DMC) per `PartState`
  - Response shape: `{ kpis, granularity, production_breakdown, state_breakdown }`
- **`GET /plants`** → `string[]` of distinct `Plant_Id` from `SAM_Log`. Still used by `Lists` page; Dashboard no longer fetches it (single-plant install).

**KPI definitions** (all via `classifyState` against the latest-per-DMC set in the date window):

| KPI | Definition |
|---|---|
| Total Parts | `COUNT(DISTINCT DMC)` |
| Passed | DISTINCT DMCs in state `PACKED` or `RING_OK` |
| Circlip Fail | DISTINCT DMCs in state `CIRCLIP_SCRAP` |
| Ring Fail | DISTINCT DMCs in state `RING_NG` |
| In Progress | DISTINCT DMCs in state `IN_PROGRESS` |
| Reinspected | DISTINCT DMCs where `MAX(Ring_Count) > 1` (orthogonal to state) |
| Pass Rate | `Passed / Total * 100`, one decimal place |

**Sanity invariant**: `Passed + Circlip_Fail + Ring_Fail + In_Progress = Total_Parts` for any filter window. Verified end-to-end (production breakdown red bars = sum of three fail tiles; state donut sums to total).

#### `routes/lists.ts`

- **`GET /list?type&from&to&plant&search&sort&order&page&size`** — deduped by DMC. Each row carries the latest-row fields plus `state`, `total_attempts`, `reinspected`. Type filter values: `all | passed | packed | circlip_scrap | ring_rejected | in_progress | reinspected`. Sort whitelist includes all SAM_Log columns plus the three derived. Returns `{ data, total, page, size, total_pages }`.
- **`GET /export?…same params…`** — CSV download. Same query as `/list` but unpaginated and no JSON wrapper. Content-Disposition filename includes the bucket name (`sam_log_<type>_<yyyy-MM-dd>.csv`). **It is CSV, not real Excel**, despite some earlier docs calling it Excel.

#### `routes/parts.ts`

- **`GET /part/:dmc`** — all rows for the DMC, ordered by `Ring_Count ASC` then `Date_Time ASC`. Response `{ dmc, total_records, records, summary }`. `summary` is the latest-row + classified state + total_attempts + reinspected + first_seen/last_seen.
- **`GET /part/:dmc/report.pdf`** — server-rendered PDF via `pdfkit`. Same data as `/part/:dmc`, sections: title + DMC + Current State table + Inspection Attempts (one colored-bar line per row) + Event Timeline. Content-Disposition is `attachment; filename="part-trace-<sanitized-DMC>-<YYYY-MM-DD>.pdf"`. Streams; no caching.

#### `routes/images.ts`

- **`GET /part/:dmc/images`** — 404s if the DMC isn't in `SAM_Log`; otherwise returns `{ dmc, groups: [{ inspection_type, ring_count, expected, indexed, images: [...] }] }`. Groups are ordered Circlip first, then RING by `ring_count` ASC. `expected` is driven by env (`EXPECTED_RING_PICTURES_PER_ATTEMPT` / `EXPECTED_CIRCLIP_PICTURES_PER_ATTEMPT`). Pending rows are excluded.
- **`GET /part/:dmc/images/summary`** — same shape minus the `images[]` array. Cheap.
- **`GET /image/:id`** — streams the JPEG/BMP from `file_path`. JOINs through SAM_Log so a DMC not in SAM_Log can't serve images. Drops the orphan row and returns 404 if the file is missing on disk.
- **`GET /admin/images/pending`** — diagnostic, returns all rows with `pending_match=1`. NOT gated by the SAM_Log existence check (that's the whole point — pending rows often have unknown DMCs).

#### `routes/maintenance.ts`

- **`GET /maintenance/status`** — returns the latest snapshot per component from `dbo.maintenance_snapshot`. **That table does not exist** in the current DB, so the route returns `[]`. Pre-existing placeholder. See §7.
- **`GET /maintenance/history/:component?from&to`** — same situation. Returns `[]`.

### DB access layer

- **`getPool()`** in `backend/src/db/connection.ts` — singleton mssql pool. Parses `host\INSTANCE` from `DB_HOST` if present. Defaults: encrypt false, trustServerCertificate `${DB_TRUST_SERVER_CERTIFICATE}`, request timeout 30 s, connection timeout 15 s. mssql defaults to `useUTC: true` — relevant for timezone handling (see §10).

- **`buildLatestPerDmcCte(extraConditions: string[])`** in `db/state.ts` — emits a SQL CTE prefix yielding three named CTEs: `filtered` (SAM_Log filtered by the date/plant/search conditions), `per_dmc` (one row per DMC with `max_ring_count`, `has_circlip_fail`, `first_seen`, `last_seen`), and `latest` (the row where `Ring_Count = max_ring_count` per DMC). Callers append their `SELECT … FROM latest l INNER JOIN per_dmc p ON p.DMC = l.DMC` to the returned string.

- **`bindFilterInputs(request, filters)`** — binds `@from`, `@to`, `@plant` on the request and returns the matching `WHERE` clauses.

- **`STATE_CASE_SQL`** — the SQL `CASE` expression mirroring `classifyState`. Used in every aggregate.

- **`classifyState(latest, hasCirclipFail)`** in TS — used by single-DMC paths (parts.ts, PDF renderer).

- **`serializeDateTime(value)`** and **`serializeDateTimeFields(rows, fields=['Date_Time'])`** in `db/datetime.ts` — take a JS `Date` returned by mssql (whose UTC components match the SQL wall-clock under `useUTC: true`) and rewrite it as an ISO string `2026-05-08T17:04:09.000+05:30` using the **host's local offset**. Frontend `formatDateTime` extracts the wall-clock parts and ignores the offset, so display matches what SSMS shows regardless of viewer locale. Applied on every route that returns `Date_Time` (lists, part trace, image responses' `captured_at`).

### Image subsystem (`backend/src/images/`)

Composition is in `index.ts → startImageSubsystem(log)`:

1. `startImageWatcher(log)`:
   - `fs.access(INCOMING_IMAGES_PATH)` first; if it fails, log warning and SKIP — backend stays healthy even when the bind-mount isn't in place.
   - `chokidar.watch(INCOMING_IMAGES_PATH, { persistent: true, ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }, depth: 4, usePolling, interval: 1000, binaryInterval: 1500, ignored: <only .jpg/.bmp> })`.
   - `add` events go through a **single Promise chain** (`queue = queue.then(...)`) so `indexImage` calls are serialized — protects `nextPictureNo` from races.
2. `node-cron` schedules:
   - `* * * * *` → `runPendingRetry()`. Re-entrancy guarded with a flag.
   - `0 2 * * *` → `runRetention()`. Daily FIFO purge based on `IMAGE_RETENTION_DAYS`.

Behaviours worth knowing:

- **Parser** (`parser.ts`) regex: `/^(.+)_(\d)_(CAM\d+)_(\d{10})\.(jpg|bmp)$/i`. The `(.+)` is greedy — for the standard single-flag filename it captures the DMC suffix exactly. `cfg.camToType[cameraId]` maps `CAM1`→`RING`, `CAM2`→`CIRCLIP` (env-overridable).
- **Matcher** (`matcher.ts`) RING path: asymmetric window. `capturedAt` is allowed to be up to `IMAGE_MATCH_PRE_TOLERANCE_SECONDS` (default 60 s) **before** Ring_Time and up to `IMAGE_MATCH_TOLERANCE_SECONDS` (default 300 s) **after**. `ORDER BY Ring_Time DESC` picks the **latest** matching Ring_Time — fixes a real bug where consecutive re-inspection attempts ~4 min apart cross-pollinated each other's image groups under the previous symmetric "closest wins" logic.
- **Matcher** CIRCLIP path: symmetric ±`IMAGE_MATCH_TOLERANCE_SECONDS` (no boundary issue since circlip is one-shot).
- **Wall-clock formatting**: matcher writes `capturedAt` as a wall-clock SQL string built from `Date.getHours()` / `getMinutes()` etc. **using the container's local TZ**. The container must run with `TZ=Asia/Kolkata` (or whatever the SCADA box's TZ is — passed through env). Both sides of the SQL comparison go through `TRY_CONVERT(DATETIME2, ..., 120)` so they're parsed naively as wall-clock.
- **Mover** (`mover.ts`): destination is `${output}/${sanitize(DMC)}/${type}/attempt_${ringCount ?? 1}/${OK|NG}/${origFilename}`. `sanitizeForWindowsFs` replaces `< > : " | ? *` with `_` so Windows can browse the path even when the DMC contains illegal characters like `>`. Falls back to copy+unlink on `EXDEV` / `EPERM` (the source and destination are separate bind-mounts in the container's view).
- **NO_MATCH cleanup**: when the retry job decides a row is past the 15-min window with no match, it **DELETEs** the Image_Index row entirely (the spec said "set pending_match=0" but that broke the unique index because multiple NO_MATCH rows would all be `(DMC, type, NULL, NULL)` post-clear — see §10). The file stays in source. `Alarm_Log` records `IMAGE_NO_INSPECTION_FOUND` once per row.
- **Retention** (`retention.ts`): `SELECT id, file_path FROM Image_Index WHERE captured_at < DATEADD(day, -@retention_days, SYSDATETIME())`. Best-effort `fs.unlink` then row delete. `ENOENT` is tolerated. Single `IMAGE_RETENTION_RUN` alarm summarises each run.

### Environment variables (`env.template`)

All knobs are configurable via `.env`. Defaults shown.

```
DB_HOST=host.docker.internal\SQLEXPRESS    # SCADA box default
DB_PORT=1433
DB_NAME=SAM
DB_USER=Sam_Piston
DB_PASSWORD=<set per install>
DB_TRUST_SERVER_CERTIFICATE=true

LOG_LEVEL=info

TZ=Asia/Kolkata                           # MUST match the SCADA box; matcher depends on this

# Image integration
INCOMING_IMAGES_PATH=/data/incoming                       # container path
IMAGES_OUTPUT_PATH=/data/images                           # container path
DMC_STATIC_PREFIX=[)>.06-VTH16-P234102                    # the prefix the CV-X strips
CAM_CIRCLIP=CAM2
CAM_RING=CAM1
EXPECTED_RING_PICTURES_PER_ATTEMPT=25
EXPECTED_CIRCLIP_PICTURES_PER_ATTEMPT=1
IMAGE_RETENTION_DAYS=365
IMAGE_MATCH_TOLERANCE_SECONDS=300                          # after-Ring_Time window
IMAGE_MATCH_PRE_TOLERANCE_SECONDS=60                       # before-Ring_Time window
IMAGE_PENDING_TIMEOUT_MINUTES=15
IMAGE_FILE_HANDLING=move                                   # or 'copy'
IMAGE_WATCH_USE_POLLING=true                               # inotify is unreliable on Win bind-mounts
```

---

## 5. Frontend

React 18 + Vite 6 + React Router 6 + Tailwind 3. Built into a static bundle by `vite build` (via the multi-stage Dockerfile) and served by an nginx-alpine container with a tiny SPA-fallback config.

### App shell + license gate (`App.tsx`)

On mount, `fetchLicenseStatus()` is called. While `licensed === null` a spinner is shown. If `licensed === false`, `<LicenseActivation>` is rendered. Otherwise the routed layout renders. The license check is performed once per browser session — refresh forces a re-check.

Routes registered:

| Path | Component | Notes |
|---|---|---|
| `/` | `<Navigate to="/dashboard" replace />` | |
| `/dashboard` | `pages/Dashboard.tsx` | |
| `/lists` | `pages/Lists.tsx` | |
| `/part-trace` | `pages/PartTrace.tsx` | Reads `?dmc=` |
| `/images` | `pages/Images.tsx` | Reads `?dmc&inspection_type&attempt` |
| `/maintenance` | `pages/Maintenance.tsx` | Renders empty state against the empty placeholder API |

### `lib/api.ts`

Typed fetch wrappers + URL helpers. Notable functions:

- `fetchDashboard(from, to, plant?)`, `fetchPlants()`.
- `fetchList(params)` returns `PaginatedResponse<PartListItem>`. `getExportUrl(params)` returns the CSV URL for direct download.
- `fetchPart(dmc)` returns `PartResponse` with `summary`. `partTracePdfUrl(dmc)` returns the PDF route URL.
- `fetchPartImages(dmc)` / `fetchPartImagesSummary(dmc)`. `imageSrc(id)` returns the byte-streaming URL.
- `fetchMaintenanceStatus()` / `fetchMaintenanceHistory(component, from?, to?)`.
- `fetchLicenseStatus()`, `activateLicense(key)`.
- `formatDateTime(iso)` — extracts the wall-clock components from the ISO string with offset that the backend emits. Locale-agnostic — same display regardless of viewer's browser TZ.
- `formatTimestamp(value)` — passes through PLC strings (e.g. `Circlip_Time`) unchanged. Never appends `ms`.
- `formatDuration(ms)` — appends `ms`. **Currently unused**, kept as a future hook so nobody re-introduces the old `Time: <timestamp> ms` rendering bug.
- `PART_STATE_LABEL: Record<PartState, string>` — single source of truth for state display strings ("Packed", "Ring OK", "Ring Rejected", "Circlip Scrap", "In Progress").

### Pages

**Dashboard** — 7 KPI tiles in a `grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 auto-rows-fr` layout (consistent heights enforced by `min-h-[2.5rem]` on the title). Cold-loads with `From = To = today` (server-local). Plant filter removed from this page's DateRangePicker because the install is single-machine and the donut would always have one slice.

- **Production Breakdown**: stacked bar chart with three series — Passed (green), In Progress (amber), Failed (red). Adaptive X-axis:
  - range ≤ 1 day → `HH:00` ticks (hourly buckets)
  - range 2–31 days → `dd-MM` ticks (daily buckets)
  - range > 31 days → `dd-MM` ticks for the Monday of each week (weekly buckets)
  - Backend includes `granularity: 'hour'|'day'|'week'` in the response so the UI knows how to format ticks.
- **State Distribution donut**: replaces the old single-slice plant donut. Uses `state_breakdown` from the API, sized by DISTINCT-DMC count with the canonical state colors.

**Lists** — paginated table, dedup-by-DMC. Cold loads with `From = To = today`. Type filter dropdown: All Results / Passed / Circlip Scrap / Ring Rejected / Reinspected / In Progress / Packed. Columns include `Date/Time`, `Plant`, `DMC` (with small `↻ Reinspected` chip when applicable), `State` (uses `StateBadge`), `Circlip`/`Circlip Time`/`Ring`/`Ring Time`, `Attempts`, `Unload Time`. `Date/Time` uses `formatDateTime`. "Export CSV" button calls `getExportUrl(...)`. Plant filter is still present here.

**PartTrace** — search input (accepts `?dmc=` deep-link, auto-loads on mount). Current State card includes a **Download PDF** button (top-right of the card) linking to `/api/part/:dmc/report.pdf`. Below the card: four stat tiles (Total Records / Ring Attempts / Reinspected / Final State). Then an **Inspection Attempts** section with one colored-bar card per row (circlip + ring), each with a **View Images** deep-link to `/images?dmc=…&inspection_type=…&attempt=…`. Then an **Event Timeline** section. All timestamps go through `formatDateTime`; PLC strings through `formatTimestamp` (no `ms`).

**Images** — search input + `?dmc=` deep-link auto-load. On load, `fetchPartImages(dmc)` populates groups in the order: CIRCLIP first, then RING by ring_count. Each `<ImageGroupView>` renders a header (title + indexed/expected + green `X OK` chip + red `Y NG` chip + Missing-N badge when `indexed < expected`), an OK/NG/All filter toggle, and a thumbnail grid (`<img loading="lazy">`). Clicking a thumbnail opens `<Lightbox>` with arrow-key + Esc + download. If the URL also contains `inspection_type` and `attempt`, the matching group scrolls into view via `ref.scrollIntoView({behavior:'smooth'})` after render.

**Maintenance** — UI is fully built but the underlying `maintenance_snapshot` table doesn't exist, so the API returns `[]` and the page shows its "No maintenance components found" empty state. See §7.

### Notable behaviors already in place

- **Date filters default to today** across Dashboard and Lists (explicit project preference — not in original brief).
- **Timezone**: backend re-tags datetime values with the host's local UTC offset; frontend parses the wall-clock from the offset-tagged ISO string and ignores the offset. Display is locale-independent.
- **Multi-attempt rendering** on PartTrace: one card per attempt, in `Ring_Count ASC` order. The circlip card uses `Ring_Count || 1` as the attempt label.
- **Reinspected badge** on Lists rows where `total_attempts > 1`.
- **Industrial-dark sidebar** in `Layout.tsx`. Fonts: Barlow + JetBrains Mono (loaded via Tailwind/CSS).
- **Footer**: still reads "Piston Traceability v2.0" — version not bumped, see §7.

---

## 6. Deployment

### Containers build (`docker-compose.yml`)

```yaml
backend:
  build: ./backend             # multi-stage: npm install + tsc + cp dist + npm --omit=dev
  container_name: traceability-backend
  environment:
    - DB_HOST=${DB_HOST:-localhost}
    - DB_PORT=${DB_PORT:-1433}
    - DB_NAME=${DB_NAME:-SAM}
    - DB_USER=${DB_USER:-sa}
    - DB_PASSWORD=${DB_PASSWORD}
    - DB_TRUST_SERVER_CERTIFICATE=${DB_TRUST_SERVER_CERTIFICATE:-true}
    - LOG_LEVEL=${LOG_LEVEL:-info}
    - NODE_ENV=production
    - TZ=${TZ:-UTC}
  volumes:
    - ./data/exports:/data/exports
    - ./data/logs:/data/logs
    - ./data/license:/data/license
    - "D:/Keyence - CVX:/data/incoming"     # CV-X source folder
    - "D:/Records Actual:/data/images"      # organized destination
  networks: [traceability-network]
  restart: unless-stopped

ui:
  build: ./frontend            # multi-stage: vite build → nginx-alpine
  container_name: traceability-ui
  networks: [traceability-network]
  depends_on: [backend]
  restart: unless-stopped

nginx:
  image: nginx:alpine
  container_name: traceability-nginx
  ports: ["8080:80"]
  volumes:
    - ./nginx/default.conf:/etc/nginx/conf.d/default.conf
  networks: [traceability-network]
  depends_on: [backend, ui]
  restart: unless-stopped
```

The two image-related bind mounts assume Windows-side paths `D:\Keyence - CVX` and `D:\Records Actual`. `start.bat` creates them defensively.

### Launcher scripts (Windows `.bat`)

- **`start.bat`** — checks Docker Desktop, checks `.env` exists, creates `data\exports`, `data\logs`, `D:\Keyence - CVX`, `D:\Records Actual` if missing, runs `docker-compose up -d --build`, waits 5 s, prints access URLs.
- **`stop.bat`** — `docker-compose down`.
- **`load-images.bat`** — exists for offline-install scenarios; loads pre-built Docker tarballs. Not used in dev. (Not inspected this round — see §7.)
- **`build-release.bat`** — packages a release. Not exercised this round.

### Fresh SCADA-box deployment checklist (verified against the live install)

The README has the full version. Summary:

1. Install Docker Desktop, ensure it's running.
2. Install SQL Server, create the `SAM` database with the v2.0 schema (`SAM_Log`, `Alarm_Log`, `Image_Index` — Node-RED's writers + existing migration).
3. Create a SQL login (e.g. `Sam_Piston`) with `SELECT` on `SAM_Log`. The image subsystem will need INSERT/UPDATE/DELETE on `Image_Index` and INSERT on `Alarm_Log` — granted in step 5.
4. Copy `env.template` to `.env`, set `DB_*` values, set `TZ` to the SCADA box's local TZ (`Asia/Kolkata` for the current customer).
5. Run `backend\sql\0001_image_index_columns.sql` against `SAM` in SSMS or via `sqlcmd`. Then run the two `GRANT` statements from §3 above.
6. Run `start.bat`.
7. Hit `http://localhost:8080/api/health` to confirm the backend is up and DB is connected. Hit `/api/admin/images/pending` to confirm the image subsystem is registered.
8. Activate the license: open `http://localhost:8080`, enter the key.

### `release-files/` mirror

The brief and spec both reference a `release-files/` directory mirroring `docker-compose.yml` / `env.template` / `start.bat`. **This directory does not exist** in the repo. The mirror was deferred to a final delivery polish pass and never created. Tools-related `build-release.bat` references it in script lines that were never validated.

---

## 7. State of the build

### Working and verified

| Area | How it was verified |
|---|---|
| Multi-row schema reads (Dashboard / Lists / PartTrace KPIs and rendering) | Sanity invariant tested against real live data: `Passed + Circlip_Fail + Ring_Fail + In_Progress = Total_Parts` holds. State donut sums to total. Chart red total = sum of three fail tiles. |
| Date/time display | Backend `serializeDateTime` + frontend `formatDateTime` produce IST wall-clock independent of viewer TZ. Verified by comparing UI display to direct SSMS query. |
| Multi-attempt rendering on PartTrace | A real multi-attempt part (4 attempts) was viewed; one card per circlip + per ring attempt, ordered correctly, color coded. |
| Reinspected KPI + badge | Verified the `MAX(Ring_Count) > 1` check on a part with 4 attempts shows as Reinspected on the dashboard tile and as a `↻ Reinspected` chip on its Lists row. |
| In Progress KPI tile | Verified value matches `SELECT COUNT(DISTINCT DMC) FROM dbo.SAM_Log WHERE …` with the IN_PROGRESS predicate. |
| Adaptive time bucketing in Production Breakdown | Tested three range sizes: 1-day → hour granularity (24 buckets max), 7-day → day granularity (7 buckets), 60-day → week granularity. Backend response carries `granularity` and frontend formats X-axis labels accordingly. |
| State Distribution donut | Tested against live data, slice counts match KPI tiles. |
| KPI card consistent heights | Visual check — all seven cards align even when titles wrap to two lines. |
| Lists CSV export | Downloaded a CSV, opened in Excel, columns and rows match the `/list` JSON response for the same filter. |
| Part Trace PDF | Downloaded for a real DMC, opened in Adobe Reader. Header + Current State table + Inspection Attempts list + Event Timeline render cleanly. Color coding (green PASS / red FAIL) consistent with UI. |
| License gate | Verified: removing `data/license/license.json` → unlicensed page renders, all API calls return 403 except `/license/*` and `/health`. Activating with a valid HMAC key writes the file and unlocks the app. |
| Image subsystem end-to-end (synthetic) | Dropped a hand-crafted JPEG into `D:\Keyence - CVX\…` with filename matching the spec and mtime aligned to a real `Ring_Time`. Within ~3 s the file was moved to `D:\Records Actual\<DMC>\RING\attempt_1\OK\…`, an `Image_Index` row was inserted, `/api/part/:dmc/images` returned the group, and `/api/image/:id` streamed valid JPEG bytes. |
| Image lockdown | `/api/part/FAKE_DMC/images` returns 404. `/api/image/:id` for an image whose DMC isn't in `SAM_Log` returns 404. |
| ok_flag display | After the BIT-as-boolean fix, NG files display with a red NG badge in the UI; OK files green. Verified on a real reinspected part with mixed OK/NG. |
| Timezone-aware matcher | Verified by aligning a synthetic file's local-time mtime to `Ring_Time` (in IST) and seeing it match within 1 s of delta. |
| Asymmetric matcher tolerance | Numerically traced against a real 4-attempt part where the previous symmetric matcher produced 25/34/28/13; the new logic produces 25/25/25/25 (validated against the data — see §8). |
| Path sanitization | A DMC with `>` in it lands on disk at `[)_.06-VTH16-…` and is browseable in Windows Explorer; UI continues to work against the original DMC. |

### Built but unverified (or partially verified)

| Area | Why it's unverified |
|---|---|
| `IMAGE_FILE_HANDLING=copy` mode | The code path exists but every live test used the default `move`. The copy path uses `fs.copyFile` and skips the rename/EXDEV dance; should work but never exercised. |
| Daily retention cron | Logic tested by code review; `IMAGE_RETENTION_DAYS=0` was suggested for an end-to-end test but never run on the SCADA box. Scheduled to fire at 02:00; the SCADA box hasn't crossed that boundary with real data under the current build yet. |
| `/admin/images/pending` over time | Used during dev to drain ~106 pending rows successfully. Has not been used as a long-running operational diagnostic. |
| Production-summary CSV export | Not built. The spec's wording about "production summary export" was deferred; CSV export currently only exists for the Lists query, not for KPI/dashboard data. |
| Multi-plant scenarios | The Lists page still has a Plant filter. Whole pipeline has only been tested with one Plant_Id (`Sam Plant`). Filtering for a non-existent plant returns empty results, which is correct, but the donut and dashboard are degenerate either way. |
| Browser other than Edge/Chrome | All UI testing was in Edge. The bundle uses standard React/Vite output; should work in Firefox / Safari but not tested. |

### Not built / deferred

| Item | Reason |
|---|---|
| **Maintenance Module** | Frontend is built (`pages/Maintenance.tsx`) and the API routes exist (`/maintenance/status`, `/maintenance/history/:component`) but the underlying `dbo.maintenance_snapshot` table **does not exist** in the live DB. UI gracefully shows "No maintenance components found." Whoever wires this up next will need: (a) Node-RED to start writing maintenance snapshots, (b) the table schema confirmed/created, (c) optional polish on the History date filter (currently defaults to last 30 days). |
| **RBAC / multi-user auth** | Out of scope this round. Only mechanism is the boolean license activation; no user accounts, no role separation. Anyone with the URL has full UI access. |
| **Licensing distribution + renewal** | The HMAC-signed file-token check works, but no infrastructure for issuing keys to customers, no expiry, no remote revocation. `tools/generate-license.ts` exists for manual key generation. |
| **Version bumps** | Both `package.json`s, the footer string, and the README still say `2.0.0`. Deliberately not bumped during the fast-iteration phase. Bump to e.g. `2.1.0` as part of the delivery polish pass. |
| **`release-files/` mirror** | Doesn't exist. `build-release.bat` references it. Defer to delivery polish. |
| **PLC fixes** (Ring_DMC repopulation, SCL date format) | Reported as DONE on the PLC side per project notes, but not directly verified by this app. The matcher works against whatever `Ring_Time` strings show up. |
| **README** | Has the install steps and image-integration tunables. Hasn't been re-reviewed for tone or marketing polish. |
| **Production summary export, bucket-specific export endpoints** | Considered, dropped as unnecessary — the existing `/export?type=…` query-string parameterization already covers per-bucket needs. |

---

## 8. Known issues

### Resolved in this branch but worth knowing

These were real bugs caught and fixed during the live deploys. They could resurface if the underlying assumptions change.

1. **nginx upstream DNS cache** — after `docker-compose up -d --build backend`, the backend container gets a new IP but nginx still has the old one cached, so the API returns 502 until nginx is restarted. Workaround during dev: `docker-compose restart nginx`. Permanent fix (not done): switch to `resolver` + `set $upstream …; proxy_pass $upstream;` pattern in nginx config.

2. **mssql returns `BIT` as JS boolean, not 0/1** — `r.ok_flag === 1` is always false because `true !== 1`. Every consumer of a BIT column must use truthy coerce: `r.ok_flag ? 1 : 0`. There were two instances of this bug (one in the API response shaping, one in the retry-job's mover call). Both fixed. **If any new BIT columns are added, watch for this.**

3. **`UQ_Image_Resolved` filter** — must include `picture_no IS NOT NULL`, not just `pending_match = 0`. Without the `picture_no` clause, multiple NO_MATCH rows being cleared via `pending_match = 0` (with NULL picture_no and ring_count) all collapse to the same key `(DMC, type, NULL, NULL)` and the second one crashes the retry job. The retry job now **deletes** NO_MATCH rows instead of clearing them — both safer and keeps the unique index small.

4. **Container TZ** — `TZ=Asia/Kolkata` in `.env` is non-negotiable for this install. The matcher formats `capturedAt` using local-time methods (`Date.getHours()` etc.). With `TZ=UTC` (default), the matcher reads UTC hour from a file mtime that's actually IST → match SQL compares `09:41:24 UTC components` to `15:11:24 IST wall-clock string` → 5h30m delta → NO_MATCH for every real image. Documented in `env.template` and README.

5. **File mtime is AFTER `Ring_Time`** — CV-X writes files ~10–15 s after the PLC logs Ring_Time. Combined with re-inspection attempts that can be ~4 min apart, the previous symmetric-tolerance / closest-Ring_Time matcher cross-pollinated boundary images between attempts. Asymmetric `±[pre, tol]` window + ORDER BY Ring_Time DESC fixes it. This is robust as long as `IMAGE_MATCH_PRE_TOLERANCE_SECONDS` (default 60) is much smaller than the minimum gap between consecutive attempts.

### Fragilities / open observations

1. **`maintenance_snapshot` table is missing from the live DB.** The Maintenance page renders an empty state and the routes return `[]`. Decide whether to (a) create the table + write to it, or (b) hide the Maintenance nav until someone owns the feature.

2. **`sp_record_ring_attempt` stored procedure does not exist.** The brief mentioned it; the live DB has no stored procs at all. Worth asking whether Node-RED was supposed to call one (it currently does direct INSERTs to SAM_Log).

3. **Stale CV-X images in source on a DB-clear.** If you wipe `SAM_Log` to start fresh, the files left in `D:\Keyence - CVX\` will all NO_MATCH against the cleaned-up DB on the next backend restart. Each gets one alarm row and stays in source. Triage by hand. The two `_backup_20260508` tables in `dbo` are similar leftovers — drop them if a clean schema is desired.

4. **Picture_no order vs source_counter order.** When a part has files arriving across the pending/first-touch boundary, retry-resolved files get higher `picture_no` values than first-touch files even if their `source_counter` is lower. `picture_no` is "order in which we indexed the file," not "order CV-X took the picture." The spec mentions a one-shot `ROW_NUMBER() OVER (… ORDER BY source_counter)` re-numbering query as a fix; it was not added because the UI doesn't strictly need monotone picture_no with respect to capture order. Use that query if you ever need it.

5. **Misplaced files from the retry-mover bug.** Files that the buggy retry path put in `OK/` instead of `NG/` (during the pre-fix window) are still physically misplaced on disk. The Image Viewer reads `ok_flag` from the DB (which has the truthy value), so the **UI is correct**; only the on-disk folder layout is inconsistent for those rows. The customer chose to wipe and start fresh rather than write a reconciliation pass. If a future customer hits the same issue: a `walk Image_Index → check file_path → compute expected folder → move + UPDATE file_path` script would do it.

6. **Windows path display in Explorer.** DMCs contain `>` and other Windows-illegal characters. We sanitize them in the destination path (so Explorer can traverse). The API uses the **original** DMC; users searching by DMC in the UI get correct results.

7. **No automated test suite.** Verification was manual + console probing throughout. A regression of the matcher behavior would only be caught by visual inspection of the Image Viewer or by querying the DB directly. **Worth adding** a small test harness around `classifyState`, `parseImagePath`, and `matchToSamLog` (deterministic, unit-testable). Not done.

8. **`/api/image/:id` content-type detection** is by file extension (`.jpg → image/jpeg`, `.bmp → image/bmp`, `.png → image/png`, otherwise `application/octet-stream`). No magic-byte sniffing.

9. **Watcher: `usePolling: true` is the default for safety.** On a Windows host with a Docker Linux container, inotify across the bind-mount boundary is unreliable. Polling adds ~1 s latency per file but never misses. If you ever switch to a Linux SCADA box, flip `IMAGE_WATCH_USE_POLLING=false` for native events.

10. **Mover dedup is by `(source_counter, camera_id)`.** This is robust as long as CV-X's 10-digit counter is monotonically unique. If CV-X is reset or replaced (counter rolls back to 0), you could collide with old indexed rows. No guard against this is in place.

---

## 9. External dependencies

### PLC (Siemens, by Symbiotic)

- Drives the line; emits status events to Node-RED.
- **Owned by**: the PLC integrator. This app does not connect to it.
- **Fixed (per project notes)**: Ring_DMC repopulation logic, SCL date format (was YYYY-DD-MM, now correct).
- **Outstanding from this app's perspective**: timing of `Ring_Time` writes vs CV-X writes. We've worked around the ~10–15 s offset via the asymmetric matcher; if the PLC behavior changes, revisit `IMAGE_MATCH_PRE_TOLERANCE_SECONDS`.

### Node-RED

- Transforms PLC events into `SAM_Log` row writes.
- **Owned by**: Symbiotic.
- The app trusts whatever Node-RED writes; it does not write to SAM_Log itself.
- Possible future direction: if Node-RED were to call a stored procedure (`sp_record_ring_attempt`?) instead of doing direct INSERTs, this app would not need to change — but the procedure should be created and Node-RED retargeted.

### Keyence CV-X cameras

- Independent of PLC. CV-X has its own controller and writes images directly to `D:\Keyence - CVX\` per the configured naming rule.
- **Filename contract** (locked): `{DMC_SUFFIX}_{OK_FLAG}_CAM{N}_{COUNTER:10digits}.jpg`. The parser regex matches this exactly. If CV-X is reconfigured to emit a different filename pattern, the parser **will silently reject everything as IMAGE_PARSE_FAIL**.
- **Outstanding observation**: CV-X does NOT write images for parts that fail at the circlip station (they don't continue to ring inspection). This is per-image quality assurance behavior — not a bug. The UI shows "No images for this part" for circlip-scrap DMCs, which is correct but could be more informative (see §11 Q3).
- The "integrator dependency" the original spec mentioned has been resolved: we work directly against the current CV-X file output, no third-party integration layer.

### SQL Server

- Hosted on the SCADA box itself (SQLEXPRESS instance).
- The app uses the `mssql` package with `host.docker.internal\SQLEXPRESS` from inside the container.
- Backups, replication, retention of SAM_Log/Alarm_Log/Image_Index are **the customer's responsibility**, not this app's.

### Docker Desktop

- Required on the SCADA box.
- Tested with Docker Desktop 28.x.
- Linux containers running on Windows host. Bind mounts go through Docker's filesystem-translation layer, which is why we use polling + path sanitization.

---

## 10. Key decisions

Short log so the next owner doesn't re-litigate these:

1. **Multi-row schema kept, not flattened.** The brief considered flattening to one-row-per-part. We kept the multi-row model from Node-RED and built the classifier on top. This means every aggregate query has to go through `buildLatestPerDmcCte` — slightly more SQL complexity but matches the PLC's natural event model and supports unlimited reinspection attempts without schema change.

2. **One canonical `classifyState` source of truth.** Both `classifyState(row, hasCirclipFail)` in TS and `STATE_CASE_SQL` in SQL exist; they're written to be observably equivalent. Every KPI / chart / list / export / PDF flows through one of these. **Do not add a new `WHERE Result = 'PASS'`** anywhere — the round before this round was a cleanup pass that removed those exact ad-hoc checks. The classifier is the answer.

3. **Date_Time handled by backend re-tag**, not frontend timezone math. The serializer takes the JS Date that mssql returns (whose UTC components match the SQL wall-clock under `useUTC: true`) and re-tags those components with the host's local offset. Frontend just extracts the wall-clock from the string. Result: display is locale-independent and matches SSMS exactly. **Do not change `useUTC`** in the mssql connection options — the whole chain assumes the default `useUTC: true`.

4. **CSV export, not Excel/XLSX.** The spec mentioned ExcelJS and "Excel exports." We kept the existing CSV path because (a) it works, (b) Excel opens it directly, (c) avoiding a new dep keeps the backend image small. If a customer ever insists on XLSX, swap in `exceljs`. Frontend doesn't care — it's just a download URL.

5. **PDF via pdfkit, not Chromium.** Custom programmatic layout via pdfkit. Trade-off: less faithful to the UI than Puppeteer-with-Chromium would be, but no Chromium dep on the SCADA box, much smaller image. The current PDF visually approximates the UI (blue left-bar accents, green/red color coding, mono DMC, indented timelines).

6. **Image organizer in TypeScript inside the backend container**, not a separate Python service. The original v2 spec had a Python script (`061120204.py`) for this. v3 folded the work into the backend so there's no separate container, no separate language, no separate license to manage. The Python script is reference-only and not part of the deploy.

7. **DMC-rooted destination tree**, not session-folder-rooted. CV-X's `yymmdd_hhmmss` session folders are storage buckets — they can split one inspection across multiple folders and combine multiple parts in one folder. Grouping by them would be wrong. We group by DMC instead, with SAM_Log timestamps as the join key.

8. **Path sanitization for Windows browsability.** The destination path uses `_` in place of `< > : " | ? *`. The DMC stored in DB is unchanged. Trade-off: file-system browsing works, slightly weaker "find the directory by typing the DMC" UX (the `_` replacement isn't reversible without rules).

9. **Asymmetric matcher tolerance with "latest Ring_Time wins."** Tight `IMAGE_MATCH_PRE_TOLERANCE_SECONDS` plus wider `IMAGE_MATCH_TOLERANCE_SECONDS`. Better-suited to CV-X's actual write-after-PLC behavior than the original symmetric-closest logic.

10. **NO_MATCH deletes the row.** Spec said "set pending_match=0 and keep the row" but this breaks the unique index. Deleting is cleaner and the file stays in source for manual review. The diagnostic record is captured in `Alarm_Log`.

11. **Licensing entirely deferred this round.** HMAC-signed file token works; key issuance/renewal/revocation infrastructure does not exist. Don't try to add it without product input.

12. **Plant filter removed from Dashboard but kept on Lists.** Each install is single-machine, so the dashboard donut would be one slice. Lists keeps the filter because removing it would be a feature regression if a future install ever has multiple machines writing to one DB.

13. **`today/today` cold load** on both Dashboard and Lists. Project preference, not in the original brief. Stored in user-memory as a persistent project rule.

14. **Watcher polling on, by default.** `IMAGE_WATCH_USE_POLLING=true`. Reliable on Docker-Windows bind mounts. Disable only if you've verified inotify works.

---

## 11. Open questions

For the next owner — these were not resolved during this build.

1. **Should `sp_record_ring_attempt` exist?** The brief named it as something to `sp_help`. The live DB has no stored procs at all. Confirm with Symbiotic / Node-RED maintainer whether a procedure was planned. If yes, it should be created (and Node-RED retargeted to call it). If no, drop the reference from internal docs.

2. **Maintenance Module — wire it up or hide it?** UI is built, API is built, schema (`maintenance_snapshot`) is missing. Three options: (a) hide the nav entry until Symbiotic writes the table, (b) create the table and stub Node-RED, (c) leave it as a visible placeholder for product-demo reasons. Pick one.

3. **Image Viewer empty state for circlip-scrap parts.** Right now the page says "No images for this part" — true but uninformative for a CIRCLIP_SCRAP DMC that CV-X correctly didn't photograph. Worth adding a context-aware message: "This part failed at the circlip station; no inspection images were captured." Requires the API to know the part's state — small change to the `/part/:dmc/images` route to JOIN through SAM_Log and include the classifier verdict.

4. **Picture_no monotonicity.** Whether to back-fill `ROW_NUMBER() OVER (PARTITION BY DMC, inspection_type, ring_count ORDER BY source_counter)` to make `picture_no` match capture order rather than index order. The UI doesn't strictly need it; QA might.

5. **`tools/generate-license.ts`** workflow. Does the customer have a license? Have they confirmed it? Who owns issuing keys? Unclear from this round.

6. **`release-files/` mirror** — when is the delivery polish pass scheduled? Until then the manual deploy path (this README) is the only path.

7. **Version bump cadence.** Both `package.json`s and the footer all read `2.0.0`. When and how do we cut a `2.1.0`?

8. **Long-term retention behavior with very large image volumes.** The retention sweep is `SELECT id, file_path … WHERE captured_at < DATEADD(day, -@retention_days, SYSDATETIME())`. With years of production traffic, the SELECT could return many rows. Currently runs to completion in one transaction. If volume becomes a problem, batch it.

9. **CV-X clock drift vs SCADA clock.** Observed: CV-X's `yymmdd_hhmmss` session folder names were ~3.5 hours off from the file mtimes. We use mtime, not folder name, so it doesn't matter for matching — but the folder names being out of sync is worth flagging if anyone later relies on them.

10. **What happens if `SAM_Log` schema changes?** The `Date_Time` column type, `Ring_Time` format, addition of new columns — nothing here gracefully handles those. The reader queries are written assuming the exact column set documented in §3.

---

## Final note

The branch `claude/nice-tesla-4371fa` on `origin/SASPL-ORG/Piston_Tracebility` contains all of this work as **10 commits** stacked on top of `main`. The PR was not yet opened at handoff time. Either fast-forward `main` to that branch's HEAD, or open a PR and review the commit history (each commit message is structured and explains what's in it).

The branch's tip when this document was written:

```
176b662 Image Viewer: auto-load on deep-link
2738525 Image matcher: asymmetric tolerance + latest Ring_Time wins; fixes reinspect-attempt cross-pollination
f91313c Image Viewer: show OK/NG counts per group header
f9e43c9 Image ok_flag: handle mssql BIT as JS boolean (UI showed all as OK, retry moved NG files to OK folder)
573ab09 Image matcher: timezone-aware wall-clock comparison; retry deletes on NO_MATCH
79dea0c Fix Part Trace PDF layout; bring it visually closer to the UI
8bd7000 Dashboard polish: equal-height KPI cards, three-color production chart, adaptive bucketing, state distribution donut
63bd984 Add Part Trace PDF report
17fa51c Sanitize Windows-illegal chars in destination paths; document new-system setup
d94c52e Multi-row schema support, multi-attempt UI, and CV-X image integration
```

Read those commit bodies if anything in this document is unclear — they were written contemporaneously with each fix and explain the reasoning. Good luck.
