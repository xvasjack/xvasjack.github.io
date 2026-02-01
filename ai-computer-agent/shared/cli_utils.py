"""Shared CLI utilities for invoking Claude Code from Windows/WSL."""
import os


def build_claude_cmd(claude_path, *args, wsl_cwd=None):
    """Build command list. Handles 'wsl:' prefix -> ['wsl', '--cd', cwd, '-e', 'claude', ...]
    
    B1 fix: When WSL mode, use --cd to set cwd inside WSL instead of passing
    a Linux path as subprocess cwd (which causes WinError 267 on Windows).
    """
    if claude_path.startswith("wsl:"):
        base = ["wsl"]
        if wsl_cwd:
            base += ["--cd", wsl_cwd]
        return base + ["-e", claude_path[4:]] + list(args)
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


def get_subprocess_cwd(claude_path=None):
    """B1 fix: Returns (win_cwd, wsl_cwd) tuple.
    
    WSL mode: (None, linux_path) — pass cwd=None to subprocess, wsl_cwd to build_claude_cmd.
    Native mode: (native_path, None) — pass cwd=native_path to subprocess.
    """
    if is_wsl_mode(claude_path):
        return None, get_repo_cwd(claude_path)
    return get_repo_cwd(claude_path), None
