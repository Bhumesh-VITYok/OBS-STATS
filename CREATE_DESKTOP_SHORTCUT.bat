@echo off
title Create Desktop Shortcut for OBS Monitor
color 0A

echo ======================================================================
echo       CREATING DESKTOP SHORTCUT FOR OBS BROADCAST MONITOR
echo ======================================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$WshShell = New-Object -ComObject WScript.Shell; " ^
  "$Desktop = [System.Environment]::GetFolderPath('Desktop'); " ^
  "$Shortcut = $WshShell.CreateShortcut(\"$Desktop\OBS Broadcast Monitor.lnk\"); " ^
  "$Shortcut.TargetPath = 'c:\BHUMESH\OBS WEB\START_OBS_MONITOR.bat'; " ^
  "$Shortcut.WorkingDirectory = 'c:\BHUMESH\OBS WEB'; " ^
  "$Shortcut.Description = 'Independent OBS Broadcast Multi-Stream Monitor'; " ^
  "$Shortcut.IconLocation = 'shell32.dll,18'; " ^
  "$Shortcut.Save(); " ^
  "Write-Host '[SUCCESS] Desktop shortcut created at:' \"$Desktop\OBS Broadcast Monitor.lnk\" -ForegroundColor Green"

echo.
echo You can now double-click the 'OBS Broadcast Monitor' icon on your Desktop anytime!
echo No Antigravity or terminal needed.
echo.
pause
