"""
Gmail API - Reliable email access via Google Gmail API with OAuth2.

Replaces browser-based Gmail automation with direct API calls.
Supports:
- Searching emails (read-only)
- Downloading attachments
- Polling for new emails with timeout

Security guardrails:
- Read-only access (no compose, send, delete, archive)
- Sender whitelist check before processing
- Subject whitelist check before processing
"""

import asyncio
import base64
import os
import re
import time
import logging
from typing import Dict, Any, List, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gmail_api")

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    HAS_GMAIL_API = True
except ImportError:
    HAS_GMAIL_API = False
    logger.warning(
        "Gmail API dependencies not installed. Run: "
        "pip install google-api-python-client google-auth-oauthlib google-auth-httplib2"
    )


# =============================================================================
# CONFIGURATION
# =============================================================================

# OAuth2 scopes — read-only
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

GMAIL_CREDENTIALS_PATH = os.environ.get(
    "GMAIL_CREDENTIALS_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "credentials", "gmail_credentials.json"),
)

GMAIL_TOKEN_PATH = os.environ.get(
    "GMAIL_TOKEN_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "credentials", "gmail_token.json"),
)

# Guardrails: allowed senders
ALLOWED_SENDERS = [
    "noreply@github.com",
    "notifications@github.com",
]

# Guardrails: allowed subject patterns
ALLOWED_SUBJECT_PATTERNS = [
    r"target.*search",
    r"market.*research",
    r"profile.*slides",
    r"trading.*comp",
    r"validation.*result",
    r"due.*diligence",
    r"PR.*merged",
    r"GitHub",
    r"Pull request",
]


# =============================================================================
# AUTHENTICATION
# =============================================================================


def _get_gmail_service():
    """Get authenticated Gmail API service."""
    if not HAS_GMAIL_API:
        raise RuntimeError("Gmail API dependencies not installed")

    creds = None

    # Load existing token
    if os.path.exists(GMAIL_TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_PATH, SCOPES)

    # Refresh or create new credentials
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(GMAIL_CREDENTIALS_PATH):
                raise FileNotFoundError(
                    f"Gmail credentials not found at {GMAIL_CREDENTIALS_PATH}. "
                    f"Download OAuth2 credentials from Google Cloud Console."
                )
            flow = InstalledAppFlow.from_client_secrets_file(GMAIL_CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

        # Save token for future runs
        os.makedirs(os.path.dirname(GMAIL_TOKEN_PATH), exist_ok=True)
        with open(GMAIL_TOKEN_PATH, "w") as token_file:
            token_file.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


# =============================================================================
# GUARDRAILS
# =============================================================================


def _check_sender_allowed(sender: str) -> bool:
    """Check if sender is in the allowed list."""
    if not sender:
        return False
    sender_lower = sender.lower()

    # Check against allowed senders list
    for allowed in ALLOWED_SENDERS:
        if allowed.lower() in sender_lower:
            return True

    # Also allow SendGrid emails (common automation sender)
    # SendGrid uses various subdomains, so check domain pattern
    sendgrid_patterns = [
        "sendgrid.net",
        "sendgrid.com",
        "em.sendgrid.net",
    ]
    for pattern in sendgrid_patterns:
        if pattern in sender_lower:
            return True

    # Allow emails from the configured sender (for internal automation)
    sender_email = os.environ.get("SENDER_EMAIL", "")
    if sender_email and sender_email.lower() in sender_lower:
        return True

    return False


def _check_subject_allowed(subject: str) -> bool:
    """Check if subject matches allowed patterns."""
    for pattern in ALLOWED_SUBJECT_PATTERNS:
        if re.search(pattern, subject, re.IGNORECASE):
            return True
    # Allow subjects containing service names
    service_keywords = ["target", "market", "profile", "trading", "validation", "diligence", "utb"]
    return any(kw in subject.lower() for kw in service_keywords)


# =============================================================================
# MIME HELPERS
# =============================================================================


def _get_all_parts(payload, max_depth=10, _current_depth=0):
    """Recursively walk MIME parts to find nested attachments.

    Category 2 fix: Add max_depth to prevent infinite recursion on nested emails.
    """
    if _current_depth >= max_depth:
        logger.warning(f"MIME recursion depth limit ({max_depth}) reached")
        return []

    parts = payload.get("parts", []) if payload else []
    all_parts = []
    for part in parts:
        if part:
            all_parts.append(part)
            all_parts.extend(_get_all_parts(part, max_depth, _current_depth + 1))
    return all_parts


# =============================================================================
# EMAIL OPERATIONS
# =============================================================================


async def search_emails_api(
    query: str,
    max_results: int = 5,
) -> List[Dict[str, Any]]:
    """
    Search Gmail for emails matching query.

    Args:
        query: Gmail search query (e.g., "subject:target-v6 has:attachment newer_than:1h")
        max_results: Maximum emails to return

    Returns:
        List of {id, subject, sender, date, has_attachment}
    """
    if not HAS_GMAIL_API:
        return []

    def _search():
        service = _get_gmail_service()
        results = service.users().messages().list(
            userId="me",
            q=query,
            maxResults=max_results,
        ).execute()

        messages = results.get("messages", [])
        email_list = []

        for msg_meta in messages:
            msg = service.users().messages().get(
                userId="me",
                id=msg_meta["id"],
                format="metadata",
                metadataHeaders=["Subject", "From", "Date"],
            ).execute()

            # Category 1 fix: Handle malformed headers missing "name"/"value"
            raw_headers = msg.get("payload", {}).get("headers", [])
            headers = {}
            for h in raw_headers:
                if isinstance(h, dict) and "name" in h and "value" in h:
                    headers[h["name"]] = h["value"]
            has_attachment = any(
                part.get("filename")
                for part in _get_all_parts(msg.get("payload", {}))
            )

            email_list.append({
                "id": msg_meta["id"],
                "subject": headers.get("Subject", ""),
                "sender": headers.get("From", ""),
                "date": headers.get("Date", ""),
                "has_attachment": has_attachment,
            })

        return email_list

    return await asyncio.get_running_loop().run_in_executor(None, _search)


async def download_attachment_api(
    message_id: str,
    download_dir: str,
) -> Optional[str]:
    """
    Download attachment from a Gmail message.

    Args:
        message_id: Gmail message ID
        download_dir: Directory to save the attachment

    Returns:
        File path of downloaded attachment, or None
    """
    if not HAS_GMAIL_API:
        return None

    def _download():
        service = _get_gmail_service()
        msg = service.users().messages().get(
            userId="me",
            id=message_id,
            format="full",
        ).execute()

        parts = _get_all_parts(msg.get("payload", {}))
        for part in parts:
            filename = part.get("filename")
            if not filename:
                continue

            # Check file extension
            ext = os.path.splitext(filename)[1].lower()
            if ext not in (".pptx", ".xlsx", ".xls", ".docx", ".pdf", ".csv"):
                continue

            # Category 1 fix: part.get("body", {}) may return None
            body = part.get("body")
            if not body or not isinstance(body, dict):
                continue
            attachment_id = body.get("attachmentId")
            if not attachment_id:
                continue

            attachment = service.users().messages().attachments().get(
                userId="me",
                messageId=message_id,
                id=attachment_id,
            ).execute()

            # Category 1 fix: attachment["data"] may be missing
            if not attachment or "data" not in attachment:
                logger.warning(f"Attachment {attachment_id} has no data")
                continue

            data = base64.urlsafe_b64decode(attachment["data"])

            os.makedirs(download_dir, exist_ok=True)

            # Category 4 fix: Path traversal security - sanitize filename
            # Prevent ../../etc/passwd attacks
            safe_filename = os.path.basename(filename)  # Strip any path components
            safe_filename = re.sub(r'[<>:"/\\|?*]', '_', safe_filename)  # Remove unsafe chars
            if not safe_filename or safe_filename.startswith('.'):
                safe_filename = f"attachment_{attachment_id[:8]}{ext}"
            file_path = os.path.join(download_dir, safe_filename)

            with open(file_path, "wb") as f:
                f.write(data)

            logger.info(f"Downloaded attachment: {file_path} ({len(data)} bytes)")
            return file_path

        return None

    return await asyncio.get_running_loop().run_in_executor(None, _download)


async def wait_for_email_api(
    query: str,
    download_dir: str,
    timeout_minutes: int = 15,
    poll_interval: int = 30,
) -> Dict[str, Any]:
    """
    Poll Gmail for an email matching the query, then download its attachment.

    Args:
        query: Gmail search query
        download_dir: Where to save attachments
        timeout_minutes: Max time to wait
        poll_interval: Seconds between polls

    Returns:
        {"success": True, "file_path": ...} or {"success": False, "error": ...}
    """
    logger.info(f"Waiting for email: {query} (timeout: {timeout_minutes}m)")

    deadline = time.time() + (timeout_minutes * 60)

    while time.time() < deadline:
        try:
            emails = await search_emails_api(query, max_results=3)

            for email in emails:
                # Guardrails
                if not _check_sender_allowed(email["sender"]):
                    logger.warning(f"Sender not allowed: {email['sender']}")
                    continue
                if not _check_subject_allowed(email["subject"]):
                    logger.warning(f"Subject not allowed: {email['subject']}")
                    continue

                if email.get("has_attachment"):
                    file_path = await download_attachment_api(email["id"], download_dir)
                    if file_path:
                        return {
                            "success": True,
                            "file_path": file_path,
                            "email_id": email["id"],
                            "subject": email["subject"],
                        }

        except Exception as e:
            logger.warning(f"Email poll failed: {e}")

        remaining = int(deadline - time.time())
        logger.info(f"No matching email yet. Retrying in {poll_interval}s ({remaining}s remaining)")
        await asyncio.sleep(poll_interval)

    return {
        "success": False,
        "error": f"Email not received within {timeout_minutes} minutes",
    }
