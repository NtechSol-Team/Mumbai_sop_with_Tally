@echo off
REM =======================================================================
REM  Mumbai ERP Tally Sync Agent - run from source on the Tally PC.
REM  No installer needed. Double-click this file, or add it to
REM  Task Scheduler / the Startup folder to run at login.
REM
REM  1. Fill in the four values below (from Settings -> Tally Sync).
REM  2. Make sure Node 20+ is installed.
REM =======================================================================

REM Uncomment and fill these, or set them in the environment before launch.
REM Never commit a pairing token to source control.
REM set "MUMBAI_ERP_URL=https://api.your-domain.com"
REM set "MUMBAI_ERP_TOKEN=YOUR_PAIRING_TOKEN"
REM set "TALLY_COMPANY=EXACT_NAME_FROM_LIST_COMPANIES"
if not defined TALLY_HOST set "TALLY_HOST=localhost"
if not defined TALLY_PORT set "TALLY_PORT=9000"
if not defined POLL_SECONDS set "POLL_SECONDS=20"

cd /d "%~dp0"
echo Working folder: %cd%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install it from https://nodejs.org, then close this window,
  echo open a NEW Command Prompt, and run this file again.
  goto :end
)

call node -v
call npm -v
echo.

if not exist "node_modules\saxes" (
  echo Installing dependencies - first run only, this can take a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed. See the messages above.
    goto :end
  )
)

echo Starting Mumbai ERP Tally Sync Agent...
echo   ERP:   %MUMBAI_ERP_URL%
echo   Tally: %TALLY_HOST%:%TALLY_PORT%
echo Press Ctrl+C to stop.
echo.
call node src\run-headless.js %*
if errorlevel 1 (
  echo.
  echo [ERROR] The agent exited with an error. See the messages above.
)

:end
echo.
echo (This window stays open. Press any key to close it.)
pause >nul
