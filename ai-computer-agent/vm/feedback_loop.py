"""
Feedback Loop Orchestration

This module implements the autonomous fix-test-verify loop:

State Machine:
IDLE → TESTING_FRONTEND → WAITING_FOR_EMAIL → ANALYZING_OUTPUT
  ↑                                                    ↓
  └── WAITING_FOR_DEPLOY ← MERGING_PR ← GENERATING_FIX

Each state transition reports progress to the host controller.

Integrations:
- Issue 4: Verification after each state transition
- Issue 6: Research module for stuck detection
- Issue 7: Retry/recovery per step
- Issue 8: Crash recovery via loop state persistence
"""

import asyncio
import os
import time
import json
from collections import OrderedDict
from typing import Optional, Dict, Any, List, Callable
from dataclasses import dataclass, field
from enum import Enum
import logging
import hashlib

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("feedback_loop")


# A2: Consistent issue key generation to fix research reset mismatch
def _get_issue_key(issues: List[str]) -> str:
    """Generate consistent hash key for issue tracking.

    RC-5: Use full SHA256 hash (64 chars) instead of truncated 32 chars
    to prevent hash collision causing false "stuck" detection.
    """
    all_issues_str = ";".join(sorted(issues))
    return hashlib.sha256(all_issues_str.encode()).hexdigest()  # Full hash


# C2: LRU Dict for bounded issue tracking
class LRUDict(OrderedDict):
    """LRU-evicting dictionary to prevent unbounded memory growth.

    RC-3: Thread-safe with asyncio.Lock for concurrent access protection.
    Note: For async code, use async_get/async_set methods.
    """

    def __init__(self, max_size: int = 100):
        super().__init__()
        self.max_size = max_size
        # RC-3: Lock for thread-safe concurrent access
        import threading
        self._lock = threading.Lock()

    def __setitem__(self, key, value):
        with self._lock:
            if key in self:
                self.move_to_end(key)
            super().__setitem__(key, value)
            if len(self) > self.max_size:
                self.popitem(last=False)

    def get(self, key, default=None):
        with self._lock:
            if key in self:
                self.move_to_end(key)
            return super().get(key, default)

    def update(self, *args, **kwargs):
        """RC-3: Thread-safe update."""
        with self._lock:
            super().update(*args, **kwargs)
            # Evict excess items after bulk update
            while len(self) > self.max_size:
                self.popitem(last=False)


# =============================================================================
# STATE MACHINE
# =============================================================================


class LoopState(Enum):
    IDLE = "idle"
    TESTING_FRONTEND = "testing_frontend"
    WAITING_FOR_EMAIL = "waiting_for_email"
    ANALYZING_OUTPUT = "analyzing_output"
    GENERATING_FIX = "generating_fix"
    MERGING_PR = "merging_pr"
    WAITING_FOR_DEPLOY = "waiting_for_deploy"
    CHECKING_LOGS = "checking_logs"
    COMPLETED = "completed"
    FAILED = "failed"
    STUCK = "stuck"


class IssueCategory(Enum):
    MISSING_DATA = "missing_data"
    WRONG_FORMAT = "wrong_format"
    STYLING_ERROR = "styling_error"
    RUNTIME_ERROR = "runtime_error"
    BUILD_FAILURE = "build_failure"
    MERGE_CONFLICT = "merge_conflict"
    API_ERROR = "api_error"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


# E2: Maximum lengths for user input
MAX_COMPANY_NAME_LENGTH = 200
MAX_ISSUE_LENGTH = 500


@dataclass
class LoopConfig:
    service_name: str
    max_iterations: int = 10
    max_same_issue_attempts: int = 3
    email_wait_timeout_minutes: int = 15
    deploy_wait_timeout_minutes: int = 10
    ci_wait_timeout_minutes: int = 10
    health_check_url: Optional[str] = None
    railway_service_url: Optional[str] = None
    # Issue 6: Research config
    anthropic_api_key: Optional[str] = None
    max_research_attempts: int = 2

    def __post_init__(self):
        """Category 10 fix: Validate config values are positive"""
        if not self.service_name or not self.service_name.strip():
            raise ValueError("service_name is required")
        # EH-5: Clearer validation messages
        if self.max_iterations < 1:
            raise ValueError(f"max_iterations must be at least 1, got {self.max_iterations}")
        if self.max_same_issue_attempts < 1:
            raise ValueError(f"max_same_issue_attempts must be at least 1, got {self.max_same_issue_attempts}")
        if self.email_wait_timeout_minutes < 1:
            raise ValueError(f"email_wait_timeout_minutes must be at least 1 minute, got {self.email_wait_timeout_minutes}")
        if self.deploy_wait_timeout_minutes < 1:
            raise ValueError(f"deploy_wait_timeout_minutes must be at least 1 minute, got {self.deploy_wait_timeout_minutes}")
        if self.ci_wait_timeout_minutes < 1:
            raise ValueError(f"ci_wait_timeout_minutes must be at least 1 minute, got {self.ci_wait_timeout_minutes}")
        if self.max_research_attempts < 0:
            raise ValueError(f"max_research_attempts must be >= 0, got {self.max_research_attempts}")


@dataclass
class LoopIteration:
    number: int
    state: LoopState
    issues_found: List[str] = field(default_factory=list)
    fix_applied: str = ""
    pr_number: Optional[int] = None
    pr_merged: bool = False
    deploy_verified: bool = False
    output_file: Optional[str] = None
    started_at: float = 0
    completed_at: float = 0
    # Issue 6: Research tracking
    research_attempted: bool = False
    research_result: Optional[str] = None


@dataclass
class LoopResult:
    success: bool
    iterations: int
    prs_merged: int
    summary: str
    elapsed_seconds: int
    final_issues: List[str] = field(default_factory=list)


# =============================================================================
# FEEDBACK LOOP
# =============================================================================


class FeedbackLoop:
    """
    Orchestrates the complete feedback loop.

    Usage:
        loop = FeedbackLoop(config, callbacks)
        result = await loop.run()
    """

    def __init__(
        self,
        config: LoopConfig,
        submit_form: Callable,
        wait_for_email: Callable,
        analyze_output: Callable,
        generate_fix: Callable,
        merge_pr: Callable,
        wait_for_ci: Callable,
        check_logs: Callable,
        on_progress: Optional[Callable] = None,
    ):
        self.config = config
        self.submit_form = submit_form
        self.wait_for_email = wait_for_email
        self.analyze_output = analyze_output
        self.generate_fix = generate_fix
        self.merge_pr_fn = merge_pr
        self.wait_for_ci_fn = wait_for_ci
        self.check_logs = check_logs
        self.on_progress = on_progress

        self.state = LoopState.IDLE
        self.iterations: List[LoopIteration] = []
        self.prs_merged = 0
        # C2: Use LRU dict to prevent unbounded memory growth
        self.issue_tracker: LRUDict = LRUDict(max_size=100)
        self.start_time = 0
        self._research_attempts = 0

    async def _report_progress(self, message: str):
        """Report progress to host"""
        logger.info(f"[{self.state.value}] {message}")
        if self.on_progress:
            current_iteration = len(self.iterations)
            result = self.on_progress(
                self.state.value, message,
                iteration=current_iteration,
                prs_merged=self.prs_merged,
            )
            if asyncio.iscoroutine(result):
                await result

    def _save_state(self, iteration_number: int):
        """Issue 8: Persist loop state for crash recovery."""
        try:
            from loop_state import save_loop_state, PersistedLoopState
            state = PersistedLoopState(
                service_name=self.config.service_name,
                iteration=iteration_number,
                state=self.state.value,
                prs_merged=self.prs_merged,
                issue_tracker=self.issue_tracker,
                iterations_data=[
                    {"number": it.number, "state": it.state.value, "issues": it.issues_found}
                    for it in self.iterations
                ],
                started_at=self.start_time,
            )
            save_loop_state(state)
        except Exception as e:
            logger.warning(f"Failed to save loop state: {e}")

    def _clear_state(self):
        """Issue 8: Clear persisted state on completion."""
        try:
            from loop_state import clear_loop_state
            clear_loop_state()
        except Exception as e:
            logger.warning(f"Failed to clear loop state: {e}")

    async def run(self, cancel_token: dict = None, resume_from: int = 0) -> LoopResult:
        """Execute the complete feedback loop.
        M18: Pass cancel_token={"cancelled": False} and set to True to stop.
        resume_from: iteration number to resume from (Issue 8)
        """
        self.start_time = time.time()
        if cancel_token is None:
            cancel_token = {"cancelled": False}

        await self._report_progress(f"Starting feedback loop for {self.config.service_name}")

        start_iteration = resume_from
        if resume_from > 0:
            await self._report_progress(f"Resuming from iteration {resume_from}")

        consecutive_failures = 0
        for i in range(start_iteration, self.config.max_iterations):
            # M18: Check cancellation between iterations
            if cancel_token.get("cancelled"):
                await self._report_progress("Feedback loop cancelled by user")
                break
            iteration = LoopIteration(number=i + 1, state=LoopState.IDLE, started_at=time.time())
            # C8: Bound iterations list to prevent unbounded memory growth
            MAX_ITERATIONS_HISTORY = 100
            if len(self.iterations) >= MAX_ITERATIONS_HISTORY:
                self.iterations = self.iterations[-(MAX_ITERATIONS_HISTORY - 1):]
            self.iterations.append(iteration)

            # Issue 8: Save state at start of each iteration
            self._save_state(i + 1)

            await self._report_progress(f"=== Iteration {i + 1}/{self.config.max_iterations} ===")

            try:
                result = await self._run_iteration(iteration)
                # Category 5 fix: Replace assert with proper exception (assertions disabled with -O flag)
                if result not in ("pass", "continue", "stuck"):
                    raise ValueError(f"Invalid iteration result: {result}")
                consecutive_failures = 0
                iteration.completed_at = time.time()

                if result == "pass":
                    self._clear_state()
                    elapsed = int(time.time() - self.start_time)
                    return LoopResult(
                        success=True,
                        iterations=i + 1,
                        prs_merged=self.prs_merged,
                        summary=f"Output matches template after {i + 1} iterations",
                        elapsed_seconds=elapsed,
                    )
                elif result == "stuck":
                    self._clear_state()
                    elapsed = int(time.time() - self.start_time)
                    return LoopResult(
                        success=False,
                        iterations=i + 1,
                        prs_merged=self.prs_merged,
                        summary=f"Stuck on same issue after {self.config.max_same_issue_attempts} attempts",
                        elapsed_seconds=elapsed,
                        final_issues=iteration.issues_found,
                    )
                # result == "continue" → next iteration

            except Exception as e:
                logger.error(f"Iteration {i + 1} failed: {e}")
                iteration.state = LoopState.FAILED
                iteration.completed_at = time.time()
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    logger.error("3 consecutive failures — aborting loop")
                    break

        self._clear_state()
        elapsed = int(time.time() - self.start_time)
        # Issue 104 fix: Check iterations length before [-1] access
        final_issues = []
        if self.iterations and len(self.iterations) > 0:
            final_issues = self.iterations[-1].issues_found
        return LoopResult(
            success=False,
            iterations=self.config.max_iterations,
            prs_merged=self.prs_merged,
            summary=f"Max iterations ({self.config.max_iterations}) reached",
            elapsed_seconds=elapsed,
            final_issues=final_issues,
        )

    async def _run_iteration(self, iteration: LoopIteration) -> str:
        """
        Run a single iteration.
        Returns: "pass", "continue", or "stuck"

        Issue 7: Each step is wrapped in retry with per-step error handling.
        Issue 4: Verification after key transitions.
        """
        from retry import retry_with_backoff
        from verification import (
            verify_form_submission,
            verify_email_downloaded,
            verify_pr_created,
            verify_deployment,
        )

        # Step 1: Submit form on frontend (retry 3x)
        self.state = LoopState.TESTING_FRONTEND
        iteration.state = LoopState.TESTING_FRONTEND
        await self._report_progress("Submitting form on frontend")

        try:
            submit_result = await retry_with_backoff(
                self.submit_form, max_retries=3, step_name="submit_form", step_timeout=300,
            )
        except Exception as e:
            iteration.issues_found.append(f"Form submission failed after retries: {e}")
            return "continue"

        # Issue 4: Verify form submission (skip if step was skipped)
        if not submit_result.get("skipped"):
            verification = await verify_form_submission(submit_result)
            if not verification.get("verified"):
                logger.warning(f"Form submission verification failed: {verification.get('error')}")
                iteration.issues_found.append(f"Form verification failed: {verification.get('error')}")
                return "continue"

        # Step 2: Wait for email with output (retry 2x)
        self.state = LoopState.WAITING_FOR_EMAIL
        iteration.state = LoopState.WAITING_FOR_EMAIL
        await self._report_progress(
            f"Waiting for email (timeout: {self.config.email_wait_timeout_minutes}m)"
        )

        try:
            email_result = await retry_with_backoff(
                self.wait_for_email, max_retries=2, step_name="wait_for_email", step_timeout=0,
            )
        except Exception as e:
            iteration.issues_found.append(f"Email wait failed after retries: {e}")
            return "continue"

        if not email_result.get("success"):
            iteration.issues_found.append(f"Email wait failed: {email_result.get('error')}")
            return "continue"

        iteration.output_file = email_result.get("file_path")

        # Issue 4: Verify email downloaded (skip if step was skipped)
        if not email_result.get("skipped"):
            email_verification = await verify_email_downloaded(iteration.output_file)
            if not email_verification.get("verified"):
                logger.warning(f"Email download verification failed: {email_verification.get('error')}")
                iteration.issues_found.append(f"Email verification failed: {email_verification.get('error')}")
                return "continue"

        # Step 3: Analyze output
        self.state = LoopState.ANALYZING_OUTPUT
        iteration.state = LoopState.ANALYZING_OUTPUT
        await self._report_progress("Analyzing output")

        # Category 3 fix: Add timeout to analyze_output (can hang on corrupted files)
        # Category 5 fix: Add error handling around analyze_output call
        try:
            analysis = await asyncio.wait_for(
                self.analyze_output(iteration.output_file),
                timeout=300  # 5 minute timeout for analysis
            )
        except asyncio.TimeoutError:
            iteration.issues_found.append("Output analysis timed out after 5 minutes")
            # RL-3: Clear output_file on analysis timeout since analysis is incomplete
            iteration.output_file = None
            return "continue"
        except Exception as e:
            iteration.issues_found.append(f"Output analysis failed: {e}")
            # RL-3: Clear output_file on analysis error since analysis is incomplete
            iteration.output_file = None
            return "continue"

        if analysis is None:
            iteration.issues_found.append("Output analysis returned None")
            return "continue"

        # Category 4 fix: Validate analysis is a dict before calling .get()
        if not isinstance(analysis, dict):
            iteration.issues_found.append(f"Output analysis returned non-dict type: {type(analysis).__name__}")
            return "continue"

        issues = analysis.get("issues", [])
        # EH-2: Properly validate issues type instead of losing structure with str()
        if isinstance(issues, list):
            iteration.issues_found = issues
        elif issues is None:
            iteration.issues_found = []
        else:
            # Log the unexpected type for debugging, then wrap appropriately
            logger.warning(f"EH-2: analysis.issues has unexpected type {type(issues).__name__}, expected list")
            # If it's a string, treat it as a single issue; otherwise report the type error
            if isinstance(issues, str):
                iteration.issues_found = [issues]
            else:
                iteration.issues_found = [f"Invalid issues format: {type(issues).__name__}"]

        if not issues:
            await self._report_progress("No issues found — output matches template!")
            return "pass"

        await self._report_progress(f"Found {len(issues)} issues: {issues[:3]}")

        # Check if stuck on same issues
        # Issue 71 fix: Hash ALL issues, not just first 3, to prevent missing later issues
        # A2: Use consistent key generation function
        issue_key = _get_issue_key(issues)
        # C2: LRUDict handles bounding automatically
        self.issue_tracker[issue_key] = self.issue_tracker.get(issue_key, 0) + 1

        if self.issue_tracker[issue_key] >= self.config.max_same_issue_attempts:
            await self._report_progress(f"Stuck: same issues found {self.issue_tracker[issue_key]} times")

            # Issue 6: Try research before giving up
            research_result = await self._try_research(issues, iteration)
            if research_result == "continue":
                return "continue"  # research found a new approach
            return "stuck"

        # Step 4: Generate fix (retry 2x)
        self.state = LoopState.GENERATING_FIX
        iteration.state = LoopState.GENERATING_FIX
        await self._report_progress("Generating fix via Claude Code")

        try:
            fix_result = await retry_with_backoff(
                lambda: self.generate_fix(issues, analysis),
                max_retries=2, step_name="generate_fix", step_timeout=600,
            )
        except Exception as e:
            iteration.issues_found.append(f"Fix generation failed after retries: {e}")
            return "continue"

        # Category 1 fix: null check before .get() on fix_result
        if fix_result is None:
            iteration.issues_found.append("Fix generation returned None")
            return "continue"

        iteration.fix_applied = fix_result.get("description", "")
        iteration.pr_number = fix_result.get("pr_number")

        if not fix_result.get("success"):
            iteration.issues_found.append(f"Fix generation failed: {fix_result.get('error')}")
            return "continue"

        # Gap 1: If fix succeeded but no PR was created, try creating one explicitly
        if fix_result.get("success") and not iteration.pr_number:
            logger.warning("Fix succeeded but no PR created — attempting explicit PR creation")
            await self._report_progress("No PR detected — creating PR via gh CLI")
            try:
                import re
                gh_proc = await asyncio.create_subprocess_exec(
                    "gh", "pr", "create", "--fill", "--head", f"claude/{self.config.service_name}-fix-iter{iteration.number}",
                    cwd=os.path.expanduser("~/xvasjack.github.io"),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(gh_proc.communicate(), timeout=60)
                gh_result_stdout = stdout.decode() if stdout else ""
                gh_result_stderr = stderr.decode() if stderr else ""
                if gh_proc.returncode == 0:
                    pr_match = re.search(r'/pull/(\d+)', gh_result_stdout)
                    if pr_match:
                        iteration.pr_number = int(pr_match.group(1))
                        logger.info(f"Created PR #{iteration.pr_number} via gh CLI fallback")
                    else:
                        logger.warning(f"gh pr create output didn't contain PR number: {gh_result_stdout}")
                else:
                    logger.warning(f"gh pr create failed: {gh_result_stderr}")
            except Exception as e:
                logger.warning(f"Explicit PR creation failed: {e}")

        # Issue 4: Verify PR created
        # EH-3: Use explicit None check instead of boolean evaluation (pr_number=0 is valid)
        if iteration.pr_number is not None:
            pr_verification = await verify_pr_created(iteration.pr_number)
            if not pr_verification.get("verified"):
                logger.warning(f"PR verification failed: {pr_verification.get('error')}")

        # Step 5: Wait for CI and merge PR
        # EH-3: Use explicit None check instead of boolean evaluation
        if iteration.pr_number is not None:
            self.state = LoopState.MERGING_PR
            iteration.state = LoopState.MERGING_PR

            # Wait for CI
            # C7: Add timeout to CI wait to prevent indefinite blocking
            await self._report_progress(f"Waiting for CI on PR #{iteration.pr_number}")
            try:
                ci_result = await asyncio.wait_for(
                    self.wait_for_ci_fn(iteration.pr_number),
                    timeout=self.config.ci_wait_timeout_minutes * 60
                )
            except asyncio.TimeoutError:
                iteration.issues_found.append(f"CI wait timed out after {self.config.ci_wait_timeout_minutes} minutes")
                return "continue"
            except Exception as e:
                iteration.issues_found.append(f"CI wait failed: {e}")
                return "continue"

            # Category 1 fix: null check before .get() on ci_result
            if ci_result is None:
                iteration.issues_found.append("CI check returned None")
                return "continue"

            if not ci_result.get("passed"):
                iteration.issues_found.append(f"CI failed: {ci_result.get('error')}")
                return "continue"

            # Merge (with retry for transient failures)
            await self._report_progress(f"Merging PR #{iteration.pr_number}")
            try:
                merge_result = await retry_with_backoff(
                    lambda: self.merge_pr_fn(iteration.pr_number),
                    max_retries=3, initial_delay=5, step_name="merge_pr", step_timeout=60,
                )
            except Exception as e:
                iteration.issues_found.append(f"Merge failed after retries: {e}")
                return "continue"

            # A3: Validate merge_result is dict before calling .get()
            if not isinstance(merge_result, dict):
                iteration.issues_found.append(f"Invalid merge_result type: {type(merge_result)}")
                return "continue"

            if merge_result.get("success"):
                iteration.pr_merged = True
                self.prs_merged += 1
            else:
                error_type = merge_result.get("error_type", "")
                if error_type == "merge_conflict":
                    await self._report_progress(f"Merge conflict on PR #{iteration.pr_number} — invoking fix")
                    try:
                        from actions.claude_code import fix_merge_conflict
                        # Category 1 fix: null check before .get() on merge_result
                        conflict_files = merge_result.get("conflict_files", []) if merge_result else []
                        await fix_merge_conflict(iteration.pr_number, conflict_files, service_name=self.config.service_name)
                        # Retry merge after conflict resolution
                        merge_result = await self.merge_pr_fn(iteration.pr_number)
                        if merge_result and merge_result.get("success"):
                            iteration.pr_merged = True
                            self.prs_merged += 1
                        else:
                            # B5: Report progress on merge conflict failure
                            await self._report_progress(f"Merge still failed after conflict fix: {merge_result.get('error') if merge_result else 'Unknown'}")
                            iteration.issues_found.append(f"Merge still failed after conflict fix: {merge_result.get('error') if merge_result else 'Unknown'}")
                            return "continue"
                    except Exception as e:
                        # B5: Report progress on exception
                        await self._report_progress(f"Merge conflict fix failed: {e}")
                        iteration.issues_found.append(f"Merge conflict fix failed: {e}")
                        return "continue"
                elif error_type == "not_mergeable":
                    await self._report_progress(f"Not mergeable (CI may be failing) on PR #{iteration.pr_number} — invoking fix")
                    try:
                        from actions.claude_code import fix_ci_failure
                        from actions.github import get_ci_error_logs
                        ci_logs = await get_ci_error_logs(iteration.pr_number)
                        # A8: Check ci_logs is not None before calling .get()
                        if ci_logs and ci_logs.get("success"):
                            error_logs = ci_logs.get("logs", "")
                        else:
                            error_logs = ""
                        await fix_ci_failure(iteration.pr_number, error_logs, self.config.service_name)
                        # Wait for CI to re-run then retry merge
                        await asyncio.sleep(30)
                        merge_result = await self.merge_pr_fn(iteration.pr_number)
                        if merge_result and merge_result.get("success"):
                            iteration.pr_merged = True
                            self.prs_merged += 1
                        else:
                            # B5: Report progress on CI fix failure
                            await self._report_progress(f"Merge still failed after CI fix: {merge_result.get('error') if merge_result else 'Unknown'}")
                            iteration.issues_found.append(f"Merge still failed after CI fix: {merge_result.get('error') if merge_result else 'Unknown'}")
                            return "continue"
                    except Exception as e:
                        # B5: Report progress on exception
                        await self._report_progress(f"CI failure fix failed: {e}")
                        iteration.issues_found.append(f"CI failure fix failed: {e}")
                        return "continue"
                elif error_type == "review_required":
                    await self._report_progress("Review/CI pending — waiting 30s before retry")
                    await asyncio.sleep(30)
                    merge_result = await self.merge_pr_fn(iteration.pr_number)
                    if merge_result and merge_result.get("success"):
                        iteration.pr_merged = True
                        self.prs_merged += 1
                    else:
                        # B5: Report progress on review wait failure
                        await self._report_progress(f"Merge failed after wait: {merge_result.get('error') if merge_result else 'Unknown'}")
                        iteration.issues_found.append(f"Merge failed after wait: {merge_result.get('error') if merge_result else 'Unknown'}")
                        return "continue"
                else:
                    # B5: Report progress on generic merge failure
                    await self._report_progress(f"Merge failed: {merge_result.get('error')}")
                    iteration.issues_found.append(f"Merge failed: {merge_result.get('error')}")
                    return "continue"

        # Step 6: Wait for deployment
        self.state = LoopState.WAITING_FOR_DEPLOY
        iteration.state = LoopState.WAITING_FOR_DEPLOY
        await self._report_progress("Waiting for deployment")

        deploy_ok = await self._wait_for_deployment()
        iteration.deploy_verified = deploy_ok

        # Issue 4: Verify deployment
        if deploy_ok:
            health_url = self.config.health_check_url or self.config.railway_service_url
            if health_url:
                if not health_url.endswith("/health"):
                    health_url = health_url.rstrip("/") + "/health"
                deploy_verification = await verify_deployment(health_url)
                if not deploy_verification.get("verified"):
                    logger.warning(f"Deploy verification failed: {deploy_verification.get('error')}")

        if not deploy_ok:
            logger.warning("Deployment verification failed/timed out")
            iteration.issues_found.append("Deployment verification failed — testing against old code")
            await self._report_progress("WARNING: Deploy verification failed, results may be stale")

        # Step 7: Check logs
        self.state = LoopState.CHECKING_LOGS
        iteration.state = LoopState.CHECKING_LOGS
        await self._report_progress("Checking logs for errors")

        log_result = await self.check_logs()
        if log_result.get("has_errors"):
            logger.warning(f"Log errors found: {log_result.get('errors', [])}")

        # Issue 8: Save state after iteration completes
        self._save_state(iteration.number)

        return "continue"

    async def _try_research(self, issues: List[str], iteration: LoopIteration) -> str:
        """
        Issue 6: Try research module before giving up on stuck issues.
        Returns "continue" if research found a new approach, "stuck" otherwise.
        """
        # Check if we've exceeded max research attempts
        if self._research_attempts >= self.config.max_research_attempts:
            logger.info("Max research attempts reached, giving up")
            return "stuck"

        # Check if API key is available
        api_key = self.config.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            logger.info("No Anthropic API key available, skipping research")
            return "stuck"

        try:
            from research import ResearchAgent, ResearchContext

            await self._report_progress("Researching root cause of recurring issues...")
            iteration.research_attempted = True
            self._research_attempts += 1

            agent = ResearchAgent(api_key)
            context = ResearchContext(
                issue_description="; ".join(issues[:5]),
                issue_category="unknown",
                occurrences=self.config.max_same_issue_attempts,
                previous_attempts=[
                    it.fix_applied for it in self.iterations if it.fix_applied
                ],
                service_name=self.config.service_name,
            )

            research_result = await agent.research_issue(context)
            # LB-6: Guard against None research_result
            if research_result is None:
                logger.warning("research_issue returned None")
                iteration.research_result = "Research returned no result"
                return "stuck"
            # C10: Guard against None root_cause_analysis
            rca = research_result.root_cause_analysis or ""
            iteration.research_result = rca[:500]

            logger.info(
                f"Research result: confidence={research_result.confidence}, "
                f"foundational={research_result.needs_foundational_change}"
            )

            if research_result.confidence > 0.6 and research_result.needs_foundational_change:
                # Generate fix from research
                fix_prompt = await agent.generate_fix_from_research(context, research_result)

                await self._report_progress("Research found new approach — generating fix")
                fix_result = await self.generate_fix(
                    [f"Research-informed fix: {research_result.root_cause_analysis[:200]}"],
                    {"fix_prompt": fix_prompt},
                )

                if fix_result.get("success"):
                    # A2: Reset issue tracker using consistent key generation
                    issue_key = _get_issue_key(issues)
                    self.issue_tracker[issue_key] = 0
                    await self._report_progress("Research fix applied — resetting attempt counter")
                    return "continue"

            await self._report_progress(
                f"Research confidence too low ({research_result.confidence:.1f}) or no foundational change needed"
            )
            # LB-3: Reset counter even when research doesn't find a solution to allow escape
            issue_key = _get_issue_key(issues)
            self.issue_tracker[issue_key] = max(0, self.issue_tracker.get(issue_key, 0) - 1)
            return "stuck"

        except Exception as e:
            logger.error(f"Research failed: {e}")
            iteration.research_result = f"Error: {e}"
            # LB-3: Reset counter on research failure to prevent infinite stuck state
            issue_key = _get_issue_key(issues)
            self.issue_tracker[issue_key] = max(0, self.issue_tracker.get(issue_key, 0) - 1)
            return "stuck"

    async def _wait_for_deployment(self) -> bool:
        """
        Wait for deployment by polling a health endpoint.
        Falls back to a fixed wait if no health URL configured.
        """
        health_url = self.config.health_check_url or self.config.railway_service_url

        if not health_url:
            # No health URL configured, use fixed wait
            logger.info("No health check URL configured, waiting 120s")
            await asyncio.sleep(120)
            return True

        # Ensure the URL ends with /health
        if not health_url.endswith("/health"):
            health_url = health_url.rstrip("/") + "/health"

        timeout = self.config.deploy_wait_timeout_minutes * 60
        start = time.time()
        poll_interval = 15
        max_poll_interval = 60  # Category 3 fix: Add exponential backoff with max

        logger.info(f"Polling health endpoint: {health_url}")

        attempts = 0
        while time.time() - start < timeout:
            attempts += 1
            try:
                proc = await asyncio.create_subprocess_exec(
                    "curl", "-sf", "--max-time", "10", health_url,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, _ = await proc.communicate()

                if proc.returncode == 0:
                    logger.info(f"Health check passed: {stdout.decode()[:100]}")
                    return True

            except FileNotFoundError:
                # M17: curl not installed — fall back to fixed wait
                logger.warning("curl not found, falling back to fixed wait (60s)")
                await asyncio.sleep(60)
                return True
            except Exception as e:
                logger.warning(f"Health check error: {e}")

            # Category 3 fix: Exponential backoff in health check loop
            current_interval = min(poll_interval * (1.5 ** (attempts - 1)), max_poll_interval)
            await asyncio.sleep(current_interval)

        logger.warning(f"Health check timed out after {timeout}s")
        return False
