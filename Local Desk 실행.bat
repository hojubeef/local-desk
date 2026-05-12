@echo off
setlocal

set "LAUNCHER=%~dp0scripts\Local Desk 실행.vbs"
set "FALLBACK=%~dp0scripts\Local Desk 실행.bat"

if exist "%LAUNCHER%" (
    wscript.exe "%LAUNCHER%"
    exit /b 0
)

if exist "%FALLBACK%" (
    call "%FALLBACK%"
    exit /b %ERRORLEVEL%
)

echo Local Desk launcher was not found.
echo Expected: %LAUNCHER%
pause
exit /b 1
