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

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.cli_utils import is_wsl_mode, get_subprocess_cwd, get_claude_code_path

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

    # LB-10: Include error key for consistent response format
    return {"verified": True, "error": None}


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
    # Category 6 fix: Consistent .issues check across all file types
    try:
        if ext == ".pptx":
            from file_readers.pptx_reader import analyze_pptx
            analysis = analyze_pptx(file_path)
            issues_list = getattr(analysis, 'issues', []) or []
            if any("Could not open" in str(i) for i in issues_list):
                return {"verified": False, "error": "PPTX file could not be parsed"}
            # Check for critical issues - validate list is non-empty before accessing [0]
            not_installed_issues = [i for i in issues_list if 'not installed' in str(i).lower()]
            if not_installed_issues:
                return {"verified": False, "error": f"PPTX parsing failed: {not_installed_issues[0]}"}
        elif ext in (".xlsx", ".xls"):
            from file_readers.xlsx_reader import analyze_xlsx
            analysis = analyze_xlsx(file_path)
            issues = getattr(analysis, 'issues', []) or []
            # Handle both DataIssue objects and plain strings
            for i in issues:
                issue_str = str(getattr(i, 'issue', i))
                if "Could not open" in issue_str or "not installed" in issue_str.lower():
                    return {"verified": False, "error": f"XLSX file could not be parsed: {issue_str}"}
        elif ext == ".docx":
            from file_readers.docx_reader import analyze_docx
            analysis = analyze_docx(file_path)
            issues_list = getattr(analysis, 'issues', []) or []
            # Find first matching issue for error message
            matching_issues = [str(i) for i in issues_list if "Could not open" in str(i) or "not installed" in str(i).lower()]
            if matching_issues:
                return {"verified": False, "error": f"DOCX file could not be parsed: {matching_issues[0]}"}
    except Exception as e:
        # Category 5 fix: Log the full exception, not just a generic message
        logger.error(f"File validation failed for {file_path}: {e}", exc_info=True)
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
        # C2 fix: WSL-wrap gh CLI calls
        # F49: Pass CLAUDE_CODE_PATH to is_wsl_mode
        if is_wsl_mode(get_claude_code_path()):
            win_cwd, wsl_cwd = get_subprocess_cwd()
            cmd = ["wsl", "--cd", wsl_cwd, "-e", "gh", "pr", "view", str(pr_number), "--json", "state,commits"]
        else:
            win_cwd = None
            cmd = ["gh", "pr", "view", str(pr_number), "--json", "state,commits"]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=win_cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode != 0:
            return {"verified": False, "error": f"gh pr view failed: {stderr.decode()[:200]}"}

        import json
        # B4: Add try/except for JSON parse
        try:
            pr_data = json.loads(stdout.decode())
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse PR data: {e}")
            return {"verified": False, "error": f"Invalid PR data format: {e}"}

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
        # DL-15: Kill the subprocess on timeout to prevent zombie processes
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
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
        # F50: WSL-wrap curl when running in WSL mode
        if is_wsl_mode(get_claude_code_path()):
            cmd = ["wsl", "-e", "curl", "-sS", "--max-time", str(timeout_seconds), health_url]
        else:
            cmd = ["curl", "-sS", "--max-time", str(timeout_seconds), health_url]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
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
