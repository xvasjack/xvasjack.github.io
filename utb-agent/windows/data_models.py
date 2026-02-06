"""
Data Models for Plan Visibility and Decision Tracking.

Provides structured types for:
- ExecutionPlan: The plan proposed before execution
- PlanStep: Individual steps within a plan
- Decision: Tracked decisions with reasoning
- AnalysisResult: Structured output analysis results
"""

from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any, Optional
from enum import Enum
from datetime import datetime
import uuid
import json


class PlanStepStatus(Enum):
    """Status of a plan step"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"


class DecisionCategory(Enum):
    """Categories of decisions"""
    ITERATION_START = "iteration_start"      # Start/continue iteration
    ITERATION_ABORT = "iteration_abort"      # Abort iteration
    ANALYSIS_RESULT = "analysis_result"      # Analysis passed/failed
    STUCK_DETECTION = "stuck_detection"      # Detected stuck state
    FIX_STRATEGY = "fix_strategy"            # Chose fix strategy
    RESEARCH_TRIGGER = "research_trigger"    # Triggered research
    APPROVAL_REQUEST = "approval_request"    # Requested user approval
    PLAN_GENERATION = "plan_generation"      # Generated new plan


@dataclass
class PlanStep:
    """
    A single step within an execution plan.

    Attributes:
        step_number: Sequential step number (1-indexed)
        action: The action to perform (e.g., "test_frontend", "wait_for_email")
        description: Human-readable description of what will happen
        rationale: Why this step is needed
        can_skip: Whether user can skip this step
        status: Current status of this step
        started_at: When step started (if started)
        completed_at: When step completed (if completed)
        result: Result data from step execution
    """
    step_number: int
    action: str
    description: str
    rationale: str
    can_skip: bool = False
    status: PlanStepStatus = PlanStepStatus.PENDING
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    result: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "step_number": self.step_number,
            "action": self.action,
            "description": self.description,
            "rationale": self.rationale,
            "can_skip": self.can_skip,
            "status": self.status.value,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "result": self.result,
        }

    def start(self):
        """Mark step as started"""
        self.status = PlanStepStatus.IN_PROGRESS
        self.started_at = datetime.now()

    def complete(self, result: Optional[Dict[str, Any]] = None):
        """Mark step as completed with optional result"""
        self.status = PlanStepStatus.COMPLETED
        self.completed_at = datetime.now()
        self.result = result

    def fail(self, error: str):
        """Mark step as failed"""
        self.status = PlanStepStatus.FAILED
        self.completed_at = datetime.now()
        self.result = {"error": error}

    def skip(self, reason: str = "User skipped"):
        """Mark step as skipped"""
        self.status = PlanStepStatus.SKIPPED
        self.completed_at = datetime.now()
        self.result = {"skip_reason": reason}


@dataclass
class ExecutionPlan:
    """
    An execution plan proposed before running the feedback loop.

    Attributes:
        plan_id: Unique identifier for this plan
        goal: High-level goal description
        steps: List of planned steps
        estimated_duration_minutes: Estimated time to complete
        requires_approval: Whether user approval is needed before execution
        created_at: When plan was created
        approved_at: When plan was approved (if approved)
        approved_by: Who approved (user/auto)
        context: Additional context for the plan
    """
    plan_id: str
    goal: str
    steps: List[PlanStep]
    estimated_duration_minutes: int = 30
    requires_approval: bool = True
    created_at: datetime = field(default_factory=datetime.now)
    approved_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    context: Optional[Dict[str, Any]] = None

    @classmethod
    def create(cls, goal: str, steps: List[PlanStep], **kwargs) -> "ExecutionPlan":
        """Factory method to create a new plan"""
        return cls(
            plan_id=str(uuid.uuid4())[:8],
            goal=goal,
            steps=steps,
            **kwargs
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "plan_id": self.plan_id,
            "goal": self.goal,
            "steps": [step.to_dict() for step in self.steps],
            "estimated_duration_minutes": self.estimated_duration_minutes,
            "requires_approval": self.requires_approval,
            "created_at": self.created_at.isoformat(),
            "approved_at": self.approved_at.isoformat() if self.approved_at else None,
            "approved_by": self.approved_by,
            "context": self.context,
        }

    def approve(self, by: str = "user"):
        """Mark plan as approved"""
        self.approved_at = datetime.now()
        self.approved_by = by

    def get_current_step(self) -> Optional[PlanStep]:
        """Get the current in-progress step"""
        for step in self.steps:
            if step.status == PlanStepStatus.IN_PROGRESS:
                return step
        return None

    def get_next_pending_step(self) -> Optional[PlanStep]:
        """Get the next pending step"""
        for step in self.steps:
            if step.status == PlanStepStatus.PENDING:
                return step
        return None

    def get_progress(self) -> Dict[str, Any]:
        """Get current progress summary"""
        completed = sum(1 for s in self.steps if s.status == PlanStepStatus.COMPLETED)
        failed = sum(1 for s in self.steps if s.status == PlanStepStatus.FAILED)
        skipped = sum(1 for s in self.steps if s.status == PlanStepStatus.SKIPPED)
        total = len(self.steps)

        return {
            "total_steps": total,
            "completed": completed,
            "failed": failed,
            "skipped": skipped,
            "pending": total - completed - failed - skipped,
            "percent_complete": int((completed / total) * 100) if total > 0 else 0,
        }

    def is_complete(self) -> bool:
        """Check if all steps are done (completed, failed, or skipped)"""
        return all(
            s.status in (PlanStepStatus.COMPLETED, PlanStepStatus.FAILED, PlanStepStatus.SKIPPED)
            for s in self.steps
        )


@dataclass
class DecisionOption:
    """An option considered during a decision"""
    label: str
    description: str
    pros: List[str] = field(default_factory=list)
    cons: List[str] = field(default_factory=list)
    chosen: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "description": self.description,
            "pros": self.pros,
            "cons": self.cons,
            "chosen": self.chosen,
        }


@dataclass
class Decision:
    """
    A tracked decision with full reasoning.

    Attributes:
        decision_id: Unique identifier
        category: Type of decision
        trigger: What triggered this decision
        options: Options that were considered
        chosen: Which option was chosen
        reasoning: Explanation of why this choice was made
        timestamp: When decision was made
        iteration: Which iteration this occurred in
        context: Additional context
    """
    decision_id: str
    category: DecisionCategory
    trigger: str
    options: List[DecisionOption]
    chosen: str
    reasoning: str
    timestamp: datetime = field(default_factory=datetime.now)
    iteration: int = 0
    context: Optional[Dict[str, Any]] = None

    @classmethod
    def create(
        cls,
        category: DecisionCategory,
        trigger: str,
        options: List[DecisionOption],
        chosen: str,
        reasoning: str,
        **kwargs
    ) -> "Decision":
        """Factory method to create a new decision"""
        # Mark the chosen option
        for opt in options:
            opt.chosen = opt.label == chosen

        return cls(
            decision_id=str(uuid.uuid4())[:12],
            category=category,
            trigger=trigger,
            options=options,
            chosen=chosen,
            reasoning=reasoning,
            **kwargs
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "decision_id": self.decision_id,
            "category": self.category.value,
            "trigger": self.trigger,
            "options": [opt.to_dict() for opt in self.options],
            "chosen": self.chosen,
            "reasoning": self.reasoning,
            "timestamp": self.timestamp.isoformat(),
            "iteration": self.iteration,
            "context": self.context,
        }


@dataclass
class AnalysisResult:
    """
    Structured result from output analysis.

    Supports multiple output types: PPTX, XLSX, PDF, HTML
    """
    output_type: str  # pptx, xlsx, pdf, html
    file_path: str
    template_name: str
    passed: bool
    total_checks: int
    passed_checks: int
    discrepancies: List[Dict[str, Any]]
    summary: str
    metadata: Optional[Dict[str, Any]] = None
    analyzed_at: datetime = field(default_factory=datetime.now)

    @property
    def critical_count(self) -> int:
        """Count of critical severity issues"""
        return sum(1 for d in self.discrepancies if d.get("severity") == "critical")

    @property
    def high_count(self) -> int:
        """Count of high severity issues"""
        return sum(1 for d in self.discrepancies if d.get("severity") == "high")

    @property
    def pass_rate(self) -> float:
        """Percentage of checks that passed"""
        if self.total_checks == 0:
            return 0.0
        return self.passed_checks / self.total_checks

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "output_type": self.output_type,
            "file_path": self.file_path,
            "template_name": self.template_name,
            "passed": self.passed,
            "total_checks": self.total_checks,
            "passed_checks": self.passed_checks,
            "discrepancies": self.discrepancies,
            "summary": self.summary,
            "metadata": self.metadata,
            "analyzed_at": self.analyzed_at.isoformat(),
            "critical_count": self.critical_count,
            "high_count": self.high_count,
            "pass_rate": self.pass_rate,
        }


@dataclass
class StreamEvent:
    """
    Event for streaming output visibility.

    Used to send real-time updates during Claude Agent SDK execution.
    """
    event_type: str  # token, tool_start, tool_end, thinking, error
    content: str
    tool_name: Optional[str] = None
    tool_params: Optional[Dict[str, Any]] = None
    reasoning: Optional[str] = None
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "event_type": self.event_type,
            "content": self.content,
            "tool_name": self.tool_name,
            "tool_params": self.tool_params,
            "reasoning": self.reasoning,
            "timestamp": self.timestamp.isoformat(),
        }


# Type aliases for convenience
PlanSteps = List[PlanStep]
Decisions = List[Decision]
