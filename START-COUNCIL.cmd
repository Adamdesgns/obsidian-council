@echo off
title The Obsidian Council
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 or newer, then reopen this launcher.
  pause
  exit /b 1
)
if not defined CODEX_LOCAL_USAGE_READER set "CODEX_LOCAL_USAGE_READER=1"
if not defined CLAUDE_LOCAL_USAGE_READER set "CLAUDE_LOCAL_USAGE_READER=1"
if not defined COUNCIL_GROK_PATCH_ENABLED set "COUNCIL_GROK_PATCH_ENABLED=1"
if not defined COUNCIL_GROK_MODEL set "COUNCIL_GROK_MODEL=grok-4.7-build-fast"
if not defined COUNCIL_CURSOR_ENABLED set "COUNCIL_CURSOR_ENABLED=1"
if not defined COUNCIL_CURSOR_EXE (
  set "COUNCIL_CURSOR_EXE=%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI\node.exe"
  if not defined COUNCIL_CURSOR_ENTRYPOINT set "COUNCIL_CURSOR_ENTRYPOINT=%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI\index.js"
)
if not defined COUNCIL_CURSOR_MODEL set "COUNCIL_CURSOR_MODEL=composer-2.5"
node scripts\doctor.mjs
if errorlevel 1 (
  echo Fix the required setup above before starting Council.
  pause
  exit /b 1
)
node src\council.mjs
echo.
echo Council stopped. Press any key to close this window.
pause >nul
