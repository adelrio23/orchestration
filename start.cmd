@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get Node.js 22 or newer from https://nodejs.org, then reopen this. & pause & exit /b 1)
echo Starting Local Agent Coordinator...
echo Your browser will open automatically. Keep this window open.
echo Press Ctrl+C here to pause and stop safely.
node server.mjs
if errorlevel 1 (
  echo.
  echo The coordinator stopped with an error.
  echo Run "node doctor.mjs" for installation and login checks.
)
pause
