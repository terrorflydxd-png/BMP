@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv" (
  python -m venv .venv
)
call ".venv\Scripts\activate.bat"
python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt
python app.py
pause
