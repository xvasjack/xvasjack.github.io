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
    F51: Normalize issues (strip, lowercase) to prevent same bug retried forever
    due to trivial formatting differences.
    """
    normalized = [i.strip().lower() for i in issues if i]
    all_issues_str = ";".join(sorted(normalized))
    return hashlib.sha256(all_issues_str.encode()).hexdigest()  # Full hash


# C2: LRU Dict for bounded issue tracking
class LRUDict(OrderedDict):
    """LRU-evicting dictionary to prevent unbounded memory growth.
    
    C5 fix: Removed threading.Lock — access pattern is single-coroutine sequential.
    threading.Lock blocks the event loop instead of yielding.
    """

    def __init__(self, max_size: int = 100):
        super().__init__()
        self.max_size = max_size

    def __setitem__(self, key, value):
        if key in self:
            self.move_to_end(key)
        super().__setitem__(key, value)
        if len(self) > self.max_size:
            self.popitem(last=False)

    def get(self, key, default=None):
        if key in self:
            self.move_to_end(key)
        return super().get(key, default)

    def update(self, *args, **kwargs):
        super().update(*args, **kwargs)
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
    email_wait_timeout_minutes: int = 65
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
            # 3.6: Use inspect.isawaitable for broader check (covers coroutines, tasks, futures)
            import inspect
            if inspect.isawaitable(result):
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
                issue_tracker=dict(self.issue_tracker),  # C14 fix: convert LRUDict to plain dict for JSON serialization
                iterations_data=[
                    {"number": it.number, "state": it.state.value, "issues": it.issues_found}
                    for it in self.iterations
                ],
                started_at=self.start_time,
            )
            save_loop_state(state)
        except Exception as e:
            # F56: Upgrade to error — state loss means no crash recovery
            logger.error(f"Failed to save loop state: {e}")

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
        # F8: Track actual iteration count, not max_iterations
        actual_iterations = len(self.iterations)
        return LoopResult(
            success=False,
            iterations=actual_iterations,
            prs_merged=self.prs_merged,
            summary=f"Max iterations ({actual_iterations}/{self.config.max_iterations}) reached",
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
        await self._report_progress("[Stage 1/7] Submitting form on frontend...")

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
            f"[Stage 2/7] Waiting for email result (timeout: {self.config.email_wait_timeout_minutes}m)..."
        )

        try:
            # B8 fix: Pass explicit timeout instead of 0 (which gets clamped to 30s)
            email_result = await retry_with_backoff(
                self.wait_for_email, max_retries=2, step_name="wait_for_email",
                step_timeout=self.config.email_wait_timeout_minutes * 60,
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
        await self._report_progress("[Stage 3/7] Analyzing output against template...")

        # Category 3 fix: Add timeout to analyze_output (can hang on corrupted files)
        # Category 5 fix: Add error handling around analyze_output call
        # F45: Retry analysis up to 2 times for transient failures
        analysis = None
        for _analysis_attempt in range(2):
            try:
                analysis = await asyncio.wait_for(
                    self.analyze_output(iteration.output_file),
                    timeout=300  # 5 minute timeout for analysis
                )
                break  # Success
            except asyncio.TimeoutError:
                if _analysis_attempt == 1:
                    iteration.issues_found.append("Output analysis timed out after 5 minutes (2 attempts)")
                    iteration.output_file = None
                    return "continue"
                logger.warning("Analysis timed out, retrying...")
            except Exception as e:
                if _analysis_attempt == 1:
                    iteration.issues_found.append(f"Output analysis failed: {e}")
                    iteration.output_file = None
                    return "continue"
                logger.warning(f"Analysis failed ({e}), retrying...")

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

        if analysis.get("passed", not issues):
            # Template says output passes — log non-critical issues but don't loop
            if issues:
                await self._report_progress(f"[PASS] Output matches template (with {len(issues)} non-critical notes)")
            else:
                await self._report_progress("[PASS] No issues found — output matches template!")
            return "pass"

        await self._report_progress(f"[ISSUES] Found {len(issues)} issue(s): {'; '.join(str(i) for i in issues[:3])}")

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
        await self._report_progress("[Stage 4/7] Generating fix via Claude Code (up to 20 min)...")

        try:
            fix_result = await retry_with_backoff(
                lambda: self.generate_fix(issues, analysis),
                max_retries=2, step_name="generate_fix", step_timeout=1200,
            )
        except Exception as e:
            logger.error(f"Fix generation FAILED (exception): {e}")
            await self._report_progress(f"[Stage 4/7] Fix FAILED (exception): {str(e)[:200]}")
            iteration.issues_found.append(f"Fix generation failed after retries: {e}")
            return "continue"

        # Category 1 fix: null check before .get() on fix_result
        if fix_result is None:
            logger.error("Fix generation FAILED: returned None")
            await self._report_progress("[Stage 4/7] Fix FAILED: returned None")
            iteration.issues_found.append("Fix generation returned None")
            return "continue"

        logger.info(f"Fix result: success={fix_result.get('success')}, error={(fix_result.get('error') or 'none')[:200]}")

        iteration.fix_applied = fix_result.get("description", "")
        iteration.pr_number = fix_result.get("pr_number")

        if not fix_result.get("success"):
            error_msg = fix_result.get('error') or 'unknown error'
            logger.error(f"Fix generation FAILED: {error_msg}")
            await self._report_progress(f"[Stage 4/7] Fix FAILED: {str(error_msg)[:200]}")
            iteration.issues_found.append(f"Fix generation failed: {error_msg}")
            return "continue"

        # Step 5: Verify push succeeded (push-to-main flow, no PRs)
        # F7/F13: Track whether code was actually pushed
        code_pushed = fix_result.get("success") and fix_result.get("description")
        if code_pushed:
            await self._report_progress("Fix committed and pushed to main")
            self.prs_merged += 1  # Track as "changes deployed" for stats
        else:
            logger.warning("Fix generation did not produce a push — skipping deploy wait")

        # Step 6: Wait for deployment (only if code was pushed)
        # F7/F13: Skip deploy wait if no code was pushed
        if code_pushed:
            self.state = LoopState.WAITING_FOR_DEPLOY
            iteration.state = LoopState.WAITING_FOR_DEPLOY
            await self._report_progress("[Stage 5/7] Waiting for Railway deployment...")

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
        else:
            iteration.deploy_verified = False

        # Step 7: Check logs (F6: add timeout + try/except)
        self.state = LoopState.CHECKING_LOGS
        iteration.state = LoopState.CHECKING_LOGS
        await self._report_progress("[Stage 6/7] Checking logs for runtime errors...")

        try:
            log_result = await asyncio.wait_for(self.check_logs(), timeout=120)
        except asyncio.TimeoutError:
            logger.warning("Log check timed out after 120s")
            log_result = {"has_errors": False, "errors": [], "logs": "Log check timed out"}
        except Exception as e:
            logger.warning(f"Log check failed: {e}")
            log_result = {"has_errors": False, "errors": [], "logs": f"Log check error: {e}"}
        if log_result.get("has_errors"):
            logger.warning(f"Log errors found: {log_result.get('errors', [])}")

        # Issue 8: Save state after iteration completes
        self._save_state(iteration.number)

        await self._report_progress("[Stage 7/7] Iteration complete — looping back to retest...")
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
            # F54: No health URL configured, use shorter fixed wait
            logger.info("No health check URL configured, waiting 30s for Railway deploy")
            await asyncio.sleep(30)
            return True

        # Ensure the URL ends with /health
        if not health_url.endswith("/health"):
            health_url = health_url.rstrip("/") + "/health"

        timeout = self.config.deploy_wait_timeout_minutes * 60
        start = time.time()
        poll_interval = 15
        max_poll_interval = 60  # Category 3 fix: Add exponential backoff with max

        logger.info(f"Polling health endpoint: {health_url}")

        # Railway deploy sequence: old container serves 200 → old killed → new starts → new serves 200
        # A single 200 might hit the OLD container. We need to:
        # 1. Wait for initial 200 (may be old or new container)
        # 2. Wait 30s for Railway to kill old container and start new one
        # 3. Confirm 200 again (must be new container now)
        SETTLE_WAIT = 30  # seconds between first and second health check

        attempts = 0
        while time.time() - start < timeout:
            attempts += 1
            try:
                # F55: Use -sS -w to capture HTTP status instead of -sf suppressing errors
                proc = await asyncio.create_subprocess_exec(
                    "curl", "-sS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", health_url,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await proc.communicate()
                http_code = stdout.decode().strip() if stdout else ""

                if proc.returncode == 0 and http_code.startswith("2"):
                    logger.info(f"Health check passed: HTTP {http_code} — waiting {SETTLE_WAIT}s for deploy to settle...")
                    await asyncio.sleep(SETTLE_WAIT)

                    # Second health check to confirm new container is serving
                    proc2 = await asyncio.create_subprocess_exec(
                        "curl", "-sS", "--max-time", "10", "-o", "/dev/null", "-w", "%{http_code}", health_url,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout2, stderr2 = await proc2.communicate()
                    http_code2 = stdout2.decode().strip() if stdout2 else ""

                    if proc2.returncode == 0 and http_code2.startswith("2"):
                        logger.info(f"Health check confirmed after settle: HTTP {http_code2} — deploy fully ready")
                        return True
                    else:
                        # Old container was killed during settle wait — new one not ready yet, keep polling
                        logger.warning(f"Health check failed after settle wait: HTTP {http_code2} — container likely restarting")
                else:
                    logger.warning(f"Health check: HTTP {http_code}, stderr={stderr.decode()[:200] if stderr else ''}")

            except FileNotFoundError:
                # H14 fix: Return False (unknown) instead of True when curl not found
                logger.warning("curl not found — cannot verify deployment")
                return False
            except Exception as e:
                logger.warning(f"Health check error: {e}")

            # Category 3 fix: Exponential backoff in health check loop
            current_interval = min(poll_interval * (1.5 ** (attempts - 1)), max_poll_interval)
            await asyncio.sleep(current_interval)

        logger.warning(f"Health check timed out after {timeout}s")
        return False
