@echo off
rem Builds the CrazyGames upload zip (dist\upbox-crazygames.zip). Upload that zip in the CrazyGames Developer Portal.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-crazygames.ps1"
pause
