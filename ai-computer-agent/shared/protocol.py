"""
Shared protocol definitions for Host <-> VM communication.
"""

from dataclasses import dataclass, asdict, field
from typing import Optional, List, Literal
from enum import Enum
import json


class TaskStatus(Enum):
    PENDING = "pending"
    PLANNING = "planning"
    AWAITING_APPROVAL = "awaiting_approval"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    STUCK = "stuck"
    TIMEOUT = "timeout"


class ActionType(Enum):
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    TYPE = "type"
    PRESS = "press"
    HOTKEY = "hotkey"
    SCROLL = "scroll"
    WAIT = "wait"
    SCREENSHOT = "screenshot"
    DONE = "done"
    STUCK = "stuck"
    ASK_USER = "ask_user"


@dataclass
class Task:
    id: str
    description: str
    max_duration_minutes: int = 120
    approved_plan: Optional[str] = None
    context: Optional[str] = None
    status: TaskStatus = TaskStatus.PENDING

    def to_dict(self):
        d = asdict(self)
        d['status'] = self.status.value
        return d

    # SEC-2: Maximum lengths for input validation
    MAX_DESCRIPTION_LENGTH = 50000  # 50KB max description
    MAX_CONTEXT_LENGTH = 100000  # 100KB max context
    MAX_DURATION_MINUTES = 480  # 8 hours max
    MIN_DURATION_MINUTES = 1  # 1 minute min

    @classmethod
    def from_dict(cls, d: dict):
        # F66: Copy dict to avoid mutating caller's data
        d = dict(d)
        # F18: Validate required fields
        if 'id' not in d or 'description' not in d:
            raise TypeError(f"Task requires 'id' and 'description', got keys: {list(d.keys())}")
        # Handle status field - may be missing or string
        if 'status' in d:
            if isinstance(d['status'], str):
                # DL-5: Validate status value before creating enum
                valid_statuses = {s.value for s in TaskStatus}
                if d['status'] in valid_statuses:
                    d['status'] = TaskStatus(d['status'])
                else:
                    # Invalid status, default to PENDING
                    d['status'] = TaskStatus.PENDING
        else:
            d['status'] = TaskStatus.PENDING

        # M19: Handle camelCase→snake_case conversion from JS
        if 'maxDurationMinutes' in d:
            d['max_duration_minutes'] = d.pop('maxDurationMinutes')

        # SEC-2: Validate and sanitize description length
        if 'description' in d and d['description']:
            if not isinstance(d['description'], str):
                d['description'] = str(d['description'])[:cls.MAX_DESCRIPTION_LENGTH]
            elif len(d['description']) > cls.MAX_DESCRIPTION_LENGTH:
                d['description'] = d['description'][:cls.MAX_DESCRIPTION_LENGTH]

        # SEC-2: Validate and sanitize max_duration_minutes range
        if 'max_duration_minutes' in d:
            try:
                duration = int(d['max_duration_minutes'])
                d['max_duration_minutes'] = max(cls.MIN_DURATION_MINUTES, min(duration, cls.MAX_DURATION_MINUTES))
            except (ValueError, TypeError):
                d['max_duration_minutes'] = 120  # Default to 2 hours

        # SEC-2: Validate and sanitize context field
        if 'context' in d and d['context']:
            if not isinstance(d['context'], str):
                try:
                    import json
                    d['context'] = json.dumps(d['context'])[:cls.MAX_CONTEXT_LENGTH]
                except (TypeError, ValueError):
                    d['context'] = str(d['context'])[:cls.MAX_CONTEXT_LENGTH]
            elif len(d['context']) > cls.MAX_CONTEXT_LENGTH:
                d['context'] = d['context'][:cls.MAX_CONTEXT_LENGTH]

        # Remove any extra fields not in the dataclass
        valid_fields = {'id', 'description', 'max_duration_minutes', 'approved_plan', 'context', 'status'}
        d = {k: v for k, v in d.items() if k in valid_fields}

        return cls(**d)


@dataclass
class AgentAction:
    action: ActionType
    params: dict
    thinking: str
    progress_note: str
    satisfied: bool = False

    def to_dict(self):
        d = asdict(self)
        d['action'] = self.action.value
        return d


@dataclass
class TaskUpdate:
    # SEC-10: Maximum message length to prevent memory exhaustion
    MAX_MESSAGE_LENGTH = 10000

    task_id: str
    status: TaskStatus
    message: str
    screenshot_base64: Optional[str] = None
    iteration: int = 0
    prs_merged: int = 0
    elapsed_seconds: int = 0

    def __post_init__(self):
        # SEC-10: Truncate message if too long
        if self.message and len(self.message) > self.MAX_MESSAGE_LENGTH:
            self.message = self.message[:self.MAX_MESSAGE_LENGTH] + "...[truncated]"

    def to_dict(self):
        d = asdict(self)
        d['status'] = self.status.value
        return d


@dataclass
class TaskResult:
    task_id: str
    status: TaskStatus
    summary: str
    iterations: int
    prs_merged: int
    elapsed_seconds: int
    # LB-9: Use proper Optional type with default_factory to fix type mismatch
    output_files: Optional[List[str]] = field(default_factory=list)

    def to_dict(self):
        d = asdict(self)
        d['status'] = self.status.value
        if self.output_files is None:
            d['output_files'] = []
        return d


# Message types for WebSocket communication
MESSAGE_TYPES = {
    "NEW_TASK": "new_task",
    "TASK_UPDATE": "task_update",
    "TASK_RESULT": "task_result",
    "PLAN_PROPOSAL": "plan_proposal",
    "PLAN_APPROVED": "plan_approved",
    "PLAN_REJECTED": "plan_rejected",
    "USER_INPUT": "user_input",
    "PAUSE_TASK": "pause_task",
    "RESUME_TASK": "resume_task",
    "CANCEL_TASK": "cancel_task",
    "SCREENSHOT_REQUEST": "screenshot_request",
    "SCREENSHOT_RESPONSE": "screenshot_response",
    "CLAUDE_STREAM": "claude_stream",
}


def encode_message(msg_type: str, payload: dict) -> str:
    return json.dumps({"type": msg_type, "payload": payload})


def decode_message(raw: str) -> tuple:
    """Decode a message from JSON string.

    DL-4: Returns (None, None) on parse error instead of crashing.
    """
    try:
        data = json.loads(raw)
        # F65: Validate data is a dict before calling .get()
        if not isinstance(data, dict):
            return None, None
        return data.get("type"), data.get("payload", {})
    except (json.JSONDecodeError, TypeError, KeyError) as e:
        # DL-4: Return None tuple on error instead of crashing
        return None, None
