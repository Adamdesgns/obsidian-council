@echo off
title The Obsidian Council
cd /d "%~dp0"
set "CODEX_LOCAL_USAGE_READER=1"
set "CLAUDE_LOCAL_USAGE_READER=1"
set "COUNCIL_GROK_PATCH_ENABLED=1"
set "COUNCIL_GROK_MODEL=grok-4.7-build-fast"
node src\council.mjs
echo.
echo Council stopped. Press any key to close this window.
pause >nul
