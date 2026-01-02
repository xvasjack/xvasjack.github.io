"""
Feedback Loop Manager

The core orchestrator that runs the autonomous feedback loop:
1. Test product on frontend
2. Wait for output email
3. Download and analyze output
4. Compare against template
5. Generate fix comments for Claude Code
6. Merge PR (or handle errors)
7. Wait for deployment
8. Repeat until satisfied OR escalate if stuck

STUCK DETECTION:
- Tracks recurring issues across iterations
- If same issue persists after N attempts, escalates
- Escalation = research + suggest foundational changes
"""

import asyncio
import json
import time
import hashlib
from typing import List, Dict, Any, Optional, Callable
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("feedback_loop")


class LoopState(Enum):
    IDLE = "idle"
    TESTING_FRONTEND = "testing_frontend"
    WAITING_FOR_EMAIL = "waiting_for_email"
    ANALYZING_OUTPUT = "analyzing_output"
    GENERATING_FIX = "generating_fix"
    WAITING_FOR_PR = "waiting_for_pr"
    MERGING_PR = "merging_pr"
    HANDLING_MERGE_ERROR = "handling_merge_error"
    WAITING_FOR_DEPLOY = "waiting_for_deploy"
    CHECKING_LOGS = "checking_logs"
    STUCK_RESEARCHING = "stuck_researching"
    COMPLETED = "completed"
    FAILED = "failed"


class IssueCategory(Enum):
    OUTPUT_QUALITY = "output_quality"      # Missing data, wrong format
    CODE_ERROR = "code_error"              # Runtime errors, exceptions
    MERGE_CONFLICT = "merge_conflict"      # Git conflicts
    CI_FAILURE = "ci_failure"              # Tests failing
    DEPLOY_FAILURE = "deploy_failure"      # Railway errors
    API_ERROR = "api_error"                # External API issues
    TIMEOUT = "timeout"                    # Operations timing out
    UNKNOWN = "unknown"


@dataclass
class Issue:
    """A tracked issue across iterations"""
    id: str  # Hash of issue signature
    category: IssueCategory
    description: str
    first_seen: datetime
    occurrences: int = 1
    iterations_seen: List[int] = field(default_factory=list)
    attempted_fixes: List[str] = field(default_factory=list)
    resolved: bool = False

    def signature(self) -> str:
        """Create unique signature for this issue type"""
        return f"{self.category.value}:{self.description[:100]}"


@dataclass
class LoopIteration:
    """Record of a single iteration through the loop"""
    number: int
    started_at: datetime
    completed_at: Optional[datetime] = None
    state_history: List[str] = field(default_factory=list)
    issues_found: List[str] = field(default_factory=list)  # Issue IDs
    pr_number: Optional[int] = None
    output_file: Optional[str] = None
    comparison_result: Optional[Dict] = None
    success: bool = False
    notes: str = ""


@dataclass
class LoopConfig:
    """Configuration for the feedback loop"""
    service_name: str  # e.g., "target-v6"
    template_name: str  # e.g., "target-search"
    test_input: Dict[str, Any]  # Frontend form data

    max_iterations: int = 10
    max_duration_minutes: int = 180

    # Timing
    email_timeout_minutes: int = 15
    deploy_wait_seconds: int = 60
    ci_timeout_minutes: int = 10

    # Stuck detection
    max_same_issue_attempts: int = 3  # Escalate after this many attempts
    issue_similarity_threshold: float = 0.8  # How similar issues need to be

    # Quality thresholds
    min_pass_rate: float = 0.9  # 90% of checks must pass
    allow_high_severity_issues: bool = False  # Fail if any HIGH issues


class FeedbackLoopManager:
    """
    Manages the autonomous feedback loop.

    Usage:
        loop = FeedbackLoopManager(config)
        result = await loop.run()
    """

    def __init__(self, config: LoopConfig):
        self.config = config
        self.state = LoopState.IDLE
        self.iterations: List[LoopIteration] = []
        self.issues: Dict[str, Issue] = {}  # id -> Issue
        self.started_at: Optional[datetime] = None
        self.completed_at: Optional[datetime] = None

        # Callbacks for actions (set by agent)
        self.on_test_frontend: Optional[Callable] = None
        self.on_download_email: Optional[Callable] = None
        self.on_analyze_output: Optional[Callable] = None
        self.on_send_to_claude_code: Optional[Callable] = None
        self.on_merge_pr: Optional[Callable] = None
        self.on_get_logs: Optional[Callable] = None
        self.on_research: Optional[Callable] = None
        self.on_status_update: Optional[Callable] = None

    def _issue_id(self, category: IssueCategory, description: str) -> str:
        """Generate unique ID for an issue"""
        sig = f"{category.value}:{description[:100]}"
        return hashlib.md5(sig.encode()).hexdigest()[:12]

    def _track_issue(
        self,
        category: IssueCategory,
        description: str,
        iteration: int
    ) -> Issue:
        """Track an issue, updating if seen before"""
        issue_id = self._issue_id(category, description)

        if issue_id in self.issues:
            issue = self.issues[issue_id]
            issue.occurrences += 1
            if iteration not in issue.iterations_seen:
                issue.iterations_seen.append(iteration)
        else:
            issue = Issue(
                id=issue_id,
                category=category,
                description=description,
                first_seen=datetime.now(),
                iterations_seen=[iteration],
            )
            self.issues[issue_id] = issue

        return issue

    def _is_stuck(self, issue: Issue) -> bool:
        """Check if we're stuck on an issue"""
        return (
            issue.occurrences >= self.config.max_same_issue_attempts
            and not issue.resolved
        )

    def _get_recurring_issues(self) -> List[Issue]:
        """Get issues that keep recurring"""
        return [
            issue for issue in self.issues.values()
            if issue.occurrences >= 2 and not issue.resolved
        ]

    async def _update_state(self, new_state: LoopState):
        """Update state and notify"""
        old_state = self.state
        self.state = new_state
        logger.info(f"State: {old_state.value} -> {new_state.value}")

        if self.iterations:
            self.iterations[-1].state_history.append(new_state.value)

        if self.on_status_update:
            await self.on_status_update({
                "state": new_state.value,
                "iteration": len(self.iterations),
                "issues": len(self.issues),
            })

    async def run(self) -> Dict[str, Any]:
        """
        Run the feedback loop until satisfied or exhausted.

        Returns:
            Result dict with status, iterations, and summary
        """
        self.started_at = datetime.now()
        logger.info(f"Starting feedback loop for {self.config.service_name}")

        try:
            while len(self.iterations) < self.config.max_iterations:
                # Check timeout
                elapsed = (datetime.now() - self.started_at).total_seconds() / 60
                if elapsed > self.config.max_duration_minutes:
                    logger.warning("Loop timeout reached")
                    return self._create_result("timeout")

                # Run one iteration
                iteration_result = await self._run_iteration()

                if iteration_result["success"]:
                    logger.info("Output meets quality standards!")
                    return self._create_result("success")

                if iteration_result.get("stuck"):
                    # Escalate - do research and try different approach
                    research_result = await self._handle_stuck()
                    if research_result.get("give_up"):
                        return self._create_result("stuck", research_result)

        except Exception as e:
            logger.error(f"Loop failed with error: {e}")
            return self._create_result("error", {"error": str(e)})

        return self._create_result("max_iterations")

    async def _run_iteration(self) -> Dict[str, Any]:
        """Run a single iteration of the feedback loop"""
        iteration = LoopIteration(
            number=len(self.iterations) + 1,
            started_at=datetime.now(),
        )
        self.iterations.append(iteration)
        logger.info(f"=== Iteration {iteration.number} ===")

        try:
            # Step 1: Test on frontend
            await self._update_state(LoopState.TESTING_FRONTEND)
            test_result = await self._test_frontend()
            if not test_result["success"]:
                return {"success": False, "error": "Frontend test failed"}

            # Step 2: Wait for email with output
            await self._update_state(LoopState.WAITING_FOR_EMAIL)
            email_result = await self._wait_for_email()
            if not email_result["success"]:
                self._track_issue(
                    IssueCategory.TIMEOUT,
                    "Email not received in time",
                    iteration.number
                )
                return {"success": False, "error": "Email timeout"}

            iteration.output_file = email_result.get("file_path")

            # Step 3: Analyze output
            await self._update_state(LoopState.ANALYZING_OUTPUT)
            analysis_result = await self._analyze_output(iteration.output_file)
            iteration.comparison_result = analysis_result

            # Check if output is satisfactory
            if analysis_result.get("passed"):
                iteration.success = True
                iteration.completed_at = datetime.now()
                return {"success": True}

            # Step 4: Track issues from analysis
            for discrepancy in analysis_result.get("discrepancies", []):
                issue = self._track_issue(
                    IssueCategory.OUTPUT_QUALITY,
                    discrepancy.get("suggestion", discrepancy.get("category")),
                    iteration.number
                )
                iteration.issues_found.append(issue.id)

                # Check if stuck on this issue
                if self._is_stuck(issue):
                    logger.warning(f"STUCK on issue: {issue.description}")
                    return {"success": False, "stuck": True, "stuck_issue": issue}

            # Step 5: Generate fix and send to Claude Code
            await self._update_state(LoopState.GENERATING_FIX)
            fix_result = await self._generate_and_apply_fix(analysis_result)
            if not fix_result["success"]:
                return {"success": False, "error": "Fix generation failed"}

            iteration.pr_number = fix_result.get("pr_number")

            # Step 6: Wait for and merge PR
            await self._update_state(LoopState.WAITING_FOR_PR)
            pr_result = await self._handle_pr(iteration.pr_number)
            if not pr_result["success"]:
                if pr_result.get("merge_error"):
                    await self._update_state(LoopState.HANDLING_MERGE_ERROR)
                    error_result = await self._handle_merge_error(pr_result)
                    if not error_result["success"]:
                        return {"success": False, "error": "Merge error unresolved"}

            # Step 7: Wait for deployment
            await self._update_state(LoopState.WAITING_FOR_DEPLOY)
            await self._wait_for_deploy()

            # Step 8: Check logs for errors
            await self._update_state(LoopState.CHECKING_LOGS)
            logs_result = await self._check_logs()
            if logs_result.get("has_errors"):
                self._track_issue(
                    IssueCategory.CODE_ERROR,
                    logs_result.get("error_summary", "Runtime error in logs"),
                    iteration.number
                )

            iteration.completed_at = datetime.now()
            return {"success": False}  # Continue to next iteration

        except Exception as e:
            logger.error(f"Iteration {iteration.number} failed: {e}")
            iteration.notes = str(e)
            iteration.completed_at = datetime.now()
            return {"success": False, "error": str(e)}

    async def _test_frontend(self) -> Dict[str, Any]:
        """Test the service via frontend"""
        if self.on_test_frontend:
            return await self.on_test_frontend(
                self.config.service_name,
                self.config.test_input
            )
        logger.warning("No frontend test callback set")
        return {"success": True}  # Skip if not configured

    async def _wait_for_email(self) -> Dict[str, Any]:
        """Wait for output email to arrive"""
        if self.on_download_email:
            return await self.on_download_email(
                self.config.service_name,
                self.config.email_timeout_minutes
            )
        logger.warning("No email download callback set")
        return {"success": False, "error": "No email callback"}

    async def _analyze_output(self, file_path: str) -> Dict[str, Any]:
        """Analyze the output file against template"""
        if self.on_analyze_output:
            return await self.on_analyze_output(
                file_path,
                self.config.template_name
            )
        logger.warning("No analyze callback set")
        return {"passed": True}  # Skip if not configured

    async def _generate_and_apply_fix(
        self,
        analysis_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Generate fix prompt and send to Claude Code"""
        if self.on_send_to_claude_code:
            # Create detailed prompt from analysis
            prompt = self._create_fix_prompt(analysis_result)
            return await self.on_send_to_claude_code(prompt)
        logger.warning("No Claude Code callback set")
        return {"success": False}

    def _create_fix_prompt(self, analysis_result: Dict[str, Any]) -> str:
        """Create a detailed fix prompt for Claude Code"""
        discrepancies = analysis_result.get("discrepancies", [])

        # Group by severity
        critical = [d for d in discrepancies if d.get("severity") == "critical"]
        high = [d for d in discrepancies if d.get("severity") == "high"]

        prompt = f"""Fix issues in the {self.config.service_name} service output.

Iteration: {len(self.iterations)}
Previous attempts: {len(self.iterations) - 1}

"""

        if critical:
            prompt += "## CRITICAL ISSUES (must fix)\n\n"
            for d in critical:
                prompt += f"- **{d.get('category')}** at {d.get('location')}\n"
                prompt += f"  - Expected: {d.get('expected')}\n"
                prompt += f"  - Actual: {d.get('actual')}\n"
                prompt += f"  - Fix: {d.get('suggestion')}\n\n"

        if high:
            prompt += "## HIGH PRIORITY ISSUES\n\n"
            for d in high:
                prompt += f"- **{d.get('category')}**: {d.get('suggestion')}\n"

        # Add context about recurring issues
        recurring = self._get_recurring_issues()
        if recurring:
            prompt += "\n## RECURRING ISSUES (these keep coming back)\n\n"
            for issue in recurring:
                prompt += f"- {issue.description} (seen {issue.occurrences} times)\n"
                if issue.attempted_fixes:
                    prompt += f"  - Previous attempts: {', '.join(issue.attempted_fixes[-3:])}\n"

        prompt += """
Please:
1. Identify root cause in the code
2. Fix all critical and high priority issues
3. Commit and push changes
4. The fix should be in backend/{service_name}/
"""

        return prompt.format(service_name=self.config.service_name)

    async def _handle_pr(self, pr_number: Optional[int]) -> Dict[str, Any]:
        """Wait for CI and merge PR"""
        if not pr_number:
            return {"success": False, "error": "No PR number"}

        if self.on_merge_pr:
            return await self.on_merge_pr(pr_number)

        logger.warning("No merge PR callback set")
        return {"success": True}

    async def _handle_merge_error(
        self,
        error_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Handle merge errors by capturing and sending to Claude Code"""
        error_type = error_result.get("error_type")
        error_message = error_result.get("error_message")

        self._track_issue(
            IssueCategory.MERGE_CONFLICT if "conflict" in str(error_type).lower()
            else IssueCategory.CI_FAILURE,
            error_message or "Merge failed",
            len(self.iterations)
        )

        # Get logs if available
        logs = ""
        if self.on_get_logs:
            logs_result = await self.on_get_logs()
            logs = logs_result.get("logs", "")

        # Send error context to Claude Code
        if self.on_send_to_claude_code:
            prompt = f"""Fix merge/CI error:

Error type: {error_type}
Error message: {error_message}

Logs:
```
{logs[:2000]}
```

Please fix the issue and push again.
"""
            return await self.on_send_to_claude_code(prompt)

        return {"success": False}

    async def _wait_for_deploy(self):
        """Wait for Railway deployment"""
        logger.info(f"Waiting {self.config.deploy_wait_seconds}s for deployment")
        await asyncio.sleep(self.config.deploy_wait_seconds)

    async def _check_logs(self) -> Dict[str, Any]:
        """Check Railway logs for errors"""
        if self.on_get_logs:
            return await self.on_get_logs()
        return {"has_errors": False}

    async def _handle_stuck(self) -> Dict[str, Any]:
        """
        Handle being stuck on an issue.

        1. Research the problem
        2. Suggest foundational changes
        3. Try a different approach
        """
        await self._update_state(LoopState.STUCK_RESEARCHING)

        stuck_issues = [i for i in self.issues.values() if self._is_stuck(i)]
        logger.warning(f"STUCK on {len(stuck_issues)} issues")

        if not self.on_research:
            return {"give_up": True, "reason": "No research capability"}

        # Research each stuck issue
        for issue in stuck_issues:
            research_prompt = f"""
I'm stuck on this recurring issue that keeps happening despite multiple fix attempts:

Issue: {issue.description}
Category: {issue.category.value}
Times seen: {issue.occurrences}
Previous fix attempts: {issue.attempted_fixes}

Please research:
1. What could be the root cause?
2. Are we approaching this wrong fundamentally?
3. What alternative approaches exist?
4. Should we add iterative AI checking?
5. Is there a library or pattern that handles this better?

Suggest a foundational change to solve this permanently.
"""
            research_result = await self.on_research(research_prompt)

            if research_result.get("new_approach"):
                # Try the new approach
                new_prompt = f"""
Based on research, try this new approach to fix the recurring issue:

Issue: {issue.description}

New approach:
{research_result.get('new_approach')}

This is a FOUNDATIONAL change, not just a patch.
Please implement this new approach.
"""
                if self.on_send_to_claude_code:
                    await self.on_send_to_claude_code(new_prompt)
                    issue.attempted_fixes.append("foundational_change")

                return {"give_up": False, "approach": "foundational_change"}

        # If research doesn't help, give up
        return {
            "give_up": True,
            "reason": "Could not find solution after research",
            "stuck_issues": [i.description for i in stuck_issues]
        }

    def _create_result(
        self,
        status: str,
        extra: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Create final result dict"""
        self.completed_at = datetime.now()

        result = {
            "status": status,
            "service": self.config.service_name,
            "iterations": len(self.iterations),
            "duration_minutes": (
                (self.completed_at - self.started_at).total_seconds() / 60
                if self.started_at else 0
            ),
            "issues_found": len(self.issues),
            "issues_resolved": sum(1 for i in self.issues.values() if i.resolved),
            "recurring_issues": [
                {"description": i.description, "occurrences": i.occurrences}
                for i in self._get_recurring_issues()
            ],
            "iteration_history": [
                {
                    "number": it.number,
                    "success": it.success,
                    "issues": len(it.issues_found),
                    "pr": it.pr_number,
                }
                for it in self.iterations
            ],
        }

        if extra:
            result.update(extra)

        return result


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================


def create_loop_config(
    service_name: str,
    business: str,
    country: str,
    **kwargs
) -> LoopConfig:
    """Helper to create a LoopConfig for common services"""

    # Auto-detect template
    template_map = {
        "target-v3": "target-search",
        "target-v4": "target-search",
        "target-v5": "target-search",
        "target-v6": "target-search",
        "profile-slides": "profile-slides",
        "market-research": "market-research",
        "validation": "validation-results",
        "trading-comparable": "trading-comps",
    }

    template_name = template_map.get(service_name, "target-search")

    return LoopConfig(
        service_name=service_name,
        template_name=template_name,
        test_input={
            "business": business,
            "country": country,
            **kwargs
        },
        **{k: v for k, v in kwargs.items() if k in LoopConfig.__dataclass_fields__}
    )
