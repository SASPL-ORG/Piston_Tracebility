@echo off
echo ========================================
echo Starting Piston Traceability Application
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

echo Checking .env file...
if not exist ".env" (
    echo WARNING: .env file not found!
    echo Please copy env.template to .env and configure your database settings.
    echo.
    pause
    exit /b 1
)
echo .env file found.
echo.

echo Creating data directories...
if not exist "data\exports" mkdir "data\exports"
if not exist "data\logs" mkdir "data\logs"
echo.

echo Building and starting containers...
echo This may take a few minutes on first run...
docker-compose up -d --build
if errorlevel 1 (
    echo ERROR: Failed to start containers
    echo.
    echo Check the error messages above for details.
    pause
    exit /b 1
)
echo.

echo Waiting for services to start...
timeout /t 5 /nobreak >nul

echo.
echo ========================================
echo Application started successfully!
echo ========================================
echo.
echo Access the application at:
echo   Local: http://localhost:8080
echo   Network: http://YOUR_SERVER_IP:8080
echo.
echo To stop the application, run stop.bat
echo.
pause
