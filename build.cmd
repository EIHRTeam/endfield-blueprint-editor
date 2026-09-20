@echo off
python "%~dp0scripts\build.py"
if errorlevel 1 pause
