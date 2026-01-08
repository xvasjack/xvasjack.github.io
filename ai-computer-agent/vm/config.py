"""
VM Agent Configuration

Copy this file to config_local.py and customize for your setup.
config_local.py is gitignored.
"""

import os
from dataclasses import dataclass, field
from typing import List


@dataclass
class AgentConfig:
    # Anthropic API key
    anthropic_api_key: str = ""

    # Host controller WebSocket URL
    # This should be your main PC's IP address on the local network
    host_ws_url: str = "ws://192.168.1.100:3000/agent"

    # Claude model to use
    model: str = "claude-opus-4-5-20250514"

    # Max tokens per response
    max_tokens: int = 4096

    # Screenshot scale (reduce to save tokens)
    screenshot_scale: float = 0.75


@dataclass
class GuardrailConfig:
    # Allowed email senders - ONLY emails from these senders can be accessed
    allowed_email_senders: List[str] = field(default_factory=lambda: [
        "noreply@github.com",
        "notifications@github.com",
        # Add your SendGrid sender email here
        # "your-automation@yourdomain.com",
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
        "xvasjack",  # Your GitHub username
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

    # Your repo path
    repo_path: str = r"C:\Users\You\Projects\xvasjack.github.io"

    # Shared folder between host and VM
    shared_folder: str = r"C:\agent-shared"

    # Download folder for attachments
    download_folder: str = r"C:\agent-shared\downloads"


# Load configuration
def load_config():
    """Load configuration from environment or config file"""

    agent = AgentConfig(
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://192.168.1.100:3000/agent"),
    )

    guardrails = GuardrailConfig()
    paths = PathConfig()

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


# Validate configuration
def validate_config(agent: AgentConfig, paths: PathConfig) -> List[str]:
    """Check configuration for issues"""
    issues = []

    if not agent.anthropic_api_key:
        issues.append("ANTHROPIC_API_KEY not set")

    if not os.path.exists(paths.repo_path):
        issues.append(f"Repo path does not exist: {paths.repo_path}")

    if not os.path.exists(paths.shared_folder):
        issues.append(f"Shared folder does not exist: {paths.shared_folder}")

    return issues
