@echo off
rem follow_wollof launcher for Windows. See "fw help".
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0fw.py" %*
) else (
  python "%~dp0fw.py" %*
)
