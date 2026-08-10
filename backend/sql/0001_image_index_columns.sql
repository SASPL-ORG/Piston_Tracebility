-- Image_Index column + index additions for the image-integration round (§5.3).
-- Idempotent: safe to run multiple times. Run on the SCADA box BEFORE
-- deploying the new backend image.
--
-- Verifies/adds: captured_at, ok_flag, camera_id, source_counter,
--                session_folder, pending_match
-- Creates indexes: IX_Image_Pending, IX_Image_Captured, IX_Image_DMC_Type_Attempt

USE SAM;
GO

SET NOCOUNT ON;
GO

-- captured_at (may already exist from earlier migration)
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'captured_at'
)
  ALTER TABLE dbo.Image_Index ADD captured_at DATETIME2 NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'ok_flag'
)
  ALTER TABLE dbo.Image_Index ADD ok_flag BIT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'camera_id'
)
  ALTER TABLE dbo.Image_Index ADD camera_id NVARCHAR(20) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'source_counter'
)
  ALTER TABLE dbo.Image_Index ADD source_counter BIGINT NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'session_folder'
)
  ALTER TABLE dbo.Image_Index ADD session_folder NVARCHAR(50) NULL;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index' AND COLUMN_NAME = 'pending_match'
)
  ALTER TABLE dbo.Image_Index ADD pending_match BIT NOT NULL CONSTRAINT DF_Image_Index_pending_match DEFAULT 0;
GO

-- picture_no must allow NULL: pending rows are inserted before the matcher
-- has resolved them to an attempt, so we don't have a real picture number
-- yet. Resolution updates this to a real value via the retry job.
IF EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Image_Index'
    AND COLUMN_NAME = 'picture_no' AND IS_NULLABLE = 'NO'
)
  ALTER TABLE dbo.Image_Index ALTER COLUMN picture_no INT NULL;
GO

-- Replace UQ_Image (UNIQUE on DMC, inspection_type, ring_count, picture_no)
-- with a filtered unique index that excludes pending rows. SQL Server treats
-- NULL as equal in unique constraints, so the original constraint blocks
-- multiple pending rows (which all have ring_count=NULL, picture_no=NULL)
-- for the same DMC + type. The filtered version preserves the original
-- intent for resolved rows.
IF EXISTS (
  SELECT 1 FROM sys.key_constraints
  WHERE name = 'UQ_Image' AND parent_object_id = OBJECT_ID('dbo.Image_Index')
)
  ALTER TABLE dbo.Image_Index DROP CONSTRAINT UQ_Image;
GO

-- Cleanup in case the auto-created index lingered as a non-constraint index.
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_Image' AND object_id = OBJECT_ID('dbo.Image_Index')
)
  DROP INDEX UQ_Image ON dbo.Image_Index;
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'UQ_Image_Resolved' AND object_id = OBJECT_ID('dbo.Image_Index')
)
  CREATE UNIQUE INDEX UQ_Image_Resolved
    ON dbo.Image_Index(DMC, inspection_type, ring_count, picture_no)
    WHERE pending_match = 0;
GO

-- Filtered index for the retry job's pending scan (small, fast).
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Image_Pending' AND object_id = OBJECT_ID('dbo.Image_Index')
)
  CREATE INDEX IX_Image_Pending ON dbo.Image_Index(pending_match) WHERE pending_match = 1;
GO

-- Retention sweep query.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Image_Captured' AND object_id = OBJECT_ID('dbo.Image_Index')
)
  CREATE INDEX IX_Image_Captured ON dbo.Image_Index(captured_at);
GO

-- Image Viewer per-DMC fetch + nextPictureNo lookup.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Image_DMC_Type_Attempt' AND object_id = OBJECT_ID('dbo.Image_Index')
)
  CREATE INDEX IX_Image_DMC_Type_Attempt ON dbo.Image_Index(DMC, inspection_type, ring_count);
GO

PRINT 'Image_Index migration complete.';
GO
