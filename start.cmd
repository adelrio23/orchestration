@echo off
setlocal
cd /d "%~dp0"
title Local Agent Coordinator
where node >nul 2>nul || (echo Node.js 22 or newer is required. Get it from https://nodejs.org and reopen this file. & pause & exit /b 1)
where git >nul 2>nul || (echo Git is required. Get it from https://git-scm.com and reopen this file. & pause & exit /b 1)
echo.
echo   Local Agent Coordinator
echo   =======================
echo   Starting your saved project and opening the dashboard...
echo   Keep this window open while the team works.
echo.
node supervisor.mjs
if errorlevel 1 (
  echo.
  echo The coordinator could not stay running.
  echo Run "node doctor.mjs" and inspect data\supervisor.jsonl.
  pause
  exit /b 1
)
endlocal
