@echo off
title DHS Bank Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js hittades inte. Installera fran https://nodejs.org och forsok igen.
  pause
  exit /b 1
)

echo Startar Bank Studio...
echo Stang det har fonstret for att stoppa servern.
echo.

rem Oppna webblasaren efter 2 sekunder (servern hinner starta)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:4600"

node bank-studio.js
pause
