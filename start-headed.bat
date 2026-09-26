@echo off
cd /d "%~dp0"
title 2048verse AI - HEADED mode

echo ============================================================
echo    2048verse 4x4 AI  -  HEADED mode (visible browser)
echo ============================================================
echo.
echo   Browser window WILL be shown, with the HUD panel on the page.
echo   First run: log in to your account in that window.
echo   Stop: press Ctrl+C in this console window.
echo.

call "%~dp0_env-setup.bat"
if errorlevel 1 (
    echo.
    echo   [X] Environment setup failed. Fix the issue above and retry.
    echo.
    pause
    exit /b 1
)

REM --- release profile lock left by a previous run ---
echo.
echo Cleaning stale automation Chrome windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*2048\.chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

REM UTF-8 console so the bot's Chinese log lines render correctly
chcp 65001 >nul 2>nul

echo.
echo ============================================================
echo   Starting (HEADED) ...
echo     log in to your account in the Chrome window
echo     stop with Ctrl+C in this window
echo   Extra args are passed through, e.g.:
echo     start-headed.bat --speed 0 --budget 200
echo ============================================================
echo.

node run.js --newgame --speed 30 --budget 150 %*

echo.
echo Bot exited.
pause
exit /b 0
