# Piston Traceability — Installation & Operations Guide

On-premise traceability and quality-record system for the piston assembly
line. Reads inspection data written by the PLC via Node-RED into MS SQL
Server, and organises the Keyence CV-X camera images that go with it.

> **This app never writes to `dbo.SAM_Log`.** Node-RED owns those writes. The
> app is a read-only consumer of production data, plus the owner of the image
> index, master data, packing log and tool-life tables.

---

## What this version includes

Beyond the original traceability pages (Dashboard, Lists, Part Trace, Images):

| Page / feature | What it does |
|---|---|
| **Machine Status** | Production / Machine Hold / Idle / Down time over a window, with an alarm-wise fault-duration table. Reads `dbo.vw_machine_state`. |
| **Packing** + **Packing Monitor** | Mirrors the handheld (Zebra) packing station scan verdicts in real time; packing history and label printing. |
| **Master Data** | Manage master/reference sample pieces, grouped by date. |
| **Tool Life** (on Maintenance) | Per-tool Produced / Quantity Left with admin-gated edit and reset. |
| **PLC Alarms log** (on Maintenance → Tools) | Searchable, filterable ON/OFF alarm history from `dbo.PLC_Alarms`. |
| **Shift & plant filters** | Scope KPIs, charts and lists by shift (A/B/C) and plant/line. |
| **Self-healing DB layer** | Automatic reconnect after a SQL Server restart, plus a container healthcheck. |
| **Image thumbnails** | Grid uses cached ~3 KB thumbnails instead of full-size JPEGs. |

---

## Prerequisites

1. **Docker Desktop** — installed and running.
   Download: https://www.docker.com/products/docker-desktop

2. **MS SQL Server** with the `SAM` database. Required objects:

   | Object | Owner | Notes |
   |---|---|---|
   | `dbo.SAM_Log` | Node-RED | Core production data |
   | `dbo.PLC_Alarms` | Node-RED | Machine alarm history |
   | `dbo.Machine_State` + `vw_machine_state`, `vw_machine_alarms`, `vw_machine_parts` | Node-RED | Required by Machine Status |
   | `dbo.Alarm_Log`, `dbo.Image_Index` | this app | Created/extended by migrations |
   | `dbo.Master_Data`, `dbo.Packing_Events`, `dbo.Packed_Log_TEST` | this app | Created by migrations |

   `dbo.maintenance_snapshot` is **not** required — the original Maintenance
   Module was never built. The Maintenance page now hosts Tool Life and the
   PLC Alarms log instead.

3. **A SQL login for the application** (e.g. `Sam_Piston`). Simplest working
   setup is membership of **`db_datareader` + `db_datawriter`** on `SAM`.
   It deliberately has **no DDL rights** — migrations are run by a DBA.

4. **SSMS or `sqlcmd`** on the install machine, and a login with **DDL rights**
   (a sysadmin, or your DBA account) to run the migrations in step 3.

---

## Installation

### 1. Extract the package

Example: `C:\Piston_Traceability\`

### 2. Configure the database connection

Copy `env.template` to `.env` and set:

```env
DB_HOST=host.docker.internal
DB_PORT=1433
DB_NAME=SAM
DB_USER=Sam_Piston
DB_PASSWORD=<your password>
DB_TRUST_SERVER_CERTIFICATE=true
TZ=Asia/Kolkata
```

> ### ⚠️ Do NOT put the instance name in `DB_HOST`
>
> Use `host.docker.internal` — **not** `host.docker.internal\SQLEXPRESS`.
>
> When an instance name is present, the SQL driver ignores `DB_PORT` and asks
> **SQL Browser over UDP 1434** which port the instance uses. That UDP lookup
> does not work reliably from inside a Docker container, so every query hangs
> for 15 s and fails with `ETIMEOUT`, even though SQL Server is healthy.
>
> **Requirement:** SQL Server must listen on a **static TCP port** (normally
> 1433). In SQL Server Configuration Manager → *Protocols* → *TCP/IP* →
> *IPAll*, set **TCP Port = 1433** and clear **TCP Dynamic Ports**. Restart
> the SQL Server service. Confirm with:
> ```powershell
> sqlcmd -S tcp:127.0.0.1,1433 -U Sam_Piston -P <password> -d SAM -Q "SELECT 1"
> ```

For SQL Server on another machine, use its IP/hostname instead of
`host.docker.internal`.

### 3. Apply database migrations (DBA, one-time per install)

Run **in order**, against the `SAM` database, as a login with DDL rights
(`-E` uses your Windows login):

```powershell
cd backend\sql
sqlcmd -S localhost -E -C -d SAM -b -i "0001_image_index_columns.sql"
sqlcmd -S localhost -E -C -d SAM -b -i "0002_master_data.sql"
cd migrations
sqlcmd -S localhost -E -C -d SAM -b -i "0003_master_data_and_image_index.sql"
sqlcmd -S localhost -E -C -d SAM -b -i "0004_packing_events.sql"
sqlcmd -S localhost -E -C -d SAM -b -i "0005_packed_log_packing_number.sql"
```

All are idempotent — safe to re-run on upgrades.

Optional: `backend\sql\01_cluster_samlog.sql` (indexing for large `SAM_Log`),
and `backend\sql\seeds\master_data.sql` (sample master-data rows).

**Then grant the app login its permissions:**

```sql
USE SAM;
ALTER ROLE db_datareader ADD MEMBER Sam_Piston;
ALTER ROLE db_datawriter ADD MEMBER Sam_Piston;
```

Verify:
```sql
USE SAM;
SELECT r.name AS role_name
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
WHERE u.name = 'Sam_Piston';
```

> **Note on `sqlcmd` vs SSMS:** `sqlcmd` connects with `QUOTED_IDENTIFIER OFF`,
> which breaks filtered-index creation. Migration 0005 sets it explicitly, so
> both clients work — but if you write new migrations with filtered indexes,
> include `SET QUOTED_IDENTIFIER ON;` and separate DDL batches with `GO`.

### 4. Configure the CV-X image folders

The backend reads `D:\Keyence - CVX` and writes organised images to
`D:\Records Actual`. Both are auto-created by `start.bat` if missing, and are
mapped in `docker-compose.yml` under `backend.volumes:`.

CV-X VisionEditor must save directly to `D:\Keyence - CVX` (local path — no
SMB share needed). See **Image Integration** below for the filename format.

### 5. Load Docker images

Double-click `load-images.bat` (offline installs only; skip if building from
source).

### 6. Start

Double-click `start.bat`, or:
```powershell
docker compose up -d --build
```

### 7. Access

- Local: `http://localhost:8080`
- Network: `http://YOUR_SERVER_IP:8080`

### 8. Smoke-test

```powershell
curl http://localhost:8080/api/health
```

Expected:
```json
{
  "status": "ok",
  "sql":          { "connected": true,  "lastErrorAt": null, "host": "host.docker.internal" },
  "imageWatcher": { "running": true, "path": "/data/incoming", "totalProcessed": 0 }
}
```

Both `sql.connected` and `imageWatcher.running` must be `true`. Also check:
```powershell
docker ps        # traceability-backend should show (healthy) within ~90s
```

---

## Environment reference (`.env`)

### Database
| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` | `localhost` | **No instance name** — see the warning above |
| `DB_PORT` | `1433` | Must be SQL Server's static TCP port |
| `DB_NAME` | `SAM` | |
| `DB_USER` / `DB_PASSWORD` | — | Application login |
| `DB_TRUST_SERVER_CERTIFICATE` | `true` | |
| `DB_POOL_MAX` | driver default | Max pooled connections |

### Service
| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | |
| `TZ` | `UTC` | **Set to `Asia/Kolkata`** (see below) |
| `LICENSE_PATH` | `/data/license` | Activation file location |

> **`TZ` is critical.** The PLC writes `Circlip_Time` / `Ring_Time` as
> wall-clock strings with no timezone, and the image matcher compares file
> mtimes against them using local-time components. If the container runs UTC
> while the data is IST, **every image fails to match** (5½ h offset).
> The backend image now installs `tzdata`, so `TZ` takes effect properly —
> verify with `docker exec traceability-backend date` (should print `IST`).

### Image integration
| Variable | Effective default | Purpose |
|---|---|---|
| `INCOMING_IMAGES_PATH` | `/data/incoming` | Container path for CV-X output |
| `IMAGES_OUTPUT_PATH` | `/data/images` | Container path for organised images |
| `DMC_STATIC_PREFIX` | `[)>.06-VTH16-P234102` | Prefix the camera strips |
| `CAM_RING` / `CAM_CIRCLIP` | `CAM1` / `CAM2` | Camera-to-inspection mapping |
| `EXPECTED_RING_PICTURES_PER_ATTEMPT` | `25` | Drives "Missing N images" badge |
| `EXPECTED_CIRCLIP_PICTURES_PER_ATTEMPT` | `1` | Same, for circlip |
| `IMAGE_MATCH_TOLERANCE_SECONDS` | `900` (compose) | Max seconds image mtime may be **after** the PLC timestamp |
| `IMAGE_MATCH_PRE_TOLERANCE_SECONDS` | `900` (compose) | Max seconds **before** |
| `IMAGE_PENDING_TIMEOUT_MINUTES` | `15` | How long to wait for a `SAM_Log` row |
| `IMAGE_QUARANTINE_FILE_AGE_MINUTES` | `240` | Unmatched files older than this are moved to `_quarantine_<date>` |
| `IMAGE_SCAN_INTERVAL_MS` | `5000` | Folder scan cadence — see note |
| `IMAGE_WORKER_COUNT` | `4` | Concurrent match/move workers — see note |
| `IMAGE_WATCHDOG_SECONDS` | — | Restarts the watcher if it goes silent |
| `IMAGE_FILE_HANDLING` | `move` | `move` or `copy` |
| `IMAGE_RETENTION_DAYS` | `365` | Daily FIFO purge of indexed images |
| `IMAGE_WATCH_USE_POLLING` | `true` | inotify is unreliable over Windows bind-mounts |

> **Don't lower `IMAGE_SCAN_INTERVAL_MS` or raise `IMAGE_WORKER_COUNT`
> casually.** A 500 ms scan over a large incoming folder hammered SQL Server
> hard enough to block reporting queries (30 s dashboard timeouts). Raising
> workers to 16 made throughput *worse* — they all deadlocked on request
> timeouts. 5 s / 4 workers is a tuned, tested combination.

### Tool Life admin gate
| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Login for editing tool limits |
| `ADMIN_PASSWORD` | *(empty)* | **Must be set** — when empty the backend returns 503 and edits are blocked |

### Node-RED tool-life webhook (PLC stop signal)
| Variable | Default | Purpose |
|---|---|---|
| `NODE_RED_TOOL_LIFE_WEBHOOK_URL` | *(empty)* | Node-RED HTTP-In endpoint fired when a tool's life is exhausted |
| `NODE_RED_WEBHOOK_TOKEN` | *(empty)* | Optional; sent as `Authorization: Bearer` |

> ⚠️ Leaving the URL **empty disables the PLC stop signal** — the UI still
> shows the exhaustion alert. Only populate it once the PLC wiring is
> verified; it latches `DB1000.DBX682.0` ("Tool Life Count Reached") and the
> PLC owns the reset. See `docs/TOOL_LIFE_PLC_WIRING.md`.

### Machine Status
| Variable | Default | Purpose |
|---|---|---|
| `ALARM_EXCLUDE` | *(empty)* | Comma-separated alarm names excluded from the "alarms during faults" table only. Never affects the Production/Hold/Idle headline math. |

---

## Image Integration

### CV-X side

1. **Save folder:** `D:\Keyence - CVX\[yymmdd]_[hhmmss]\[CAMn]\[CAM Judgment]\`
2. **Filename:** `{DMC_SUFFIX}_{OK_FLAG}_CAM{N}_{COUNTER:10digits}.jpg`
   - `DMC_SUFFIX` — the DMC after the static prefix (camera strips it)
   - `OK_FLAG` — `0` = OK, `1` = NG
   - `CAM1` = Ring, `CAM2` = Circlip
3. Session folder names are only storage buckets — matching uses `SAM_Log`
   timestamps, so one inspection may span several session folders.

### Destination layout

```
D:\Records Actual\<DMC>\<CIRCLIP|RING>\attempt_<N>\<OK|NG>\<original-filename>.jpg
```

Windows-illegal characters (`< > : " | ? *`) are replaced with `_` in the
**folder name only** — the DMC stored in `Image_Index` and returned by the API
is unchanged.

### Folders the app creates inside the incoming directory

| Folder | Contents |
|---|---|
| `_quarantine_<date>` | Images that never matched a `SAM_Log` row. **Excluded from scanning** — they will not be retried. |
| `_hold*` | Reserved; also excluded from scanning |

Under `IMAGES_OUTPUT_PATH`:

| Folder | Contents |
|---|---|
| `__thumbs` | Cached ~3 KB grid thumbnails, generated on first view. Safe to delete — it rebuilds on demand. |

### When images don't match

An image can only attach to a part that has a matching inspection row. A
**ring** image needs a non-NULL `Ring_Time` for that DMC. If Node-RED wasn't
writing to SQL when the image was captured, that row never exists and the
image is unmatched forever — it lands in `_quarantine_<date>`.

Quarantined files are **never deleted automatically**. Review and clear them
periodically.

---

## Routine maintenance

### Prune `dbo.Alarm_Log` — important

There is **no retention job for alarms.** `IMAGE_NO_INSPECTION_FOUND` rows can
accumulate very quickly when images go unmatched — on one install this table
reached **22.5 million rows / 14.9 GB**.

Check size:
```sql
USE SAM;
SELECT alarm_code, COUNT(*) FROM dbo.Alarm_Log GROUP BY alarm_code ORDER BY 2 DESC;
```

Prune in batches (avoids a huge transaction log):
```sql
USE SAM;
SET NOCOUNT ON;
DECLARE @n INT = 1;
WHILE @n > 0
BEGIN
    DELETE TOP (50000) FROM dbo.Alarm_Log
    WHERE alarm_code = 'IMAGE_NO_INSPECTION_FOUND'
      AND ts < DATEADD(day, -30, SYSDATETIME());
    SET @n = @@ROWCOUNT;
END
```

Nothing in the application reads `Alarm_Log` — it is a write-only diagnostic
log, so pruning it is safe. (The alarms shown in the UI come from
`dbo.PLC_Alarms`, a different table — never prune that without checking.)

### Keep the incoming folder small

Clear old `_quarantine_<date>` folders and empty session folders. A very large
incoming folder slows the scan and delays new images.

### Thumbnails

First view of an image generates its thumbnail (~135 ms vs ~60 ms cached). To
pre-warm after a bulk import, request the thumb endpoint for recent image IDs:
`GET /api/image/<id>/thumb`.

---

## Updating an existing install

1. `stop.bat`
2. Replace package files — **preserve `.env` and `data\license\`**
3. Run any new migrations from `backend\sql\` and `backend\sql\migrations\`
4. Copy any new variables from `env.template` into your `.env`
5. `load-images.bat` (offline installs) then `start.bat`
6. Verify `/api/health` shows `sql.connected: true` and
   `imageWatcher.running: true`

---

## Network access & security

1. Find the server IP with `ipconfig`.
2. Windows Defender Firewall: allow **8080**, block **3000**.
3. Clients browse to `http://YOUR_SERVER_IP:8080`.

Only nginx (8080) is exposed. The backend and UI containers are not
reachable from the network; all API traffic goes through the reverse proxy.

---

## Troubleshooting

### `ETIMEOUT` / dashboard shows "Internal Server Error"
Almost always `DB_HOST` containing an instance name. Set
`DB_HOST=host.docker.internal` with `DB_PORT=1433`, ensure SQL Server has a
static TCP port, then `docker compose up -d backend`.

### App worked, then stopped after a SQL Server restart
The connection pool went stale. This build reconnects automatically and the
container healthcheck restarts a wedged backend; if you're on an older build,
`docker compose up -d backend` restores it.

### Container shows `(unhealthy)` but the app works
The healthcheck must probe `127.0.0.1`, not `localhost` — inside the container
`localhost` resolves to IPv6 `::1` first and the server binds IPv4 only, so
every probe fails. Already fixed in `docker-compose.yml`.

### Images not appearing
1. Confirm CV-X is writing into `D:\Keyence - CVX`.
2. `docker exec traceability-backend ls /data/incoming` — the bind mount must resolve.
3. `curl http://localhost:8080/api/health` — check `imageWatcher.running` and whether `totalProcessed` is climbing.
4. `docker logs traceability-backend | findstr "[images]"`.
5. `GET /api/admin/images/pending` — images awaiting their `SAM_Log` row.
6. Check `dbo.Alarm_Log` for `IMAGE_PARSE_FAIL` (bad filename) and
   `IMAGE_NO_INSPECTION_FOUND` (no matching inspection row).
7. Check `_quarantine_<date>` — a large number there means inspection rows
   aren't being written; investigate Node-RED/PLC, not the app.

### Image page slow to load
Expected on parts with hundreds of images (re-inspections) the first time —
thumbnails generate on demand. The grid loads 48 at a time; use "Show all" if
you need the rest. Subsequent views are cached.

### Parts stuck showing "In Progress"
A part stays IN_PROGRESS until a ring result is written. Rows with no circlip
**and** no ring result were scanned onto the line but never inspected — a line
or PLC issue, not an app fault. Lists flags these with a **Stale** chip after
2 hours.

### Node-RED shows "Login failed for user ''"
Node-RED's stored DB credentials were lost (its `flows_cred.json` is separate
from this app). Re-enter user/password in the MSSQL config node and Deploy.
Set a fixed `credentialSecret` in Node-RED's `settings.js` first, otherwise a
reinstall silently invalidates saved credentials again.

### Port already in use
Change the nginx mapping in `docker-compose.yml`: `"8081:80"`.

---

## Support

For issues, contact your system administrator.
