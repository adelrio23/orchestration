@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS installer from https://nodejs.org, then reopen this. & pause & exit /b 1)
echo Starting the coordinator. Your browser will open in a few seconds.
echo Keep this window open. Press Ctrl+C here to stop.
start "" /b cmd /c "timeout /t 3 >nul & start http://127.0.0.1:4317/"
node server.mjs
pause
