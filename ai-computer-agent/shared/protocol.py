"""
Shared protocol definitions for Host <-> VM communication.
"""

from dataclasses import dataclass, asdict
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

    @classmethod
    def from_dict(cls, d: dict):
        d['status'] = TaskStatus(d['status'])
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
    task_id: str
    status: TaskStatus
    message: str
    screenshot_base64: Optional[str] = None
    iteration: int = 0
    prs_merged: int = 0
    elapsed_seconds: int = 0

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
    output_files: List[str] = None

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
}


def encode_message(msg_type: str, payload: dict) -> str:
    return json.dumps({"type": msg_type, "payload": payload})


def decode_message(raw: str) -> tuple:
    data = json.loads(raw)
    return data["type"], data["payload"]
