#!/bin/bash
# ====================================================================
# Starting Ollama with full Chrome Extension CORS support (Linux)
# ====================================================================

export OLLAMA_ORIGINS="*"
export OLLAMA_HOST="0.0.0.0:11434"

echo "======================================================="
echo " Starting Ollama with Chrome Extension CORS support (Linux)"
echo "======================================================="

# 1. Check if Ollama is already running on port 11434
if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "✓ Ollama is already running on http://127.0.0.1:11434."
    echo "  Your models are ready to be used by the extension!"
    exit 0
fi

# 2. Check if ollama CLI is available
if command -v ollama >/dev/null 2>&1; then
    echo "Launching Ollama server in the background..."
    nohup ollama serve > /tmp/ollama.log 2>&1 &
    sleep 2
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
        echo "✓ Ollama started successfully on port 11434!"
    else
        echo "Ollama is starting up. Please check with: curl http://127.0.0.1:11434/api/tags"
    fi
else
    echo "Ollama binary was not found in PATH."
    echo "If Ollama is installed in a custom folder, run: /path/to/ollama serve"
    echo "Or download Ollama from https://ollama.com"
fi
