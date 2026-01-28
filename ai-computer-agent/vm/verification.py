"""
Verification Module

Verifies state transitions in the feedback loop:
- Form submission succeeded
- Email attachment downloaded and valid
- PR created and open
- Deployment healthy
"""

import asyncio
import os
import logging
from typing import Dict, Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("verification")


async def verify_form_submission(response: Dict[str, Any]) -> Dict[str, Any]:
    """
    Verify that form submission succeeded.

    Args:
        response: Result from submit_form / submit_form_api

    Returns:
        {"verified": True/False, "error": ...}
    """
    if not response:
        return {"verified": False, "error": "No response from form submission"}

    if not response.get("success"):
        return {"verified": False, "error": response.get("error", "Submission returned success=False")}

    status_code = response.get("status_code")
    if status_code and status_code not in (200, 201):
        return {"verified": False, "error": f"Unexpected status code: {status_code}"}

    # Check response body for error indicators
    resp_data = response.get("response", {})
    if isinstance(resp_data, dict):
        if resp_data.get("error"):
            return {"verified": False, "error": f"Response contains error: {resp_data['error']}"}

    return {"verified": True}


async def verify_email_downloaded(file_path: Optional[str]) -> Dict[str, Any]:
    """
    Verify that downloaded file exists and is valid.

    Args:
        file_path: Path to downloaded file

    Returns:
        {"verified": True/False, "error": ...}
    """
    if not file_path:
        return {"verified": False, "error": "No file path provided"}

    if not os.path.exists(file_path):
        return {"verified": False, "error": f"File not found: {file_path}"}

    file_size = os.path.getsize(file_path)
    if file_size == 0:
        return {"verified": False, "error": "Downloaded file is empty (0 bytes)"}

    ext = os.path.splitext(file_path)[1].lower()
    expected_extensions = {".pptx", ".xlsx", ".xls", ".docx", ".pdf", ".csv"}
    if ext not in expected_extensions:
        return {"verified": False, "error": f"Unexpected file extension: {ext}"}

    # Try to validate file isn't corrupted
    try:
        if ext == ".pptx":
            from file_readers.pptx_reader import analyze_pptx
            analysis = analyze_pptx(file_path)
            if any("Could not open" in str(i) for i in getattr(analysis, 'issues', [])):
                return {"verified": False, "error": "PPTX file could not be parsed"}
        elif ext in (".xlsx", ".xls"):
            from file_readers.xlsx_reader import analyze_xlsx
            analysis = analyze_xlsx(file_path)
            issues = getattr(analysis, 'issues', [])
            if any("Could not open" in str(getattr(i, 'issue', i)) for i in issues):
                return {"verified": False, "error": "XLSX file could not be parsed"}
        elif ext == ".docx":
            from file_readers.docx_reader import analyze_docx
            analysis = analyze_docx(file_path)
            if any("Could not open" in str(i) for i in analysis.issues):
                return {"verified": False, "error": "DOCX file could not be parsed"}
    except Exception as e:
        return {"verified": False, "error": f"File validation failed: {e}"}

    logger.info(f"File verified: {file_path} ({file_size} bytes)")
    return {"verified": True, "file_size": file_size}


async def verify_pr_created(pr_number: Optional[int]) -> Dict[str, Any]:
    """
    Verify that a PR was created and is open.

    Args:
        pr_number: PR number to check

    Returns:
        {"verified": True/False, "error": ...}
    """
    if not pr_number:
        return {"verified": False, "error": "No PR number provided"}

    try:
        proc = await asyncio.create_subprocess_exec(
            "gh", "pr", "view", str(pr_number), "--json", "state,commits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode != 0:
            return {"verified": False, "error": f"gh pr view failed: {stderr.decode()[:200]}"}

        import json
        pr_data = json.loads(stdout.decode())

        state = pr_data.get("state", "")
        commits = pr_data.get("commits", [])

        if state not in ("OPEN", "MERGED"):
            return {"verified": False, "error": f"PR #{pr_number} state is {state}, expected OPEN or MERGED"}

        if not commits:
            return {"verified": False, "error": f"PR #{pr_number} has no commits"}

        logger.info(f"PR #{pr_number} verified: state={state}, commits={len(commits)}")
        return {"verified": True, "state": state, "commit_count": len(commits)}

    except FileNotFoundError:
        return {"verified": False, "error": "gh CLI not found"}
    except asyncio.TimeoutError:
        return {"verified": False, "error": "gh pr view timed out"}
    except Exception as e:
        return {"verified": False, "error": f"PR verification failed: {e}"}


async def verify_deployment(
    health_url: str,
    expected_commit: Optional[str] = None,
    timeout_seconds: int = 5,
) -> Dict[str, Any]:
    """
    Verify deployment is healthy.

    Args:
        health_url: Health check endpoint URL
        expected_commit: Expected commit hash (if health returns version)
        timeout_seconds: Max time to wait for health response

    Returns:
        {"verified": True/False, "error": ...}
    """
    if not health_url:
        return {"verified": False, "error": "No health URL provided"}

    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-sf", "--max-time", str(timeout_seconds), health_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds + 5)

        if proc.returncode != 0:
            return {"verified": False, "error": f"Health check failed: {stderr.decode()[:200]}"}

        body = stdout.decode()
        logger.info(f"Health check passed: {body[:100]}")

        result = {"verified": True, "response": body[:200]}

        # Check commit if provided and health returns version info
        if expected_commit and expected_commit in body:
            result["commit_matched"] = True
        elif expected_commit:
            result["commit_matched"] = False

        return result

    except FileNotFoundError:
        return {"verified": False, "error": "curl not found"}
    except asyncio.TimeoutError:
        return {"verified": False, "error": f"Health check timed out after {timeout_seconds}s"}
    except Exception as e:
        return {"verified": False, "error": f"Health check failed: {e}"}
