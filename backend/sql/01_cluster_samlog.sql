-- Cluster SAM_Log on (Date_Time, DMC, Ring_Count) and drop the
-- now-redundant Date_Time nonclustered index.
--
-- WHY: Every dashboard / lists / summary query filters by Date_Time
-- first. As a heap, SQL Server has to scan the heap + key-lookup for
-- every matching row. A clustered index on Date_Time turns the date
-- range filter into a single range seek, which keeps the queries
-- sub-second at the 200K-300K-row target.
--
-- HOW TO RUN: connect to SCADA\SQLEXPRESS as sa (or any login with
-- ALTER on dbo.SAM_Log) and execute this file. SAM_Log uses Sam_Piston
-- for the app, which is intentionally not a db_owner -- only run this
-- migration via SSMS or sqlcmd with admin credentials. Safe to run
-- against a live database; with PAGE compression the rebuild is fast
-- even at 300K rows (seconds, not minutes).
--
-- IDEMPOTENT: re-running is a no-op.

USE SAM;
GO

-- 1. Drop the redundant Date_Time nonclustered index. Once the clustered
--    key leads with Date_Time, the optimizer hits the clustered index
--    for range scans instead.
IF EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'IX_SAMLog_DateTime' AND object_id = OBJECT_ID('dbo.SAM_Log')
)
BEGIN
  PRINT 'Dropping IX_SAMLog_DateTime (redundant once clustered)...';
  DROP INDEX IX_SAMLog_DateTime ON dbo.SAM_Log;
END
GO

-- 2. Add the clustered index. Non-unique because in theory two events
--    can land at the exact same Date_Time across DMCs; the real
--    uniqueness is preserved by UQ_SAMLog_DMC_RingCount.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'CX_SAMLog_Date_DMC_Ring' AND object_id = OBJECT_ID('dbo.SAM_Log')
)
BEGIN
  PRINT 'Creating clustered index CX_SAMLog_Date_DMC_Ring...';
  CREATE CLUSTERED INDEX CX_SAMLog_Date_DMC_Ring
    ON dbo.SAM_Log (Date_Time, DMC, Ring_Count)
    WITH (DATA_COMPRESSION = PAGE);
END
GO

-- 3. Verify
PRINT 'Resulting indexes on SAM_Log:';
SELECT i.type_desc, i.name,
  STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
FROM sys.indexes i
JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID('dbo.SAM_Log')
GROUP BY i.type_desc, i.name, i.index_id
ORDER BY i.index_id;
