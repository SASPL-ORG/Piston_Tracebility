-- =============================================================================
-- master_data.sql — operator-editable seed for the 10 master pieces.
--
-- WHAT TO DO BEFORE RUNNING:
--   1. Pick up each of the 10 physical master pieces in turn.
--   2. Read the DMC printed on the part.
--   3. Replace the matching '<DMC_FOR_MASTER_NN>' placeholder below.
--   4. Run this whole file against SAM via SSMS as `sa`.
--
-- THE NAME COLUMN MUST STAY IDENTICAL TO THE LIST BELOW — the UI catalog
-- ordering and the page title both pivot on it. If the line replaces a
-- master piece with one that has a different defect, change the DMC for
-- the existing id, do NOT renumber.
--
-- IDEMPOTENT: re-running with the same values is a no-op; running with
-- updated DMC values rewrites those rows and refreshes updated_at.
-- =============================================================================

USE SAM;
GO

SET NOCOUNT ON;
GO

MERGE dbo.Master_Data AS tgt
USING (VALUES
  (1,  N'Snap Ring Ok master',       N'<DMC_FOR_MASTER_01>', N'CIRCLIP',  1),
  (2,  N'Double Snap Ring',          N'<DMC_FOR_MASTER_02>', N'CIRCLIP',  1),
  (3,  N'Snap Ring Orientation NG',  N'<DMC_FOR_MASTER_03>', N'CIRCLIP',  1),
  (4,  N'Snap Ring Missing',         N'<DMC_FOR_MASTER_04>', N'CIRCLIP',  1),
  (5,  N'Top Ring Missing',          N'<DMC_FOR_MASTER_05>', N'RING',    25),
  (6,  N'2nd Ring Missing',          N'<DMC_FOR_MASTER_06>', N'RING',    25),
  (7,  N'Top Rail Missing',          N'<DMC_FOR_MASTER_07>', N'RING',    25),
  (8,  N'Bottom Rail Missing',       N'<DMC_FOR_MASTER_08>', N'RING',    25),
  (9,  N'Expander Missing',          N'<DMC_FOR_MASTER_09>', N'RING',    25),
  (10, N'Expander Overlap',          N'<DMC_FOR_MASTER_10>', N'RING',    25)
) AS src (id, name, dmc, inspection_type, images_per_attempt)
ON tgt.id = src.id
WHEN MATCHED THEN UPDATE SET
  name               = src.name,
  dmc                = src.dmc,
  inspection_type    = src.inspection_type,
  images_per_attempt = src.images_per_attempt,
  identification     = src.name,   -- keep legacy column in sync
  updated_at         = SYSDATETIME()
WHEN NOT MATCHED THEN INSERT (id, name, dmc, inspection_type, images_per_attempt, identification)
  VALUES (src.id, src.name, src.dmc, src.inspection_type, src.images_per_attempt, src.name);
GO

PRINT 'Master_Data seeded — verify with: SELECT id, name, dmc, inspection_type FROM dbo.Master_Data ORDER BY id;';
GO
