"""
Claude Code Actions - Interact with Claude Code CLI.

This module handles:
- Starting Claude Code sessions
- Sending prompts to Claude Code
- Reading Claude Code output
- Managing Claude Code processes
"""

import asyncio
import subprocess
import os
import sys
import json
from typing import Optional, List
from dataclasses import dataclass
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from computer_use import wait

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("claude_code_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


# Path to Claude Code CLI
CLAUDE_CODE_PATH = os.environ.get("CLAUDE_CODE_PATH", "claude")

# Working directory for Claude Code (your repo)
REPO_PATH = os.environ.get("REPO_PATH", r"C:\Users\You\Projects\xvasjack.github.io")


@dataclass
class ClaudeCodeResult:
    success: bool
    output: str
    error: Optional[str] = None
    pr_number: Optional[int] = None


# =============================================================================
# CLAUDE CODE EXECUTION
# =============================================================================


async def run_claude_code(
    prompt: str,
    working_dir: Optional[str] = None,
    timeout_seconds: int = 600
) -> ClaudeCodeResult:
    """
    Run Claude Code with a prompt.

    Args:
        prompt: The task/prompt to send to Claude Code
        working_dir: Directory to run in (defaults to REPO_PATH)
        timeout_seconds: Max time to wait for completion

    Returns:
        ClaudeCodeResult with output and status
    """
    logger.info(f"Running Claude Code with prompt: {prompt[:100]}...")

    cwd = working_dir or REPO_PATH

    try:
        # Run claude code in non-interactive mode
        process = await asyncio.create_subprocess_exec(
            CLAUDE_CODE_PATH,
            "--print",  # Non-interactive, prints result
            "--message", prompt,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout_seconds
            )
        except asyncio.TimeoutError:
            process.kill()
            return ClaudeCodeResult(
                success=False,
                output="",
                error="Claude Code timed out"
            )

        output = stdout.decode("utf-8", errors="replace")
        error = stderr.decode("utf-8", errors="replace")

        success = process.returncode == 0

        # Try to extract PR number if one was created
        pr_number = extract_pr_number(output)

        return ClaudeCodeResult(
            success=success,
            output=output,
            error=error if error else None,
            pr_number=pr_number,
        )

    except FileNotFoundError:
        return ClaudeCodeResult(
            success=False,
            output="",
            error=f"Claude Code not found at {CLAUDE_CODE_PATH}"
        )
    except Exception as e:
        return ClaudeCodeResult(
            success=False,
            output="",
            error=str(e)
        )


def extract_pr_number(output: str) -> Optional[int]:
    """Extract PR number from Claude Code output if a PR was created"""
    import re

    # Look for patterns like "Created PR #123" or "Pull request: #123"
    patterns = [
        r"PR\s*#(\d+)",
        r"pull request.*#(\d+)",
        r"github\.com/.*/pull/(\d+)",
    ]

    for pattern in patterns:
        match = re.search(pattern, output, re.IGNORECASE)
        if match:
            return int(match.group(1))

    return None


# =============================================================================
# COMMON PROMPTS
# =============================================================================


async def fix_issue(
    issue_description: str,
    file_path: Optional[str] = None,
    context: Optional[str] = None
) -> ClaudeCodeResult:
    """
    Ask Claude Code to fix an issue.

    Args:
        issue_description: Description of what's wrong
        file_path: Specific file to fix (optional)
        context: Additional context (error logs, etc.)

    Returns:
        ClaudeCodeResult
    """
    prompt = f"Fix this issue: {issue_description}"

    if file_path:
        prompt += f"\n\nFile: {file_path}"

    if context:
        prompt += f"\n\nAdditional context:\n{context}"

    prompt += "\n\nAfter fixing, commit and push the changes."

    return await run_claude_code(prompt)


async def improve_output(
    service_name: str,
    current_issues: List[str],
    expected_outcome: str
) -> ClaudeCodeResult:
    """
    Ask Claude Code to improve a service's output.

    Args:
        service_name: Name of the service (e.g., "target-v6")
        current_issues: List of issues with current output
        expected_outcome: What the output should look like

    Returns:
        ClaudeCodeResult
    """
    issues_text = "\n".join(f"- {issue}" for issue in current_issues)

    prompt = f"""Improve the output of the {service_name} service.

Current issues:
{issues_text}

Expected outcome:
{expected_outcome}

Please:
1. Identify the root cause of these issues in the code
2. Implement fixes
3. Commit and push the changes

Focus on the service in backend/{service_name}/"""

    return await run_claude_code(prompt)


async def fix_pptx_output(
    issues: List[str],
    pptx_analysis: str
) -> ClaudeCodeResult:
    """
    Ask Claude Code to fix issues with PowerPoint output.

    Args:
        issues: List of issues found in the PPT
        pptx_analysis: Analysis of the PPT content

    Returns:
        ClaudeCodeResult
    """
    issues_text = "\n".join(f"- {issue}" for issue in issues)

    prompt = f"""Fix the PowerPoint output from the profile-slides or target search service.

Issues found in the output:
{issues_text}

PPT Analysis:
{pptx_analysis}

Please:
1. Find the code that generates the PPT
2. Fix the issues
3. Commit and push changes

Look in backend/profile-slides/ or backend/target-*/"""

    return await run_claude_code(prompt)


async def fix_merge_conflict(
    pr_number: int,
    conflict_files: List[str]
) -> ClaudeCodeResult:
    """
    Ask Claude Code to resolve merge conflicts.

    Args:
        pr_number: The PR number with conflicts
        conflict_files: List of files with conflicts

    Returns:
        ClaudeCodeResult
    """
    files_text = "\n".join(f"- {f}" for f in conflict_files)

    prompt = f"""Resolve merge conflicts in PR #{pr_number}.

Files with conflicts:
{files_text}

Please:
1. Fetch the PR branch
2. Resolve conflicts (prefer the PR changes unless they break functionality)
3. Commit and push the resolution"""

    return await run_claude_code(prompt)


async def fix_ci_failure(
    pr_number: int,
    error_logs: str
) -> ClaudeCodeResult:
    """
    Ask Claude Code to fix CI failures.

    Args:
        pr_number: The PR number with failing CI
        error_logs: The error logs from CI

    Returns:
        ClaudeCodeResult
    """
    prompt = f"""Fix the CI failure in PR #{pr_number}.

Error logs:
```
{error_logs}
```

Please:
1. Analyze the error
2. Fix the underlying issue
3. Commit and push the fix"""

    return await run_claude_code(prompt)


# =============================================================================
# SESSION MANAGEMENT
# =============================================================================


class ClaudeCodeSession:
    """
    Manages a long-running Claude Code session for iterative work.
    """

    def __init__(self, working_dir: Optional[str] = None):
        self.working_dir = working_dir or REPO_PATH
        self.process: Optional[asyncio.subprocess.Process] = None
        self.history: List[dict] = []

    async def start(self):
        """Start an interactive Claude Code session"""
        # For now, we use one-shot commands
        # Future: could use expect-like interaction for true sessions
        pass

    async def send(self, message: str) -> ClaudeCodeResult:
        """Send a message to Claude Code"""
        result = await run_claude_code(message, self.working_dir)
        self.history.append({
            "message": message,
            "result": result.output,
            "success": result.success,
        })
        return result

    async def close(self):
        """Close the Claude Code session"""
        if self.process:
            self.process.terminate()
            await self.process.wait()
            self.process = None


# =============================================================================
# UTILITIES
# =============================================================================


async def check_claude_code_installed() -> bool:
    """Check if Claude Code CLI is installed and accessible"""
    try:
        process = await asyncio.create_subprocess_exec(
            CLAUDE_CODE_PATH,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.communicate()
        return process.returncode == 0
    except FileNotFoundError:
        return False


async def get_claude_code_version() -> Optional[str]:
    """Get Claude Code version"""
    try:
        process = await asyncio.create_subprocess_exec(
            CLAUDE_CODE_PATH,
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await process.communicate()
        return stdout.decode().strip()
    except Exception:
        return None
