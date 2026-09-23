@echo off
title The Obsidian Council
cd /d "%~dp0"
set "CODEX_LOCAL_USAGE_READER=1"
set "CLAUDE_LOCAL_USAGE_READER=1"
set "COUNCIL_GROK_PATCH_ENABLED=1"
set "COUNCIL_GROK_MODEL=grok-4.7-build-fast"
set "COUNCIL_CURSOR_ENABLED=1"
set "COUNCIL_CURSOR_EXE=%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI\node.exe"
set "COUNCIL_CURSOR_ENTRYPOINT=%LOCALAPPDATA%\Programs\ObsidianCouncilCursorCLI\index.js"
set "COUNCIL_CURSOR_MODEL=composer-2.5"
node src\council.mjs
echo.
echo Council stopped. Press any key to close this window.
pause >nul
