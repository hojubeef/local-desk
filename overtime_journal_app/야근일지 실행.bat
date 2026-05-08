@echo off
setlocal

set "APP_DIR=%~dp0"
set "SERVER=%APP_DIR%server.py"

if not exist "%SERVER%" (
    echo server.py was not found.
    pause
    exit /b 1
)

set "PYTHON_EXE="

if exist "%APP_DIR%.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%APP_DIR%.venv\Scripts\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
    set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
) else if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
    set "PYTHON_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)

if defined PYTHON_EXE (
    "%PYTHON_EXE%" "%SERVER%"
    pause
    exit /b %ERRORLEVEL%
)

where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%SERVER%"
    pause
    exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if not errorlevel 1 (
    python "%SERVER%"
    pause
    exit /b %ERRORLEVEL%
)

echo Python was not found.
echo Build an exe or install Python 3.11+.
pause
exit /b 1
