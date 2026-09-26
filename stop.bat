@echo off
cd /d "%~dp0"
title 2048verse Auto Player - Stop

echo ============================================================
echo    Stopping 2048verse AI bot
echo ============================================================
echo.

REM One PowerShell call does everything (single quotes only -> no batch escaping issues)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'run\.js' -and $_.CommandLine -notmatch 'dsh' }; if ($procs) { foreach ($p in $procs) { Write-Host ('  [node]  stopping PID ' + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force } } else { Write-Host '  [node]  no running bot found' }; Start-Sleep -Seconds 4; $chrome = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*2048\.chrome-profile*' }; if ($chrome) { Write-Host ('  [chrome] closing ' + @($chrome).Count + ' processes (profile lock released)'); foreach ($p in $chrome) { Stop-Process -Id $p.ProcessId -Force } } else { Write-Host '  [chrome] none' }; Start-Sleep -Seconds 2; $n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'run\.js' -and $_.CommandLine -notmatch 'dsh' }).Count; $c = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*2048\.chrome-profile*' }).Count; Write-Host ''; Write-Host ('  remaining -> bot node: ' + $n + '   automation chrome: ' + $c)"

echo.
echo Bot stopped. Data and screenshots are kept in the results\ folder.
echo.
pause
