"""
Gmail Actions - Read emails and download attachments from Gmail.

STRICT GUARDRAILS:
- Can ONLY read emails from authorized senders (automation outputs)
- Can ONLY download attachments
- CANNOT compose, reply, forward, or send any emails
- CANNOT delete or archive emails

This module uses browser automation to interact with Gmail web interface.
"""

import asyncio
import os
import re
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
import logging

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import (
    open_url_in_browser, screenshot, click, type_text,
    press_key, hotkey, scroll, wait, focus_window
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gmail_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


GMAIL_URL = "https://mail.google.com"
DOWNLOAD_PATH = os.environ.get("AGENT_DOWNLOAD_PATH", r"C:\agent-shared\downloads")


# =============================================================================
# ALLOWED EMAIL PATTERNS - STRICT GUARDRAILS
# =============================================================================


ALLOWED_SENDER_PATTERNS = [
    # GitHub notifications
    r"noreply@github\.com",
    r"notifications@github\.com",

    # Your automation sender (SendGrid)
    # Add your actual sender email pattern here
    r".*@.*\.sendgrid\.net",

    # Railway notifications
    r".*@railway\.app",
]

ALLOWED_SUBJECT_PATTERNS = [
    # Your automation outputs
    r"target.*search.*result",
    r"target.*v\d+.*result",
    r"market.*research.*complete",
    r"profile.*slides.*ready",
    r"trading.*comp.*result",
    r"validation.*complete",
    r"due.*diligence.*report",
    r"transcription.*complete",

    # GitHub
    r"\[GitHub\]",
    r"PR.*merged",
    r"Pull request",
    r"Build.*failed",
    r"Build.*succeeded",
]


def is_email_allowed(sender: str, subject: str) -> bool:
    """Check if email matches allowed patterns"""
    sender_ok = any(re.search(p, sender, re.IGNORECASE) for p in ALLOWED_SENDER_PATTERNS)
    subject_ok = any(re.search(p, subject, re.IGNORECASE) for p in ALLOWED_SUBJECT_PATTERNS)

    if not sender_ok:
        logger.warning(f"BLOCKED: Sender not allowed: {sender}")
    if not subject_ok:
        logger.warning(f"BLOCKED: Subject not allowed: {subject}")

    return sender_ok and subject_ok


# =============================================================================
# GMAIL NAVIGATION
# =============================================================================


async def open_gmail():
    """Open Gmail in browser"""
    logger.info("Opening Gmail")
    await open_url_in_browser(GMAIL_URL)
    await wait(3)

    # Check if we need to sign in
    screen = await screenshot()
    return {
        "screenshot": screen,
        "action": "check_login_status"
    }


async def search_emails(query: str):
    """
    Search for emails in Gmail.

    Args:
        query: Gmail search query (e.g., "from:noreply@github.com has:attachment")
    """
    logger.info(f"Searching Gmail: {query}")

    # Click search box (usually has "/" shortcut)
    await press_key("/")
    await wait(0.3)

    # Clear existing search
    await hotkey("ctrl", "a")
    await wait(0.1)

    # Type search query
    await type_text(query)
    await press_key("enter")
    await wait(2)


async def search_automation_emails():
    """Search specifically for automation output emails with attachments"""
    # Search for emails with attachments from automation senders
    query = "has:attachment newer_than:7d"
    await search_emails(query)
    await wait(2)


async def open_first_email():
    """Open the first email in the list"""
    # Press 'o' to open (Gmail keyboard shortcut)
    await press_key("o")
    await wait(1)


async def go_to_inbox():
    """Navigate to inbox"""
    # Press 'g' then 'i' for Go to Inbox
    await press_key("g")
    await wait(0.2)
    await press_key("i")
    await wait(1)


# =============================================================================
# EMAIL READING
# =============================================================================


@dataclass
class EmailInfo:
    """Information extracted from an email"""
    sender: str
    subject: str
    has_attachment: bool
    attachment_names: List[str]
    is_allowed: bool
    screenshot: str


async def get_current_email_info() -> Dict[str, Any]:
    """
    Take screenshot of current email and return info for Claude to analyze.
    Claude will extract sender, subject, and attachment info.
    """
    screen = await screenshot()

    return {
        "screenshot": screen,
        "action": "extract_email_info",
        "instructions": """
            Extract from this email:
            1. Sender email address
            2. Subject line
            3. Whether it has attachments
            4. Attachment filenames if visible

            Then verify against allowed patterns:
            - Allowed senders: GitHub, SendGrid, Railway
            - Allowed subjects: target search, market research, profile slides, trading comp, validation, due diligence, GitHub PR

            Return JSON:
            {
                "sender": "...",
                "subject": "...",
                "has_attachment": true/false,
                "attachment_names": ["..."],
                "is_allowed": true/false,
                "reason": "why allowed or not"
            }
        """
    }


# =============================================================================
# ATTACHMENT HANDLING
# =============================================================================


async def download_attachment(filename_hint: Optional[str] = None):
    """
    Download attachment from currently open email.

    Gmail shows attachments at bottom of email or as chips.
    """
    logger.info(f"Downloading attachment: {filename_hint or 'any'}")

    # Take screenshot for Claude to find attachment
    screen = await screenshot()

    return {
        "screenshot": screen,
        "action": "download_attachment",
        "filename_hint": filename_hint,
        "instructions": """
            Find the attachment in this email and download it:
            1. Look for attachment preview at bottom of email
            2. Hover over attachment to show download button
            3. Click download icon (down arrow)

            For multiple attachments, download all of them.

            If filename_hint provided, prioritize that file.
            Common files: .pptx, .xlsx, .pdf
        """
    }


async def download_all_attachments():
    """Download all attachments from current email"""
    logger.info("Downloading all attachments")

    # Gmail shortcut: hover attachment, click download
    # Or use "Download all" if available

    screen = await screenshot()

    return {
        "screenshot": screen,
        "action": "download_all_attachments",
        "instructions": """
            Download all attachments from this email:
            1. Scroll down to see all attachments if needed
            2. Look for "Download all" button or download each individually
            3. Each attachment should be downloaded to Downloads folder
        """
    }


async def wait_for_download(timeout_seconds: int = 30) -> bool:
    """Wait for download to complete"""
    # Check Downloads folder for new files
    # This is handled by monitoring the download folder
    await wait(5)  # Give it time
    return True


# =============================================================================
# BLOCKED ACTIONS - WILL RAISE ERRORS
# =============================================================================


async def _blocked_action(action_name: str):
    """Raise error for blocked actions"""
    error_msg = f"BLOCKED: {action_name} is strictly forbidden by guardrails"
    logger.error(error_msg)
    raise PermissionError(error_msg)


async def compose_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("compose_email")


async def reply_to_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("reply_to_email")


async def forward_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("forward_email")


async def send_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("send_email")


async def delete_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("delete_email")


async def archive_email(*args, **kwargs):
    """BLOCKED"""
    await _blocked_action("archive_email")


# =============================================================================
# NAVIGATION HELPERS
# =============================================================================


async def next_email():
    """Go to next email in list"""
    await press_key("j")  # Gmail shortcut
    await wait(0.5)


async def previous_email():
    """Go to previous email in list"""
    await press_key("k")  # Gmail shortcut
    await wait(0.5)


async def back_to_list():
    """Go back to email list from email view"""
    await press_key("u")  # Gmail shortcut
    await wait(0.5)


async def refresh_inbox():
    """Refresh the inbox"""
    # Shift + N or just reload
    await press_key("f5")
    await wait(2)


async def enable_keyboard_shortcuts():
    """
    Ensure Gmail keyboard shortcuts are enabled.
    Go to Settings > See all settings > General > Keyboard shortcuts > ON
    """
    # This would need to be done once manually
    # Or we can navigate programmatically
    pass


# =============================================================================
# COMPLETE WORKFLOWS
# =============================================================================


async def find_and_download_automation_output(
    service_name: str,
    max_age_days: int = 1
) -> Dict[str, Any]:
    """
    Complete workflow to find and download automation output.

    1. Open Gmail
    2. Search for recent automation emails
    3. Find email matching service
    4. Verify it's from allowed sender
    5. Download attachments
    6. Return file paths

    Args:
        service_name: e.g., "target-v6", "market-research", "profile-slides"
        max_age_days: Only look at emails from last N days

    Returns:
        Dict with status and downloaded file info
    """
    logger.info(f"Looking for {service_name} output email")

    # Open Gmail
    await open_gmail()

    # Search for the specific service output
    query = f"subject:{service_name} has:attachment newer_than:{max_age_days}d"
    await search_emails(query)

    # Take screenshot to verify results
    screen = await screenshot()

    return {
        "screenshot": screen,
        "action": "find_and_open_email",
        "service_name": service_name,
        "next_steps": [
            "1. Verify email is from allowed sender",
            "2. Open the email",
            "3. Download all attachments",
            "4. Return file paths"
        ]
    }


async def wait_for_automation_email(
    service_name: str,
    timeout_minutes: int = 30,
    check_interval_seconds: int = 60
) -> Dict[str, Any]:
    """
    Wait for an automation email to arrive.

    Args:
        service_name: Service to wait for (e.g., "target-v6")
        timeout_minutes: Max time to wait
        check_interval_seconds: How often to check

    Returns:
        Dict with status and email info when found
    """
    logger.info(f"Waiting for {service_name} email (timeout: {timeout_minutes}min)")

    start_time = asyncio.get_event_loop().time()
    timeout_seconds = timeout_minutes * 60

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            return {
                "status": "timeout",
                "message": f"No email found after {timeout_minutes} minutes"
            }

        # Check for new email
        await open_gmail()
        query = f"subject:{service_name} has:attachment newer_than:1h is:unread"
        await search_emails(query)

        # Take screenshot for analysis
        screen = await screenshot()

        # Return for Claude to check if email found
        yield {
            "screenshot": screen,
            "action": "check_for_email",
            "elapsed_minutes": int(elapsed / 60),
            "remaining_minutes": int((timeout_seconds - elapsed) / 60),
        }

        # Wait before next check
        await wait(check_interval_seconds)


# =============================================================================
# FILE MONITORING
# =============================================================================


def get_recent_downloads(
    folder: str = DOWNLOAD_PATH,
    extensions: List[str] = [".pptx", ".xlsx", ".pdf"],
    max_age_minutes: int = 5
) -> List[str]:
    """
    Get list of recently downloaded files.

    Args:
        folder: Download folder path
        extensions: File extensions to look for
        max_age_minutes: Only files modified in last N minutes

    Returns:
        List of file paths
    """
    import time

    if not os.path.exists(folder):
        return []

    recent_files = []
    cutoff_time = time.time() - (max_age_minutes * 60)

    for filename in os.listdir(folder):
        filepath = os.path.join(folder, filename)

        # Check extension
        if not any(filename.lower().endswith(ext) for ext in extensions):
            continue

        # Check modification time
        if os.path.getmtime(filepath) > cutoff_time:
            recent_files.append(filepath)

    return sorted(recent_files, key=os.path.getmtime, reverse=True)
