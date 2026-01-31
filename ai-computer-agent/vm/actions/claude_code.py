"""
Claude Code Actions - Interact with Claude Code CLI.

This module handles:
- Running Claude Code with task-scoped mandates
- Sending prompts with guardrail instructions
- Reading Claude Code output
- Extracting PR numbers from output
"""

import asyncio
import os
import sys
import json
from typing import Optional, List
from dataclasses import dataclass
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.cli_utils import build_claude_cmd, get_claude_code_path, get_repo_cwd

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("claude_code_actions")


# =============================================================================
# CONFIGURATION
# =============================================================================


# Claude Code CLI binary. On Windows calling into WSL, use "wsl:claude".
CLAUDE_CODE_PATH = get_claude_code_path()

# Working directory for Claude Code (your repo) — WSL-aware
REPO_PATH = get_repo_cwd()

# Mandate file path (prepended to every prompt)
MANDATE_PATH = os.environ.get(
    "CLAUDE_MANDATE_PATH",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "claude_mandate.md")
)

# Protected files that should NEVER be modified
PROTECTED_FILES = [
    ".env", ".env.*", "credentials*", "secrets*",
    ".github/workflows/*",
    "CLAUDE.md",
    "ai-computer-agent/**",
    ".git/config",
    "*.pem", "*.key", "*.cert",
]


@dataclass
class ClaudeCodeResult:
    success: bool
    output: str
    error: Optional[str] = None
    pr_number: Optional[int] = None


# =============================================================================
# MANDATE
# =============================================================================


def _load_mandate() -> str:
    """Load the mandate file if it exists."""
    if os.path.exists(MANDATE_PATH):
        with open(MANDATE_PATH, "r") as f:
            return f.read()
    return ""


# Issue 3 fix: Maximum prompt length to prevent unbounded memory usage
MAX_PROMPT_LENGTH = 100000  # ~25K tokens


def _build_prompt(
    task_prompt: str,
    service_name: Optional[str] = None,
    allowed_dirs: Optional[List[str]] = None,
    iteration: int = 0,
    previous_issues: Optional[str] = None,
    original_task: Optional[str] = None,
) -> str:
    """Build a full prompt with mandate + task context."""
    parts = []

    # Issue 3 fix: Truncate inputs to prevent unbounded prompt length
    task_prompt = task_prompt[:MAX_PROMPT_LENGTH // 2] if task_prompt else ""
    previous_issues = previous_issues[:10000] if previous_issues else None
    original_task = original_task[:5000] if original_task else None

    # Load mandate
    mandate = _load_mandate()
    if mandate:
        # Fill in template variables
        dirs = ", ".join(allowed_dirs) if allowed_dirs else f"backend/{service_name}/, backend/shared/" if service_name else "backend/"
        mandate = mandate.replace("{ALLOWED_DIRECTORIES}", dirs)
        mandate = mandate.replace("{SERVICE_NAME}", service_name or "unknown")
        mandate = mandate.replace("{ITERATION_NUMBER}", str(iteration))
        mandate = mandate.replace("{PREVIOUS_ISSUES}", previous_issues or "None")
        mandate = mandate.replace("{ORIGINAL_TASK}", original_task or task_prompt[:200])
        mandate = mandate.replace("{FIX_PROMPT}", task_prompt)
        parts.append(mandate)
    else:
        # Inline mandate if file doesn't exist
        parts.append(f"""# Agent Mandate
You are being invoked by an automated agent. Follow these rules:
1. ONLY modify files in: {', '.join(allowed_dirs) if allowed_dirs else f'backend/{service_name}/, backend/shared/' if service_name else 'backend/'}
2. NEVER modify: .env, .github/workflows/*, CLAUDE.md, ai-computer-agent/**
3. NEVER run destructive commands: rm -rf, git push --force, git reset --hard
4. NEVER delete test files to make tests pass — fix the actual code
5. ALWAYS run tests after changes
6. ALWAYS commit with message format: "Fix: <description>"
7. ALWAYS push to branch claude/<service>-fix-<short-desc>
8. ALWAYS create a PR (don't push directly to main)
""")
        parts.append(f"\n## Task\n{task_prompt}")

    return "\n\n".join(parts)


# =============================================================================
# CLAUDE CODE EXECUTION
# =============================================================================


async def run_claude_code(
    prompt: str,
    working_dir: Optional[str] = None,
    timeout_seconds: int = 600,
    service_name: Optional[str] = None,
    allowed_dirs: Optional[List[str]] = None,
    iteration: int = 0,
    previous_issues: Optional[str] = None,
    original_task: Optional[str] = None,
) -> ClaudeCodeResult:
    """
    Run Claude Code with a prompt, including mandate guardrails.

    Args:
        prompt: The task/prompt to send to Claude Code
        working_dir: Directory to run in (defaults to REPO_PATH)
        timeout_seconds: Max time to wait for completion
        service_name: Service being fixed (for mandate scoping)
        allowed_dirs: Directories Claude is allowed to modify
        iteration: Current iteration number
        previous_issues: Description of previous issues
        original_task: Original user request

    Returns:
        ClaudeCodeResult with output and status
    """
    # Build full prompt with mandate
    full_prompt = _build_prompt(
        prompt,
        service_name=service_name,
        allowed_dirs=allowed_dirs,
        iteration=iteration,
        previous_issues=previous_issues,
        original_task=original_task,
    )

    logger.info(f"Running Claude Code (service={service_name}, iter={iteration}): {prompt[:100]}...")

    cwd = working_dir or REPO_PATH

    # T6: Stash uncommitted changes to prevent git switch failures
    try:
        stash_proc = await asyncio.create_subprocess_exec(
            "git", "stash", "--include-untracked",
            cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        await stash_proc.communicate()
    except Exception as e:
        logger.warning(f"git stash failed (non-fatal): {e}")

    process = None  # RL-2: Track process for cleanup
    try:
        try:
            from config import CLAUDE_MODEL
        except ImportError:
            CLAUDE_MODEL = "opus"
        process = await asyncio.create_subprocess_exec(
            *build_claude_cmd(
                CLAUDE_CODE_PATH,
                "--print",
                "--model", CLAUDE_MODEL,
                "--message", full_prompt,
                "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash",
            ),
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
            # Issue 20/21 fix: Call communicate() after kill() to properly reap the process
            process.kill()
            try:
                await asyncio.wait_for(process.communicate(), timeout=5)
            except asyncio.TimeoutError:
                # B4: Explicitly wait for process to prevent zombie
                await process.wait()
            return ClaudeCodeResult(
                success=False,
                output="",
                error=f"Claude Code timed out after {timeout_seconds}s"
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
            error=f"Claude Code not found at {CLAUDE_CODE_PATH}. Install: npm install -g @anthropic-ai/claude-code"
        )
    except Exception as e:
        # RL-2: Clean up process on any exception
        if process is not None and process.returncode is None:
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass  # Best effort cleanup
        return ClaudeCodeResult(
            success=False,
            output="",
            error=str(e)
        )


def extract_pr_number(output: str) -> Optional[int]:
    """Extract PR number from Claude Code output if a PR was created"""
    import re

    patterns = [
        r"PR\s*#(\d+)",
        r"pull request.*#(\d+)",
        r"pull/(\d+)",
        r"github\.com/.*/pull/(\d+)",
        r"Created pull request #(\d+)",
        r"pr create.*#(\d+)",
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
    service_name: str,
    file_path: Optional[str] = None,
    context: Optional[str] = None,
    iteration: int = 0,
) -> ClaudeCodeResult:
    """Ask Claude Code to fix an issue in a specific service."""
    prompt = f"Fix this issue in the {service_name} service: {issue_description}"

    if file_path:
        prompt += f"\n\nFile: {file_path}"
    if context:
        prompt += f"\n\nAdditional context:\n{context}"

    prompt += "\n\nAfter fixing, commit and create a PR."

    return await run_claude_code(
        prompt,
        service_name=service_name,
        iteration=iteration,
    )


async def improve_output(
    service_name: str,
    current_issues: List[str],
    expected_outcome: str,
    iteration: int = 0,
    previous_issues: Optional[str] = None,
) -> ClaudeCodeResult:
    """Ask Claude Code to improve a service's output."""
    issues_text = "\n".join(f"- {issue}" for issue in current_issues)

    prompt = f"""Improve the output of the {service_name} service.

Current issues:
{issues_text}

Expected outcome:
{expected_outcome}

Please:
1. Identify the root cause of these issues in the code
2. Implement fixes
3. Run tests to verify
4. Commit and create a PR

Focus on backend/{service_name}/"""

    return await run_claude_code(
        prompt,
        service_name=service_name,
        iteration=iteration,
        previous_issues=previous_issues,
    )


async def fix_pptx_output(
    issues: List[str],
    pptx_analysis: str,
    service_name: str = "profile-slides",
    iteration: int = 0,
) -> ClaudeCodeResult:
    """Ask Claude Code to fix issues with PowerPoint output."""
    issues_text = "\n".join(f"- {issue}" for issue in issues)

    prompt = f"""Fix the PowerPoint output from the {service_name} service.

Issues found in the output:
{issues_text}

PPT Analysis:
{pptx_analysis}

Please:
1. Find the code that generates the PPT
2. Fix the issues
3. Run tests
4. Commit and create a PR

Look in backend/{service_name}/"""

    return await run_claude_code(
        prompt,
        service_name=service_name,
        iteration=iteration,
    )


async def fix_merge_conflict(
    pr_number: int,
    conflict_files: List[str],
    service_name: Optional[str] = None,
) -> ClaudeCodeResult:
    """Ask Claude Code to resolve merge conflicts."""
    files_text = "\n".join(f"- {f}" for f in conflict_files)

    prompt = f"""Resolve merge conflicts in PR #{pr_number}.

Files with conflicts:
{files_text}

Please:
1. Fetch the PR branch
2. Resolve conflicts (prefer the PR changes unless they break functionality)
3. Commit and push the resolution"""

    return await run_claude_code(prompt, service_name=service_name)


async def fix_ci_failure(
    pr_number: int,
    error_logs: str,
    service_name: Optional[str] = None,
) -> ClaudeCodeResult:
    """Ask Claude Code to fix CI failures."""
    prompt = f"""Fix the CI failure in PR #{pr_number}.

Error logs:
```
{error_logs[:3000]}
```

Please:
1. Analyze the error
2. Fix the underlying issue
3. Commit and push the fix"""

    return await run_claude_code(
        prompt,
        service_name=service_name,
    )


# =============================================================================
# UTILITIES
# =============================================================================


async def check_claude_code_installed() -> bool:
    """Check if Claude Code CLI is installed and accessible"""
    try:
        process = await asyncio.create_subprocess_exec(
            *build_claude_cmd(CLAUDE_CODE_PATH, "--version"),
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
            *build_claude_cmd(CLAUDE_CODE_PATH, "--version"),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await process.communicate()
        return stdout.decode().strip()
    except Exception:
        return None
