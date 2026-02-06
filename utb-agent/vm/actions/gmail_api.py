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
import email.utils
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gmail_api")


# E4: Parse email date to UTC
def _parse_email_date(date_str: str) -> Optional[datetime]:
    """Parse email date string to UTC datetime."""
    if not date_str:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(date_str)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None

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
    "xvasjack@gmail.com",
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
    global HAS_GMAIL_API
    if not HAS_GMAIL_API:
        raise RuntimeError("Gmail API dependencies not installed")

    creds = None

    # Load existing token
    if os.path.exists(GMAIL_TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(GMAIL_TOKEN_PATH, SCOPES)

    # Refresh or create new credentials
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as e:
                logger.error(f"OAuth token refresh failed: {e}")
                # 0.6: Disable Gmail API to prevent repeated failed refresh attempts
                HAS_GMAIL_API = False
                return None
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
        # A5: Set secure file permissions (owner read/write only)
        os.chmod(GMAIL_TOKEN_PATH, 0o600)

    return build("gmail", "v1", credentials=creds)


# =============================================================================
# GUARDRAILS
# =============================================================================


def _extract_email_domain(sender: str) -> str:
    """B2: Extract domain from email address for validation."""
    if not sender:
        return ""
    # Extract email address from "Name <email@domain.com>" format
    match = re.search(r'[\w.+-]+@([\w.-]+)', sender)
    return match.group(1).lower() if match else ""


def _check_sender_allowed(sender: str) -> bool:
    """Check if sender is in the allowed list. B2: Use domain matching instead of substring."""
    if not sender:
        return False

    sender_domain = _extract_email_domain(sender)
    if not sender_domain:
        return False

    # Check against allowed senders list (extract domains from allowed addresses)
    for allowed in ALLOWED_SENDERS:
        allowed_domain = _extract_email_domain(allowed) or allowed.lower()
        # B2: Exact domain match instead of substring match
        if sender_domain == allowed_domain or sender_domain.endswith("." + allowed_domain):
            return True

    # Also allow SendGrid emails (common automation sender)
    # SendGrid uses various subdomains, so check domain pattern
    sendgrid_domains = [
        "sendgrid.net",
        "sendgrid.com",
    ]
    for domain in sendgrid_domains:
        if sender_domain == domain or sender_domain.endswith("." + domain):
            return True

    # Allow emails from the configured sender (for internal automation)
    # Check both SENDER_EMAIL and USER_EMAIL env vars
    for env_var in ("SENDER_EMAIL", "USER_EMAIL"):
        config_email = os.environ.get(env_var, "")
        if config_email:
            config_domain = _extract_email_domain(config_email)
            if config_domain and sender_domain == config_domain:
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
# SECURITY HELPERS
# =============================================================================


# B3: Allowed download directories
ALLOWED_DOWNLOAD_DIRS = [
    "/tmp",
    os.path.expanduser("~/Downloads"),
    os.path.expanduser("~/downloads"),
    os.path.join(os.path.expanduser("~"), "Downloads"),
]


def _validate_download_dir(download_dir: str) -> bool:
    """B3: Validate download directory is in allowed list."""
    if not download_dir:
        return False
    abs_dir = os.path.abspath(os.path.expanduser(download_dir))
    # Check if the directory is under an allowed path
    for allowed in ALLOWED_DOWNLOAD_DIRS:
        allowed_abs = os.path.abspath(os.path.expanduser(allowed))
        if abs_dir == allowed_abs or abs_dir.startswith(allowed_abs + os.sep):
            return True
    # Also allow any directory under user's home
    home_dir = os.path.expanduser("~")
    if abs_dir.startswith(home_dir + os.sep):
        return True
    return False


# =============================================================================
# MIME HELPERS
# =============================================================================


# C6: Maximum total MIME parts to prevent DoS
MAX_MIME_PARTS_TOTAL = 100


def _get_all_parts(payload, max_depth=10, _current_depth=0, _total_parts=None):
    """Recursively walk MIME parts to find nested attachments.

    Category 2 fix: Add max_depth to prevent infinite recursion on nested emails.
    C6: Add total parts limit to prevent DoS on emails with many parts.
    """
    if _total_parts is None:
        _total_parts = [0]  # Mutable container for tracking across recursion

    if _current_depth >= max_depth:
        logger.warning(f"MIME recursion depth limit ({max_depth}) reached")
        return []

    if _total_parts[0] >= MAX_MIME_PARTS_TOTAL:
        logger.warning(f"MIME total parts limit ({MAX_MIME_PARTS_TOTAL}) reached")
        return []

    parts = payload.get("parts", []) if payload else []
    all_parts = []
    for part in parts:
        if part:
            _total_parts[0] += 1
            if _total_parts[0] > MAX_MIME_PARTS_TOTAL:
                logger.warning(f"MIME total parts limit ({MAX_MIME_PARTS_TOTAL}) exceeded")
                break
            all_parts.append(part)
            all_parts.extend(_get_all_parts(part, max_depth, _current_depth + 1, _total_parts))
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
            includeSpamTrash=True,
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

    # RC-3: Wrap blocking executor call with timeout to prevent indefinite hangs
    return await asyncio.wait_for(
        asyncio.get_running_loop().run_in_executor(None, _search),
        timeout=30  # 30 second timeout for email search
    )


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

    # B3: Validate download directory
    if not _validate_download_dir(download_dir):
        logger.error(f"Download directory not allowed: {download_dir}")
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
            # 1.14: Extended whitelist — add .ppt, .html, .htm, .zip
            allowed_exts = {".pptx", ".xlsx", ".xls", ".docx", ".pdf", ".csv", ".ppt", ".html", ".htm", ".zip", ".txt"}
            if ext not in allowed_exts:
                logger.warning(f"Skipping attachment with unknown extension: {filename}")
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

            # B2: Complete path traversal fix - verify final path is within download_dir
            real_path = os.path.realpath(file_path)
            if not real_path.startswith(os.path.realpath(download_dir) + os.sep):
                logger.error(f"Path traversal detected: {file_path} -> {real_path}")
                return None

            with open(file_path, "wb") as f:
                f.write(data)

            logger.info(f"Downloaded attachment: {file_path} ({len(data)} bytes)")
            return file_path

        return None

    # RC-3: Wrap blocking executor call with timeout to prevent indefinite hangs
    return await asyncio.wait_for(
        asyncio.get_running_loop().run_in_executor(None, _download),
        timeout=60  # 60 second timeout for attachment download
    )


async def wait_for_email_api(
    query: str,
    download_dir: str,
    timeout_minutes: int = 65,
    poll_interval: int = 30,
    skip_email_ids: Optional[set] = None,
    after_epoch: Optional[int] = None,
    liveness_check: Optional[Any] = None,
    liveness_check_interval: int = 3,
) -> Dict[str, Any]:
    """
    Poll Gmail for an email matching the query, then download its attachment.

    Args:
        query: Gmail search query
        download_dir: Where to save attachments
        timeout_minutes: Max time to wait
        poll_interval: Seconds between polls
        skip_email_ids: Set of email IDs to skip (already processed in previous iterations)
        after_epoch: Only match emails received after this Unix epoch (seconds)

    Returns:
        {"success": True, "file_path": ...} or {"success": False, "error": ...}
    """
    skip_ids = skip_email_ids or set()
    if skip_ids:
        logger.info(f"Skipping {len(skip_ids)} already-processed email(s)")
    # Add time filter to only match emails after form submission
    if after_epoch:
        query = f"{query} after:{after_epoch}"
    logger.info(f"Waiting for email: query={query} | timeout={timeout_minutes}m | poll_interval={poll_interval}s")

    deadline = time.time() + (timeout_minutes * 60)
    poll_count = 0

    while time.time() < deadline:
        poll_count += 1
        remaining = int(deadline - time.time())

        # Backend liveness check every N polls (skip first poll — give backend time)
        if liveness_check and poll_count > 1 and poll_count % liveness_check_interval == 0:
            alive = await liveness_check()
            if not alive.get("alive"):
                logger.warning(f"[Poll #{poll_count}] Backend health check FAILED: {alive.get('reason')}")
                await asyncio.sleep(10)  # double-check (avoid false positive from network blip)
                alive2 = await liveness_check()
                if not alive2.get("alive"):
                    logger.error(f"[Poll #{poll_count}] Backend confirmed dead: {alive2.get('reason')}")
                    return {
                        "success": False,
                        "error": f"Backend died during email wait: {alive2.get('reason')}",
                        "backend_died": True,
                    }
                logger.info(f"[Poll #{poll_count}] Backend recovered on recheck — continuing")

        logger.info(f"[Poll #{poll_count}] Searching Gmail... (query: {query}) | {remaining}s remaining")

        try:
            emails = await search_emails_api(query, max_results=3)
            logger.info(f"[Poll #{poll_count}] Found {len(emails)} email(s) matching query")

            # 1.13: Rename loop var to avoid shadowing stdlib `email` module
            for i, email_msg in enumerate(emails):
                logger.info(f"[Poll #{poll_count}] Email {i+1}: subject='{email_msg['subject']}' from='{email_msg['sender']}' has_attachment={email_msg.get('has_attachment')}")
                # Skip already-processed emails from previous iterations
                if email_msg["id"] in skip_ids:
                    logger.info(f"[Poll #{poll_count}] SKIPPED — already processed: {email_msg['id']}")
                    continue
                # Guardrails
                if not _check_sender_allowed(email_msg["sender"]):
                    logger.warning(f"[Poll #{poll_count}] SKIPPED — sender not allowed: {email_msg['sender']}")
                    continue
                if not _check_subject_allowed(email_msg["subject"]):
                    logger.warning(f"[Poll #{poll_count}] SKIPPED — subject not allowed: {email_msg['subject']}")
                    continue

                # Note: has_attachment from metadata format is unreliable (parts not returned).
                # The Gmail query already includes has:attachment, so trust that and try downloading.
                logger.info(f"[Poll #{poll_count}] Attempting attachment download from email {email_msg['id']}...")
                file_path = await download_attachment_api(email_msg["id"], download_dir)
                if file_path:
                    logger.info(f"[Poll #{poll_count}] SUCCESS — downloaded: {file_path}")
                    return {
                        "success": True,
                        "file_path": file_path,
                        "email_id": email_msg["id"],
                        "subject": email_msg["subject"],
                    }
                else:
                    logger.warning(f"[Poll #{poll_count}] No downloadable attachment in email {email_msg['id']} — trying next")

        except Exception as e:
            logger.warning(f"[Poll #{poll_count}] Poll failed with error: {e}")

        logger.info(f"[Poll #{poll_count}] No matching email yet. Sleeping {poll_interval}s... ({remaining}s remaining)")
        await asyncio.sleep(poll_interval)

    return {
        "success": False,
        "error": f"Email not received within {timeout_minutes} minutes",
    }
