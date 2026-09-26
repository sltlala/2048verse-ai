@echo off
cd /d "%~dp0"
title 2048verse AI - MOBILE mode (Android via adb)
setlocal

echo ============================================================
echo    2048verse AI  -  MOBILE mode
echo    Plays the 2048 app on your phone through adb
echo ============================================================
echo.
echo   Before you start:
echo     1. connect the phone with a USB cable, unlock it
echo     2. enable Developer options / USB debugging
echo     3. tap "Allow" on the USB debugging popup
echo     4. open the 2048 game and leave the game screen visible
echo     5. keep the phone awake - do NOT touch the screen
echo.
echo   Stop: press Ctrl+C in this console window.
echo.

REM ---------- locate adb ----------
if not defined ADB set "ADB=D:\Program_software\platform-tools\adb.exe"
if not exist "%ADB%" for /f "delims=" %%i in ('where adb 2^>nul') do set "ADB=%%i"
if not exist "%ADB%" (
    echo   [X] adb.exe not found.
    echo       Install Android platform-tools, then either put adb.exe on
    echo       PATH or set the ADB environment variable to its full path.
    echo.
    pause
    exit /b 1
)
echo   adb: %ADB%

REM ---------- device check ----------
echo.
echo   Connected devices:
"%ADB%" devices
"%ADB%" get-state >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [X] No usable device. Check:
    echo       - USB cable / different USB port
    echo       - USB debugging enabled
    echo       - "Allow USB debugging" popup accepted on the phone
    echo       - try:  "%ADB%" kill-server  then run this script again
    echo.
    pause
    exit /b 1
)
echo   device OK

REM ---------- dependencies ----------
if not exist "node_modules\pngjs" (
    echo.
    echo   Installing dependencies, about 1 minute...
    call npm install --cache ".npm-cache" --no-audit --no-fund
    if errorlevel 1 (
        echo   [X] npm install failed. Check your network and retry.
        pause
        exit /b 1
    )
)

REM UTF-8 console so the bot's Chinese log lines render correctly
chcp 65001 >nul 2>nul

REM ---------- board recognition self-test ----------
echo.
echo   Recognising the board (the game must be on screen)...
echo.
node tools\mobile\bot-mobile.js --discover
if errorlevel 3 goto ERR_NO_GAME
if errorlevel 2 goto ERR_UNKNOWN
if errorlevel 1 goto ERR_OTHER

echo.
echo ============================================================
echo   Starting the bot. Extra args are passed through, e.g.:
echo     start-mobile.bat --moves 300 --budget 120
echo     start-mobile.bat --settle 160 --swipe-ms 80
echo   Results: mobile-results.jsonl   Screenshots: mobile-shots\
echo ============================================================
echo.

node tools\mobile\bot-mobile.js --budget 80 %*
echo.
echo Bot exited. Results are in mobile-results.jsonl and mobile-shots\.
pause
exit /b 0

:ERR_NO_GAME
echo.
echo   [X] The board area looks empty.
echo       Open the 2048 game on the phone and keep the game screen visible.
echo       If the game IS open, the board rectangle is probably out of date:
echo         node tools\mobile\calibrate.js
echo       then update BOARD in tools\mobile\board.js.
echo.
pause
exit /b 1

:ERR_UNKNOWN
echo.
echo   [!] Unknown tile colour detected.
echo       Sample crops were saved to mobile-shots\unknown\ .
echo       Add the value to COLOR_MAP in tools\mobile\board.js, then rerun.
echo.
pause
exit /b 1

:ERR_OTHER
echo.
echo   [X] Board recognition failed - see the error above.
echo.
pause
exit /b 1
