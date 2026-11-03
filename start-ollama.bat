@echo off
title Starting Ollama with Extension Access
echo =======================================================
echo  Starting Ollama with full Chrome Extension CORS support
echo =======================================================
set OLLAMA_ORIGINS=chrome-extension://*,http://127.0.0.1:*,http://localhost:*
set OLLAMA_HOST=127.0.0.1:11434

REM Check if Ollama app exists in standard locations
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
    echo Ollama app started successfully!
    exit /b 0
)

REM Fallback to CLI ollama serve
where ollama >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo Launching Ollama server...
    ollama serve
) else (
    echo Ollama was not found in standard paths. Please ensure Ollama is installed from https://ollama.com.
    pause
)
