-- 0004_packing_events.sql
--
-- Run ONCE in SSMS as a login that has CREATE TABLE on the SAM database
-- (the application's backend login does not, by design — narrow blast
-- radius). Idempotent: re-running is safe.
--
-- After this script lands, the backend's lazy ensurePackingTable() will
-- see IF NOT EXISTS = exists, skip the CREATE, and the INSERT in
-- persistPackingEvent() will succeed. /api/packing/today-stats will then
-- return source:"db" with real per-day counts.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables
  WHERE name = 'Packing_Events' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.Packing_Events (
    Id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    Ts              DATETIME2     NOT NULL,
    Device          NVARCHAR(64)  NOT NULL,
    Selected_Grade  NVARCHAR(64)  NOT NULL,
    Scanned_Grade   NVARCHAR(64)  NOT NULL,
    DMC             NVARCHAR(255) NULL,
    Result          NVARCHAR(32)  NOT NULL,
    Ok              BIT           NOT NULL,
    Message         NVARCHAR(512) NOT NULL,
    Received_At     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Packing_Events_Ts' AND object_id = OBJECT_ID('dbo.Packing_Events')
)
BEGIN
  CREATE INDEX IX_Packing_Events_Ts ON dbo.Packing_Events (Ts DESC);
END;

-- Confirm
SELECT TOP 1 'Packing_Events ready' AS status
FROM sys.tables WHERE name = 'Packing_Events' AND schema_id = SCHEMA_ID('dbo');
