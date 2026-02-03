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

from shared.cli_utils import build_claude_cmd, get_claude_code_path, get_repo_cwd, get_subprocess_cwd

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
    git_diff: str = ""


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
7. After changes, commit with message "Fix: <description>" and push to main
8. NEVER push --force to main
""")
        parts.append(f"\n## Task\n{task_prompt}")

    return "\n\n".join(parts)


# =============================================================================
# CLAUDE CODE EXECUTION
# =============================================================================


async def _get_git_head(effective_cwd, wsl_cwd):
    """Get current HEAD commit hash. WSL-aware. Returns hash or empty string."""
    try:
        from shared.cli_utils import is_wsl_mode
        if is_wsl_mode(CLAUDE_CODE_PATH):
            cmd = ["wsl", "--cd", wsl_cwd or effective_cwd, "-e", "git", "rev-parse", "HEAD"]
        else:
            cmd = ["git", "rev-parse", "HEAD"]
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=effective_cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        return stdout.decode().strip() if stdout else ""
    except Exception as e:
        logger.debug(f"_get_git_head failed: {e}")
        return ""


async def _capture_git_diff(effective_cwd, wsl_cwd, pre_head, max_chars=5000):
    """Capture code diff from last commit. Returns stat + truncated diff.
    Returns "" if HEAD hasn't changed since pre_head (no new commit)."""
    try:
        # Check if HEAD changed
        current_head = await _get_git_head(effective_cwd, wsl_cwd)
        if not current_head or current_head == pre_head:
            return ""  # No new commit made

        from shared.cli_utils import is_wsl_mode
        wsl = is_wsl_mode(CLAUDE_CODE_PATH)

        # Get stat summary
        if wsl:
            stat_cmd = ["wsl", "--cd", wsl_cwd or effective_cwd, "-e", "git", "diff", "HEAD~1", "--stat"]
        else:
            stat_cmd = ["git", "diff", "HEAD~1", "--stat"]
        stat_proc = await asyncio.create_subprocess_exec(
            *stat_cmd, cwd=effective_cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stat_out, _ = await asyncio.wait_for(stat_proc.communicate(), timeout=15)
        stat_text = stat_out.decode("utf-8", errors="replace").strip() if stat_out else ""

        # Get full diff
        if wsl:
            diff_cmd = ["wsl", "--cd", wsl_cwd or effective_cwd, "-e", "git", "diff", "HEAD~1"]
        else:
            diff_cmd = ["git", "diff", "HEAD~1"]
        diff_proc = await asyncio.create_subprocess_exec(
            *diff_cmd, cwd=effective_cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        diff_out, _ = await asyncio.wait_for(diff_proc.communicate(), timeout=15)
        diff_text = diff_out.decode("utf-8", errors="replace") if diff_out else ""

        # Truncate with head/tail preservation
        if len(diff_text) > max_chars:
            head_size = max_chars * 3 // 4
            tail_size = max_chars // 4
            diff_text = diff_text[:head_size] + f"\n\n... [{len(diff_text) - max_chars} chars truncated] ...\n\n" + diff_text[-tail_size:]

        parts = []
        if stat_text:
            parts.append(f"### Files changed:\n{stat_text}")
        if diff_text:
            parts.append(f"### Diff:\n{diff_text}")
        return "\n".join(parts) if parts else ""
    except Exception as e:
        return f"(diff capture failed: {e})"


async def run_claude_code(
    prompt: str,
    working_dir: Optional[str] = None,
    timeout_seconds: int = 1200,
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
    # B1 fix: Use get_subprocess_cwd for proper WSL handling
    win_cwd, wsl_cwd = get_subprocess_cwd(CLAUDE_CODE_PATH)
    effective_cwd = working_dir or win_cwd  # Use win_cwd (None in WSL mode)

    # T6/C3 fix: Stash uncommitted changes — WSL-aware
    # F78: Add timeout to git stash to prevent hang
    stash_applied = False
    try:
        from shared.cli_utils import is_wsl_mode
        if is_wsl_mode(CLAUDE_CODE_PATH):
            git_cmd = ["wsl", "--cd", wsl_cwd or cwd, "-e", "git", "stash", "--include-untracked"]
        else:
            git_cmd = ["git", "stash", "--include-untracked"]
        stash_proc = await asyncio.create_subprocess_exec(
            *git_cmd,
            cwd=effective_cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(stash_proc.communicate(), timeout=30)
        stash_output = stdout.decode().strip() if stdout else ""
        # Track if stash actually saved something (vs "No local changes to save")
        stash_applied = "Saved working directory" in stash_output
    except asyncio.TimeoutError:
        logger.warning("git stash timed out after 30s (non-fatal)")
    except Exception as e:
        logger.warning(f"git stash failed (non-fatal): {e}")

    # Capture HEAD before Claude Code runs (for git diff after)
    pre_head = await _get_git_head(effective_cwd, wsl_cwd)

    process = None  # RL-2: Track process for cleanup
    try:
        try:
            from config import CLAUDE_MODEL
        except ImportError:
            CLAUDE_MODEL = "opus"

        # Always pipe prompt via stdin to avoid --allowedTools variadic flag
        # consuming the prompt as a tool name (CLI bug: <tools...> is greedy)
        cmd_args = build_claude_cmd(
            CLAUDE_CODE_PATH,
            "--print",
            "--model", CLAUDE_MODEL,
            "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash",
            "-",  # read prompt from stdin
            wsl_cwd=wsl_cwd or cwd,
        )

        # Give Claude Code 4GB heap to avoid OOM on large prompts
        env = os.environ.copy()
        env["NODE_OPTIONS"] = "--max-old-space-size=4096"

        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            cwd=effective_cwd,  # B1 fix: None in WSL mode to avoid WinError 267
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        process.stdin.write(full_prompt.encode())
        process.stdin.close()

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
            # F12: Restore stash on timeout to prevent changes being lost
            if stash_applied:
                try:
                    from shared.cli_utils import is_wsl_mode
                    if is_wsl_mode(CLAUDE_CODE_PATH):
                        pop_cmd = ["wsl", "--cd", wsl_cwd or cwd, "-e", "git", "stash", "pop"]
                    else:
                        pop_cmd = ["git", "stash", "pop"]
                    pop_proc = await asyncio.create_subprocess_exec(
                        *pop_cmd, cwd=effective_cwd,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    )
                    await asyncio.wait_for(pop_proc.communicate(), timeout=10)
                except Exception:
                    logger.warning("git stash pop failed after timeout (changes may be in stash)")
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

        # F11: Restore stashed changes after Claude Code finishes
        if stash_applied:
            try:
                from shared.cli_utils import is_wsl_mode
                if is_wsl_mode(CLAUDE_CODE_PATH):
                    pop_cmd = ["wsl", "--cd", wsl_cwd or cwd, "-e", "git", "stash", "pop"]
                else:
                    pop_cmd = ["git", "stash", "pop"]
                pop_proc = await asyncio.create_subprocess_exec(
                    *pop_cmd, cwd=effective_cwd,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(pop_proc.communicate(), timeout=30)
            except Exception as e:
                logger.warning(f"git stash pop failed (non-fatal): {e}")

        # Capture git diff if Claude Code committed changes
        git_diff = ""
        if success:
            git_diff = await _capture_git_diff(effective_cwd, wsl_cwd, pre_head)

        return ClaudeCodeResult(
            success=success,
            output=output,
            error=error if error else None,
            pr_number=pr_number,
            git_diff=git_diff,
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

    prompt += "\n\nAfter fixing, commit and push directly to main."

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
4. Commit and push directly to main

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
4. Commit and push directly to main

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
{error_logs[:5000] if len(error_logs) <= 5000 else error_logs[:3000] + '\n...[truncated]...\n' + error_logs[-2000:]}
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
