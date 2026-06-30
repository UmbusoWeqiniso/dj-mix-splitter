@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtualenv...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  call .venv\Scripts\python.exe -m pip install --upgrade pip
  call .venv\Scripts\pip.exe install -r requirements.txt
)

where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo WARNING: ffmpeg not found on PATH.
  echo Install from https://ffmpeg.org/download.html and add ffmpeg.exe to PATH.
)

set PYTHONUNBUFFERED=1
cd backend
..\.venv\Scripts\uvicorn.exe app:app --host 127.0.0.1 --port 8000 %*
