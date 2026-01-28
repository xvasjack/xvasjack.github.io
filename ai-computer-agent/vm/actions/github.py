"""
GitHub Actions - GitHub operations via gh CLI.

This module provides high-level actions for:
- Viewing pull requests
- Merging PRs
- Waiting for CI checks
- Checking PR status

All operations use the `gh` CLI tool instead of browser automation
for reliability and speed.
"""

import asyncio
import json
import re
import os
from typing import Optional, List
from dataclasses import dataclass
import logging

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
# CONFIGURATION
# =============================================================================


DEFAULT_OWNER = os.environ.get("GITHUB_OWNER", "xvasjack")
DEFAULT_REPO = os.environ.get("GITHUB_REPO", "xvasjack.github.io")


def _repo_flag() -> str:
    return f"{DEFAULT_OWNER}/{DEFAULT_REPO}"


# =============================================================================
# GH CLI HELPERS
# =============================================================================


def _sanitize_for_logging(args: List[str]) -> str:
    """C4: Sanitize command arguments for safe logging."""
    # Truncate very long arguments and escape special characters
    sanitized = []
    for arg in args:
        if len(arg) > 200:
            arg = arg[:200] + "..."
        # Remove potential log injection characters
        arg = arg.replace("\n", "\\n").replace("\r", "\\r")
        sanitized.append(arg)
    return " ".join(sanitized)


async def _run_gh(args: List[str], timeout_seconds: int = 60) -> dict:
    """
    Run a gh CLI command and return parsed result.

    Returns:
        {"success": bool, "stdout": str, "stderr": str, "returncode": int}
    """
    cmd = ["gh"] + args
    # C4: Sanitize args for logging to prevent log injection
    logger.info(f"Running: {_sanitize_for_logging(cmd)}")

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout_seconds
            )
        except asyncio.TimeoutError:
            # A3: Properly reap the process after kill() to prevent zombie
            process.kill()
            try:
                await asyncio.wait_for(process.communicate(), timeout=5)
            except asyncio.TimeoutError:
                # B4: Explicitly wait for process to prevent zombie
                await process.wait()
            return {
                "success": False,
                "stdout": "",
                "stderr": "Command timed out",
                "returncode": -1,
            }

        stdout_str = stdout.decode("utf-8", errors="replace").strip()
        stderr_str = stderr.decode("utf-8", errors="replace").strip()

        return {
            "success": process.returncode == 0,
            "stdout": stdout_str,
            "stderr": stderr_str,
            "returncode": process.returncode,
        }

    except FileNotFoundError:
        return {
            "success": False,
            "stdout": "",
            "stderr": "gh CLI not found. Install: https://cli.github.com/",
            "returncode": -1,
        }
    except Exception as e:
        return {
            "success": False,
            "stdout": "",
            "stderr": str(e),
            "returncode": -1,
        }


async def _run_gh_json(args: List[str], timeout_seconds: int = 60) -> dict:
    """Run gh command expecting JSON output, return parsed dict."""
    result = await _run_gh(args, timeout_seconds)
    if result["success"] and result["stdout"]:
        try:
            result["data"] = json.loads(result["stdout"])
        except json.JSONDecodeError:
            result["data"] = None
    else:
        result["data"] = None
    return result


def _extract_conflict_files(diff_output: str) -> List[str]:
    """Extract file paths from a git diff output."""
    files = []
    for line in diff_output.splitlines():
        if line.startswith("diff --git"):
            # Format: diff --git a/path b/path
            parts = line.split(" b/", 1)
            if len(parts) == 2:
                files.append(parts[1])
    return files


# =============================================================================
# PR OPERATIONS
# =============================================================================


async def get_pr_status(pr_number: int) -> dict:
    """
    Get the status of a PR using gh CLI.

    Returns:
        {state, mergeable, checks_passed, title, url, ...}
    """
    logger.info(f"Getting status of PR #{pr_number}")

    result = await _run_gh_json([
        "pr", "view", str(pr_number),
        "--repo", _repo_flag(),
        "--json", "state,mergeable,title,url,statusCheckRollup,mergeStateStatus,number,headRefName",
    ])

    if not result["success"] or not result["data"]:
        return {
            "success": False,
            "error": result["stderr"] or "Failed to get PR status",
        }

    data = result["data"]

    # Determine if checks passed
    checks = data.get("statusCheckRollup", []) or []
    # H13: Check conclusion, not just status. COMPLETED with FAILURE != success
    checks_passed = all(
        c.get("conclusion", "").upper() == "SUCCESS"
        for c in checks
    ) if checks else True  # No checks = passes

    checks_pending = any(
        c.get("status") in ("IN_PROGRESS", "QUEUED", "PENDING")
        for c in checks
    )

    return {
        "success": True,
        "state": data.get("state", "UNKNOWN"),
        "mergeable": data.get("mergeable", "UNKNOWN"),
        "merge_state_status": data.get("mergeStateStatus", "UNKNOWN"),
        "checks_passed": checks_passed,
        "checks_pending": checks_pending,
        "title": data.get("title", ""),
        "url": data.get("url", ""),
        "number": data.get("number", pr_number),
        "branch": data.get("headRefName", ""),
    }


async def merge_pr(pr_number: int) -> dict:
    """
    Merge a PR using gh CLI.

    Args:
        pr_number: PR number to merge

    Returns:
        {success: bool, error: str}
    """
    logger.info(f"Merging PR #{pr_number}")

    result = await _run_gh([
        "pr", "merge", str(pr_number),
        "--repo", _repo_flag(),
        "--merge",
        "--delete-branch",
    ])

    if result["success"]:
        logger.info(f"PR #{pr_number} merged successfully")
        return {"success": True, "message": f"PR #{pr_number} merged"}
    else:
        error = result["stderr"] or "Merge failed"
        logger.error(f"Merge failed: {error}")

        # Detect specific error types
        error_type = "merge_failure"
        if "merge conflict" in error.lower():
            error_type = "merge_conflict"
        elif "not mergeable" in error.lower():
            error_type = "not_mergeable"
        elif "review" in error.lower():
            error_type = "review_required"

        # For merge conflicts, extract the conflicting files from the PR diff
        conflict_files = []
        if error_type == "merge_conflict":
            try:
                diff_result = await _run_gh(["pr", "diff", str(pr_number), "--repo", _repo_flag()])
                conflict_files = _extract_conflict_files(diff_result.get("stdout", ""))
            except Exception as e:
                logger.warning(f"Failed to extract conflict files: {e}")

        return {
            "success": False,
            "error": error,
            "error_type": error_type,
            "conflict_files": conflict_files,
        }


async def wait_for_ci(pr_number: int, timeout_minutes: int = 10) -> dict:
    """
    Wait for CI checks to complete on a PR.

    Uses `gh pr checks --watch` for real-time monitoring.

    Args:
        pr_number: PR number to watch
        timeout_minutes: Max time to wait

    Returns:
        {passed: bool, error: str}
    """
    logger.info(f"Waiting for CI on PR #{pr_number} (timeout: {timeout_minutes}m)")

    # First try gh pr checks --watch which blocks until checks complete
    result = await _run_gh(
        [
            "pr", "checks", str(pr_number),
            "--repo", _repo_flag(),
            "--watch",
        ],
        timeout_seconds=timeout_minutes * 60,
    )

    if result["success"]:
        logger.info(f"CI checks passed for PR #{pr_number}")
        return {"passed": True}

    # If --watch failed or timed out, check status manually
    status = await get_pr_status(pr_number)
    if status.get("success"):
        if status.get("checks_passed"):
            return {"passed": True}
        elif status.get("checks_pending"):
            return {"passed": False, "error": "CI checks still pending (timeout)"}

    error = result["stderr"] or "CI checks failed"
    logger.error(f"CI failed: {error}")
    return {"passed": False, "error": error}


async def get_ci_error_logs(pr_number: int) -> dict:
    """
    Get detailed CI error logs for a failing PR.

    Returns:
        {success: bool, logs: str, failed_checks: list}
    """
    logger.info(f"Getting CI error logs for PR #{pr_number}")

    result = await _run_gh_json([
        "pr", "checks", str(pr_number),
        "--repo", _repo_flag(),
        "--json", "name,state,conclusion,detailsUrl",
    ])

    if not result["success"] or not result["data"]:
        return {"success": False, "logs": "", "failed_checks": []}

    checks = result["data"] if isinstance(result["data"], list) else []
    failed = [c for c in checks if c.get("conclusion") == "FAILURE"]

    # Get run logs for failed checks
    logs_parts = []
    for check in failed:
        logs_parts.append(f"FAILED: {check.get('name', 'unknown')}")
        logs_parts.append(f"  URL: {check.get('detailsUrl', 'N/A')}")

    # Also try to get the PR's latest run logs via gh run
    # A6: Query runs for the PR's head branch, not main
    pr_status = await get_pr_status(pr_number)
    pr_branch = pr_status.get("branch") if pr_status.get("success") else None
    run_list_args = [
        "run", "list",
        "--repo", _repo_flag(),
        "--limit", "1",
        "--json", "databaseId,conclusion,status",
    ]
    if pr_branch:
        run_list_args.extend(["--branch", pr_branch])
    run_result = await _run_gh_json(run_list_args)

    if run_result.get("data") and isinstance(run_result["data"], list) and run_result["data"]:
        run_id = run_result["data"][0].get("databaseId")
        if run_id:
            log_result = await _run_gh([
                "run", "view", str(run_id),
                "--repo", _repo_flag(),
                "--log-failed",
            ], timeout_seconds=30)
            if log_result["success"]:
                logs_parts.append("\n--- Failed Run Logs ---")
                logs_parts.append(log_result["stdout"][:5000])  # Limit size

    return {
        "success": True,
        "logs": "\n".join(logs_parts),
        "failed_checks": [c.get("name") for c in failed],
    }


# =============================================================================
# PR DISCOVERY
# =============================================================================


async def check_for_new_prs(author: Optional[str] = None) -> List[dict]:
    """
    Check for new open PRs, optionally filtered by author.

    Returns list of PR info dicts.
    """
    args = [
        "pr", "list",
        "--repo", _repo_flag(),
        "--state", "open",
        "--json", "number,title,url,author,headRefName,createdAt",
        "--limit", "10",
    ]

    if author:
        args.extend(["--author", author])

    result = await _run_gh_json(args)

    if not result["success"] or not result["data"]:
        return []

    prs = result["data"] if isinstance(result["data"], list) else []
    return [
        {
            "number": pr.get("number"),
            "title": pr.get("title"),
            "url": pr.get("url"),
            "author": pr.get("author", {}).get("login", "unknown"),
            "branch": pr.get("headRefName"),
            "created_at": pr.get("createdAt"),
        }
        for pr in prs
    ]


async def find_claude_prs() -> List[dict]:
    """Find PRs created by Claude Code (branches starting with claude/)."""
    result = await _run_gh_json([
        "pr", "list",
        "--repo", _repo_flag(),
        "--state", "open",
        "--json", "number,title,url,headRefName,createdAt",
        "--limit", "10",
    ])

    if not result["success"] or not result["data"]:
        return []

    prs = result["data"] if isinstance(result["data"], list) else []
    return [
        {
            "number": pr.get("number"),
            "title": pr.get("title"),
            "url": pr.get("url"),
            "branch": pr.get("headRefName"),
        }
        for pr in prs
        if (pr.get("headRefName") or "").startswith("claude/")
    ]


# =============================================================================
# PR COMMENTS
# =============================================================================


async def get_pr_comments(pr_number: int) -> List[dict]:
    """Get comments on a PR."""
    result = await _run_gh_json([
        "api", f"repos/{_repo_flag()}/pulls/{pr_number}/comments",
    ])

    if not result["success"] or not result["data"]:
        return []

    comments = result["data"] if isinstance(result["data"], list) else []
    return [
        {
            "author": c.get("user", {}).get("login", "unknown"),
            "body": c.get("body", ""),
            "created_at": c.get("created_at"),
        }
        for c in comments
    ]


# =============================================================================
# UTILITIES
# =============================================================================


async def check_gh_installed() -> bool:
    """Check if gh CLI is installed and authenticated."""
    result = await _run_gh(["auth", "status"])
    return result["success"]
