@echo off
REM Builds the single self-contained "Productivity Tracker.exe" from the spec
REM and installs it. Requires: pip install pyinstaller.
REM
REM The exe bundles Flask + pywebview + templates/static (see productivity-
REM tracker.spec) into ONE file. It reads its data (config.json, tracker.db,
REM backups, logs) from the working directory, so the desktop shortcut sets its
REM WorkingDirectory to the repo. The onefile exe is unsigned: if antivirus ever
REM quarantines it, add a Defender exclusion or code-sign it (see CLAUDE.md).
cd /d "%~dp0"
set INSTALL=%LOCALAPPDATA%\Programs\ProductivityTracker

pyinstaller productivity-tracker.spec
if errorlevel 1 goto :err

if not exist "%INSTALL%" mkdir "%INSTALL%"
copy /Y "dist\Productivity Tracker.exe" "%INSTALL%\Productivity Tracker.exe"
echo.
echo Installed to %INSTALL%\Productivity Tracker.exe
echo Desktop shortcut "Productivity Tracker.lnk" launches it (WorkingDirectory = repo).
goto :done

:err
echo Build failed.
:done
pause
