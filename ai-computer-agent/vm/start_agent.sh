#!/bin/bash
# Start the AI Computer Agent (VM side)
# Run this from within the Windows VM or WSL environment

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found"
    exit 1
fi

# Check Claude Code CLI
if ! command -v claude &>/dev/null; then
    echo "WARNING: claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
fi

# Install dependencies if needed
if [ ! -d "__pycache__" ]; then
    echo "Installing Python dependencies..."
    pip install -r requirements.txt
fi

# Set defaults
export HOST_WS_URL="${HOST_WS_URL:-ws://localhost:3000/agent}"
export REPO_PATH="${REPO_PATH:-$HOME/xvasjack.github.io}"

echo "Starting AI Computer Agent..."
echo "  Host: $HOST_WS_URL"
echo "  Repo: $REPO_PATH"

python3 agent.py
