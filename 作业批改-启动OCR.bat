@echo off
chcp 65001 >nul
title Homework Grader - Local OCR (port 8897)
cd /d "%~dp0"
if not exist "ocr-venv\Scripts\python.exe" (
  echo [!] ocr-venv not found.
  echo     Create it first:
  echo         python -m venv ocr-venv
  echo         ocr-venv\Scripts\python.exe -m pip install rapidocr-onnxruntime
  pause
  exit /b 1
)
echo Starting local OCR service for the homework-grading window...
"%~dp0ocr-venv\Scripts\python.exe" "%~dp0hwgrade-ocr.py" %*
echo.
echo OCR service stopped. Press any key to close.
pause >nul
