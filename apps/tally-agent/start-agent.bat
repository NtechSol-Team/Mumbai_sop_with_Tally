@echo off
REM ─────────────────────────────────────────────────────────────────────
REM  Mumbai ERP Tally Sync Agent — run from source on the Tally PC.
REM  No installer needed. Double-click this file, or add it to
REM  Task Scheduler / the Startup folder to run at login.
REM
REM  1. Fill in the four values below (from Settings -> Tally Sync).
REM  2. Make sure Node 20+ is installed and `npm install --omit=dev`
REM     has been run once in this folder.
REM ─────────────────────────────────────────────────────────────────────

set "MUMBAI_ERP_URL=https://mumbai-erp-ntechsol-api.onrender.com"
set "MUMBAI_ERP_TOKEN=mea_PASTE_YOUR_TOKEN_HERE"
set "TALLY_HOST=localhost"
set "TALLY_PORT=9000"
set "TALLY_COMPANY=Your Company Name Exactly As In Tally"
set "POLL_SECONDS=20"

cd /d "%~dp0"

if not exist "node_modules\xmlbuilder2" (
  echo Installing dependencies (first run only)...
  call npm install --omit=dev
)

echo Starting Mumbai ERP Tally Sync Agent...
echo   ERP:   %MUMBAI_ERP_URL%
echo   Tally: %TALLY_HOST%:%TALLY_PORT%
echo Press Ctrl+C to stop.
echo.
node src\run-headless.js
pause
