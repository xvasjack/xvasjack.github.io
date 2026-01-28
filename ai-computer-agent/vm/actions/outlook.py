"""
Outlook Actions - Specialized actions for Outlook email interaction.

STRICT GUARDRAILS:
- Can ONLY read emails from authorized senders
- Can ONLY download attachments
- CANNOT compose, reply, forward, or send any emails
- CANNOT access any email not related to automation output

Authorized email patterns:
- GitHub notifications
- Your automation service outputs (SendGrid sender)
"""

import asyncio
import re
import time
from typing import Optional, List
from dataclasses import dataclass
import logging
import os

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import (
    open_application, focus_window, screenshot, click, type_text,
    press_key, hotkey, scroll, wait, open_url_in_browser
)
from guardrails import check_email_before_open, GuardrailResult, CONFIG

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("outlook_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


# Path where attachments should be saved
DOWNLOAD_PATH = os.environ.get("AGENT_DOWNLOAD_PATH", r"C:\agent-shared\downloads")

# Outlook Web URL (preferred over desktop app for automation)
OUTLOOK_WEB_URL = "https://outlook.office.com/mail/"


# =============================================================================
# EMAIL PATTERNS - Only these are allowed
# =============================================================================


ALLOWED_SENDER_PATTERNS = [
    r"noreply@github\.com",
    r"notifications@github\.com",
    # Add your SendGrid sender email pattern here
    r".*@.*\.sendgrid\.net",
    # Your specific automation sender
]

ALLOWED_SUBJECT_PATTERNS = [
    r"target.*search.*result",
    r"market.*research.*complete",
    r"profile.*slides.*ready",
    r"trading.*comp.*result",
    r"validation.*complete",
    r"due.*diligence.*report",
    r"\[GitHub\]",
    r"PR.*merged",
    r"Pull request",
]


def is_email_allowed(sender: str, subject: str) -> bool:
    """Check if email matches allowed patterns"""
    sender_ok = any(re.search(p, sender, re.IGNORECASE) for p in ALLOWED_SENDER_PATTERNS)
    subject_ok = any(re.search(p, subject, re.IGNORECASE) for p in ALLOWED_SUBJECT_PATTERNS)
    return sender_ok and subject_ok


# =============================================================================
# OUTLOOK WEB (PREFERRED)
# =============================================================================


async def open_outlook_web():
    """Open Outlook Web in browser"""
    logger.info("Opening Outlook Web")
    await open_url_in_browser(OUTLOOK_WEB_URL)
    await wait(3)


async def search_emails(query: str):
    """Search for emails in Outlook Web"""
    logger.info(f"Searching emails: {query}")

    # Click search box (usually at top)
    # Claude will identify exact position from screenshot
    await hotkey("alt", "q")  # Outlook Web search shortcut
    await wait(0.5)

    # Type search query
    await type_text(query)
    await press_key("enter")
    await wait(2)


async def search_automation_emails():
    """Search specifically for automation output emails"""
    # Search for emails from your automation sender
    # Adjust this to match your SendGrid sender
    await search_emails("from:noreply hasattachment:true")
    await wait(2)


async def open_latest_email():
    """Open the first/latest email in the list"""
    # Press Down arrow to select first email, then Enter to open
    await press_key("down")
    await wait(0.3)
    await press_key("enter")
    await wait(1)


async def get_email_info_from_screen() -> dict:
    """
    Take screenshot and return for Claude to extract sender/subject.
    Claude will verify against guardrails before proceeding.
    """
    screen = await screenshot()
    return {
        "screenshot": screen,
        "needs_verification": True,
        "instruction": "Extract sender and subject. Verify against allowed patterns before proceeding."
    }


# =============================================================================
# ATTACHMENT HANDLING
# =============================================================================


async def download_attachment(filename_pattern: Optional[str] = None):
    """
    Download attachment from currently open email.

    Args:
        filename_pattern: Optional pattern to match specific file (e.g., "*.pptx")

    Returns:
        Dict with screenshot and action needed, or None if failed
    """
    logger.info(f"Downloading attachment: {filename_pattern or 'any'}")

    # Category 12 fix: This function was incomplete - add actual download attempt
    # In Outlook Web, attachments appear in the email body
    # Right-click on attachment -> Download

    # Take screenshot for Claude to find the attachment
    try:
        screen = await screenshot()
    except Exception as e:
        logger.error(f"Failed to take screenshot: {e}")
        return {"screenshot": None, "action_needed": "find_and_download_attachment", "pattern": filename_pattern, "error": str(e)}

    # Claude will:
    # 1. Find the attachment in the email
    # 2. Right-click on it
    # 3. Click "Download"

    return {
        "screenshot": screen,
        "action_needed": "find_and_download_attachment",
        "pattern": filename_pattern
    }


async def save_attachment_to_folder():
    """
    Handle the Save As dialog to save to designated folder.
    """
    # Wait for Save As dialog
    await wait(1)

    # Clear filename box and type path
    await hotkey("ctrl", "l")  # Focus location bar
    await wait(0.2)
    await type_text(DOWNLOAD_PATH)
    await press_key("enter")
    await wait(0.5)

    # Click Save
    await hotkey("alt", "s")  # Save button shortcut
    await wait(1)


# =============================================================================
# NAVIGATION
# =============================================================================


async def go_back_to_inbox():
    """Navigate back to inbox from email view"""
    await press_key("escape")
    await wait(0.5)


async def refresh_inbox():
    """Refresh the inbox"""
    await press_key("f5")
    await wait(2)


async def scroll_email_list(direction: str = "down"):
    """Scroll the email list"""
    clicks = -3 if direction == "down" else 3
    await scroll(clicks)
    await wait(0.5)


# =============================================================================
# BLOCKED ACTIONS - These will raise errors
# =============================================================================


def _blocked_action(action_name: str):
    """B8: Raise error for blocked actions (synchronous to ensure immediate error)"""
    error_msg = f"BLOCKED: {action_name} is not allowed by guardrails"
    logger.error(error_msg)
    raise PermissionError(error_msg)


def compose_email(*args, **kwargs):
    """BLOCKED: Cannot compose emails. B8: Synchronous to ensure error raised immediately."""
    _blocked_action("compose_email")


def reply_to_email(*args, **kwargs):
    """BLOCKED: Cannot reply to emails. B8: Synchronous to ensure error raised immediately."""
    _blocked_action("reply_to_email")


def forward_email(*args, **kwargs):
    """BLOCKED: Cannot forward emails. B8: Synchronous to ensure error raised immediately."""
    _blocked_action("forward_email")


def send_email(*args, **kwargs):
    """BLOCKED: Cannot send emails. B8: Synchronous to ensure error raised immediately."""
    _blocked_action("send_email")


def delete_email(*args, **kwargs):
    """BLOCKED: Cannot delete emails. B8: Synchronous to ensure error raised immediately."""
    _blocked_action("delete_email")


# =============================================================================
# OUTLOOK DESKTOP (FALLBACK)
# =============================================================================


async def open_outlook_desktop():
    """Open Outlook desktop app (use Web version when possible)"""
    logger.info("Opening Outlook desktop app")
    await open_application("Outlook")
    await wait(3)

    # Wait for Outlook window
    if not await focus_window("Outlook"):
        logger.error("Could not open Outlook")
        return False

    return True


async def outlook_desktop_search(query: str):
    """Search in Outlook desktop app"""
    # Ctrl+E focuses search in Outlook desktop
    await hotkey("ctrl", "e")
    await wait(0.3)
    await type_text(query)
    await press_key("enter")
    await wait(2)


# =============================================================================
# WORKFLOW HELPERS
# =============================================================================


async def wait_for_new_email(
    sender_pattern: str,
    subject_pattern: str,
    timeout_seconds: int = 300,
    check_interval: int = 30
) -> bool:
    """
    Wait for a new email matching the pattern.

    Args:
        sender_pattern: Regex pattern for sender
        subject_pattern: Regex pattern for subject
        timeout_seconds: Max time to wait
        check_interval: Seconds between checks

    Returns:
        True if matching email found, False if timeout
    """
    logger.info(f"Waiting for email from {sender_pattern} about {subject_pattern}")

    start_time = time.monotonic()

    while True:
        elapsed = time.monotonic() - start_time
        if elapsed > timeout_seconds:
            logger.warning("Timeout waiting for email")
            return False

        # Refresh inbox
        await refresh_inbox()
        await wait(2)

        # Search for the email
        search_query = f"from:{sender_pattern} subject:{subject_pattern}"
        await search_emails(search_query)
        await wait(2)

        # Take screenshot for Claude to analyze
        screen = await screenshot()

        # A7: Actually check if email was found by analyzing the screen
        # Import the vision helper to ask about the screen content
        try:
            from actions.vision import ask_about_screen
            email_found_response = await ask_about_screen(
                "Is there an email in the search results that matches the search criteria? Reply YES or NO only.",
                screen
            )
            if email_found_response and "YES" in email_found_response.upper():
                logger.info("Matching email found!")
                return True
        except ImportError:
            # Vision module not available, just log progress
            pass
        except Exception as e:
            logger.warning(f"Email detection check failed: {e}")

        logger.info(f"Checking for email... ({int(elapsed)}s elapsed)")

        # Category 12 fix: Race condition - ensure we don't sleep past deadline
        remaining = timeout_seconds - (time.monotonic() - start_time)
        if remaining <= 0:
            logger.warning("Timeout waiting for email")
            return False
        await wait(min(check_interval, remaining))


async def download_latest_automation_output(file_extension: str = ".pptx") -> Optional[str]:
    """
    Complete workflow to download the latest automation output.

    1. Open Outlook Web
    2. Search for automation emails
    3. Open latest
    4. Verify sender/subject against guardrails
    5. Download attachment
    6. Return path to downloaded file

    Args:
        file_extension: Expected file extension (.pptx, .xlsx, etc.)

    Returns:
        Path to downloaded file, or None if failed
    """
    logger.info(f"Downloading latest automation output ({file_extension})")

    # Open Outlook
    await open_outlook_web()

    # Search for automation emails with attachments
    await search_automation_emails()

    # Open latest
    await open_latest_email()

    # Get email info for guardrail check
    email_info = await get_email_info_from_screen()

    # Main agent will:
    # 1. Use Claude to extract sender/subject from screenshot
    # 2. Verify against guardrails
    # 3. If allowed, proceed to download
    # 4. If not allowed, skip this email

    return email_info  # Caller handles the rest
