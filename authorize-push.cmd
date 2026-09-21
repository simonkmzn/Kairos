@echo off
rem ONE-TIME setup: lets the hourly logger push the forward-test log to GitHub by itself.
rem A GitHub sign-in window opens once; after that the background pushes are silent.
cd /d "%~dp0"
setlocal enabledelayedexpansion

set "GIT="
for /f "delims=" %%G in ('dir /b /o-n "%LOCALAPPDATA%\GitHubDesktop\app-*" 2^>nul') do (
  if not defined GIT if exist "%LOCALAPPDATA%\GitHubDesktop\%%G\resources\app\git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\GitHubDesktop\%%G\resources\app\git\cmd\git.exe"
)
if not defined GIT (
  echo Could not find git. Is GitHub Desktop installed?
  pause
  exit /b 1
)

echo Using: %GIT%
echo.
echo Telling git to remember GitHub logins...
"%GIT%" config --global credential.helper manager

echo.
echo Pushing. If a GitHub sign-in window appears, approve it ^(this happens once^).
echo.
"%GIT%" push
set RC=%errorlevel%

echo.
if "%RC%"=="0" (
  echo SUCCESS - the logger can now push on its own every hour.
) else (
  echo Push failed with code %RC%.
  echo If no sign-in window appeared, just use the Push button in GitHub Desktop instead.
)
echo.
pause
