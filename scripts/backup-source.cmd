@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0backup-source.ps1" %*
