@echo off
echo ================================================
echo  Piston Traceability - Build Release Package
echo  Symbiotic Automation Systems
echo ================================================
echo.

cd /d "%~dp0"

:: Check Docker
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Desktop is not running!
    pause
    exit /b 1
)

:: Set version
set VERSION=2.0.0
set RELEASE_DIR=release\Piston_Traceability_v%VERSION%

echo [1/5] Building Docker images from source...
echo.
docker-compose build
if errorlevel 1 (
    echo ERROR: Docker build failed!
    pause
    exit /b 1
)
echo.
echo Images built successfully.
echo.

echo [2/5] Exporting Docker images to .tar files...
echo.
if not exist "%RELEASE_DIR%\docker-images" mkdir "%RELEASE_DIR%\docker-images"

docker save piston_traceability_v100-backend:latest -o "%RELEASE_DIR%\docker-images\backend.tar"
if errorlevel 1 (
    echo ERROR: Failed to export backend image
    pause
    exit /b 1
)
echo   - backend.tar exported

docker save piston_traceability_v100-ui:latest -o "%RELEASE_DIR%\docker-images\ui.tar"
if errorlevel 1 (
    echo ERROR: Failed to export UI image
    pause
    exit /b 1
)
echo   - ui.tar exported
echo.

echo [3/5] Copying deployment files...
echo.

:: Copy docker-compose for production (no build, just images)
copy /Y "release-files\docker-compose.yml" "%RELEASE_DIR%\docker-compose.yml" >nul
copy /Y "release-files\start.bat" "%RELEASE_DIR%\start.bat" >nul
copy /Y "release-files\stop.bat" "%RELEASE_DIR%\stop.bat" >nul
copy /Y "release-files\load-images.bat" "%RELEASE_DIR%\load-images.bat" >nul
copy /Y "env.template" "%RELEASE_DIR%\env.template" >nul

:: Copy nginx config
if not exist "%RELEASE_DIR%\nginx" mkdir "%RELEASE_DIR%\nginx"
copy /Y "nginx\default.conf" "%RELEASE_DIR%\nginx\default.conf" >nul

:: Copy logo
if not exist "%RELEASE_DIR%\data\license" mkdir "%RELEASE_DIR%\data\license"
if not exist "%RELEASE_DIR%\data\exports" mkdir "%RELEASE_DIR%\data\exports"
if not exist "%RELEASE_DIR%\data\logs" mkdir "%RELEASE_DIR%\data\logs"

echo   - docker-compose.yml (production)
echo   - start.bat, stop.bat, load-images.bat
echo   - env.template
echo   - nginx/default.conf
echo   - data directories
echo.

echo [4/5] Verifying package contents...
echo.
echo   Release directory: %RELEASE_DIR%
echo.
dir /b /s "%RELEASE_DIR%" 2>nul | find /c /v "" > temp_count.txt
set /p FILE_COUNT=<temp_count.txt
del temp_count.txt
echo   Total files: %FILE_COUNT%
echo.

echo [5/5] Package ready!
echo.
echo ================================================
echo  RELEASE PACKAGE CREATED SUCCESSFULLY
echo ================================================
echo.
echo  Location: %RELEASE_DIR%
echo.
echo  What's included (CLIENT gets):
echo    docker-images\backend.tar   - Compiled backend (NO source code)
echo    docker-images\ui.tar        - Compiled frontend (NO source code)
echo    docker-compose.yml          - Container orchestration
echo    nginx\default.conf          - Reverse proxy config
echo    env.template                - Database config template
echo    start.bat                   - Start the app
echo    stop.bat                    - Stop the app
echo    load-images.bat             - Load Docker images
echo.
echo  What's NOT included (PROTECTED):
echo    backend\src\*               - Backend source code
echo    frontend\src\*              - Frontend source code
echo    tools\*                     - License key generator
echo    Dockerfiles                 - Build instructions
echo    node_modules                - Dependencies
echo.
echo  To deploy on client machine:
echo    1. Copy the %RELEASE_DIR% folder to client
echo    2. Client copies env.template to .env and sets DB credentials
echo    3. Client runs start.bat
echo    4. Client opens http://localhost:8080
echo    5. Client enters the license key you generated
echo.
pause
