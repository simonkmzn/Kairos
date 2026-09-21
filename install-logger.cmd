@echo off
rem Registers a Windows scheduled task that runs the forward-test logger every hour at :05
rem (while you are logged in). It starts the local server if needed and sweeps in a hidden browser.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\logger.ps1" -Install
echo.
echo Running one sweep now to check that it works...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\logger.ps1"
echo.
echo Done. The log of every run is in results\logger.log. To remove: uninstall-logger.cmd
pause
