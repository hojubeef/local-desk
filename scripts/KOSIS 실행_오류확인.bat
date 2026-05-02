@echo off
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "APP_DIR=%ROOT_DIR%\apps\kosis"
set "APP_PATH=%APP_DIR%\app.py"

if not exist "%APP_PATH%" (
    echo apps\kosis\app.py was not found.
    pause
    exit /b 1
)

cd /d "%APP_DIR%"

if exist "%ROOT_DIR%\.venv\Scripts\python.exe" (
    "%ROOT_DIR%\.venv\Scripts\python.exe" "%APP_PATH%"
    pause
    exit /b
)

if exist "%ROOT_DIR%\venv\Scripts\python.exe" (
    "%ROOT_DIR%\venv\Scripts\python.exe" "%APP_PATH%"
    pause
    exit /b
)

if exist "%APP_DIR%\.venv\Scripts\python.exe" (
    "%APP_DIR%\.venv\Scripts\python.exe" "%APP_PATH%"
    pause
    exit /b
)

if exist "%APP_DIR%\venv\Scripts\python.exe" (
    "%APP_DIR%\venv\Scripts\python.exe" "%APP_PATH%"
    pause
    exit /b
)

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%APP_PATH%"
    pause
    exit /b
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%APP_PATH%"
    pause
    exit /b
)

python "%APP_PATH%"
pause
