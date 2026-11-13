@echo off
rem Rebuilds dist\cdreplay.exe (portable target only, no zip).
cd /d "%~dp0"
if not exist node_modules\electron-builder (
	echo Installing dependencies...
	call npm install
)
call npx electron-builder --win portable
