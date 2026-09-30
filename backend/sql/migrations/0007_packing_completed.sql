-- 0007_packing_completed.sql
-- Persist which pallets the operator has closed via "Print & Complete", so a
-- backend restart's reseed never resurrects a finished pallet as the active one
-- (the "pallet full keeps coming back" bug).
--
-- The backend tries to CREATE this table lazily on startup, but the runtime
-- login (Sam_Piston) has no DDL rights ("CREATE TABLE permission denied"), so
-- run this once as a DDL-privileged login (e.g. sa) to enable persistence.
-- Until then the seed still avoids the bug via its chronological + skip-full
-- heuristics; this table only additionally makes an EARLY complete of a
-- partial pallet survive a restart.
--
-- Idempotent: safe to run more than once.

IF OBJECT_ID('dbo.Packing_Completed', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Packing_Completed (
        Packing_Number NVARCHAR(20) NOT NULL PRIMARY KEY,
        Completed_At   DATETIME2    NOT NULL
            CONSTRAINT DF_Packing_Completed_At DEFAULT SYSUTCDATETIME()
    );
END;

-- Let the backend's runtime login read + write the completion markers.
-- (No effect if the login/role already has these rights.)
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'Sam_Piston')
BEGIN
    GRANT SELECT, INSERT, DELETE ON dbo.Packing_Completed TO [Sam_Piston];
END;
