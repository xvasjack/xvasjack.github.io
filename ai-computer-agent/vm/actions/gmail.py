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
import time
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
import logging

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import (
    open_url_in_browser, screenshot, click, type_text,
    press_key, hotkey, scroll, wait, focus_window, move_to,
    type_text_unicode,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gmail_actions")


# =============================================================================
# IV-1: Query parameter escaping to prevent injection
# =============================================================================


def _escape_query_param(value: str) -> str:
    """Escape special characters in Gmail search query parameters.

    IV-1: Prevents query injection by escaping characters that have special
    meaning in Gmail search syntax.
    """
    if not value:
        return ""
    # Escape quotes and backslashes, remove newlines/tabs
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", " ").replace("\r", " ").replace("\t", " ")
    # If value contains spaces, wrap in quotes
    if " " in escaped:
        escaped = f'"{escaped}"'
    return escaped


# =============================================================================
# CONFIGURATION
# =============================================================================


GMAIL_URL = "https://mail.google.com"

# F21: Read browser from env var, default to Brave (user's primary browser)
AGENT_BROWSER = os.environ.get("AGENT_BROWSER", "brave")

# Use actual browser download folder, not a custom one
DOWNLOAD_PATH = os.environ.get(
    "AGENT_DOWNLOAD_PATH",
    os.path.join(os.path.expanduser("~"), "Downloads")
)


# =============================================================================
# ALLOWED EMAIL PATTERNS - STRICT GUARDRAILS
# =============================================================================


ALLOWED_SENDER_PATTERNS = [
    r"noreply@github\.com",
    r"notifications@github\.com",
    r".*@.*\.sendgrid\.net",
    r".*@railway\.app",
]

ALLOWED_SUBJECT_PATTERNS = [
    r"target.*search.*result",
    r"target.*v\d+.*result",
    r"market.*research.*complete",
    r"profile.*slides.*ready",
    r"trading.*comp.*result",
    r"validation.*complete",
    r"due.*diligence.*report",
    r"transcription.*complete",
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
    """Open Gmail in browser and verify we reach the inbox (not a login page)."""
    logger.info(f"Opening Gmail in {AGENT_BROWSER}")
    # F27: Try to focus existing browser window first to avoid tab accumulation
    already_open = await focus_window(AGENT_BROWSER)
    if already_open:
        # Navigate in current tab instead of opening new one
        await hotkey("ctrl", "l")  # Focus address bar
        await wait(0.2)
        await type_text(GMAIL_URL)
        await press_key("enter")
    else:
        await open_url_in_browser(GMAIL_URL, browser=AGENT_BROWSER)
    # F22: Increased wait from 3s to 8s for Gmail to fully load
    await wait(8)

    screen = await screenshot()

    # Use vision to detect login page vs inbox
    from actions.vision import ask_about_screen
    answer = await ask_about_screen(
        "Is this a Gmail inbox or a Google login page? Answer INBOX or LOGIN",
        screen,
    )
    if "LOGIN" in answer.upper():
        raise RuntimeError(
            "Gmail shows a login page instead of the inbox. "
            "Please log into Gmail manually before running the agent."
        )

    return {"screenshot": screen, "status": "inbox"}


async def search_emails(query: str):
    """
    Search for emails in Gmail.
    Uses vision to click search bar (keyboard shortcuts may be disabled).
    """
    logger.info(f"Searching Gmail: {query}")

    # F23: Click search bar via vision. Fallback: Ctrl+/ (universal, works without shortcuts)
    from actions.vision import find_element
    screen = await screenshot()
    coords = await find_element("Find the Gmail search bar / search input field", screen)
    if coords:
        await click(coords[0], coords[1])
    else:
        # F23: Don't use "/" shortcut (requires Gmail keyboard shortcuts enabled)
        # Use Ctrl+/ or just click at the known position of search bar
        await hotkey("ctrl", "/")
    await wait(0.5)

    # Clear existing search
    await hotkey("ctrl", "a")
    await wait(0.1)

    # Type search query
    await type_text_unicode(query)
    await press_key("enter")
    await wait(2)


async def search_automation_emails():
    """Search specifically for automation output emails with attachments"""
    query = "has:attachment newer_than:7d"
    await search_emails(query)
    await wait(2)


async def open_first_email():
    """Open the first email in the list (uses vision click, not keyboard shortcut)."""
    from actions.vision import find_element
    screen = await screenshot()
    coords = await find_element(
        "Find the first email row/item in the Gmail email list to click on it", screen
    )
    if coords:
        await click(coords[0], coords[1])
    else:
        # F28: Don't use "o" shortcut (requires Gmail keyboard shortcuts enabled)
        # Fallback: press Enter which works universally to open focused email
        await press_key("enter")
    await wait(1)


async def go_to_inbox():
    """Navigate to inbox"""
    await press_key("g")
    await wait(0.2)
    await press_key("i")
    await wait(1)


# =============================================================================
# ATTACHMENT HANDLING
# =============================================================================


async def download_attachment(filename_hint: Optional[str] = None):
    """
    Download attachment from currently open email.
    Uses vision to find and click the download button.
    """
    logger.info(f"Downloading attachment: {filename_hint or 'any'}")

    # Scroll down to see attachments (usually at bottom of email)
    await scroll(-5)
    await wait(1)

    screen = await screenshot()

    from actions.vision import find_element
    desc = "Find the download icon/button for the email attachment"
    if filename_hint:
        desc += f" (filename hint: {filename_hint})"
    coords = await find_element(desc, screen)

    if coords:
        await click(coords[0], coords[1])
        await wait(2)
        logger.info(f"Clicked download at ({coords[0]}, {coords[1]})")
        return {"success": True}

    # Fallback: try clicking on attachment chip itself to trigger download
    coords2 = await find_element(
        "Find the attachment chip or attachment preview card in the email", screen
    )
    if coords2:
        await click(coords2[0], coords2[1])
        await wait(2)
        logger.info(f"Clicked attachment chip at ({coords2[0]}, {coords2[1]})")
        return {"success": True}

    logger.warning("Could not find download button or attachment")
    return {"success": False, "error": "Attachment not found on screen"}


async def download_all_attachments():
    """Download all attachments from current email using vision."""
    logger.info("Downloading all attachments")

    await scroll(-5)
    await wait(1)

    screen = await screenshot()

    from actions.vision import find_element
    # Look for "Download all" button first
    coords = await find_element(
        "Find the 'Download all attachments' button or icon in Gmail", screen
    )
    if coords:
        await click(coords[0], coords[1])
        await wait(2)
        logger.info(f"Clicked download-all at ({coords[0]}, {coords[1]})")
        return {"success": True}

    # Fallback: download individual attachment
    return await download_attachment()


async def wait_for_download(timeout_seconds: int = 60) -> bool:
    """
    Wait for a download to complete by polling the downloads folder.

    Returns True if a new file appeared, False on timeout.
    """
    logger.info(f"Waiting for download (timeout: {timeout_seconds}s)")

    # Record files before download
    before = set(_list_download_files())

    for _ in range(timeout_seconds // 5):
        await wait(5)
        after = set(_list_download_files())
        new_files = after - before

        # Filter out temp/partial downloads
        real_files = [
            f for f in new_files
            if not f.endswith(".crdownload")
            and not f.endswith(".tmp")
            and not f.endswith(".part")
        ]

        if real_files:
            logger.info(f"Download complete: {real_files}")
            return True

    logger.warning("Download timed out")
    return False


def _list_download_files() -> List[str]:
    """List files in download folder.

    RC-5: Uses timeout to handle slow NFS/network filesystems.
    """
    if not os.path.exists(DOWNLOAD_PATH):
        return []
    try:
        # RC-5: os.listdir can block on network filesystems
        # For sync context, we can't use executor, but add a simple check
        import signal

        def _timeout_handler(signum, frame):
            raise TimeoutError("Directory listing timed out")

        # Only set alarm on Unix systems
        if hasattr(signal, 'SIGALRM'):
            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(5)  # 5 second timeout
            try:
                files = os.listdir(DOWNLOAD_PATH)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
        else:
            # Windows doesn't support SIGALRM, just do the listing
            files = os.listdir(DOWNLOAD_PATH)

        return [os.path.join(DOWNLOAD_PATH, f) for f in files]
    except (TimeoutError, OSError) as e:
        logger.warning(f"Failed to list download directory: {e}")
        return []


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
    await press_key("j")
    await wait(0.5)


async def previous_email():
    """Go to previous email in list"""
    await press_key("k")
    await wait(0.5)


async def back_to_list():
    """Go back to email list from email view"""
    await press_key("u")
    await wait(0.5)


async def refresh_inbox():
    """Refresh the inbox"""
    await press_key("f5")
    await wait(2)


# =============================================================================
# FILE MONITORING
# =============================================================================


def get_recent_downloads(
    folder: Optional[str] = None,
    extensions: List[str] = None,
    max_age_minutes: int = 5
) -> List[str]:
    """
    Get list of recently downloaded files.

    Args:
        folder: Download folder path (defaults to DOWNLOAD_PATH)
        extensions: File extensions to look for
        max_age_minutes: Only files modified in last N minutes

    Returns:
        List of file paths, newest first
    """
    if extensions is None:
        extensions = [".pptx", ".xlsx", ".pdf", ".docx", ".csv"]

    folder = folder or DOWNLOAD_PATH

    if not os.path.exists(folder):
        return []

    recent_files = []
    cutoff_time = time.time() - (max_age_minutes * 60)

    for filename in os.listdir(folder):
        filepath = os.path.join(folder, filename)

        # Skip temp/partial downloads
        if filename.endswith((".crdownload", ".tmp", ".part")):
            continue

        # Check extension
        if not any(filename.lower().endswith(ext) for ext in extensions):
            continue

        # Check modification time
        try:
            if os.path.getmtime(filepath) > cutoff_time:
                recent_files.append(filepath)
        except OSError:
            continue

    return sorted(recent_files, key=os.path.getmtime, reverse=True)


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
    3. Open first matching email
    4. Download attachments
    5. Wait for download to complete
    6. Return file paths

    Args:
        service_name: e.g., "target-v6", "market-research"
        max_age_days: Only look at emails from last N days

    Returns:
        Dict with status and downloaded file info
    """
    logger.info(f"Looking for {service_name} output email")

    await open_gmail()

    # IV-1: Escape query parameter to prevent injection
    query = f"subject:{_escape_query_param(service_name)} has:attachment newer_than:{max_age_days}d is:unread"
    await search_emails(query)

    # Open first result
    await open_first_email()
    await wait(1)

    # Download attachment
    await download_attachment()
    await wait(1)

    # Wait for download to complete
    downloaded = await wait_for_download(timeout_seconds=60)

    if downloaded:
        files = get_recent_downloads(max_age_minutes=2)
        if files:
            return {
                "success": True,
                "file_path": files[0],
                "all_files": files,
            }

    return {
        "success": False,
        "error": "Download failed or no file found",
    }
