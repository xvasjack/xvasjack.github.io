"""
Agent Configuration

Copy this file to config_local.py and customize for your setup.
config_local.py is gitignored.
"""

import os
import platform
import logging
from dataclasses import dataclass, field
from typing import List
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO)
_logger = logging.getLogger("config")


# M1: Single source of truth for Claude model
CLAUDE_MODEL = "claude-opus-4-5-20250514"


# Issue 30/34 fix: Allowed hosts for WebSocket connections
ALLOWED_WS_HOSTS = {
    "localhost",
    "127.0.0.1",
    "::1",
}


def _validate_ws_url(url: str) -> str:
    """Issue 30/34 fix: Validate WebSocket URL against allowed hosts."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""

        # Allow localhost and explicitly configured hosts
        if hostname in ALLOWED_WS_HOSTS:
            return url

        # If URL comes from env var, log a warning but allow it
        # (user explicitly configured it)
        if os.environ.get("HOST_WS_URL"):
            _logger.warning(
                f"HOST_WS_URL is set to non-localhost host: {hostname}. "
                f"Ensure this is intentional and secure."
            )
            return url

        # Default to localhost
        _logger.warning(f"Invalid WebSocket host: {hostname}, defaulting to localhost")
        return "ws://localhost:3000/agent"
    except Exception as e:
        _logger.error(f"WebSocket URL validation error: {e}")
        return "ws://localhost:3000/agent"


@dataclass
class AgentConfig:
    # No API key needed — Claude Code CLI uses Max subscription
    anthropic_api_key: str = ""

    # Host controller WebSocket URL
    host_ws_url: str = "ws://localhost:3000/agent"

    # Claude model to use
    model: str = CLAUDE_MODEL

    # Max tokens per response
    max_tokens: int = 4096

    # Screenshot scale (reduce to save tokens)
    screenshot_scale: float = 0.75

    # Claude Code CLI path
    claude_code_path: str = "claude"

    # Repo path
    repo_path: str = os.path.expanduser("~/xvasjack.github.io")


# M4: Single GuardrailConfig — guardrails.py imports from here
@dataclass
class GuardrailConfig:
    # Allowed email senders - ONLY emails from these senders can be accessed
    allowed_email_senders: List[str] = field(default_factory=lambda: [
        "noreply@github.com",
        "notifications@github.com",
    ])

    # Allowed email subject patterns (regex)
    allowed_email_subjects: List[str] = field(default_factory=lambda: [
        r"target.*search",
        r"market.*research",
        r"profile.*slides",
        r"trading.*comp",
        r"validation.*result",
        r"due.*diligence",
        r"PR.*merged",
        r"GitHub",
        r"Pull request",
    ])

    # GitHub repos that can be accessed
    github_allowed_repos: List[str] = field(default_factory=lambda: [
        "xvasjack",
    ])

    # Your frontend URL
    frontend_url: str = "https://xvasjack.github.io"

    # Folders the agent can access
    allowed_folders: List[str] = field(default_factory=lambda: [
        r"C:\\Users\\.*\\Downloads",
        r"C:\\agent-shared",
        r"Z:\\",
    ])


@dataclass
class PathConfig:
    # Where Claude Code is installed
    claude_code_path: str = "claude"

    # Your repo path (used as cwd for Claude Code)
    repo_path: str = os.path.expanduser("~/xvasjack.github.io")

    # Shared folder between host and agent
    shared_folder: str = r"C:\agent-shared"

    # Download folder for attachments (use actual browser download path)
    download_folder: str = os.path.join(os.path.expanduser("~"), "Downloads")

    # Issue 3: Gmail API credentials
    gmail_credentials_path: str = os.environ.get(
        "GMAIL_CREDENTIALS_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials", "gmail_credentials.json"),
    )
    gmail_token_path: str = os.environ.get(
        "GMAIL_TOKEN_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials", "gmail_token.json"),
    )

    # Issue 8: Loop state persistence
    loop_state_path: str = os.environ.get(
        "LOOP_STATE_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "loop_state.json"),
    )

    # Issue 9: Learned templates directory
    templates_dir: str = os.environ.get(
        "TEMPLATES_DIR",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates"),
    )


# Issue 2: Railway backend URLs
RAILWAY_URLS = {
    "target-v3": os.environ.get("TARGET_V3_URL", "https://target-v3.up.railway.app"),
    "target-v4": os.environ.get("TARGET_V4_URL", "https://target-v4.up.railway.app"),
    "target-v5": os.environ.get("TARGET_V5_URL", "https://target-v5.up.railway.app"),
    "target-v6": os.environ.get("TARGET_V6_URL", "https://target-v6.up.railway.app"),
    "market-research": os.environ.get("MARKET_RESEARCH_URL", "https://market-research.up.railway.app"),
    "profile-slides": os.environ.get("PROFILE_SLIDES_URL", "https://profile-slides.up.railway.app"),
    "trading-comparable": os.environ.get("TRADING_COMPARABLE_URL", "https://trading-comparable.up.railway.app"),
    "validation": os.environ.get("VALIDATION_URL", "https://validation.up.railway.app"),
    "due-diligence": os.environ.get("DUE_DILIGENCE_URL", "https://due-diligence.up.railway.app"),
    "utb": os.environ.get("UTB_URL", "https://utb.up.railway.app"),
}


# Load configuration
def load_config():
    """Load configuration from environment or config file"""

    # Issue 30/34 fix: Validate WebSocket URL
    raw_ws_url = os.environ.get("HOST_WS_URL", "ws://localhost:3000/agent")
    validated_ws_url = _validate_ws_url(raw_ws_url)

    agent = AgentConfig(
        host_ws_url=validated_ws_url,
    )

    guardrails = GuardrailConfig()
    paths = PathConfig(
        repo_path=os.environ.get("REPO_PATH", os.path.expanduser("~/xvasjack.github.io")),
        download_folder=os.environ.get(
            "AGENT_DOWNLOAD_PATH",
            os.path.join(os.path.expanduser("~"), "Downloads")
        ),
    )

    # Try to load local overrides
    try:
        from config_local import (
            agent_config,
            guardrail_config,
            path_config
        )
        agent = agent_config
        guardrails = guardrail_config
        paths = path_config
    except ImportError:
        pass

    return agent, guardrails, paths


# L8: Validate configuration — only check paths appropriate for current OS
def validate_config(agent: AgentConfig, paths: PathConfig) -> List[str]:
    """Check configuration for issues"""
    issues = []

    if not os.path.exists(paths.repo_path):
        issues.append(f"Repo path does not exist: {paths.repo_path}")

    # Only check Windows-specific paths on Windows
    if platform.system() == "Windows":
        if not os.path.exists(paths.shared_folder):
            issues.append(f"Shared folder does not exist: {paths.shared_folder}")

    # Issue 7/48 fix: Warn if credentials are in repo directory (security risk)
    repo_dir = os.path.realpath(paths.repo_path)
    for cred_path in [paths.gmail_credentials_path, paths.gmail_token_path]:
        if cred_path and os.path.exists(cred_path):
            cred_real = os.path.realpath(cred_path)
            if cred_real.startswith(repo_dir):
                issues.append(
                    f"SECURITY WARNING: Credential file {cred_path} is inside repo directory. "
                    f"Set GMAIL_CREDENTIALS_PATH and GMAIL_TOKEN_PATH env vars to move outside repo."
                )

    return issues
