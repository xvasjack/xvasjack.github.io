"""
Plan Generator - Creates execution plans before running feedback loops.

This module generates transparent execution plans that:
1. Show the user exactly what will happen
2. Estimate duration
3. Allow approval before execution
4. Enable real-time step tracking
"""

import logging
from typing import Dict, Any, Optional, List
from datetime import datetime

from data_models import (
    ExecutionPlan,
    PlanStep,
    PlanStepStatus,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("plan_generator")


class PlanGenerator:
    """
    Generates execution plans for feedback loops.

    Plans are generated based on:
    - Service type (affects steps needed)
    - Configuration (timeouts, max iterations)
    - Historical data (if available)
    """

    # Time estimates per step type (in minutes)
    STEP_TIME_ESTIMATES = {
        "test_frontend": 2,
        "wait_for_email": 45,  # Can vary widely
        "analyze_output": 5,
        "generate_fix": 10,
        "wait_for_pr": 10,
        "merge_pr": 2,
        "wait_for_deploy": 3,
        "check_logs": 2,
        "research": 15,
        "approval": 5,
    }

    def __init__(self):
        self.templates: Dict[str, List[Dict[str, Any]]] = {}
        self._load_plan_templates()

    def _load_plan_templates(self):
        """Load predefined plan templates for common workflows"""

        # Standard feedback loop plan
        self.templates["feedback_loop"] = [
            {
                "action": "test_frontend",
                "description": "Submit test input via frontend form",
                "rationale": "Trigger the service to generate output",
                "can_skip": False,
            },
            {
                "action": "wait_for_email",
                "description": "Wait for email with output attachment",
                "rationale": "Service sends results via email (can take 10-45 minutes)",
                "can_skip": False,
            },
            {
                "action": "analyze_output",
                "description": "Compare output against template",
                "rationale": "Identify discrepancies and issues",
                "can_skip": False,
            },
            {
                "action": "generate_fix",
                "description": "Generate code fix via Claude Code",
                "rationale": "Create fix for identified issues",
                "can_skip": True,  # Skip if output passed
            },
            {
                "action": "wait_for_pr",
                "description": "Wait for CI checks on PR",
                "rationale": "Ensure fix doesn't break tests",
                "can_skip": True,
            },
            {
                "action": "merge_pr",
                "description": "Merge the fix PR",
                "rationale": "Apply fix to main branch",
                "can_skip": True,
            },
            {
                "action": "wait_for_deploy",
                "description": "Wait for Railway deployment",
                "rationale": "Fix needs to be deployed before re-test",
                "can_skip": True,
            },
            {
                "action": "check_logs",
                "description": "Check Railway logs for errors",
                "rationale": "Ensure deployment succeeded",
                "can_skip": True,
            },
        ]

        # Quick validation plan (no fixes)
        self.templates["validation_only"] = [
            {
                "action": "test_frontend",
                "description": "Submit test input via frontend form",
                "rationale": "Trigger the service to generate output",
                "can_skip": False,
            },
            {
                "action": "wait_for_email",
                "description": "Wait for email with output attachment",
                "rationale": "Service sends results via email",
                "can_skip": False,
            },
            {
                "action": "analyze_output",
                "description": "Compare output against template",
                "rationale": "Generate validation report",
                "can_skip": False,
            },
        ]

        # Research and fix plan (for stuck issues)
        self.templates["research_fix"] = [
            {
                "action": "research",
                "description": "Research solutions for recurring issue",
                "rationale": "Find alternative approaches",
                "can_skip": False,
            },
            {
                "action": "generate_fix",
                "description": "Generate foundational fix",
                "rationale": "Address root cause, not symptoms",
                "can_skip": False,
            },
            {
                "action": "wait_for_pr",
                "description": "Wait for CI checks",
                "rationale": "Validate fix doesn't break tests",
                "can_skip": False,
            },
            {
                "action": "merge_pr",
                "description": "Merge the fix",
                "rationale": "Apply foundational change",
                "can_skip": False,
            },
            {
                "action": "wait_for_deploy",
                "description": "Wait for deployment",
                "rationale": "Fix needs to be live for testing",
                "can_skip": False,
            },
            {
                "action": "test_frontend",
                "description": "Re-test with the fix",
                "rationale": "Verify fix resolves issue",
                "can_skip": False,
            },
            {
                "action": "wait_for_email",
                "description": "Wait for new output",
                "rationale": "Get updated results",
                "can_skip": False,
            },
            {
                "action": "analyze_output",
                "description": "Analyze if fix worked",
                "rationale": "Confirm issue is resolved",
                "can_skip": False,
            },
        ]

    def generate_plan(
        self,
        goal: str,
        service_name: str,
        config: Dict[str, Any],
        template_type: str = "feedback_loop",
        iteration: int = 1,
    ) -> ExecutionPlan:
        """
        Generate an execution plan for a task.

        Args:
            goal: High-level goal description
            service_name: Service being tested
            config: Loop configuration
            template_type: Which template to use
            iteration: Current iteration number (affects estimates)

        Returns:
            ExecutionPlan ready for approval
        """
        logger.info(f"Generating {template_type} plan for {service_name}")

        template = self.templates.get(template_type, self.templates["feedback_loop"])

        # Create steps from template
        steps = []
        for i, step_def in enumerate(template, 1):
            step = PlanStep(
                step_number=i,
                action=step_def["action"],
                description=self._customize_description(
                    step_def["description"],
                    service_name,
                    config,
                ),
                rationale=step_def["rationale"],
                can_skip=step_def.get("can_skip", False),
            )
            steps.append(step)

        # Calculate estimated duration
        total_minutes = self._estimate_duration(steps, config, iteration)

        # Create the plan
        plan = ExecutionPlan.create(
            goal=goal,
            steps=steps,
            estimated_duration_minutes=total_minutes,
            requires_approval=True,
            context={
                "service_name": service_name,
                "template_type": template_type,
                "iteration": iteration,
                "config": {
                    "max_iterations": config.get("max_iterations", 999),
                    "email_timeout_minutes": config.get("email_timeout_minutes", 45),
                },
            },
        )

        logger.info(f"Generated plan {plan.plan_id} with {len(steps)} steps")
        return plan

    def _customize_description(
        self,
        description: str,
        service_name: str,
        config: Dict[str, Any],
    ) -> str:
        """Customize step description with specific values"""
        return description.format(
            service=service_name,
            email_timeout=config.get("email_timeout_minutes", 45),
            deploy_wait=config.get("deploy_wait_seconds", 60) // 60,
        )

    def _estimate_duration(
        self,
        steps: List[PlanStep],
        config: Dict[str, Any],
        iteration: int,
    ) -> int:
        """
        Estimate total duration for a plan.

        Adjusts estimates based on:
        - Configuration values
        - Iteration number (later iterations may be faster)
        """
        total = 0

        for step in steps:
            base_time = self.STEP_TIME_ESTIMATES.get(step.action, 5)

            # Adjust for config
            if step.action == "wait_for_email":
                # Use configured timeout (average is ~half)
                base_time = config.get("email_timeout_minutes", 45) // 2
            elif step.action == "wait_for_deploy":
                base_time = config.get("deploy_wait_seconds", 60) // 60

            # Later iterations may be faster (patterns learned)
            if iteration > 3:
                base_time = int(base_time * 0.8)

            total += base_time

        return total

    def generate_single_iteration_plan(
        self,
        service_name: str,
        business: str,
        country: str,
        iteration: int = 1,
        email_timeout: int = 45,
    ) -> ExecutionPlan:
        """
        Generate a plan for a single feedback loop iteration.

        This is a convenience method for the common case.
        """
        goal = f"Test {service_name} with '{business}' in {country}"

        if iteration > 1:
            goal = f"Re-test {service_name} after fix (iteration {iteration})"

        return self.generate_plan(
            goal=goal,
            service_name=service_name,
            config={
                "email_timeout_minutes": email_timeout,
                "max_iterations": 999,
            },
            template_type="feedback_loop",
            iteration=iteration,
        )

    def generate_full_loop_plan(
        self,
        service_name: str,
        business: str,
        country: str,
        max_iterations: int = 999,
        email_timeout: int = 45,
    ) -> ExecutionPlan:
        """
        Generate a plan for the entire feedback loop run.

        Unlike single iteration plans, this shows the full cycle
        that may repeat multiple times.
        """
        goal = f"Run full QA loop for {service_name}: test → fix → re-test until perfect"

        steps = [
            PlanStep(
                step_number=1,
                action="initial_test",
                description=f"Submit test: '{business}' in {country}",
                rationale="Get baseline output to evaluate",
                can_skip=False,
            ),
            PlanStep(
                step_number=2,
                action="wait_for_email",
                description=f"Wait up to {email_timeout} min for email",
                rationale="Service generates output asynchronously",
                can_skip=False,
            ),
            PlanStep(
                step_number=3,
                action="analyze_and_compare",
                description="Analyze output against template",
                rationale="Identify all issues to fix",
                can_skip=False,
            ),
            PlanStep(
                step_number=4,
                action="fix_loop",
                description="Fix issues, merge, deploy, re-test (repeat as needed)",
                rationale="Iterate until output matches template or stuck",
                can_skip=False,
            ),
            PlanStep(
                step_number=5,
                action="final_approval",
                description="Request approval when output passes",
                rationale="Human confirmation before marking complete",
                can_skip=False,
            ),
        ]

        # Estimate: first iteration + average fix iterations
        estimated_minutes = (
            self.STEP_TIME_ESTIMATES["test_frontend"]
            + email_timeout // 2  # Average email wait
            + self.STEP_TIME_ESTIMATES["analyze_output"]
            + 3 * (  # Assume ~3 fix iterations on average
                self.STEP_TIME_ESTIMATES["generate_fix"]
                + self.STEP_TIME_ESTIMATES["merge_pr"]
                + self.STEP_TIME_ESTIMATES["wait_for_deploy"]
                + email_timeout // 3  # Faster on subsequent tests
            )
            + self.STEP_TIME_ESTIMATES["approval"]
        )

        return ExecutionPlan.create(
            goal=goal,
            steps=steps,
            estimated_duration_minutes=estimated_minutes,
            requires_approval=True,
            context={
                "service_name": service_name,
                "business": business,
                "country": country,
                "max_iterations": max_iterations,
                "email_timeout_minutes": email_timeout,
                "plan_type": "full_loop",
            },
        )


# Singleton instance
_generator: Optional[PlanGenerator] = None


def get_plan_generator() -> PlanGenerator:
    """Get the singleton PlanGenerator instance"""
    global _generator
    if _generator is None:
        _generator = PlanGenerator()
    return _generator


def generate_feedback_loop_plan(
    service_name: str,
    business: str,
    country: str,
    **kwargs
) -> ExecutionPlan:
    """
    Convenience function to generate a feedback loop plan.

    Args:
        service_name: Service to test
        business: Business description
        country: Target country
        **kwargs: Additional configuration

    Returns:
        ExecutionPlan ready for approval
    """
    generator = get_plan_generator()
    return generator.generate_full_loop_plan(
        service_name=service_name,
        business=business,
        country=country,
        **kwargs
    )
