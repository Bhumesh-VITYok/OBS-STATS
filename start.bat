@echo off
title OBS Web Controller & Broadcast Stats Monitor
color 0B

echo ======================================================================
echo           OBS WEB CONTROLLER - BROADCAST STATS MONITOR
echo ======================================================================
echo.

set NODE_EXE=

if exist "C:\Program Files\Companion\resources\node-runtimes\node22\node.exe" (
    set "NODE_EXE=C:\Program Files\Companion\resources\node-runtimes\node22\node.exe"
    goto :FOUND_NODE
)

if exist "C:\Program Files\Companion\resources\node-runtimes\node18\node.exe" (
    set "NODE_EXE=C:\Program Files\Companion\resources\node-runtimes\node18\node.exe"
    goto :FOUND_NODE
)

where node >nul 2>nul
if %errorlevel% equ 0 (
    set "NODE_EXE=node"
    goto :FOUND_NODE
)

echo [ERROR] Node.js executable was not detected!
echo Please install Node.js from https://nodejs.org or ensure Bitfocus Companion is installed.
pause
exit /b 1

:FOUND_NODE
echo [INFO] Using Node runtime: %NODE_EXE%
echo [INFO] Starting OBS Web Controller Server...
echo.

:: Launch the web browser automatically after 1 second in background
start "" /b powershell -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:3000'"

:: Start the server
"%NODE_EXE%" server.js

pause
