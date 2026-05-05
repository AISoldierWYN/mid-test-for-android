@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0packages\android\scripts\start-playground.ps1" %*

if errorlevel 1 (
  echo.
  echo Android Playground exited with an error.
  pause
)
