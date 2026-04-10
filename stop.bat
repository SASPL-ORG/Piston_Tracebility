@echo off
echo ========================================
echo Stopping Piston Traceability Application
echo ========================================
echo.

cd /d "%~dp0"

echo Stopping containers...
docker-compose down
if errorlevel 1 (
    echo WARNING: Some containers may not have stopped properly
) else (
    echo.
    echo Application stopped successfully.
)
echo.
pause
