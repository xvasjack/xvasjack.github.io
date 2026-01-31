"""
Decision Tracker - Records and persists all agent decisions.

Provides full transparency into why the agent made each decision:
- What triggered the decision
- What options were considered
- Which option was chosen
- Why it was chosen

Persists to local JSON files for:
- Post-run analysis
- Debugging stuck loops
- Training data for future improvements
"""

import asyncio
import json
import os
from datetime import datetime
from typing import List, Dict, Any, Optional, Callable
from dataclasses import dataclass, asdict
import logging
from pathlib import Path

from data_models import Decision, DecisionCategory, DecisionOption

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("decision_tracker")


class DecisionTracker:
    """
    Tracks all decisions made by the agent with full reasoning.

    Decisions are:
    1. Recorded in memory for the session
    2. Broadcast to UI via callback
    3. Persisted to JSON file for later analysis
    """

    def __init__(
        self,
        task_id: str,
        traces_folder: Optional[str] = None,
        on_decision: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        """
        Initialize decision tracker.

        Args:
            task_id: Unique ID for this task/session
            traces_folder: Where to save decision traces (default: ./traces)
            on_decision: Callback to broadcast decisions
        """
        self.task_id = task_id
        self.traces_folder = Path(traces_folder or self._get_default_traces_folder())
        self.on_decision = on_decision
        self.decisions: List[Decision] = []

        # Ensure traces folder exists
        self.traces_folder.mkdir(parents=True, exist_ok=True)

        # Create trace file path
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.trace_file = self.traces_folder / f"trace_{task_id}_{timestamp}.json"

        logger.info(f"Decision tracker initialized. Trace file: {self.trace_file}")

    def _get_default_traces_folder(self) -> str:
        """M16: Get default traces folder from env or OS-appropriate default"""
        return os.environ.get("AGENT_TRACES_DIR",
            r"C:\agent\traces" if os.name == 'nt' else os.path.expanduser("~/.agent/traces")
        )

    async def record_decision(
        self,
        category: DecisionCategory,
        trigger: str,
        options: List[Dict[str, Any]],
        chosen: str,
        reasoning: str,
        iteration: int = 0,
        context: Optional[Dict[str, Any]] = None,
    ) -> Decision:
        """
        Record a decision with full reasoning.

        Args:
            category: Type of decision
            trigger: What triggered this decision
            options: List of options considered (dicts with label, description)
            chosen: Which option was chosen (label)
            reasoning: Why this choice was made
            iteration: Current iteration number
            context: Additional context

        Returns:
            The recorded Decision
        """
        # Convert option dicts to DecisionOption objects
        option_objects = [
            DecisionOption(
                label=opt.get("label", "unknown"),
                description=opt.get("description", ""),
                pros=opt.get("pros", []),
                cons=opt.get("cons", []),
                chosen=opt.get("label") == chosen,
            )
            for opt in options
        ]

        # Create decision
        decision = Decision.create(
            category=category,
            trigger=trigger,
            options=option_objects,
            chosen=chosen,
            reasoning=reasoning,
            iteration=iteration,
            context=context,
        )

        # Store in memory
        self.decisions.append(decision)

        # Broadcast to UI
        if self.on_decision:
            await self._broadcast(decision)

        # Persist to file
        await self._persist(decision)

        logger.info(f"Decision recorded: [{category.value}] {chosen}")
        return decision

    async def _broadcast(self, decision: Decision):
        """Broadcast decision to UI via callback"""
        try:
            decision_dict = decision.to_dict()
            if asyncio.iscoroutinefunction(self.on_decision):
                await self.on_decision(decision_dict)
            else:
                self.on_decision(decision_dict)
        except Exception as e:
            logger.warning(f"Failed to broadcast decision: {e}")

    async def _persist(self, decision: Decision):
        """Persist decision to JSON file"""
        try:
            # Append to trace file
            with open(self.trace_file, "a") as f:
                json.dump(decision.to_dict(), f)
                f.write("\n")
        except Exception as e:
            logger.warning(f"Failed to persist decision: {e}")

    def get_all_decisions(self) -> List[Dict[str, Any]]:
        """Get all decisions as list of dicts"""
        return [d.to_dict() for d in self.decisions]

    def get_decisions_by_category(self, category: DecisionCategory) -> List[Decision]:
        """Get all decisions of a specific category"""
        return [d for d in self.decisions if d.category == category]

    def get_decisions_for_iteration(self, iteration: int) -> List[Decision]:
        """Get all decisions for a specific iteration"""
        return [d for d in self.decisions if d.iteration == iteration]

    def get_summary(self) -> Dict[str, Any]:
        """Get summary of all decisions"""
        by_category = {}
        for d in self.decisions:
            cat = d.category.value
            by_category[cat] = by_category.get(cat, 0) + 1

        return {
            "task_id": self.task_id,
            "total_decisions": len(self.decisions),
            "by_category": by_category,
            "trace_file": str(self.trace_file),
        }

    async def close(self):
        """Finalize and close the tracker"""
        # Write summary to end of trace file
        try:
            with open(self.trace_file, "a") as f:
                f.write("\n--- SUMMARY ---\n")
                json.dump(self.get_summary(), f, indent=2)
                f.write("\n")
            logger.info(f"Decision trace saved to {self.trace_file}")
        except Exception as e:
            logger.warning(f"Failed to finalize trace file: {e}")


# Convenience functions for common decision patterns


async def record_iteration_start(
    tracker: DecisionTracker,
    iteration: int,
    max_iterations: int,
    blocking_issues: List[str] = None,
) -> Decision:
    """Record decision to start/continue an iteration"""
    options = [
        {"label": "continue", "description": "Continue with the iteration"},
        {"label": "abort", "description": "Stop the feedback loop"},
    ]

    if blocking_issues:
        reasoning = f"Iteration {iteration} of {max_iterations}. " \
                   f"Blocking issues: {', '.join(blocking_issues[:3])}"
    else:
        reasoning = f"Iteration {iteration} of {max_iterations}. " \
                   f"No blocking issues detected."

    return await tracker.record_decision(
        category=DecisionCategory.ITERATION_START,
        trigger=f"Starting iteration {iteration}",
        options=options,
        chosen="continue",
        reasoning=reasoning,
        iteration=iteration,
    )


async def record_analysis_result(
    tracker: DecisionTracker,
    iteration: int,
    passed: bool,
    issue_count: int,
    critical_count: int,
) -> Decision:
    """Record decision based on analysis result"""
    options = [
        {"label": "passed", "description": "Output meets quality standards"},
        {"label": "failed", "description": "Output has issues to fix"},
    ]

    chosen = "passed" if passed else "failed"
    reasoning = f"Analysis complete. " \
               f"Passed: {passed}. " \
               f"Issues: {issue_count} total, {critical_count} critical."

    return await tracker.record_decision(
        category=DecisionCategory.ANALYSIS_RESULT,
        trigger="Output analysis completed",
        options=options,
        chosen=chosen,
        reasoning=reasoning,
        iteration=iteration,
        context={
            "issue_count": issue_count,
            "critical_count": critical_count,
        },
    )


async def record_stuck_detection(
    tracker: DecisionTracker,
    iteration: int,
    issue_description: str,
    occurrences: int,
    threshold: int,
) -> Decision:
    """Record decision when stuck is detected"""
    options = [
        {"label": "research", "description": "Research solutions online"},
        {"label": "escalate", "description": "Ask user for help"},
        {"label": "continue", "description": "Try another fix attempt"},
        {"label": "give_up", "description": "Stop trying to fix this issue"},
    ]

    chosen = "research" if occurrences < threshold + 2 else "escalate"
    reasoning = f"Issue '{issue_description[:50]}...' has occurred {occurrences} times " \
               f"(threshold: {threshold}). Choosing to {chosen}."

    return await tracker.record_decision(
        category=DecisionCategory.STUCK_DETECTION,
        trigger=f"Detected stuck on issue after {occurrences} occurrences",
        options=options,
        chosen=chosen,
        reasoning=reasoning,
        iteration=iteration,
        context={
            "issue": issue_description,
            "occurrences": occurrences,
        },
    )


async def record_fix_strategy(
    tracker: DecisionTracker,
    iteration: int,
    strategy: str,
    issue_type: str,
    alternatives: List[str],
) -> Decision:
    """Record decision about which fix strategy to use"""
    options = [
        {"label": strategy, "description": "Chosen strategy"},
    ]
    for alt in alternatives:
        options.append({"label": alt, "description": "Alternative strategy"})

    reasoning = f"For {issue_type} issue, chose '{strategy}' strategy. " \
               f"Alternatives considered: {', '.join(alternatives)}."

    return await tracker.record_decision(
        category=DecisionCategory.FIX_STRATEGY,
        trigger=f"Selecting fix strategy for {issue_type}",
        options=options,
        chosen=strategy,
        reasoning=reasoning,
        iteration=iteration,
    )


# Factory function


def create_tracker(
    task_id: str,
    on_decision: Optional[Callable] = None,
    traces_folder: Optional[str] = None,
) -> DecisionTracker:
    """
    Create a new decision tracker.

    Args:
        task_id: Unique task identifier
        on_decision: Callback for broadcasting decisions
        traces_folder: Where to save traces

    Returns:
        Configured DecisionTracker
    """
    return DecisionTracker(
        task_id=task_id,
        traces_folder=traces_folder,
        on_decision=on_decision,
    )
