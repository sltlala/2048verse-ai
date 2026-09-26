@echo off
cd /d "%~dp0"
title 2048verse AI - HEADLESS launcher

echo ============================================================
echo    2048verse 4x4 AI  -  HEADLESS mode (background)
echo ============================================================
echo.

call "%~dp0_env-setup.bat"
if errorlevel 1 (
    echo.
    echo   [X] Environment setup failed. Fix the issue above and retry.
    echo.
    pause
    exit /b 1
)

REM --- already running? (write count to temp file; avoids for/f quote pitfalls) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'run\.js' -and $_.CommandLine -notmatch 'dsh' }).Count" > "%TEMP%\2048_botcount.tmp" 2>nul
set "RUNNING="
set /p RUNNING=<"%TEMP%\2048_botcount.tmp"
del "%TEMP%\2048_botcount.tmp" >nul 2>nul
if "%RUNNING%"=="" set "RUNNING=0"
if not "%RUNNING%"=="0" (
    echo.
    echo   [!] A bot instance is already running ^(count = %RUNNING%^).
    echo       Stop it first with stop.bat, or use start-headed.bat to watch it.
    echo.
    pause
    exit /b 1
)

REM --- release profile lock ---
echo Cleaning stale automation Chrome windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*2048\.chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

if not exist "logs" mkdir "logs" >nul 2>nul

echo Starting in background ...
echo.

REM Launch fully detached:
REM   - the CHILD does the redirection to a file (no pipe from the parent, so no
REM     EPIPE crash when this launcher window closes)
REM   - -WindowStyle Hidden gives it its own hidden console, detached from ours
powershell -NoProfile -ExecutionPolicy Bypass -Command "$extra = '%*'.Trim(); $cmd = 'node run.js --headless --newgame --http-port 8765 --shot-interval 10 --speed 30 --budget 150'; if ($extra.Length -gt 0) { $cmd = $cmd + ' ' + $extra }; $cmd = $cmd + ' > logs\bot.log 2>&1'; Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory '%CD%' -WindowStyle Hidden"

REM redirect-safe sleep (timeout breaks when stdin is redirected)
ping -n 9 127.0.0.1 >nul 2>nul

echo ============================================================
echo   Bot started in background. How to watch / control:
echo.
echo     Live dashboard : http://127.0.0.1:8765
echo     Latest shot    : results\screenshots\live.png
echo     Log file       : logs\bot.log
echo     Stop the bot   : double-click stop.bat
echo.
echo   Note: the very first login must be done in HEADED mode
echo         (or import a session file), because headless has
echo         no window to type into.
echo ============================================================
echo.
echo Press any key to close this window (the bot keeps running).
pause >nul
exit /b 0
