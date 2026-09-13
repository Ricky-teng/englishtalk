@echo off
rem ---------------------------------------------------------------
rem  English Talk launcher
rem  NOTE: this file is intentionally pure ASCII.
rem  cmd.exe reads a .bat using the system ANSI codepage (Big5 on a
rem  zh-TW machine) BEFORE chcp takes effect, so any UTF-8 Chinese
rem  here would corrupt the following lines. Keep it ASCII only.
rem ---------------------------------------------------------------
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title English Talk

echo.
echo ==========================================
echo   English Talk - duplex English practice
echo ==========================================
echo.

rem ---- locate Python ----
set "PY="

where py >nul 2>nul
if errorlevel 1 goto try_python
set "PY=py -3"
goto check_py

:try_python
where python >nul 2>nul
if errorlevel 1 goto no_python
set "PY=python"

:check_py
%PY% -c "import sys" >nul 2>nul
if errorlevel 1 goto no_python

rem ---- install edge-tts on first run ----
%PY% -c "import edge_tts" >nul 2>nul
if not errorlevel 1 goto run

echo [setup] First run: installing edge-tts (free neural voices)...
%PY% -m pip install --disable-pip-version-check --quiet edge-tts
if errorlevel 1 echo [warn] edge-tts install failed - will fall back to browser voice.
echo.

:run
%PY% server.py
echo.
pause
exit /b 0

:no_python
echo [ERROR] Python not found.
echo.
echo Please install Python 3.9+ from:
echo     https://www.python.org/downloads/
echo IMPORTANT: tick "Add Python to PATH" during installation,
echo then run this file again.
echo.
pause
exit /b 1
