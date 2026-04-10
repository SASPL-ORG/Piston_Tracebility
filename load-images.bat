@echo off
echo ========================================
echo Loading Docker Images
echo ========================================
echo.

cd /d "%~dp0"

echo Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Desktop is not running!
    echo Please start Docker Desktop and try again.
    pause
    exit /b 1
)
echo Docker Desktop is running.
echo.

echo Loading Docker images...
echo This may take a few minutes...
echo.

echo Loading backend image...
docker load -i docker-images\backend.tar
if errorlevel 1 (
    echo ERROR: Failed to load backend image
    pause
    exit /b 1
)
echo.

echo Loading image-service image...
docker load -i docker-images\image-service.tar
if errorlevel 1 (
    echo ERROR: Failed to load image-service image
    pause
    exit /b 1
)
echo.

echo Loading UI image...
docker load -i docker-images\ui.tar
if errorlevel 1 (
    echo ERROR: Failed to load UI image
    pause
    exit /b 1
)
echo.
echo ========================================
echo Images loaded successfully!
echo ========================================
echo.
pause
