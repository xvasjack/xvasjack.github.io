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
export AUTO_APPROVE_PLANS="${AUTO_APPROVE_PLANS:-true}"  # T0.1: Auto-approve plans by default
export USER_EMAIL="${USER_EMAIL:-$(git -C "$REPO_PATH" config user.email 2>/dev/null || echo "")}"

# 0.10: Discover CLAUDE_CODE_PATH
if command -v claude &>/dev/null; then
    export CLAUDE_CODE_PATH="${CLAUDE_CODE_PATH:-$(which claude)}"
fi

# 0.10: Start host server if not already running
if ! curl -sf http://localhost:3000/health &>/dev/null; then
    echo "Starting host server..."
    if [ -d "$SCRIPT_DIR/../host" ]; then
        (cd "$SCRIPT_DIR/../host" && node server.js &)
        sleep 2
    fi
fi

echo "Starting AI Computer Agent..."
echo "  Host: $HOST_WS_URL"
echo "  Repo: $REPO_PATH"
echo "  Email: $USER_EMAIL"

python3 agent.py
