@echo off
REM =======================================================================
REM  Mumbai ERP Tally Sync Agent - run from source on the Tally PC.
REM  No installer needed. Double-click this file, or add it to
REM  Task Scheduler / the Startup folder to run at login.
REM
REM  1. Fill in the four values below (from Settings -> Tally Sync).
REM  2. Make sure Node 20+ is installed.
REM =======================================================================

set "MUMBAI_ERP_URL=https://mumbai-erp-ntechsol-api.onrender.com"
set "MUMBAI_ERP_TOKEN=mea_8abccb9eb054d911068018101ac44b61c15b3756d508776e"
set "TALLY_HOST=localhost"
set "TALLY_PORT=9000"
set "TALLY_COMPANY=Mumbai Erp"
set "POLL_SECONDS=20"

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

node -v
npm -v
echo.

if not exist "node_modules\xmlbuilder2" (
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
node src\run-headless.js
if errorlevel 1 (
  echo.
  echo [ERROR] The agent exited with an error. See the messages above.
)

:end
echo.
echo (This window stays open. Press any key to close it.)
pause >nul
