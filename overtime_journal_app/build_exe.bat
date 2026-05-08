@echo off
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

set "PYTHON_EXE="
set "PYTHONPATH_EXTRA="

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
    set "PYTHON_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
)

if exist "%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\site-packages\PyInstaller" (
    set "PYTHONPATH_EXTRA=%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.11_qbz5n2kfra8p0\LocalCache\local-packages\Python311\site-packages"
)

where pyinstaller >nul 2>nul
if not errorlevel 1 (
    pyinstaller ^
      --noconfirm ^
      --noconsole ^
      --onefile ^
      --name "야근일지" ^
      --add-data "web;web" ^
      server.py
    goto done
)

if defined PYTHON_EXE if defined PYTHONPATH_EXTRA (
    set "PYTHONPATH=%PYTHONPATH_EXTRA%;%PYTHONPATH%"
    "%PYTHON_EXE%" -m PyInstaller ^
      --noconfirm ^
      --noconsole ^
      --onefile ^
      --name "야근일지" ^
      --add-data "web;web" ^
      server.py
    goto done
)

echo PyInstaller was not found.
echo Install it in a build environment, then run this file again:
echo python -m pip install pyinstaller
pause
exit /b 1

:done
echo.
echo Done. Check the dist folder.
pause
