@echo off
chcp 65001 >nul
title Homework Grader - install local OCR env
cd /d "%~dp0"

echo ============================================
echo   作业批改 · 安装本机离线 OCR 环境
echo   （只需在新电脑上跑一次，需要联网）
echo ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [!] 没有找到 python。
  echo     请先安装 Python 3.8 及以上版本： https://www.python.org/downloads/
  echo     安装时务必勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

echo [1/3] 创建独立环境 ocr-venv（不会影响系统 Python）...
if not exist "ocr-venv\Scripts\python.exe" (
  python -m venv ocr-venv
) else (
  echo       已存在，跳过。
)

echo.
echo [2/3] 安装识别引擎 rapidocr-onnxruntime（走清华镜像，约 100-200MB）...
"%~dp0ocr-venv\Scripts\python.exe" -m pip install --no-input --retries 2 --timeout 30 -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr-onnxruntime
if errorlevel 1 (
  echo.
  echo [!] 安装失败。可以手动执行下面这条命令再试：
  echo     ocr-venv\Scripts\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple rapidocr-onnxruntime
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] 自检...
"%~dp0ocr-venv\Scripts\python.exe" -c "import rapidocr_onnxruntime,sys;print('  引擎已就绪:',rapidocr_onnxruntime.__version__ if hasattr(rapidocr_onnxruntime,'__version__') else 'ok')"

echo.
echo ============================================
echo   完成！以后双击「作业批改-启动OCR.bat」即可使用
echo ============================================
pause
