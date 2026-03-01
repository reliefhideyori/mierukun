@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo ============================================
echo  音声文字起こしツール
echo ============================================
echo.

REM 依存パッケージのインストール（初回のみ）
pip show fastapi >nul 2>&1
if errorlevel 1 (
    echo [install] 必要なパッケージをインストール中...
    pip install -r requirements.txt
    echo.
)

echo [start] サーバーを起動します...
echo [info]  ブラウザで http://localhost:8001 を開いてください
echo.
python main.py

pause
