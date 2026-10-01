@echo off
title Deploy OBS Web Controller to GitHub Pages (Free Hosting)
color 0E

echo ======================================================================
echo       DEPLOY OBS WEB CONTROLLER TO GITHUB (FREE HOSTING)
echo ======================================================================
echo.
echo This tool allows you to host the OBS Broadcast Monitor on GitHub Pages
echo for FREE, accessible from any phone, laptop, or PC anywhere in the world!
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Git is not installed on this PC.
    echo Please install Git from https://git-scm.com/downloads or upload this folder
    echo directly to GitHub via your web browser at https://github.com/new
    pause
    exit /b 1
)

echo [1/4] Initializing Git repository...
if not exist ".git" (
    git init
)

echo [2/4] Adding project files...
git add index.html style.css obs-client.js app.js README.md streams_config.json server.js START_OBS_MONITOR.bat

echo [3/4] Creating commit...
git commit -m "Deploy OBS Broadcast Web Controller & Stats Monitor"

echo.
echo ======================================================================
echo Please enter your GitHub Repository URL
echo (Create a new repo on https://github.com/new first if you haven't yet)
echo Example: https://github.com/your-username/obs-monitor.git
echo ======================================================================
set /p REPO_URL="Enter GitHub Repo URL (or press Enter to skip push): "

if "%REPO_URL%"=="" (
    echo.
    echo [INFO] Git commit saved locally. You can push manually anytime using:
    echo   git remote add origin YOUR_REPO_URL
    echo   git push -u origin main
    goto :DONE
)

git branch -M main
git remote remove origin 2>nul
git remote add origin %REPO_URL%
echo [4/4] Pushing to GitHub...
git push -u origin main

:DONE
echo.
echo ======================================================================
echo HOW TO ENABLE FREE GITHUB PAGES HOSTING:
echo ======================================================================
echo 1. Open your repository on GitHub.com
echo 2. Click "Settings" (gear icon) > click "Pages" on the left menu
echo 3. Under "Build and deployment", set Source: "Deploy from a branch"
echo 4. Select Branch: "main" and folder: "/ (root)", then click "Save"
echo.
echo Within 60 seconds, your site will be live for FREE at:
echo   https://<your-username>.github.io/<repo-name>/
echo ======================================================================
echo.
pause
