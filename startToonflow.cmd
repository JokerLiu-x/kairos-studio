@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0startToonflow.ps1"
if errorlevel 1 pause
