-- =============================================================================
-- 0003_master_data_and_image_index.sql
--
-- Two coupled changes for the Master Data image-matching fix:
--   1. Extend dbo.Master_Data with the columns the new catalog API needs
--      (name, inspection_type, images_per_attempt, active, updated_at) and
--      backfill them from the existing rows.
--   2. Add an is_master flag + supporting index to dbo.Image_Index so master
--      captures and production captures live in the same table but can be
--      queried distinctly.
--
-- IDEMPOTENT: re-running is a no-op once each piece is in place.
--
-- HOW TO RUN: open SSMS connected to SCADA\SQLEXPRESS as `sa` (or any login
-- with ALTER on the SAM database) and execute against the SAM database. The
-- app user `Sam_Piston` deliberately does NOT have DDL — do not try to run
-- this from inside the backend container.
-- =============================================================================

USE SAM;
GO

SET NOCOUNT ON;
GO

-- -----------------------------------------------------------------------------
-- 1. dbo.Master_Data
-- -----------------------------------------------------------------------------
-- The table was first created by 0002_master_data.sql with columns
--   (id IDENTITY, dmc, identification, created_at).
-- We additively migrate to the new shape without dropping `identification`
-- (any read-side outside the app could still depend on it).

-- 1a. Table exists check + create-if-missing (for fresh installs).
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Master_Data'
)
BEGIN
  PRINT 'Creating dbo.Master_Data from scratch...';
  CREATE TABLE dbo.Master_Data (
    id                  INT             NOT NULL PRIMARY KEY,
    name                NVARCHAR(100)   NOT NULL,
    dmc                 NVARCHAR(500)   NOT NULL,
    identification      NVARCHAR(200)   NULL,        -- legacy alias of `name`
    inspection_type     NVARCHAR(20)    NOT NULL,    -- 'CIRCLIP' | 'RING'
    images_per_attempt  INT             NOT NULL,
    active              BIT             NOT NULL DEFAULT 1,
    created_at          DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    updated_at          DATETIME2       NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_Master_Data_DMC UNIQUE (dmc)
  );
END
GO

-- 1b. ADD COLUMNs idempotently when migrating an existing 0002-shaped table.
IF COL_LENGTH('dbo.Master_Data', 'name') IS NULL
BEGIN
  PRINT 'Adding dbo.Master_Data.name...';
  ALTER TABLE dbo.Master_Data ADD name NVARCHAR(100) NULL;
END
GO

IF COL_LENGTH('dbo.Master_Data', 'inspection_type') IS NULL
BEGIN
  PRINT 'Adding dbo.Master_Data.inspection_type...';
  ALTER TABLE dbo.Master_Data ADD inspection_type NVARCHAR(20) NULL;
END
GO

IF COL_LENGTH('dbo.Master_Data', 'images_per_attempt') IS NULL
BEGIN
  PRINT 'Adding dbo.Master_Data.images_per_attempt...';
  ALTER TABLE dbo.Master_Data ADD images_per_attempt INT NULL;
END
GO

IF COL_LENGTH('dbo.Master_Data', 'active') IS NULL
BEGIN
  PRINT 'Adding dbo.Master_Data.active...';
  ALTER TABLE dbo.Master_Data ADD active BIT NOT NULL CONSTRAINT DF_Master_Data_active DEFAULT 1;
END
GO

IF COL_LENGTH('dbo.Master_Data', 'updated_at') IS NULL
BEGIN
  PRINT 'Adding dbo.Master_Data.updated_at...';
  ALTER TABLE dbo.Master_Data ADD updated_at DATETIME2 NOT NULL CONSTRAINT DF_Master_Data_updated_at DEFAULT SYSDATETIME();
END
GO

-- 1c. Backfill new columns from existing rows. Catalog convention from the
-- old in-code SEED_ROWS:  ids 1-4 are CIRCLIP/1-image masters,  ids 5-10 are
-- RING/25-image masters. Operator can override per-row if a particular
-- master changes type later.
UPDATE dbo.Master_Data
SET name = ISNULL(name, identification)
WHERE name IS NULL AND identification IS NOT NULL;
GO

UPDATE dbo.Master_Data
SET inspection_type =
  CASE WHEN id <= 4 THEN N'CIRCLIP' ELSE N'RING' END
WHERE inspection_type IS NULL;
GO

UPDATE dbo.Master_Data
SET images_per_attempt =
  CASE WHEN id <= 4 THEN 1 ELSE 25 END
WHERE images_per_attempt IS NULL;
GO

-- 1d. Tighten the new columns to NOT NULL once they're populated.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Master_Data')
    AND name = 'name' AND is_nullable = 1
)
  ALTER TABLE dbo.Master_Data ALTER COLUMN name NVARCHAR(100) NOT NULL;
GO

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Master_Data')
    AND name = 'inspection_type' AND is_nullable = 1
)
  ALTER TABLE dbo.Master_Data ALTER COLUMN inspection_type NVARCHAR(20) NOT NULL;
GO

IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.Master_Data')
    AND name = 'images_per_attempt' AND is_nullable = 1
)
  ALTER TABLE dbo.Master_Data ALTER COLUMN images_per_attempt INT NOT NULL;
GO

-- 1e. Unique-by-DMC constraint (matcher relies on a single Master_Data row
-- per DMC). Skipped if it already exists.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_Master_Data_DMC' AND object_id = OBJECT_ID('dbo.Master_Data')
)
  ALTER TABLE dbo.Master_Data ADD CONSTRAINT UQ_Master_Data_DMC UNIQUE (dmc);
GO

-- -----------------------------------------------------------------------------
-- 2. dbo.Image_Index.is_master
-- -----------------------------------------------------------------------------
IF COL_LENGTH('dbo.Image_Index', 'is_master') IS NULL
BEGIN
  PRINT 'Adding dbo.Image_Index.is_master...';
  ALTER TABLE dbo.Image_Index
    ADD is_master TINYINT NOT NULL CONSTRAINT DF_Image_Index_is_master DEFAULT 0;
END
GO

-- Filtered index for the Master Data query — only the (very small) set of
-- rows where is_master = 1 is indexed, so it costs little on insert but
-- makes the per-DMC-per-date master lookup a single seek.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes WHERE name = 'IX_Image_Index_master_lookup'
)
  CREATE INDEX IX_Image_Index_master_lookup
    ON dbo.Image_Index (DMC, inspection_type, captured_at)
    WHERE is_master = 1;
GO

PRINT 'Migration 0003 complete.';
GO
