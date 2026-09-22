@echo off
title Obsidian Council - Private Phone Access
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-phone.ps1"
if errorlevel 1 (
  echo.
  echo Council phone access did not start. Read the message above.
  pause
)
