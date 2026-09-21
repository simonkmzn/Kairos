@echo off
rem Starts the local server (needed for saving, live headlines and the forward-test log) and opens the terminal.
cd /d "%~dp0"
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8777/config/signal.js' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if %errorlevel%==0 (
  echo The server is already running ^(probably started by the logger^). Opening the terminal.
  start http://localhost:8777/
  exit /b
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8777/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port 8777
