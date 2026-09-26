@echo off
cd /d "%~dp0"
title 2048verse AI - Launcher

echo ============================================================
echo    2048verse 4x4  AI Auto Player
echo ============================================================
echo.
echo    [1]  HEADED    visible browser + HUD on the page
echo                  (use this for the FIRST login)
echo.
echo    [2]  HEADLESS  run in background, watch via dashboard
echo                  http://127.0.0.1:8765
echo.
echo    [3]  STOP      stop a running bot
echo.
echo    [0]  EXIT
echo.
choice /c 1230 /n /m "  Select [1/2/3/0]: "

if errorlevel 4 exit /b 0
if errorlevel 3 ( call "%~dp0stop.bat" & exit /b 0 )
if errorlevel 2 ( call "%~dp0start-headless.bat" & exit /b 0 )
if errorlevel 1 ( call "%~dp0start-headed.bat" & exit /b 0 )
exit /b 0
