#!/bin/bash
# =======================================================
# Starting Ollama with full Chrome Extension CORS support
# =======================================================
export OLLAMA_ORIGINS="*"
export OLLAMA_HOST="0.0.0.0:11434"

echo "======================================================="
echo " Starting Ollama with full Chrome Extension CORS access"
echo "======================================================="

if [ -d "/Applications/Ollama.app" ]; then
    open -a Ollama
    echo "Ollama app launched!"
elif command -v ollama >/dev/null 2>&1; then
    echo "Launching Ollama server..."
    ollama serve
else
    echo "Ollama not found. Please install Ollama from https://ollama.com"
fi
