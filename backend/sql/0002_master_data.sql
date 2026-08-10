-- Master_Data table: operator-managed reference list of DMCs paired with
-- the defect class they represent (e.g. "Snap Ring Missing"). Used by the
-- Master Data page in the UI. Idempotent — safe to re-run.

USE SAM;
GO

SET NOCOUNT ON;
GO

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Master_Data'
)
  CREATE TABLE dbo.Master_Data (
    id INT IDENTITY(1,1) PRIMARY KEY,
    dmc NVARCHAR(500) NOT NULL,
    identification NVARCHAR(200) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
  );
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Master_Data_CreatedAt' AND object_id = OBJECT_ID('dbo.Master_Data')
)
  CREATE INDEX IX_Master_Data_CreatedAt ON dbo.Master_Data(created_at DESC);
GO
