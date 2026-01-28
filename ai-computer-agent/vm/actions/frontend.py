"""
Frontend Actions - Interact with your GitHub Pages frontend.

This module handles:
- Navigating to your frontend
- Filling out search forms (vision-based clicking)
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

try:
    from computer_use import (
        open_url_in_browser, screenshot, click, type_text,
        press_key, hotkey, scroll, wait, focus_window,
        type_text_unicode,
    )
    HAS_FRONTEND = True
except ImportError as e:
    HAS_FRONTEND = False
    _FRONTEND_IMPORT_ERROR = str(e)
    logger.warning(f"computer_use not available: {e}")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("frontend_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


FRONTEND_URL = os.environ.get(
    "FRONTEND_URL",
    "https://xvasjack.github.io"
)

SERVICE_PAGES = {
    "target-v3": "/find-target.html",
    "target-v4": "/find-target-v4.html",
    "target-v5": "/find-target-v5.html",
    "target-v6": "/find-target-v6.html",
    "validation": "/validation.html",
    "market-research": "/market-research.html",
    "profile-slides": "/profile-slides.html",
    "trading-comparable": "/trading-comparable.html",
    "due-diligence": "/due-diligence.html",
    "utb": "/utb.html",
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
    await wait(3)
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


async def clear_and_type(text: str):
    """Select all text in current field and replace with new text."""
    await hotkey("ctrl", "a")
    await wait(0.1)
    await type_text_unicode(text)
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


async def fill_search_form(data: SearchFormData):
    """
    B6/H1: Fill out a search form using vision-based clicking.
    Clicks each field by label, then types the value.
    """
    logger.info(f"Filling search form: {data.business} in {data.country}")

    from vision import find_element

    screen = await screenshot()

    # Fill business field
    coords = await find_element(
        "Find the 'Business Type' or 'Industry' input field text box", screen
    )
    if coords:
        await click(coords[0], coords[1])
        await wait(0.2)
        await clear_and_type(data.business)
    else:
        logger.warning("Could not find business field, using tab navigation")
        await press_key("tab")
        await wait(0.2)
        await clear_and_type(data.business)

    # Fill country field
    screen = await screenshot()
    coords = await find_element(
        "Find the 'Country' or 'Region' input field text box", screen
    )
    if coords:
        await click(coords[0], coords[1])
        await wait(0.2)
        await clear_and_type(data.country)
    else:
        await tab_to_next_field()
        await clear_and_type(data.country)

    # Fill exclusion field if provided
    if data.exclusion:
        screen = await screenshot()
        coords = await find_element(
            "Find the 'Exclusion' or 'Exclude' input field text box", screen
        )
        if coords:
            await click(coords[0], coords[1])
            await wait(0.2)
            await clear_and_type(data.exclusion)
        else:
            await tab_to_next_field()
            await clear_and_type(data.exclusion)

    return {"success": True}


# =============================================================================
# EMAIL HANDLING
# =============================================================================


async def set_email_in_localStorage(email: str):
    """
    Set email in localStorage as 'ycpUserEmail'.
    H19: Uses Ctrl+Shift+J to go directly to console (avoids F12 toggle issue).
    """
    logger.info(f"Setting email in localStorage: {email}")

    # Open DevTools console directly (Ctrl+Shift+J avoids F12 toggle problem)
    await hotkey("ctrl", "shift", "j")
    await wait(1)

    # Set localStorage (escape quotes to prevent JS injection)
    safe_email = email.replace("\\", "\\\\").replace("'", "\\'")
    js_command = f"localStorage.setItem('ycpUserEmail', '{safe_email}')"
    await type_text(js_command)
    await press_key("enter")
    await wait(0.3)

    # Close DevTools
    await hotkey("ctrl", "shift", "j")
    await wait(0.5)


# =============================================================================
# COMPLETE FORM SUBMISSION WORKFLOW
# =============================================================================


async def submit_form(url: str, form_data: Dict) -> Dict:
    """
    Submit a form on a given URL.
    H1: Uses vision-based clicking to find each field.

    Args:
        url: Full URL of the form page
        form_data: Dict with form field values

    Returns:
        {success: bool, error: str}
    """
    logger.info(f"Submitting form at {url}")

    if not HAS_FRONTEND:
        return {"success": False, "error": f"Frontend not available: {_FRONTEND_IMPORT_ERROR}"}

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

        # H1: Use vision-based clicking to fill form fields
        from vision import find_element

        fields_to_fill = [
            ("Business Type", "business", form_data.get("business", "")),
            ("Country", "country", form_data.get("country", "")),
            ("Exclusion", "exclusion", form_data.get("exclusion", "")),
        ]

        for label, key, value in fields_to_fill:
            if value:
                screen = await screenshot()
                coords = await find_element(
                    f"Find the '{label}' input field or text box on this form", screen
                )
                if coords:
                    await click(coords[0], coords[1])
                    await wait(0.2)
                    await clear_and_type(value)
                else:
                    # Fallback to tab navigation
                    await press_key("tab")
                    await wait(0.2)
                    await clear_and_type(value)
                await wait(0.3)

        # Submit - try finding submit button first
        screen = await screenshot()
        coords = await find_element(
            "Find the Submit or Search button on this form", screen
        )
        if coords:
            await click(coords[0], coords[1])
        else:
            await press_key("enter")
        await wait(2)

        # Check for success via vision confirmation
        confirmed = await wait_for_submission_confirmation(timeout_seconds=30)
        if not confirmed:
            return {"success": False, "error": "Form submission not confirmed by vision check"}

        screen = await screenshot()
        return {"success": True, "screenshot": screen}

    except Exception as e:
        logger.error(f"Form submission failed: {e}")
        return {"success": False, "error": str(e)}


async def wait_for_submission_confirmation(timeout_seconds: int = 30) -> bool:
    """H2: Wait for form submission confirmation using vision to detect state."""
    logger.info("Waiting for submission confirmation")

    from vision import ask_about_screen

    start_time = asyncio.get_event_loop().time()

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            logger.warning("Submission confirmation timed out")
            return False

        screen = await screenshot()
        answer = await ask_about_screen(
            "Does this show a successful form submission? Answer SUCCESS, ERROR, or LOADING",
            screen,
        )

        if "SUCCESS" in answer.upper():
            return True
        elif "ERROR" in answer.upper():
            logger.error(f"Form submission error detected: {answer}")
            return False
        # LOADING — poll again
        await wait(3)


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

    Args:
        version: target-v3, target-v4, target-v5, or target-v6
        business: Business/industry to search
        country: Country to search in
        exclusion: Companies to exclude
        email: Email for results

    Returns:
        Result dict with status
    """
    logger.info(f"Running {version} search: {business} in {country}")

    service = f"target-{version}" if not version.startswith("target-") else version

    # Build URL
    url_map = {
        "target-v3": "find-target.html",
        "target-v4": "find-target-v4.html",
        "target-v5": "find-target-v5.html",
        "target-v6": "find-target-v6.html",
    }
    page = url_map.get(service, f"{service}.html")
    url = f"{FRONTEND_URL}/{page}"

    form_data = {
        "business": business,
        "country": country,
        "exclusion": exclusion or "",
        "email": email or "",
    }

    return await submit_form(url, form_data)
