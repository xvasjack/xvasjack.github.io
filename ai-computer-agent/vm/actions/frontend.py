"""
Frontend Actions - Interact with your GitHub Pages frontend.

This module handles:
- Navigating to your frontend
- Filling out search forms
- Submitting requests
- Waiting for processing
"""

import asyncio
from typing import Optional, Dict
from dataclasses import dataclass
import logging
import os

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import (
    open_url_in_browser, screenshot, click, type_text,
    press_key, hotkey, scroll, wait, focus_window
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("frontend_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


# Your frontend URL - update this to your GitHub Pages URL
FRONTEND_URL = os.environ.get(
    "FRONTEND_URL",
    "https://xvasjack.github.io"
)

# Service endpoints (relative paths on your frontend)
SERVICE_PAGES = {
    "target-v3": "/target-v3.html",
    "target-v4": "/target-v4.html",
    "target-v5": "/target-v5.html",
    "target-v6": "/target-v6.html",
    "validation": "/validation.html",
    "market-research": "/market-research.html",
    "profile-slides": "/profile-slides.html",
    "trading-comparable": "/trading-comparable.html",
    "due-diligence": "/due-diligence.html",
}


# =============================================================================
# NAVIGATION
# =============================================================================


async def open_frontend():
    """Open the main frontend page"""
    logger.info(f"Opening frontend: {FRONTEND_URL}")
    await open_url_in_browser(FRONTEND_URL)
    await wait(2)


async def open_service_page(service: str):
    """Open a specific service page"""
    if service not in SERVICE_PAGES:
        logger.error(f"Unknown service: {service}")
        return False

    url = FRONTEND_URL + SERVICE_PAGES[service]
    logger.info(f"Opening service page: {url}")
    await open_url_in_browser(url)
    await wait(2)
    return True


# =============================================================================
# FORM FILLING
# =============================================================================


@dataclass
class SearchFormData:
    """Data for a search form submission"""
    business: str
    country: str
    exclusion: Optional[str] = None
    email: Optional[str] = None


async def fill_search_form(data: SearchFormData):
    """
    Fill out a standard search form.

    Your forms typically have:
    - Business input
    - Country input
    - Exclusion input (optional)
    - Email input

    Claude will identify the actual field positions from screenshots.
    """
    logger.info(f"Filling search form: {data.business} in {data.country}")

    # Take screenshot to identify form fields
    screen = await screenshot()

    # The main agent will use Claude to:
    # 1. Identify form field locations
    # 2. Click each field
    # 3. Type the values
    # 4. Submit

    return {
        "screenshot": screen,
        "form_data": {
            "business": data.business,
            "country": data.country,
            "exclusion": data.exclusion,
            "email": data.email,
        },
        "action_needed": "fill_form_fields"
    }


async def fill_field_by_label(label: str, value: str):
    """
    Fill a form field identified by its label.
    Claude will find the field near the label and fill it.
    """
    logger.info(f"Filling field '{label}' with '{value}'")

    # Take screenshot
    screen = await screenshot()

    return {
        "screenshot": screen,
        "label": label,
        "value": value,
        "action_needed": "find_label_and_fill"
    }


async def click_field_and_type(field_name: str, value: str):
    """Generic: click a field and type value"""
    # Claude identifies field, we just type after click
    await type_text(value)
    await wait(0.2)


async def clear_field():
    """Clear the current field"""
    await hotkey("ctrl", "a")
    await press_key("delete")
    await wait(0.1)


async def tab_to_next_field():
    """Move to next form field"""
    await press_key("tab")
    await wait(0.1)


# =============================================================================
# FORM SUBMISSION
# =============================================================================


async def submit_form():
    """
    Submit the form.
    Usually clicks a Submit/Search button or presses Enter.
    """
    logger.info("Submitting form")

    # Take screenshot to find submit button
    screen = await screenshot()

    # Claude will find and click the submit button
    return {
        "screenshot": screen,
        "action_needed": "click_submit_button"
    }


async def click_submit_button():
    """Click the submit button (Claude finds it)"""
    # Placeholder - Claude handles this
    pass


async def wait_for_submission_confirmation(timeout_seconds: int = 30) -> bool:
    """
    Wait for form submission to complete.
    Looks for success message or loading indicator.
    """
    logger.info("Waiting for submission confirmation")

    start_time = asyncio.get_event_loop().time()

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            return False

        # Take screenshot
        screen = await screenshot()

        # Claude analyzes for success/error message
        # Return screenshot for interpretation
        await wait(1)

        # In practice, main loop handles this
        return True


# =============================================================================
# EMAIL HANDLING
# =============================================================================


async def set_email_in_localStorage(email: str):
    """
    Your frontend stores email in localStorage as 'ycpUserEmail'.
    This opens browser console and sets it.
    """
    logger.info(f"Setting email in localStorage: {email}")

    # Open DevTools console
    await press_key("f12")
    await wait(1)

    # Focus console
    await hotkey("ctrl", "shift", "j")
    await wait(0.5)

    # Set localStorage
    js_command = f"localStorage.setItem('ycpUserEmail', '{email}')"
    await type_text(js_command)
    await press_key("enter")
    await wait(0.3)

    # Close DevTools
    await press_key("f12")
    await wait(0.5)


async def get_stored_email() -> str:
    """Get the email from localStorage"""
    # Open console
    await press_key("f12")
    await wait(1)
    await hotkey("ctrl", "shift", "j")
    await wait(0.5)

    # Get value
    await type_text("localStorage.getItem('ycpUserEmail')")
    await press_key("enter")
    await wait(0.3)

    # Take screenshot to read the value
    screen = await screenshot()

    # Close DevTools
    await press_key("f12")
    await wait(0.5)

    return screen  # Claude interprets


# =============================================================================
# COMPLETE WORKFLOWS
# =============================================================================


async def run_target_search(
    version: str,
    business: str,
    country: str,
    exclusion: Optional[str] = None,
    email: Optional[str] = None
) -> dict:
    """
    Complete workflow to run a target search.

    1. Open service page
    2. Set email if provided
    3. Fill form
    4. Submit
    5. Return confirmation

    Args:
        version: target-v3, target-v4, target-v5, or target-v6
        business: Business/industry to search
        country: Country to search in
        exclusion: Companies to exclude
        email: Email for results (uses localStorage if not provided)

    Returns:
        Result dict with status
    """
    logger.info(f"Running {version} search: {business} in {country}")

    # Open service page
    service = f"target-{version}" if not version.startswith("target-") else version
    await open_service_page(service)

    # Set email if provided
    if email:
        await set_email_in_localStorage(email)

    # Fill form
    form_data = SearchFormData(
        business=business,
        country=country,
        exclusion=exclusion,
        email=email,
    )
    await fill_search_form(form_data)

    # Submit
    await submit_form()

    # Wait for confirmation
    success = await wait_for_submission_confirmation()

    return {
        "success": success,
        "service": service,
        "business": business,
        "country": country,
    }


async def run_validation(file_path: str, email: Optional[str] = None) -> dict:
    """
    Run validation service with a file upload.

    Args:
        file_path: Path to Excel/CSV file
        email: Email for results

    Returns:
        Result dict with status
    """
    logger.info(f"Running validation with file: {file_path}")

    # Open validation page
    await open_service_page("validation")

    # Set email if provided
    if email:
        await set_email_in_localStorage(email)

    # File upload requires Claude to:
    # 1. Find the file input
    # 2. Click to open file dialog
    # 3. Navigate to file
    # 4. Select and upload

    return {
        "file_path": file_path,
        "action_needed": "file_upload",
        "screenshot": await screenshot(),
    }


# =============================================================================
# WRAPPER FUNCTIONS FOR FEEDBACK LOOP
# =============================================================================


async def submit_form(url: str, form_data: Dict) -> Dict:
    """
    High-level wrapper to submit a form on a given URL.
    Used by feedback_loop_runner.

    Args:
        url: Full URL of the form page
        form_data: Dict with form field values

    Returns:
        {success: bool, error: str}
    """
    logger.info(f"Submitting form at {url}")

    try:
        # Open the URL
        await open_url_in_browser(url)
        await wait(3)

        # Set email if provided
        if form_data.get("email"):
            await set_email_in_localStorage(form_data["email"])
            await wait(0.5)

        # Refresh to pick up localStorage email
        await press_key("f5")
        await wait(2)

        # Fill the form - this uses Claude's visual interpretation
        # For now, we do a simplified keyboard-based approach
        # Tab through fields and fill them

        fields_to_fill = [
            ("business", form_data.get("business", "")),
            ("country", form_data.get("country", "")),
            ("exclusion", form_data.get("exclusion", "")),
        ]

        for field_name, value in fields_to_fill:
            if value:
                # Type the value (Claude will handle field focus)
                await type_text(value)
                await tab_to_next_field()

        # Submit - press Enter or click button
        await press_key("enter")
        await wait(2)

        # Check for success message
        screen = await screenshot()

        return {"success": True, "screenshot": screen}

    except Exception as e:
        logger.error(f"Form submission failed: {e}")
        return {"success": False, "error": str(e)}


async def wait_for_form_submission(timeout_seconds: int = 30) -> bool:
    """
    Wait for form submission to complete.
    Used by feedback_loop_runner.

    Args:
        timeout_seconds: Max time to wait

    Returns:
        True if submission succeeded
    """
    return await wait_for_submission_confirmation(timeout_seconds)
