@echo off
setlocal
cd /d "%~dp0"
rem Node portatil incluido; si no, usa el del sistema
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
rem Verificacion de dependencias (no bloquea)
if exist "%~dp0COMPROBAR_PC.ps1" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0COMPROBAR_PC.ps1"
rem Arranca el servidor oculto y abre el navegador
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4177"
