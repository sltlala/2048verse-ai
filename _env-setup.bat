@echo off
REM ============================================================
REM  Shared environment setup, called by start-headed.bat /
REM  start-headless.bat.  Exits with code 0 on success, 1 on failure.
REM  NOTE: kept pure ASCII on purpose - non-ASCII bytes in a .bat
REM  break cmd.exe parsing (multi-byte offset bug).
REM ============================================================
setlocal enabledelayedexpansion

REM Tools install dir (keep tools on D: drive)
set "TOOLS_DIR=D:\Program_software"

REM ============ 1/4  Node.js ============
set "NODE_EXE=node"
where node >nul 2>nul
if not errorlevel 1 goto NODE_OK
if exist "%TOOLS_DIR%\nodejs\node.exe" (
    set "NODE_EXE=%TOOLS_DIR%\nodejs\node.exe"
    set "PATH=%TOOLS_DIR%\nodejs;%PATH%"
    goto NODE_OK
)
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto NODE_OK
)
echo [1/4] Node.js not found. Installing to %TOOLS_DIR%\nodejs ...
where winget >nul 2>nul
if errorlevel 1 goto NO_WINGET
if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%" >nul 2>nul
winget install --id OpenJS.NodeJS.LTS -e --location "%TOOLS_DIR%\nodejs" --accept-source-agreements --accept-package-agreements
if exist "%TOOLS_DIR%\nodejs\node.exe" (
    set "NODE_EXE=%TOOLS_DIR%\nodejs\node.exe"
    set "PATH=%TOOLS_DIR%\nodejs;%PATH%"
    goto NODE_OK
)
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto NODE_OK
)
goto NEED_RESTART

:NODE_OK
echo [1/4] Node.js version:
"%NODE_EXE%" -v

REM ============ 2/4  npm ============
if exist "%TOOLS_DIR%\nodejs\npm.cmd" set "PATH=%TOOLS_DIR%\nodejs;%PATH%"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 goto NO_NPM
echo [2/4] npm version:
call npm -v

REM ============ 3/4  Google Chrome ============
set "CHROME_OK=0"
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_OK=1"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_OK=1"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_OK=1"
if exist "%TOOLS_DIR%\Chrome\Application\chrome.exe" set "CHROME_OK=1"
if "%CHROME_OK%"=="1" goto CHROME_FOUND
echo [3/4] Google Chrome not found. Installing via winget...
where winget >nul 2>nul
if errorlevel 1 goto NO_WINGET
winget install --id Google.Chrome -e --accept-source-agreements --accept-package-agreements
goto CHROME_DONE

:CHROME_FOUND
echo [3/4] Google Chrome found

:CHROME_DONE
REM ============ 4/4  Dependencies ============
if exist "node_modules\playwright" goto DEP_OK
echo [4/4] Installing dependencies (playwright), about 1-2 minutes...
call npm install --cache ".npm-cache" --no-audit --no-fund
if errorlevel 1 goto DEP_FAIL

:DEP_OK
echo [4/4] Dependencies ready
if exist "%TOOLS_DIR%\GitHubCLI\bin\gh.exe" echo [info] GitHub CLI: %TOOLS_DIR%\GitHubCLI\bin\gh.exe
exit /b 0

REM ============ Error branches ============
:NO_WINGET
echo.
echo   [X] winget not available. Please install manually:
echo       Node.js LTS   : https://nodejs.org/en/download
echo       Google Chrome : https://www.google.com/chrome/
echo.
exit /b 1

:NEED_RESTART
echo.
echo   [!] Node.js installed, but a new window is required.
echo       Please close this window and run the launcher again.
echo.
exit /b 1

:NO_NPM
echo.
echo   [X] npm not found. Please reinstall Node.js (npm is bundled).
echo.
exit /b 1

:DEP_FAIL
echo.
echo   [X] Dependency install failed. Check your network and retry.
echo.
exit /b 1
