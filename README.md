# Piston Traceability - Client Installation Guide

## Prerequisites

1. **Docker Desktop** - Must be installed and running
   - Download from: https://www.docker.com/products/docker-desktop
   - Install and start Docker Desktop
   - Wait until Docker Desktop is fully running (check system tray)

2. **MS SQL Server** with the `SAM` database already created and the v2.0
   schema in place (`dbo.SAM_Log`, `dbo.Alarm_Log`, `dbo.Image_Index`,
   `dbo.maintenance_snapshot`). If you're starting from an empty SQL Server,
   the v2.0 schema migration must be run before this install.

3. **A SQL login for the application** (e.g. `Sam_Piston`) with `SELECT` on
   `dbo.SAM_Log`. Step 3 of the installation grants the additional
   permissions the image subsystem needs.

4. **SQL Server Management Studio (SSMS)** or `sqlcmd` on the install
   machine — needed to run the schema migration in step 3.

## Installation Steps

1. **Extract the package** to a folder on your server
   - Example: `C:\Piston_Traceability\`

2. **Configure database connection:**
   - Copy `env.template` to `.env`
   - Edit `.env` with your database credentials:
     - `DB_HOST` - SQL Server hostname or IP
     - `DB_PORT` - SQL Server port (usually 1433)
     - `DB_NAME` - Database name (default `SAM`)
     - `DB_USER` - Application SQL login (e.g. `Sam_Piston`)
     - `DB_PASSWORD` - That login's password

   **For Windows:** Use `host.docker.internal\INSTANCE_NAME` for DB_HOST
   **For Linux:** Use the actual IP address or hostname

3. **Apply the database migration and grant permissions** (DBA, one-time per install):

   a. Run the schema migration. In SSMS, connect to the SQL Server, open
      `backend\sql\0001_image_index_columns.sql`, confirm the database
      dropdown is set to `SAM`, then press F5. Or via `sqlcmd`:
      ```powershell
      sqlcmd -S .\SQLEXPRESS -d SAM -E -i backend\sql\0001_image_index_columns.sql
      ```
      The script is idempotent — safe to re-run on upgrades. Expect a
      `Image_Index migration complete.` line and no errors.

   b. Grant the application login the writes the image subsystem needs.
      Run in SSMS against `SAM` (substitute `Sam_Piston` for whichever
      login you set as `DB_USER`):
      ```sql
      USE SAM;
      GRANT INSERT ON dbo.Alarm_Log TO Sam_Piston;
      GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Image_Index TO Sam_Piston;
      ```
      Verify with:
      ```sql
      SELECT OBJECT_NAME(major_id) AS object_name, permission_name, state_desc
      FROM sys.database_permissions p
      JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
      WHERE u.name = 'Sam_Piston'
        AND major_id IN (OBJECT_ID('dbo.Alarm_Log'), OBJECT_ID('dbo.Image_Index'));
      ```
      You should see `Alarm_Log: INSERT GRANT` and the four
      `Image_Index: SELECT/INSERT/UPDATE/DELETE GRANT` rows.

4. **Configure CV-X image folders (Important):**
   - The backend reads from `D:\Keyence - CVX` (CV-X live output) and writes
     organized images to `D:\Records Actual` (DMC-rooted, attempt-grouped).
     Both folders are auto-created by `start.bat` if missing.
   - CV-X VisionEditor must save to `D:\Keyence - CVX` directly (no SMB share
     needed — it's a local path on the SCADA box). See **Image Integration**
     below for the required filename format.
   - To override either path, edit `.env`:
     - `INCOMING_IMAGES_PATH` (container path; default `/data/incoming`)
     - `IMAGES_OUTPUT_PATH` (container path; default `/data/images`)
     - The Windows-side host paths are configured in `docker-compose.yml`
       under the `backend.volumes:` block.

5. **Load Docker images:**
   - Double-click `load-images.bat`
   - Wait for images to load (this may take a few minutes)

6. **Start the application:**
   - Double-click `start.bat`
   - Wait for containers to start (~10 seconds)

7. **Access the application:**
   - Open browser: `http://localhost:8080`
   - Or from network: `http://YOUR_SERVER_IP:8080`

8. **Smoke-test the install:**
   - The dashboard should load with KPI tiles all showing `0` for an
     empty database, or current production numbers if data exists.
   - `http://localhost:8080/api/health` should return
     `{"status":"ok","db":"connected","timestamp":"..."}`.
   - `http://localhost:8080/api/admin/images/pending` should return
     `{"count":0,"items":[]}` until CV-X starts writing images.

## Updating an existing install

When pulling a new build over an existing install:

1. Stop the application: `stop.bat`
2. Replace the package files (preserve `.env` and `data\license\`)
3. Re-run any new SQL migrations from `backend\sql\` (idempotent — safe
   to re-apply ones that already ran)
4. If `env.template` has new variables, copy them into your `.env`
5. `load-images.bat` to load the updated containers
6. `start.bat`

## Stopping the Application

- Double-click `stop.bat`

## Network Access Setup

To allow clients to access via IP address:

1. **Find your server IP:**
   - Open Command Prompt
   - Run: `ipconfig`
   - Note the IPv4 Address (e.g., 192.168.1.100)

2. **Configure Windows Firewall:**
   - Open Windows Defender Firewall
   - Allow port 8080 (or 80 if changed)
   - Block port 3000 (backend should not be accessible)

3. **Clients access:**
   - `http://YOUR_SERVER_IP:8080`

## Security

- **Backend API is NOT directly accessible** from network
- Only nginx port (8080) is exposed
- All API calls go through nginx reverse proxy
- Clients can only access the web UI

## Image Integration

The backend container watches `D:\Keyence - CVX` for new CV-X images, matches
them to the corresponding `SAM_Log` inspection event, and moves each image
into a structured destination tree under `D:\Records Actual`.

### CV-X side

1. **Save folder rule** (configured in CV-X VisionEditor, Image Save settings):
   - Save to: `D:\Keyence - CVX\[yymmdd]_[hhmmss]\[CAMn]\[CAM Judgment]\`
2. **Filename rule**:
   - `{DMC_SUFFIX}_{OK_FLAG}_CAM{N}_{COUNTER:10digits}.jpg`
   - `DMC_SUFFIX` is the part of the DMC after the static prefix; the camera
     strips the prefix automatically.
   - `OK_FLAG`: `0` = OK, `1` = NG (per-image quality flag).
   - `CAM1` = Ring camera, `CAM2` = Circlip camera (overridable via env).
3. The session folder name (`yymmdd_hhmmss`) is just a storage bucket — the
   backend uses the SAM_Log timestamps, not the folder name, to group images
   into inspection events. CV-X is allowed to split a single inspection across
   multiple session folders.

### Destination layout

The backend writes to `D:\Records Actual\<DMC>\<CIRCLIP|RING>\attempt_<N>\<OK|NG>\<original-filename>.jpg`.
This makes images discoverable both from the UI (Image Viewer page) and by
hand on the file system. Original filenames are preserved.

Characters in the DMC that Windows forbids in file paths (`< > : " | ? *`)
are replaced with `_` in the on-disk directory name only — the DMC stored
in `dbo.Image_Index` and returned by the API is unchanged. So a DMC of
`[)>.06-VTH16-P234102M110-T260414P501AC8A0092-DB70` lands in
`D:\Records Actual\[)_.06-VTH16-P234102M110-T260414P501AC8A0092-DB70\…`.

### Tunables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DMC_STATIC_PREFIX` | `[)>.06-VTH16-P234102` | The fixed prefix the camera strips |
| `CAM_RING` / `CAM_CIRCLIP` | `CAM1` / `CAM2` | CAM-to-inspection-type mapping |
| `EXPECTED_RING_PICTURES_PER_ATTEMPT` | `25` | Drives the "Missing N images" badge |
| `EXPECTED_CIRCLIP_PICTURES_PER_ATTEMPT` | `1` | Same, for circlip |
| `IMAGE_MATCH_TOLERANCE_SECONDS` | `300` | ± window when matching image to SAM_Log |
| `IMAGE_PENDING_TIMEOUT_MINUTES` | `15` | How long to wait for a SAM_Log row before giving up |
| `IMAGE_FILE_HANDLING` | `move` | `move` or `copy` |
| `IMAGE_RETENTION_DAYS` | `365` | Daily FIFO purge |
| `IMAGE_WATCH_USE_POLLING` | `true` | inotify is unreliable across Windows bind-mounts |

## Troubleshooting

### Port already in use
- Change nginx port in `docker-compose.yml`: `"8081:80"`

### Database connection errors
- Check `.env` file has correct credentials
- Verify SQL Server is accessible from Docker
- For Windows: Use `host.docker.internal` as hostname

### Application not accessible
- Check Docker containers: `docker ps`
- Check logs: `docker-compose logs`
- Verify firewall allows port 8080

### Images not appearing
- Verify CV-X is writing files into `D:\Keyence - CVX` on the SCADA box.
- Confirm the bind mount in `docker-compose.yml` resolves: from inside the
  backend container, `/data/incoming` should list incoming files.
- Check the indexer has not stalled: `docker-compose logs backend | findstr "[images]"`.
- Check the pending queue: `GET /api/admin/images/pending` — files that
  arrived before their SAM_Log row land here and resolve via the 1-minute
  retry job.
- Alarm log table `dbo.Alarm_Log` records `IMAGE_PARSE_FAIL` (filename
  didn't match) and `IMAGE_NO_INSPECTION_FOUND` (timed out without a SAM_Log
  match) for diagnosis.

## Support

For issues, contact your system administrator.
