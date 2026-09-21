@echo off
rem Appends the latest Binance candles and funding rates to data\ (only new rows are downloaded).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-data.ps1" -Interval 1h -Since 2019-10-01
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-data.ps1" -Interval 4h -Since 2019-06-01
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-data.ps1" -Interval 1d -Since 2018-01-01
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-data.ps1" -Funding -Since 2019-09-01
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\fetch-fng.ps1"
echo.
echo Data updated. To re-tune the signal engine: run serve.cmd, then open http://localhost:8777/tune.html
pause
