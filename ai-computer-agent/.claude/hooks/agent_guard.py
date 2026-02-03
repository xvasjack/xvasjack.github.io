#!/usr/bin/env python3
"""
PreToolUse Hook — Defense in depth for Claude Code invocations.

This hook runs before every tool call when Claude Code is invoked by the agent.
It blocks modifications to protected files and dangerous commands.

Usage in .claude/settings.json:
{
  "hooks": {
    "PreToolUse": [
      {
        "command": "python3 .claude/hooks/agent_guard.py"
      }
    ]
  }
}
"""

import json
import sys
import re


# Files/patterns that should NEVER be modified
PROTECTED_PATTERNS = [
    ".env",
    ".env.",
    "credentials",
    "secrets",
    ".github/workflows/",
    "CLAUDE.md",
    "ai-computer-agent/",
    ".git/config",
    ".pem",
    ".key",
    ".cert",
]

# Commands that should NEVER be run
DANGEROUS_COMMANDS = [
    "rm -rf",
    "push --force",
    "push -f",
    "reset --hard",
    "format c:",
    "format d:",
    "del /s",
    "rmdir /s",
    "git push origin main",
    "git push origin master",
]


def check_file_path(file_path: str) -> str:
    """Check if a file path is protected. Returns block reason or empty string."""
    for pattern in PROTECTED_PATTERNS:
        if pattern in file_path:
            return f"Protected file pattern: {pattern}"
    return ""


def check_command(command: str) -> str:
    """Check if a command is dangerous. Returns block reason or empty string."""
    command_lower = command.lower()
    for danger in DANGEROUS_COMMANDS:
        if danger in command_lower:
            return f"Dangerous command: {danger}"

    # H27 fix: Also block force push variants to main/master
    if "push" in command_lower and ("main" in command_lower or "master" in command_lower):
        if "-f" in command_lower or "--force" in command_lower or "--force-with-lease" in command_lower:
            return "BLOCKED: Force push to main/master is forbidden"

    return ""


def main():
    # Read tool call from stdin
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        # Can't parse input, allow by default
        print(json.dumps({"decision": "allow"}))
        return

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    # Check file-modifying tools
    if tool_name in ("Edit", "Write", "MultiEdit"):
        file_path = tool_input.get("file_path", "")
        reason = check_file_path(file_path)
        if reason:
            print(json.dumps({
                "decision": "block",
                "reason": f"AGENT GUARD: {reason} — file: {file_path}"
            }))
            return

    # Check bash commands
    if tool_name == "Bash":
        command = tool_input.get("command", "")
        reason = check_command(command)
        if reason:
            print(json.dumps({
                "decision": "block",
                "reason": f"AGENT GUARD: {reason} — command: {command[:100]}"
            }))
            return

    # Allow everything else
    print(json.dumps({"decision": "allow"}))


if __name__ == "__main__":
    main()
