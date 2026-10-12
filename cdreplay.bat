@echo off
rem Launches cdreplay. Optional argument: a .rpl file, a ladder replay link or a game id (also works for "Open with").
cd /d "%~dp0"
if not exist node_modules\electron (
	echo Installing Electron...
	call npm install
)
start "" "node_modules\electron\dist\electron.exe" . %1
