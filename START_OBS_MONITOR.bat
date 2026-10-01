@echo off
title OBS Broadcast Web Monitor - Independent Server
color 0B

echo ======================================================================
echo           OBS WEB CONTROLLER - BROADCAST STATS MONITOR
echo                   (Independent Standalone Runner)
echo ======================================================================
echo.

set "NODE_EXE="

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

echo [WARNING] Node.js runtime not found in default paths.
echo Opening standalone web interface directly in your default browser...
start "" "c:\BHUMESH\OBS WEB\public\index.html"
exit /b 0

:FOUND_NODE
echo [INFO] Found Node.js runtime at: %NODE_EXE%
echo [INFO] Starting OBS Broadcast Server on http://localhost:3000...
echo.

:: Automatically open browser after 1.5 seconds in background
start "" /b powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500; Start-Process 'http://localhost:3000'"

:: Run server (will output local & LAN addresses)
"%NODE_EXE%" "c:\BHUMESH\OBS WEB\server.js"

pause
