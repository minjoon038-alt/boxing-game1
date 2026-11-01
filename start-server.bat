@echo off
rem Starts the BOXING server and opens the game. Keep this window open while playing.
start "" http://localhost:8123/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
