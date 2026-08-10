-- 0006_station_events.sql
--
-- Per-station traceability log. One row is written each time a piston
-- COMPLETES a station, captured live by Node-RED from DB1000's per-station
-- structs (INFEED BARCODE .. UNLOAD STATION). This is what turns the Part
-- Trace Event Timeline from a fixed placeholder list into a real,
-- station-by-station movement trace with a timestamp + pass/fail per station.
--
-- Run ONCE in SSMS (or sqlcmd) as a login with CREATE TABLE on SAM. The app
-- login Sam_Piston has no DDL by design; it already gets SELECT/INSERT on new
-- tables via db_datareader/db_datawriter, so no explicit GRANT is needed.
-- Idempotent: safe to re-run.

SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

USE SAM;
GO

IF OBJECT_ID('dbo.Station_Events', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Station_Events (
    Id            BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    DMC           NVARCHAR(255) NOT NULL,          -- full DMC of the piston
    Station_No    INT           NOT NULL,          -- 1..18, physical line order
    Station_Name  NVARCHAR(60)  NOT NULL,          -- e.g. 'CIRCLIP STATION'
    Event_Time    NVARCHAR(50)  NOT NULL,          -- server wall-clock string,
                                                   -- stamped at completion (like
                                                   -- Circlip_Time / Ring_Time)
    Result        NVARCHAR(20)  NULL,              -- 'OK' | 'NOT_OK' | 'ABNORMAL'
    Reason        NVARCHAR(255) NULL,              -- station reject reason, if any
    Barcode       NVARCHAR(255) NULL,              -- barcode read at that station
    Received_At   DATETIME2     NOT NULL
                    CONSTRAINT DF_Station_Events_Received DEFAULT SYSDATETIME()
  );
  -- Part Trace reads all rows for a DMC in station order.
  CREATE INDEX IX_Station_Events_DMC ON dbo.Station_Events (DMC, Station_No);
  PRINT 'Created dbo.Station_Events.';
END
ELSE
  PRINT 'dbo.Station_Events already exists - no change.';
GO

-- No UNIQUE(DMC, Station_No): a re-inspected part can legitimately pass a
-- station more than once; the app groups by station and takes the latest.

SELECT 'Station_Events ready' AS status
WHERE OBJECT_ID('dbo.Station_Events', 'U') IS NOT NULL;
GO
