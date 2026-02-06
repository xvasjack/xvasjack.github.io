#!/usr/bin/env python3
"""
PreToolUse Hook — Defense in depth for Claude Code invocations.

This hook runs before every tool call when Claude Code is invoked by the agent.
It blocks modifications to protected files and dangerous commands.
When AGENT_MODE=1 (set by agent subprocess), also blocks fabricated content.

Usage in .claude/settings.json:
{
  "hooks": {
    "PreToolUse": [
      {
        "command": "python3 ai-computer-agent/.claude/hooks/agent_guard.py"
      }
    ]
  }
}
"""

import json
import sys
import re
import os

# Import shared fabrication patterns
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'vm'))
try:
    from fabrication_patterns import check_fabrication as _shared_check_fabrication, FABRICATION_PATTERNS
except ImportError:
    # Fallback: if shared module not found, define minimal patterns inline
    FABRICATION_PATTERNS = [
        r"https?://www\.\w+-\w+-\w+\.com\.\w{2}",
        r"getFallback\w*Content|getDefault\w*Data",
        r"fallback(?:Result|Data|Companies|Regulations)",
        r"\[\s*20\d{2}\s*(?:,\s*20\d{2}\s*){3,}\]",
    ]
    _shared_check_fabrication = None


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


def _allow():
    """Return allow response in new hook format."""
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow"
        }
    }))


def _deny(reason: str):
    """Return deny response in new hook format."""
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    }))


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


def check_fabrication(content: str) -> str:
    """Check content for fabrication patterns. Returns block reason or empty string."""
    if not content:
        return ""

    # Use shared module if available (has broader patterns)
    if _shared_check_fabrication is not None:
        result = _shared_check_fabrication(content)
        return result or ""

    # Fallback: local check with inline patterns
    for pattern in FABRICATION_PATTERNS:
        match = re.search(pattern, content, re.IGNORECASE)
        if match:
            return f"FABRICATION DETECTED: Pattern '{pattern}' matched '{match.group(0)[:50]}'"

    return ""


def check_bash_file_write(command: str) -> str:
    """Block Bash commands that write to backend files. Agent must use Edit tool."""
    # Patterns that write to files
    file_write_patterns = [
        r"echo\s+.*>",           # echo > file
        r"cat\s+.*>",            # cat > file (heredoc)
        r"printf\s+.*>",         # printf > file
        r"sed\s+-i",             # sed in-place edit
        r"awk\s+.*>",            # awk > file
        r"tee\s+",               # tee writes to files
    ]

    for pattern in file_write_patterns:
        if re.search(pattern, command):
            # Check if it's writing to backend/
            if "backend/" in command or "/backend/" in command:
                return "BLOCKED: Use Edit tool to modify backend files, not Bash commands"

    return ""


def main():
    # Check if running in agent mode
    agent_mode = os.environ.get("AGENT_MODE") == "1"

    # Read tool call from stdin
    try:
        input_data = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, EOFError):
        # Can't parse input, allow by default
        _allow()
        return

    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    # Check file-modifying tools
    if tool_name in ("Edit", "Write", "MultiEdit"):
        file_path = tool_input.get("file_path", "")
        reason = check_file_path(file_path)
        if reason:
            _deny(f"AGENT GUARD: {reason} — file: {file_path}")
            return

        # AGENT_MODE: Check for fabrication in ALL file writes (not just backend/)
        if agent_mode:
            content = tool_input.get("new_string", "") or tool_input.get("content", "")
            reason = check_fabrication(content)
            if reason:
                _deny(f"AGENT GUARD: {reason}")
                return

    # Check bash commands
    if tool_name == "Bash":
        command = tool_input.get("command", "")
        reason = check_command(command)
        if reason:
            _deny(f"AGENT GUARD: {reason} — command: {command[:100]}")
            return

        # AGENT_MODE: Block Bash file writes to backend
        if agent_mode:
            reason = check_bash_file_write(command)
            if reason:
                _deny(f"AGENT GUARD: {reason}")
                return

            # AGENT_MODE: Check Bash command content for fabrication patterns
            # Catches: echo "fake data" > file, heredocs, printf, etc.
            reason = check_fabrication(command)
            if reason:
                _deny(f"AGENT GUARD: {reason} (in Bash command)")
                return

    # Allow everything else
    _allow()


if __name__ == "__main__":
    main()
