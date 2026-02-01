"""
STRICT GUARDRAILS FOR AI COMPUTER AGENT

This module enforces hard limits on what the agent can and cannot do.
These guardrails are NON-NEGOTIABLE and cannot be bypassed.

BLOCKED:
- Microsoft Teams (all access)
- Any email not related to AI automation output
- Billing/payment pages
- Email composition/sending
- Destructive file operations outside designated folders

ALLOWED:
- GitHub (PRs, code review, merging)
- Outlook (ONLY reading emails from allowed senders)
- Your frontend (form submission)
- Railway (viewing logs)
- File Explorer (Downloads folder only)
- Claude Code CLI
"""

import re
from dataclasses import dataclass
from typing import List, Tuple, Optional
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("guardrails")


class BlockReason(Enum):
    TEAMS_ACCESS = "Microsoft Teams access is strictly forbidden"
    UNAUTHORIZED_EMAIL = "This email is not from an authorized sender"
    EMAIL_COMPOSE = "Composing or sending emails is forbidden"
    BILLING_PAGE = "Billing and payment pages are forbidden"
    UNAUTHORIZED_APP = "This application is not authorized"
    DESTRUCTIVE_ACTION = "This destructive action is not allowed"
    UNAUTHORIZED_FOLDER = "Access to this folder is not authorized"


# M4: Import GuardrailConfig from config.py (single source of truth)
# F69: Add parent dir to sys.path so import works regardless of cwd
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from config import GuardrailConfig


# Global config instance
CONFIG = GuardrailConfig()


def update_config(new_config: dict):
    """Update guardrail config from settings"""
    global CONFIG
    for key, value in new_config.items():
        if hasattr(CONFIG, key):
            setattr(CONFIG, key, value)
    logger.info(f"Guardrails config updated: {new_config}")


# =============================================================================
# BLOCKED PATTERNS - HARD CODED, CANNOT BE CHANGED AT RUNTIME
# =============================================================================

# Window titles that are ALWAYS blocked
BLOCKED_WINDOW_TITLES = [
    r"Microsoft Teams",
    r"Teams",
    r"teams\.microsoft\.com",
    r"teams\.live\.com",
    # Prevent accessing other communication apps
    r"Slack",
    r"Discord",
    r"WhatsApp",
    r"Telegram",
    r"Signal",
    # Prevent accessing financial/payment
    r"PayPal",
    r"Stripe Dashboard",
    r"\bbilling\b",
    r"\bpayment\b",
    r"\bcheckout\b",
    # Prevent accessing AI billing specifically
    r"platform\.openai\.com.*billing",
    r"console\.anthropic\.com.*billing",
    r"api\.together\.ai.*billing",
]

# URLs that are ALWAYS blocked
# Issue 5/15 fix: Use non-greedy .*? to prevent ReDoS exponential backtracking
BLOCKED_URLS = [
    r"teams\.microsoft\.com",
    r"teams\.live\.com",
    r".*?\.slack\.com",
    r"discord\.com",
    r"web\.whatsapp\.com",
    r"web\.telegram\.org",
    # L3: More specific billing URL patterns (avoid blocking unrelated URLs)
    # Issue 5 fix: Use non-greedy quantifiers to prevent ReDoS
    r".*?[/.]billing[/.].*?",
    r".*?[/.]payment[/.].*?",
    r".*?[/.]checkout[/.].*?",
    r"platform\.openai\.com/account",
    r"console\.anthropic\.com/settings/billing",
    # Email compose - Issue 5 fix: Use non-greedy quantifiers
    r"outlook.*?\?compose",
    r"outlook.*?/mail/compose",
    r"mail\.google\.com.*?compose",
    r"outlook.*?/owa/.*?action=compose",
]

# Text patterns that indicate email composition (block these actions)
EMAIL_COMPOSE_INDICATORS = [
    r"new message",
    r"new email",
    r"compose",
    r"reply",
    r"reply all",
    r"forward",
    r"send",
    r"draft",
]

# Process names that are ALWAYS blocked
BLOCKED_PROCESSES = [
    "Teams.exe",
    "ms-teams.exe",
    "slack.exe",
    "Discord.exe",
    "WhatsApp.exe",
    "Telegram.exe",
]


# =============================================================================
# GUARDRAIL CHECK FUNCTIONS
# =============================================================================


def check_window_title(title: str) -> Tuple[bool, Optional[BlockReason]]:
    """Check if a window title is allowed"""
    title_lower = title.lower()

    for pattern in BLOCKED_WINDOW_TITLES:
        if re.search(pattern, title, re.IGNORECASE):
            logger.warning(f"BLOCKED: Window title matches blocked pattern: {pattern}")
            return False, BlockReason.TEAMS_ACCESS if "teams" in pattern.lower() else BlockReason.UNAUTHORIZED_APP

    return True, None


def check_url(url: str) -> Tuple[bool, Optional[BlockReason]]:
    """Check if a URL is allowed"""
    url_lower = url.lower()

    # SEC-6: Validate URL scheme to block dangerous protocols
    ALLOWED_SCHEMES = ('http://', 'https://', 'ws://', 'wss://')
    if url_lower and not any(url_lower.startswith(scheme) for scheme in ALLOWED_SCHEMES):
        # Block javascript:, data:, file://, and other dangerous schemes
        logger.warning(f"BLOCKED: URL has disallowed scheme: {url[:50]}")
        return False, BlockReason.UNAUTHORIZED_APP

    for pattern in BLOCKED_URLS:
        if re.search(pattern, url, re.IGNORECASE):
            logger.warning(f"BLOCKED: URL matches blocked pattern: {pattern}")

            if "teams" in pattern.lower():
                return False, BlockReason.TEAMS_ACCESS
            elif "billing" in pattern.lower() or "payment" in pattern.lower():
                return False, BlockReason.BILLING_PAGE
            elif "compose" in pattern.lower():
                return False, BlockReason.EMAIL_COMPOSE
            else:
                return False, BlockReason.UNAUTHORIZED_APP

    return True, None


def check_email_allowed(sender: str, subject: str) -> Tuple[bool, Optional[BlockReason]]:
    """Check if an email is from an allowed sender with allowed subject"""

    # SEC-9: Limit input length to mitigate ReDoS risk
    MAX_SENDER_LENGTH = 500
    MAX_SUBJECT_LENGTH = 1000
    sender = sender[:MAX_SENDER_LENGTH] if sender else ""
    subject = subject[:MAX_SUBJECT_LENGTH] if subject else ""

    # H17 fix: Domain-anchored matching to prevent bypass via attacker@not-sendgrid.net
    sender_allowed = False
    sender_lower = sender.lower().strip()
    # Extract email address from sender field (handle "Name <email>" format)
    email_match = re.search(r'[\w.+-]+@[\w.-]+', sender_lower)
    if email_match:
        sender_email = email_match.group(0)
        _, _, sender_domain = sender_email.rpartition('@')
        for allowed_sender in CONFIG.allowed_email_senders:
            allowed = allowed_sender.lower().strip()
            if '@' in allowed:
                # Full email match
                if sender_email == allowed:
                    sender_allowed = True
                    break
            else:
                # Domain match: exact or subdomain (e.g. mail.sendgrid.net matches sendgrid.net)
                if sender_domain == allowed or sender_domain.endswith('.' + allowed):
                    sender_allowed = True
                    break

    if not sender_allowed:
        logger.warning(f"BLOCKED: Email sender not in allowed list: {sender}")
        return False, BlockReason.UNAUTHORIZED_EMAIL

    # Check subject matches expected patterns
    # SEC-9: Subject already truncated above to prevent ReDoS
    subject_allowed = False
    for pattern in CONFIG.allowed_email_subjects:
        try:
            if re.search(pattern, subject, re.IGNORECASE):
                subject_allowed = True
                break
        except re.error as e:
            logger.warning(f"Invalid regex pattern in config: {pattern} - {e}")
            continue

    if not subject_allowed:
        logger.warning(f"BLOCKED: Email subject doesn't match allowed patterns: {subject}")
        return False, BlockReason.UNAUTHORIZED_EMAIL

    return True, None


def check_email_compose_attempt(screen_text: str, action: dict) -> Tuple[bool, Optional[BlockReason]]:
    """Detect and block any attempt to compose/send emails"""

    # Check if action is trying to click compose-related buttons
    if action.get("action") == "click":
        target_text = action.get("params", {}).get("target_text", "").lower()
        for indicator in EMAIL_COMPOSE_INDICATORS:
            if re.search(indicator, target_text, re.IGNORECASE):
                logger.warning(f"BLOCKED: Attempted to click email compose button: {target_text}")
                return False, BlockReason.EMAIL_COMPOSE

    # Check if screen shows compose window
    screen_lower = screen_text.lower()
    compose_indicators = ["to:", "cc:", "bcc:", "subject:", "send", "discard draft"]
    compose_count = sum(1 for ind in compose_indicators if ind in screen_lower)

    # If multiple compose indicators present, likely in compose mode
    if compose_count >= 3:
        logger.warning("BLOCKED: Screen appears to be email compose window")
        return False, BlockReason.EMAIL_COMPOSE

    return True, None


def check_folder_access(path: str) -> Tuple[bool, Optional[BlockReason]]:
    """Check if folder/file access is allowed"""
    import os
    # M20 fix: Normalize path to prevent ../traversal bypass
    path = os.path.normpath(os.path.realpath(path))

    for allowed_pattern in CONFIG.allowed_folders:
        if re.match(allowed_pattern, path, re.IGNORECASE):
            return True, None

    logger.warning(f"BLOCKED: Folder access not authorized: {path}")
    return False, BlockReason.UNAUTHORIZED_FOLDER


def check_github_repo(repo_url: str) -> Tuple[bool, Optional[BlockReason]]:
    """M7: Check if GitHub repo access is allowed using URL parsing, not substring."""
    from urllib.parse import urlparse

    parsed = urlparse(repo_url)
    path_parts = [p for p in parsed.path.strip("/").split("/") if p]

    for allowed_repo in CONFIG.github_allowed_repos:
        # Check if the owner or repo name matches (first or second path component)
        if path_parts and path_parts[0].lower() == allowed_repo.lower():
            return True, None
        if len(path_parts) > 1 and path_parts[1].lower() == allowed_repo.lower():
            return True, None

    logger.warning(f"BLOCKED: GitHub repo not in allowed list: {repo_url}")
    return False, BlockReason.UNAUTHORIZED_APP


def check_process(process_name: str) -> Tuple[bool, Optional[BlockReason]]:
    """Check if a process is allowed to be interacted with"""

    for blocked in BLOCKED_PROCESSES:
        if blocked.lower() == process_name.lower():
            logger.warning(f"BLOCKED: Process is blocked: {process_name}")
            return False, BlockReason.TEAMS_ACCESS if "teams" in process_name.lower() else BlockReason.UNAUTHORIZED_APP

    return True, None


# =============================================================================
# MAIN GUARDRAIL CHECK
# =============================================================================


@dataclass
class GuardrailResult:
    allowed: bool
    reason: Optional[BlockReason] = None
    message: str = ""


def check_action(
    action: dict,
    current_window_title: str = "",
    current_url: str = "",
    screen_text: str = "",
    target_path: str = "",
) -> GuardrailResult:
    """
    Main guardrail check - run this before executing any action.

    Returns GuardrailResult indicating if action is allowed.
    """

    # Check window title
    allowed, reason = check_window_title(current_window_title)
    if not allowed:
        return GuardrailResult(False, reason, f"Window blocked: {current_window_title}")

    # Check URL
    if current_url:
        allowed, reason = check_url(current_url)
        if not allowed:
            return GuardrailResult(False, reason, f"URL blocked: {current_url}")

    # Check for email compose attempts
    allowed, reason = check_email_compose_attempt(screen_text, action)
    if not allowed:
        return GuardrailResult(False, reason, "Email composition is not allowed")

    # Check folder access if relevant
    if target_path:
        allowed, reason = check_folder_access(target_path)
        if not allowed:
            return GuardrailResult(False, reason, f"Folder access denied: {target_path}")

    # Check if trying to type in Teams
    if action.get("action") == "type":
        if "teams" in current_window_title.lower():
            return GuardrailResult(False, BlockReason.TEAMS_ACCESS, "Cannot type in Teams")

    return GuardrailResult(True, None, "Action allowed")


def check_email_before_open(sender: str, subject: str) -> GuardrailResult:
    """Check if we're allowed to open/interact with this email"""

    allowed, reason = check_email_allowed(sender, subject)
    if not allowed:
        return GuardrailResult(
            False,
            reason,
            f"Email not authorized. Sender: {sender}, Subject: {subject}"
        )

    return GuardrailResult(True, None, "Email access allowed")


# =============================================================================
# GUARDRAIL LOGGING
# =============================================================================


class GuardrailLogger:
    """Logs all guardrail checks for audit trail"""

    def __init__(self, log_file: str = "guardrail_audit.log"):
        self.log_file = log_file

    def log_check(self, action: dict, result: GuardrailResult):
        import json
        from datetime import datetime

        entry = {
            "timestamp": datetime.now().isoformat(),
            "action": action,
            "allowed": result.allowed,
            "reason": result.reason.value if result.reason else None,
            "message": result.message,
        }

        # Category 8 fix: Add try/except for file I/O to prevent crashes
        try:
            with open(self.log_file, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except (OSError, IOError) as e:
            logger.warning(f"Could not write to guardrail audit log: {e}")

    def log_blocked(self, action: dict, result: GuardrailResult):
        """Special logging for blocked actions"""
        logger.error(f"🚫 BLOCKED ACTION: {result.message}")
        logger.error(f"   Action: {action}")
        logger.error(f"   Reason: {result.reason.value if result.reason else 'Unknown'}")
        self.log_check(action, result)


# Global logger instance
AUDIT_LOGGER = GuardrailLogger()


def is_allowed(action: dict, context: dict) -> bool:
    """
    Simple boolean check for action allowance.
    Use this as the main entry point.
    """

    result = check_action(
        action=action,
        current_window_title=context.get("window_title", ""),
        current_url=context.get("url", ""),
        screen_text=context.get("screen_text", ""),
        target_path=context.get("target_path", ""),
    )

    if not result.allowed:
        AUDIT_LOGGER.log_blocked(action, result)

    return result.allowed
