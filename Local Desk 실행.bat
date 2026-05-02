@echo off
setlocal

set "SCRIPT_DIR=%~dp0scripts"
set "LAUNCHER="

for %%F in ("%SCRIPT_DIR%\Local Desk*.bat") do (
    if exist "%%~fF" (
        set "LAUNCHER=%%~fF"
        goto :found
    )
)

:found
if not defined LAUNCHER (
    echo Local Desk launcher was not found in scripts.
    echo Expected something like: scripts\Local Desk*.bat
    pause
    exit /b 1
)

call "%LAUNCHER%"
exit /b %ERRORLEVEL%
