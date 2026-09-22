@echo off
title The Obsidian Council
cd /d "%~dp0"
set "CODEX_LOCAL_USAGE_READER=1"
node src\council.mjs
echo.
echo Council stopped. Press any key to close this window.
pause >nul
