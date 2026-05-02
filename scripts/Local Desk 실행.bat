@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "SERVER=%ROOT_DIR%\apps\kosis\web_server.py"
set "HOST=127.0.0.1"
set "PORT=8765"
set "URL=http://%HOST%:%PORT%/portal/index.html?v=20260502-google-calendar"

echo.
echo Starting Local Desk...
echo Root: %ROOT_DIR%
echo URL : %URL%
echo.

if not exist "%SERVER%" (
    echo apps\kosis\web_server.py was not found.
    echo Checked: %SERVER%
    pause
    exit /b 1
)

set "PYTHON_EXE="

if exist "%ROOT_DIR%\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%ROOT_DIR%\.venv\Scripts\python.exe"
) else if exist "%ROOT_DIR%\venv\Scripts\python.exe" (
    set "PYTHON_EXE=%ROOT_DIR%\venv\Scripts\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
) else if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
    set "PYTHON_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)

if defined PYTHON_EXE (
    echo Python: %PYTHON_EXE%
    "%PYTHON_EXE%" "%SERVER%" --host %HOST% --port %PORT% --open
    echo.
    echo Local Desk stopped or could not start. If it is already running, open:
    echo %URL%
    pause
    exit /b %ERRORLEVEL%
)

where py >nul 2>nul
if not errorlevel 1 (
    echo Python: py -3
    py -3 "%SERVER%" --host %HOST% --port %PORT% --open
    echo.
    echo Local Desk stopped or could not start. If it is already running, open:
    echo %URL%
    pause
    exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if not errorlevel 1 (
    echo Python: python
    python "%SERVER%" --host %HOST% --port %PORT% --open
    echo.
    echo Local Desk stopped or could not start. If it is already running, open:
    echo %URL%
    pause
    exit /b %ERRORLEVEL%
)

echo Python was not found.
echo Install Python, create .venv, or run this from Codex where bundled Python exists.
pause
exit /b 1
