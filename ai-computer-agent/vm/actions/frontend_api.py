"""
Frontend API - Direct HTTP POST to Railway backend services.

Replaces browser-based form submission with direct API calls.
Falls back to browser automation if API POST fails.
"""

import asyncio
import os
import re
import logging
from typing import Dict, Any, Optional
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("frontend_api")


# =============================================================================
# SECURITY: SSRF PROTECTION & EMAIL VALIDATION (Issues #2, #29, #57, #58)
# =============================================================================

# Issue 2/58 fix: Allowed domains for SSRF protection
ALLOWED_URL_DOMAINS = {
    "railway.app",
    "up.railway.app",
    "localhost",
    "127.0.0.1",
}


def _validate_url_domain(url: str) -> bool:
    """Issue 2/58 fix: Validate URL is from allowed domain to prevent SSRF."""
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname or ""

        # Check if domain or any subdomain is in allowed list
        for allowed in ALLOWED_URL_DOMAINS:
            if hostname == allowed or hostname.endswith("." + allowed):
                return True

        logger.warning(f"URL domain not in allowed list: {hostname}")
        return False
    except Exception as e:
        logger.error(f"URL validation error: {e}")
        return False


# Issue 29/57 fix: Email validation regex
EMAIL_REGEX = re.compile(
    r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
)


def _validate_email(email: str) -> bool:
    """Issue 29/57 fix: Validate email format to prevent injection."""
    if not email or not isinstance(email, str):
        return False
    # Check length to prevent DoS
    if len(email) > 254:
        return False
    return bool(EMAIL_REGEX.match(email))

try:
    import aiohttp
except ImportError:
    aiohttp = None
    logger.warning("aiohttp not installed. Run: pip install aiohttp")

try:
    import httpx
except ImportError:
    httpx = None


# =============================================================================
# RAILWAY URL CONFIGURATION
# =============================================================================

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

# Service name -> API path mapping
SERVICE_API_PATHS = {
    "target-v3": "/api/target",
    "target-v4": "/api/target",
    "target-v5": "/api/target",
    "target-v6": "/api/target",
    "market-research": "/api/market-research",
    "profile-slides": "/api/profile-slides",
    "trading-comparable": "/api/trading-comparable",
    "validation": "/api/validation",
    "due-diligence": "/api/due-diligence",
    "utb": "/api/utb",
}


# =============================================================================
# DIRECT API SUBMISSION
# =============================================================================


async def submit_form_api(
    service_name: str,
    form_data: Dict[str, str],
    timeout_connect: int = 30,
    timeout_read: int = 60,  # Issue 28 fix: Reduced from 120s to 60s to reduce DoS risk
) -> Dict[str, Any]:
    """
    Submit form data directly to Railway backend via HTTP POST.

    Args:
        service_name: Service to submit to (e.g., "target-v6")
        form_data: Form fields (Business, Country, Exclusion, Email)
        timeout_connect: Connection timeout in seconds
        timeout_read: Read timeout in seconds

    Returns:
        {"success": True/False, "response": ..., "error": ...}
    """
    base_url = RAILWAY_URLS.get(service_name)
    api_path = SERVICE_API_PATHS.get(service_name)

    if not base_url or not api_path:
        return {
            "success": False,
            "error": f"Unknown service: {service_name}. Available: {list(RAILWAY_URLS.keys())}",
        }

    # Issue 2/58 fix: Validate URL domain to prevent SSRF
    if not _validate_url_domain(base_url):
        return {
            "success": False,
            "error": f"URL domain not allowed: {base_url}. Check RAILWAY_URLS configuration.",
        }

    url = base_url.rstrip("/") + api_path

    # Build POST body matching the frontend form format
    email = form_data.get("email", form_data.get("Email", ""))

    # Issue 29/57 fix: Validate email format
    if email and not _validate_email(email):
        return {
            "success": False,
            "error": f"Invalid email format: {email[:50]}...",
        }

    body = {
        "Business": form_data.get("business", form_data.get("Business", "")),
        "Country": form_data.get("country", form_data.get("Country", "")),
        "Exclusion": form_data.get("exclusion", form_data.get("Exclusion", "")),
        "Email": email,
    }

    logger.info(f"POST {url} — Business={body['Business']}, Country={body['Country']}")

    # Try aiohttp first, then httpx, then fall back
    if aiohttp:
        return await _submit_aiohttp(url, body, timeout_connect, timeout_read)
    elif httpx:
        return await _submit_httpx(url, body, timeout_connect, timeout_read)
    else:
        return {
            "success": False,
            "error": "No HTTP client available. Install aiohttp or httpx.",
        }


async def _submit_aiohttp(
    url: str,
    body: dict,
    timeout_connect: int,
    timeout_read: int,
) -> Dict[str, Any]:
    """Submit using aiohttp."""
    timeout = aiohttp.ClientTimeout(
        sock_connect=timeout_connect,
        sock_read=timeout_read,
    )

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body) as resp:
                status = resp.status
                try:
                    response_data = await resp.json()
                except Exception:
                    response_data = await resp.text()

                if status in (200, 201):
                    logger.info(f"API POST succeeded: {status}")
                    return {
                        "success": True,
                        "response": response_data,
                        "status_code": status,
                    }
                else:
                    logger.warning(f"API POST failed: {status} — {response_data}")
                    return {
                        "success": False,
                        "error": f"HTTP {status}: {response_data}",
                        "status_code": status,
                    }

    except asyncio.TimeoutError:
        return {"success": False, "error": f"Request timed out (connect={timeout_connect}s, read={timeout_read}s)"}
    except aiohttp.ClientConnectorError as e:
        return {"success": False, "error": f"Connection failed: {e}"}
    except Exception as e:
        return {"success": False, "error": f"Request error: {e}"}


async def _submit_httpx(
    url: str,
    body: dict,
    timeout_connect: int,
    timeout_read: int,
) -> Dict[str, Any]:
    """Submit using httpx."""
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_read, connect=timeout_connect)
        ) as client:
            resp = await client.post(url, json=body)

            try:
                response_data = resp.json()
            except Exception:
                # Category 1 fix: resp.text is a property, not a method in httpx
                response_data = resp.text

            if resp.status_code in (200, 201):
                logger.info(f"API POST succeeded: {resp.status_code}")
                return {
                    "success": True,
                    "response": response_data,
                    "status_code": resp.status_code,
                }
            else:
                logger.warning(f"API POST failed: {resp.status_code}")
                return {
                    "success": False,
                    "error": f"HTTP {resp.status_code}: {response_data}",
                    "status_code": resp.status_code,
                }

    except Exception as e:
        return {"success": False, "error": f"Request error: {e}"}
