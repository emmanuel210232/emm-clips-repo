@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Regresa Emm Clips a la version anterior (usa el respaldo que se guarda antes de cada actualizacion).
rem Sirve aunque la version nueva ya no deje abrir la app. Tus videos y proyectos no se borran.
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:4177 .*LISTENING"') do taskkill /F /PID %%p >nul 2>&1
"%NODE%" lib\updater.js respaldos
echo.
choice /M "Volver a la version anterior"
if errorlevel 2 exit /b
"%NODE%" lib\updater.js volver
if errorlevel 1 (
  echo.
  echo No se pudo volver a la version anterior. Tu version actual no se cambio.
  pause
  exit /b 1
)
echo.
echo Ya puedes abrir Emm Clips otra vez con "Iniciar Emm Clips".
pause
