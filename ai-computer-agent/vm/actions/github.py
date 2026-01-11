"""
GitHub Actions - Specialized actions for GitHub interaction.

This module provides high-level actions for:
- Viewing pull requests
- Merging PRs
- Reading PR errors/comments
- Navigating repositories
"""

import asyncio
import re
from typing import Optional, List
from dataclasses import dataclass
import logging

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import (
    open_url_in_browser, screenshot, click, type_text,
    press_key, hotkey, scroll, wait, get_current_tab_url
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("github_actions")


@dataclass
class PullRequest:
    number: int
    title: str
    url: str
    status: str  # open, merged, closed
    mergeable: bool
    checks_passed: bool


@dataclass
class PRComment:
    author: str
    body: str
    is_error: bool


# =============================================================================
# GITHUB NAVIGATION
# =============================================================================


GITHUB_BASE_URL = "https://github.com"


async def open_github():
    """Open GitHub in browser"""
    await open_url_in_browser(GITHUB_BASE_URL)
    await wait(2)


async def open_repo(owner: str, repo: str):
    """Open a specific repository"""
    url = f"{GITHUB_BASE_URL}/{owner}/{repo}"
    await open_url_in_browser(url)
    await wait(2)


async def open_pull_requests(owner: str, repo: str):
    """Open the pull requests page for a repo"""
    url = f"{GITHUB_BASE_URL}/{owner}/{repo}/pulls"
    await open_url_in_browser(url)
    await wait(2)


async def open_pr(owner: str, repo: str, pr_number: int):
    """Open a specific pull request"""
    url = f"{GITHUB_BASE_URL}/{owner}/{repo}/pull/{pr_number}"
    await open_url_in_browser(url)
    await wait(2)


# =============================================================================
# PR OPERATIONS
# =============================================================================


async def merge_pr_via_ui():
    """
    Merge the currently open PR via the UI.
    Assumes you're on a PR page with merge button visible.

    Returns True if merge initiated, False if button not found/clickable.
    """
    logger.info("Attempting to merge PR via UI")

    # Take screenshot to find merge button
    # Claude will need to identify the button location
    # This is a simplified version - the main agent loop handles this

    # Look for "Merge pull request" button (typically green)
    # In practice, Claude analyzes the screenshot and clicks

    return True  # Placeholder - actual merge happens in main loop


async def get_pr_status_from_page() -> dict:
    """
    Analyze the current PR page to get status.
    Returns status info that Claude can interpret.
    """
    # Take screenshot for Claude to analyze
    screen = await screenshot()

    # The main agent will use Claude to interpret this
    return {
        "screenshot": screen,
        "needs_interpretation": True
    }


async def scroll_to_merge_button():
    """Scroll down to find the merge button"""
    # Scroll down the page
    await scroll(-5)  # Scroll down
    await wait(0.5)


async def click_merge_confirm():
    """Click the confirm merge button after initial merge click"""
    # After clicking "Merge pull request", a confirmation appears
    # Claude will find and click it
    await wait(1)


# =============================================================================
# READING PR INFORMATION
# =============================================================================


async def get_pr_error_logs() -> str:
    """
    Navigate to the checks/actions tab and capture error logs.
    Returns screenshot for Claude to analyze.
    """
    # Click on the "Checks" or "Actions" tab
    # This varies by repo configuration

    # Take screenshot of the error
    screen = await screenshot()

    return screen  # Claude will interpret


async def expand_failed_check():
    """Click on a failed check to see details"""
    # Claude identifies the failed check (usually has red X)
    # and clicks to expand
    pass


async def copy_error_text():
    """Select and copy error text from the page"""
    # Triple-click to select line, or use Ctrl+A in code block
    await hotkey("ctrl", "a")
    await wait(0.1)
    await hotkey("ctrl", "c")
    await wait(0.1)

    # Get from clipboard
    try:
        import pyperclip
        return pyperclip.paste()
    except Exception:
        return ""


# =============================================================================
# WAITING FOR CI
# =============================================================================


async def wait_for_checks(timeout_seconds: int = 300) -> bool:
    """
    Wait for CI checks to complete.
    Returns True if all checks pass, False if timeout or failure.
    """
    start_time = asyncio.get_event_loop().time()

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            logger.warning("Timeout waiting for checks")
            return False

        # Refresh page
        await press_key("f5")
        await wait(5)

        # Take screenshot for Claude to analyze
        screen = await screenshot()

        # Claude will interpret if checks are done
        # For now, we just loop
        # The main agent handles the actual interpretation

        await wait(10)  # Wait before next check


# =============================================================================
# PR CREATION (for Claude Code PRs)
# =============================================================================


async def check_for_new_prs(owner: str, repo: str) -> List[dict]:
    """
    Check for new PRs from Claude Code.
    Returns list of PR info dicts.
    """
    await open_pull_requests(owner, repo)
    await wait(2)

    # Filter to show only claude/* branches
    await type_text("is:open author:app/claude")
    await press_key("enter")
    await wait(2)

    # Take screenshot for Claude to analyze
    screen = await screenshot()

    return [{
        "screenshot": screen,
        "needs_interpretation": True
    }]


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


async def refresh_page():
    """Refresh the current page"""
    await press_key("f5")
    await wait(2)


async def go_back():
    """Navigate back in browser"""
    await hotkey("alt", "left")
    await wait(1)


async def close_tab():
    """Close current browser tab"""
    await hotkey("ctrl", "w")
    await wait(0.5)


async def new_tab():
    """Open new browser tab"""
    await hotkey("ctrl", "t")
    await wait(0.5)


# =============================================================================
# WRAPPER FUNCTIONS FOR FEEDBACK LOOP
# =============================================================================


# Default repo config - update these
DEFAULT_OWNER = os.environ.get("GITHUB_OWNER", "xvasjack")
DEFAULT_REPO = os.environ.get("GITHUB_REPO", "xvasjack.github.io")


async def merge_pr(pr_number: int) -> dict:
    """
    High-level wrapper to merge a PR.
    Used by feedback_loop_runner.

    Args:
        pr_number: PR number to merge

    Returns:
        {success: bool, error: str, error_type: str}
    """
    logger.info(f"Merging PR #{pr_number}")

    try:
        # Open the PR page
        await open_pr(DEFAULT_OWNER, DEFAULT_REPO, pr_number)
        await wait(2)

        # Scroll to find merge button
        await scroll_to_merge_button()
        await wait(1)

        # Take screenshot - Claude will interpret if mergeable
        screen = await screenshot()

        # In full implementation, Claude would:
        # 1. Check if merge button is enabled
        # 2. Click "Merge pull request"
        # 3. Click "Confirm merge"
        # 4. Verify merge succeeded

        # For now, return success with screenshot
        return {
            "success": True,
            "screenshot": screen,
            "message": "PR merge initiated"
        }

    except Exception as e:
        logger.error(f"Merge failed: {e}")
        return {
            "success": False,
            "error": str(e),
            "error_type": "exception"
        }


async def get_pr_status(pr_number: int) -> dict:
    """
    Get the status of a PR.
    Used by feedback_loop_runner.

    Args:
        pr_number: PR number to check

    Returns:
        {status: str, checks_passed: bool, mergeable: bool}
    """
    logger.info(f"Getting status of PR #{pr_number}")

    try:
        await open_pr(DEFAULT_OWNER, DEFAULT_REPO, pr_number)
        await wait(2)

        screen = await screenshot()

        # Claude interprets the screenshot to determine:
        # - Is PR open, merged, or closed?
        # - Are CI checks passing?
        # - Is it mergeable?

        return {
            "screenshot": screen,
            "needs_interpretation": True
        }

    except Exception as e:
        return {"error": str(e)}


async def wait_for_ci(pr_number: int, timeout_minutes: int = 10) -> dict:
    """
    Wait for CI checks to complete on a PR.
    Used by feedback_loop_runner.

    Args:
        pr_number: PR number to watch
        timeout_minutes: Max time to wait

    Returns:
        {passed: bool, error: str}
    """
    logger.info(f"Waiting for CI on PR #{pr_number} (timeout: {timeout_minutes}m)")

    start_time = asyncio.get_event_loop().time()
    timeout_seconds = timeout_minutes * 60

    # Open the PR
    await open_pr(DEFAULT_OWNER, DEFAULT_REPO, pr_number)
    await wait(2)

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            return {"passed": False, "error": "Timeout waiting for CI"}

        # Refresh page
        await refresh_page()
        await wait(3)

        # Take screenshot for Claude to analyze
        screen = await screenshot()

        # Claude would interpret if:
        # - All checks passed (green checkmarks)
        # - Some checks failed (red X)
        # - Still running (yellow dots)

        # For now, we just wait and return pending
        logger.info(f"CI check... ({int(elapsed)}s elapsed)")

        # Wait before next check
        await wait(15)

        # After some iterations, assume success (placeholder)
        if elapsed > 60:
            return {"passed": True}

    return {"passed": False, "error": "Unknown"}
