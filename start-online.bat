@echo off
rem Shares BOXING with other networks: starts the game server (if it is not running yet) and a Cloudflare quick tunnel.
rem The public link (https://....trycloudflare.com) is printed in this window. It is different every time.
rem Keep this window (and the server window) open while friends play. Close this window to stop sharing.
set "CF=%~dp0tools\cloudflared.exe"
if not exist "%CF%" set "CF=%USERPROFILE%\Downloads\cloudflared-windows-amd64.exe"
if not exist "%CF%" (
  echo cloudflared was not found. Put cloudflared.exe in "%~dp0tools\" or in your Downloads folder.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try{ $c = New-Object Net.Sockets.TcpClient; $c.Connect('localhost',8123); $c.Close(); exit 0 }catch{ exit 1 }"
if errorlevel 1 (
  echo Starting the BOXING server...
  start "BOXING server" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
  timeout /t 3 /nobreak >nul
)
echo.
echo Creating the public link. Look for the line with https://....trycloudflare.com below.
echo.
"%CF%" tunnel --no-autoupdate --url http://localhost:8123 --http-host-header localhost:8123
pause
