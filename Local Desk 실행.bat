@echo off
setlocal

set "LAUNCHER=%~dp0scripts\Local Desk 실행.bat"

if exist "%LAUNCHER%" (
    call "%LAUNCHER%"
    exit /b %ERRORLEVEL%
)

echo Local Desk launcher was not found.
echo Expected: %LAUNCHER%
pause
exit /b 1
