@echo off
chcp 65001 >nul
title Homework Grader Relay (port 8899)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js not found. Install Node.js first, or use the direct connection mode.
  pause
  exit /b 1
)
echo Starting local relay for the homework-grading window...
node "%~dp0hwgrade-relay.cjs" %*
echo.
echo Relay stopped. Press any key to close.
pause >nul
