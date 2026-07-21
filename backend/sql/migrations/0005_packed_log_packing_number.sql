-- 0005_packed_log_packing_number.sql
--
-- Adds a Packing_Number column to dbo.Packed_Log_TEST so the packing
-- history view survives backend restarts and supports filtering by
-- date / shift / hour-of-day. The application's backend tries to ALTER
-- this in itself on first /pack; if its login lacks DDL, that attempt
-- fails silently and we never get persistence. Run THIS script once
-- in SSMS as a login that has ALTER on the SAM database (e.g. sa).
-- Idempotent: re-running is safe.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'Packing_Number' AND Object_ID = OBJECT_ID('dbo.Packed_Log_TEST')
)
BEGIN
  ALTER TABLE dbo.Packed_Log_TEST
  ADD Packing_Number NVARCHAR(20) NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Packed_Log_TEST_Packing_Number'
)
BEGIN
  CREATE INDEX IX_Packed_Log_TEST_Packing_Number
  ON dbo.Packed_Log_TEST (Packing_Number)
  WHERE Packing_Number IS NOT NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_Packed_Log_TEST_Packed_At'
)
BEGIN
  CREATE INDEX IX_Packed_Log_TEST_Packed_At
  ON dbo.Packed_Log_TEST (Packed_At DESC);
END;

-- Confirm
SELECT 'Packing_Number column ready' AS status
WHERE EXISTS (
  SELECT 1 FROM sys.columns
  WHERE Name = 'Packing_Number' AND Object_ID = OBJECT_ID('dbo.Packed_Log_TEST')
);
