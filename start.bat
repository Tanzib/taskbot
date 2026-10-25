@echo off
title Team Task Tracker Bot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo Installing for the first time... this takes 2-5 minutes.
  call npm install
)

:loop
node index.js
echo.
echo Bot stopped. Restarting in 10 seconds... (close this window to stop it)
timeout /t 10 >nul
goto loop
