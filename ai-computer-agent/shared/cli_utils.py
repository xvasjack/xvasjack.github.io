"""Shared CLI utilities for invoking Claude Code from Windows/WSL."""
import os


def build_claude_cmd(claude_path, *args):
    """Build command list. Handles 'wsl:' prefix -> ['wsl', '-e', 'claude', ...]"""
    if claude_path.startswith("wsl:"):
        return ["wsl", "-e", claude_path[4:]] + list(args)
    return [claude_path] + list(args)


def is_wsl_mode(claude_path=None):
    if claude_path is None:
        claude_path = os.environ.get("CLAUDE_CODE_PATH", "claude")
    return claude_path.startswith("wsl:")


def to_wsl_path(win_path):
    """C:\\Users\\User\\foo -> /mnt/c/Users/User/foo"""
    if not win_path or len(win_path) < 2 or win_path[1] != ':':
        return win_path
    drive = win_path[0].lower()
    rest = win_path[2:].replace('\\', '/')
    return f"/mnt/{drive}{rest}"


def get_claude_code_path():
    return os.environ.get("CLAUDE_CODE_PATH", "claude")


def get_repo_cwd(claude_path=None):
    """Repo dir: WSL path when WSL mode, expanduser otherwise."""
    if is_wsl_mode(claude_path):
        return "/home/xvasjack/xvasjack.github.io"
    return os.environ.get("REPO_PATH", os.path.expanduser("~/xvasjack.github.io"))
