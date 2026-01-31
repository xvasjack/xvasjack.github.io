"""
AI Computer Agent - Simple plan-based automation

Architecture:
1. User submits task
2. Claude Code generates FULL plan (all steps) in ONE call
3. Agent executes steps sequentially - NO further Claude calls
4. Reports completion

Feedback loop tasks are dispatched to feedback_loop_runner.

This avoids the "conversational Claude" problem by only asking once.
"""

import asyncio
import json
import time
import os
import sys
import re
import platform
import shutil
from typing import Optional, List
from dataclasses import dataclass
import logging
import websockets

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.protocol import (
    Task, TaskStatus, TaskUpdate, TaskResult,
    MESSAGE_TYPES, encode_message, decode_message
)
from computer_use import execute_action, get_screen_context, screenshot
from guardrails import check_action
from config import CLAUDE_MODEL

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agent")


# Feedback-loop keywords — if task description matches, dispatch to feedback loop
FEEDBACK_LOOP_KEYWORDS = [
    "target-v3", "target-v4", "target-v5", "target-v6",
    "market-research", "profile-slides", "trading-comparable",
    "validation", "due-diligence", "utb", "feedback loop", "feedback-loop",
]


def _find_claude_cli() -> str:
    """Auto-detect claude CLI path. Falls back to 'claude'."""
    if shutil.which("claude"):
        return "claude"
    if platform.system() == "Windows":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            candidate = os.path.join(appdata, "npm", "claude.cmd")
            if os.path.isfile(candidate):
                return candidate
        try:
            import subprocess
            result = subprocess.run(
                ["npm", "root", "-g"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                npm_bin = os.path.dirname(result.stdout.strip())
                candidate = os.path.join(npm_bin, "claude.cmd")
                if os.path.isfile(candidate):
                    return candidate
        except Exception:
            pass
    return "claude"


def load_config():
    from config import AgentConfig as CfgAgentConfig
    claude_path = os.environ.get("CLAUDE_CODE_PATH") or _find_claude_cli()
    return CfgAgentConfig(
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://localhost:3000/agent"),
        claude_code_path=claude_path,
    )


def _is_feedback_loop_task(description: str) -> bool:
    """Detect whether a task should be handled by the feedback loop runner."""
    desc_lower = description.lower().replace(" ", "-")
    return any(kw in desc_lower for kw in FEEDBACK_LOOP_KEYWORDS)


async def _parse_task_intent(config, description: str) -> dict:
    """Parse user intent from description using Claude Code CLI (Max subscription).
    Falls back to keyword matching if CLI call fails.

    Returns dict with optional keys:
        start_from: "email_check" | "analyze" | None
        existing_file_path: str | None
        email_address: str | None
    """
    # Layer 1: Use Claude Code CLI for smart parsing (uses Max subscription, no API key)
    try:
        prompt = (
            f"Parse this task description and return ONLY a JSON object.\n\n"
            f"TASK: {description}\n\n"
            f"Extract these fields (omit if not mentioned):\n"
            f'- "start_from": "email_check" if user says results already emailed/received/sent '
            f'and wants to start from checking email. "analyze" if user says file already downloaded. '
            f"null if full loop from form submission.\n"
            f'- "existing_file_path": exact file path if user specifies one, null otherwise\n'
            f'- "email_address": email address if user mentions one, null otherwise\n\n'
            f'Return ONLY valid JSON, nothing else. '
            f'Example: {{"start_from": "email_check", "email_address": "user@gmail.com"}}'
        )

        output = await _run_claude_subprocess(config, prompt)
        import json as _json
        text = output.strip()
        start = text.find('{')
        end = text.rfind('}')
        if start >= 0 and end > start:
            parsed = _json.loads(text[start:end + 1])
            if parsed.get("start_from") not in (None, "email_check", "analyze"):
                parsed.pop("start_from", None)
            result = {k: v for k, v in parsed.items() if v is not None}
            logger.info(f"Claude intent parse: {result}")
            return result
    except Exception as e:
        logger.warning(f"Claude intent parsing failed, using keyword fallback: {e}")

    # Layer 2: Keyword fallback (always works, no external calls)
    desc_lower = description.lower()
    intent = {}

    email_skip = [
        "already been emailed", "already emailed", "already received",
        "result have already", "results have already",
        "start by opening the email", "start from email",
        "open the email", "check email first", "download the file",
        "start from download", "find the latest", "find the email",
    ]
    if any(phrase in desc_lower for phrase in email_skip):
        intent["start_from"] = "email_check"

    analyze_skip = [
        "already downloaded", "file is at", "file is in",
        "start from analy", "i have the file",
    ]
    if any(phrase in desc_lower for phrase in analyze_skip):
        if "start_from" not in intent:
            intent["start_from"] = "analyze"

    email_match = re.search(r'[\w.+-]+@[\w.-]+\.\w+', description)
    if email_match:
        intent["email_address"] = email_match.group()

    return intent


def get_plan_from_claude(config, task_description: str) -> List[dict]:
    """
    Call Claude Code ONCE to get a complete plan.
    Returns list of action dicts.
    """

    prompt = f"""WINDOWS DESKTOP AUTOMATION PLAN

TASK: {task_description}

Plan the exact sequence of mouse/keyboard interactions to complete this task on a Windows desktop.

CURRENT STATE: Desktop is visible. No apps are open unless specified in the task.

ACTION TYPES (use ONLY these):
- open_app: {{"action": "open_app", "params": {{"name": "notepad"}}}} — name = exact app name (notepad, brave, explorer, cmd)
- open_url: {{"action": "open_url", "params": {{"url": "https://example.com"}}}}
- type: {{"action": "type", "params": {{"text": "Hello World"}}}} — types text into focused field
- click: {{"action": "click", "params": {{"x": 500, "y": 300}}}} — pixel coordinates from screenshot
- press: {{"action": "press", "params": {{"key": "enter"}}}} — single key: enter, escape, tab, delete, f5
- hotkey: {{"action": "hotkey", "params": {{"keys": ["ctrl", "s"]}}}} — keyboard shortcut
- scroll: {{"action": "scroll", "params": {{"clicks": -3}}}} — negative=down, positive=up
- wait: {{"action": "wait", "params": {{"seconds": 2}}}} — pause for UI to load
- done: {{"action": "done", "params": {{}}}} — task complete (MUST be last step)

RULES:
1. Always add "wait" (1-3 seconds) after: opening apps, loading pages, submitting forms
2. Use "click" with approximate coordinates when UI element positions are predictable
3. Include "done" as the final step
4. If task is unclear or impossible, return: [{{"action": "done", "params": {{"error": "reason"}}}}]
5. Keep plans concise — minimum steps needed

Return ONLY a JSON array, nothing else:
[{{"action":"open_app","params":{{"name":"notepad"}}}},{{"action":"wait","params":{{"seconds":2}}}},{{"action":"type","params":{{"text":"Hello"}}}},{{"action":"done","params":{{}}}}]

JSON array:"""

    try:
        # B7/A2: Use asyncio.run() to create a new event loop in the executor thread
        # This avoids deadlock when called via run_in_executor from async context
        output = asyncio.run(_run_claude_subprocess(config, prompt))

        print(f"=== Claude Response ({len(output)} chars) ===")
        print(output[:2000])
        print("=== End Response ===")

        # Output is plain text from --message mode (no JSON wrapper)

        # Extract JSON array from response
        steps = extract_steps_from_response(output)

        if steps:
            print(f"Extracted {len(steps)} steps")
            return steps
        else:
            print("No valid steps found, using fallback")
            return create_fallback_plan(task_description)

    except Exception as e:
        logger.error(f"Claude call failed: {e}")
        return create_fallback_plan(task_description)


async def _run_claude_subprocess(config, prompt: str) -> str:
    """Run Claude Code CLI as an async subprocess (B7 fix). A6: Kill subprocess on timeout."""
    claude_path = config.claude_code_path if hasattr(config, 'claude_code_path') else "claude"
    cwd = config.repo_path if hasattr(config, 'repo_path') else os.getcwd()

    proc = await asyncio.create_subprocess_exec(
        claude_path,
        "--print",
        "--model", CLAUDE_MODEL,
        "--message", prompt,
        "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        return stdout.decode().strip()
    except asyncio.TimeoutError:
        # A6: Kill subprocess on timeout to prevent orphaned processes
        proc.kill()
        await proc.wait()  # Properly reap the process
        raise TimeoutError("Claude subprocess timed out after 120 seconds")
    except Exception:
        # RL-1: Ensure subprocess is reaped on ANY exception to prevent zombies
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass  # Best effort cleanup
        raise


def extract_balanced(text: str, open_char: str, close_char: str) -> Optional[str]:
    """Extract balanced brackets/braces from text"""
    start_idx = text.find(open_char)
    if start_idx == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i, char in enumerate(text[start_idx:], start_idx):
        if escape_next:
            escape_next = False
            continue
        if char == '\\' and in_string:
            escape_next = True
            continue
        if char == '"' and not escape_next:
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == open_char:
            depth += 1
        elif char == close_char:
            depth -= 1
            if depth == 0:
                return text[start_idx:i+1]
    return None


def extract_json_array(text: str) -> Optional[str]:
    """Extract JSON array by tracking bracket depth"""
    return extract_balanced(text, '[', ']')


def extract_json_object(text: str) -> Optional[str]:
    """Extract JSON object by tracking brace depth"""
    return extract_balanced(text, '{', '}')


def extract_steps_from_response(response: str) -> List[dict]:
    """Extract action steps from Claude's response (handles various formats)"""

    # SEC-5: Limit response size to prevent memory exhaustion
    MAX_RESPONSE_SIZE = 1_000_000  # 1MB max
    if len(response) > MAX_RESPONSE_SIZE:
        logger.warning(f"Response too large ({len(response)} bytes), truncating to {MAX_RESPONSE_SIZE}")
        response = response[:MAX_RESPONSE_SIZE]

    steps = []

    # Method 1: Try to find a JSON array by tracking bracket depth
    array_str = extract_json_array(response)
    if array_str:
        try:
            arr = json.loads(array_str)
            if isinstance(arr, list) and len(arr) > 0:
                for item in arr:
                    if isinstance(item, dict) and 'action' in item:
                        steps.append(normalize_action(item))
                if steps:
                    return steps
        except json.JSONDecodeError as e:
            # C1: Log JSON parse failures instead of silent pass
            logger.debug(f"JSON array parse failed: {e}")

    # Method 2: Find individual JSON objects with "action" field
    # C2: Add iteration limit to prevent CPU hang on malformed input
    MAX_EXTRACTION_ITERATIONS = 100
    remaining = response
    iterations = 0
    while '"action"' in remaining and iterations < MAX_EXTRACTION_ITERATIONS:
        iterations += 1
        idx = remaining.find('{')
        if idx == -1:
            break
        obj_str = extract_json_object(remaining[idx:])
        if obj_str and '"action"' in obj_str:
            try:
                obj = json.loads(obj_str)
                if 'action' in obj:
                    steps.append(normalize_action(obj))
            except json.JSONDecodeError as e:
                # C1: Log JSON parse failures instead of silent pass
                logger.debug(f"JSON object parse failed: {e}")
        remaining = remaining[idx + 1:]
    if iterations >= MAX_EXTRACTION_ITERATIONS:
        logger.warning(f"JSON extraction hit iteration limit ({MAX_EXTRACTION_ITERATIONS})")

    if steps:
        return steps

    # Method 3: Look for action keywords and construct steps
    response_lower = response.lower()
    if 'notepad' in response_lower:
        steps.append({"action": "open_app", "params": {"name": "notepad"}})
    elif 'chrome' in response_lower or 'browser' in response_lower or 'brave' in response_lower:
        steps.append({"action": "open_app", "params": {"name": "brave"}})

    # Look for text to type in quotes
    text_match = re.search(r'["\']([^"\']+)["\']', response)
    if text_match and ('type' in response_lower or 'write' in response_lower or 'hello' in response_lower):
        steps.append({"action": "type", "params": {"text": text_match.group(1)}})

    return steps


# Valid action types the agent can execute
VALID_ACTIONS = {
    "open_app", "open_url", "type", "click", "double_click", "right_click",
    "press", "hotkey", "scroll", "wait", "focus_window", "done",
}


def normalize_action(action: dict) -> dict:
    """Normalize action format and validate action type"""
    action_name = action.get("action", "")
    result = {
        "action": action_name,
        "params": action.get("params", {}),
    }

    # Handle nested coordinates (L5: handle both dict and list formats)
    if "coordinates" in result["params"]:
        coords = result["params"]["coordinates"]
        if isinstance(coords, dict):
            result["params"]["x"] = coords.get("x", 0)
            result["params"]["y"] = coords.get("y", 0)
        elif isinstance(coords, (list, tuple)) and len(coords) >= 2:
            result["params"]["x"] = coords[0]
            result["params"]["y"] = coords[1]
        del result["params"]["coordinates"]

    # Handle target -> name mapping for open_app
    if "target" in result["params"] and "name" not in result["params"]:
        result["params"]["name"] = result["params"]["target"]

    # Validate action type
    if action_name not in VALID_ACTIONS:
        logger.warning(f"Unknown action type: {action_name}, skipping")
        result["action"] = "wait"
        result["params"] = {"seconds": 0.5}

    return result


def create_fallback_plan(task_description: str) -> List[dict]:
    """Create a simple fallback plan based on keywords (H7: report failure for unknown tasks)"""

    # SEC-3: Maximum URL length to prevent memory issues
    MAX_URL_LENGTH = 2048
    # SEC-3: Maximum text extraction length
    MAX_TEXT_LENGTH = 1000

    steps = []
    task_lower = task_description.lower()

    # Check for common patterns
    if "notepad" in task_lower:
        steps.append({"action": "open_app", "params": {"name": "notepad"}})
        steps.append({"action": "wait", "params": {"seconds": 2}})

    if "chrome" in task_lower or "browser" in task_lower or "brave" in task_lower:
        steps.append({"action": "open_app", "params": {"name": "brave"}})
        steps.append({"action": "wait", "params": {"seconds": 2}})

    # L6: Extract URL before lowercasing to preserve case-sensitive paths
    # SEC-3: Use safer regex that stops at whitespace/common delimiters and limit length
    url_match = re.search(r'https?://[^\s<>"\')\]]+', task_description[:10000])
    if url_match:
        url = url_match.group(0).rstrip('.,;:!?')  # Strip trailing punctuation
        if len(url) <= MAX_URL_LENGTH:
            steps.append({"action": "open_url", "params": {"url": url}})
            steps.append({"action": "wait", "params": {"seconds": 2}})

    # Check for text to type
    # SEC-3: Limit search scope and text length
    type_match = re.search(r'type\s+["\']?([^"\']{1,1000})["\']?|["\']([^"\']{1,1000})["\']', task_lower[:5000])
    if type_match:
        text = type_match.group(1) or type_match.group(2)
        if text and len(text) <= MAX_TEXT_LENGTH:
            steps.append({"action": "type", "params": {"text": text}})
    elif "hello world" in task_lower:
        steps.append({"action": "type", "params": {"text": "Hello World"}})

    if not steps:
        # H7: Return error instead of silently doing nothing
        logger.error(f"Could not create fallback plan for: {task_description[:100]}")
        # SEC-1: Sanitize task description to prevent log injection
        sanitized_desc = task_description[:200].replace('\n', ' ').replace('\r', ' ')
        return [{"action": "done", "params": {"error": f"Unrecognized task: {sanitized_desc}"}}]

    steps.append({"action": "done", "params": {}})

    return steps


class Agent:
    # Issue 26 fix: Max queue size to prevent memory leak during disconnection
    MAX_SEND_QUEUE_SIZE = 1000
    # A2: Max connection retries before giving up
    MAX_CONNECT_RETRIES = 10

    def __init__(self, config):
        self.config = config
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.current_task: Optional[Task] = None
        # Issue 24/40 fix: Use asyncio.Event for thread-safe cancellation
        self._cancelled_event = asyncio.Event()
        self._current_task_handle: Optional[asyncio.Task] = None  # B10: task handle
        self._send_queue: List[str] = []  # H18: queue for retry
        # Issue 17/22 fix: Add asyncio.Lock for _send_queue synchronization
        self._send_queue_lock = asyncio.Lock()
        self._needs_reconnect = False
        # Issue 23 fix: Lock for reconnect flag
        self._reconnect_lock = asyncio.Lock()
        # A1: Shutdown event for graceful termination
        self._shutdown_event = asyncio.Event()
        # D9: Task lock for concurrent task handling
        self._task_lock = asyncio.Lock()
        # A1: Initialize _ping_counter to avoid hasattr race condition
        self._ping_counter = 0
        self._ping_counter_lock = asyncio.Lock()
        # Plan approval flow
        self._plan_event = asyncio.Event()
        self._plan_approved = False

    @property
    def _cancelled(self) -> bool:
        """Property accessor for backwards compatibility"""
        return self._cancelled_event.is_set()

    @_cancelled.setter
    def _cancelled(self, value: bool):
        """Property setter for backwards compatibility"""
        if value:
            self._cancelled_event.set()
        else:
            self._cancelled_event.clear()

    async def close(self):
        """Issue 16 fix: Properly close WebSocket connection on shutdown"""
        if self.ws:
            try:
                await self.ws.close()
                logger.info("WebSocket connection closed")
            except Exception as e:
                logger.warning(f"Error closing WebSocket: {e}")
            finally:
                self.ws = None

    async def connect_to_host(self):
        """Connect to host with exponential backoff. A2: Add max retries and shutdown check."""
        backoff = 2
        max_backoff = 60
        retries = 0
        while retries < self.MAX_CONNECT_RETRIES:
            # A2: Check for shutdown signal
            if self._shutdown_event.is_set():
                raise asyncio.CancelledError("Shutdown requested during connect")
            try:
                # H17: add connect timeout
                self.ws = await websockets.connect(
                    self.config.host_ws_url,
                    open_timeout=10,
                )
                logger.info(f"Connected to host at {self.config.host_ws_url}")
                # Flush queued messages on reconnect
                await self._flush_send_queue()
                return
            except asyncio.CancelledError:
                raise  # Don't retry on cancellation
            except Exception as e:
                retries += 1
                if retries >= self.MAX_CONNECT_RETRIES:
                    raise ConnectionError(f"Failed to connect after {retries} retries: {e}")
                logger.warning(f"Connection failed ({retries}/{self.MAX_CONNECT_RETRIES}): {e}. Retrying in {backoff}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)

    async def _flush_send_queue(self):
        """Send any queued messages after reconnect. Issue 17/22 fix: Uses lock. B1: Fix TOCTOU race."""
        # RC-4: Avoid nested locks by tracking need_reconnect outside the queue lock
        need_reconnect = False
        async with self._send_queue_lock:
            # B1: Capture local reference to prevent race condition if ws becomes None
            ws = self.ws
            while self._send_queue and ws:
                msg = self._send_queue.pop(0)
                try:
                    await ws.send(msg)
                except asyncio.CancelledError:
                    # EH-1: CancelledError must be propagated, not swallowed
                    self._send_queue.insert(0, msg)  # Put message back before re-raising
                    raise
                except Exception as e:
                    logger.error(f"Failed to flush queued message: {e}")
                    self._send_queue.insert(0, msg)
                    # DL-1: Mark for reconnect and exit loop
                    need_reconnect = True
                    break
        # RC-4: Acquire reconnect lock after releasing queue lock to avoid nested locking
        if need_reconnect:
            async with self._reconnect_lock:
                self._needs_reconnect = True

    async def _safe_send(self, msg: str):
        """H18: Send with error handling — queue on failure. A4: Fix TOCTOU race with local reference."""
        # A4: Capture local reference to prevent race condition
        ws = self.ws
        try:
            # RC-1: Wrap send in try/except to handle TOCTOU race where ws closes between check and send
            if ws and not getattr(ws, 'closed', True):
                try:
                    await ws.send(msg)
                    return  # Success, no need to queue
                except websockets.ConnectionClosed:
                    # RC-1: Connection closed during send - fall through to queue
                    logger.debug("WebSocket closed during send, queuing message")
            # Queue message for retry
            async with self._send_queue_lock:
                # Issue 26 fix: Bound queue size to prevent memory leak
                if len(self._send_queue) >= self.MAX_SEND_QUEUE_SIZE:
                    logger.warning(f"Send queue full ({self.MAX_SEND_QUEUE_SIZE}), dropping oldest message")
                    self._send_queue.pop(0)
                self._send_queue.append(msg)
            # RC-2: Always use lock when accessing _needs_reconnect
            async with self._reconnect_lock:
                self._needs_reconnect = True
        except (AttributeError, websockets.ConnectionClosed) as e:
            # A4: Handle case where ws becomes None or closed during send
            logger.warning(f"WebSocket unavailable during send: {e}")
            async with self._send_queue_lock:
                if len(self._send_queue) >= self.MAX_SEND_QUEUE_SIZE:
                    self._send_queue.pop(0)
                self._send_queue.append(msg)
            # RC-2: Always use lock when accessing _needs_reconnect
            async with self._reconnect_lock:
                self._needs_reconnect = True
        except asyncio.CancelledError:
            # EH-1: CancelledError must be propagated, not swallowed
            raise
        except (OSError, IOError, ConnectionError) as e:
            # Expected network errors - handle gracefully by queuing
            logger.error(f"Send failed (network error), queuing: {e}")
            async with self._send_queue_lock:
                if len(self._send_queue) >= self.MAX_SEND_QUEUE_SIZE:
                    self._send_queue.pop(0)
                self._send_queue.append(msg)
            # RC-2: Always use lock when accessing _needs_reconnect
            async with self._reconnect_lock:
                self._needs_reconnect = True
        except Exception as e:
            # LB-11: Log unexpected exceptions but re-raise to avoid masking bugs
            logger.error(f"Unexpected error in send: {e}", exc_info=True)
            raise

    async def send_update(self, update: TaskUpdate):
        msg = encode_message(MESSAGE_TYPES["TASK_UPDATE"], update.to_dict())
        await self._safe_send(msg)

    async def send_result(self, result: TaskResult):
        msg = encode_message(MESSAGE_TYPES["TASK_RESULT"], result.to_dict())
        await self._safe_send(msg)

    async def _wait_for_plan_approval(self, task: Task, plan_summary: str, start_time: float) -> Optional[TaskResult]:
        """Send plan proposal and wait for user approval/rejection.
        Returns None if approved, TaskResult if rejected/timed out/cancelled."""
        # Send plan proposal to host
        msg = encode_message(MESSAGE_TYPES.get("PLAN_PROPOSAL", "plan_proposal"), {
            "task_id": task.id,
            "plan": plan_summary,
        })
        await self._safe_send(msg)

        # Wait for approval/rejection
        self._plan_event.clear()
        self._plan_approved = False

        try:
            await asyncio.wait_for(self._plan_event.wait(), timeout=300)
        except asyncio.TimeoutError:
            elapsed = int(time.time() - start_time)
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Plan approval timed out after 300 seconds",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=elapsed,
            )

        if self._cancelled:
            elapsed = int(time.time() - start_time)
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Cancelled during plan approval",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=elapsed,
            )

        if not self._plan_approved:
            elapsed = int(time.time() - start_time)
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Plan rejected by user",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=elapsed,
            )

        return None  # Approved, continue execution

    async def run_task(self, task: Task) -> TaskResult:
        """Execute task — dispatches to feedback loop or plan-based execution."""

        self.current_task = task
        self._cancelled = False
        self._plan_event.clear()
        self._plan_approved = False
        start_time = time.time()

        logger.info(f"=== Starting task: {task.description} ===")

        # B1: Dispatch feedback-loop tasks to feedback_loop_runner
        if _is_feedback_loop_task(task.description):
            return await self._run_feedback_loop_task(task, start_time)

        # Regular plan-based execution
        return await self._run_plan_task(task, start_time)

    async def _run_feedback_loop_task(self, task: Task, start_time: float) -> TaskResult:
        """B1: Run a feedback-loop task."""
        logger.info("Dispatching to feedback loop runner")

        try:
            from feedback_loop_runner import run_feedback_loop

            # Extract service name and form data from task description
            desc_lower = task.description.lower().replace(" ", "-")
            service_name = None
            for kw in FEEDBACK_LOOP_KEYWORDS:
                if kw in desc_lower and kw not in ("feedback loop", "feedback-loop"):
                    service_name = kw
                    break
            if not service_name:
                elapsed = int(time.time() - start_time)
                return TaskResult(
                    task_id=task.id, status=TaskStatus.FAILED,
                    summary=f"Could not detect service name from description. Include a service keyword: {', '.join(FEEDBACK_LOOP_KEYWORDS)}",
                    iterations=0, prs_merged=0, elapsed_seconds=elapsed,
                )

            # Issue 12: Parse and validate task context
            form_data = {}
            if task.context:
                try:
                    form_data = json.loads(task.context) if isinstance(task.context, str) else task.context
                except (json.JSONDecodeError, TypeError):
                    form_data = {"business": task.description}

            # Parse user intent from description (uses Claude Code CLI or keyword fallback)
            user_intent = await _parse_task_intent(self.config, task.description)
            logger.info(f"Parsed task intent: {user_intent}")

            # Apply intent: fill gaps in form_data (don't override explicit JSON context)
            if "start_from" not in form_data and "start_from" in user_intent:
                form_data["start_from"] = user_intent["start_from"]
            if "email_address" in user_intent:
                if not form_data.get("Email") and not form_data.get("email"):
                    form_data["Email"] = user_intent["email_address"]

            # Validate required fields for form submission
            if not form_data.get("Email") and not form_data.get("email"):
                elapsed = int(time.time() - start_time)
                return TaskResult(
                    task_id=task.id, status=TaskStatus.FAILED,
                    summary="Missing required 'Email' in form_data. Provide task context as JSON with Email, Business, Country fields.",
                    iterations=0, prs_merged=0, elapsed_seconds=elapsed,
                )

            async def on_progress(state, message, iteration=0, prs_merged=0):
                await self.send_update(TaskUpdate(
                    task_id=task.id,
                    status=TaskStatus.RUNNING,
                    message=f"[{state}] {message}",
                    iteration=iteration,
                    prs_merged=prs_merged,
                    elapsed_seconds=int(time.time() - start_time),
                ))

            from actions.frontend_api import RAILWAY_URLS
            railway_url = RAILWAY_URLS.get(service_name)

            # Build readable plan summary for user approval
            form_summary = ", ".join(f"{k}={v}" for k, v in form_data.items()
                                     if k not in ("start_from", "existing_file_path"))

            start_from_mode = form_data.get("start_from")
            if start_from_mode == "email_check":
                steps_list = [
                    "1. Skip form submission (results already sent)",
                    "2. Check email for output attachment",
                    "3. Download and analyze against template",
                    "4. Generate code fix via Claude Code",
                    "5. Create PR, CI, merge",
                    "6. Wait for deploy",
                    "7. Re-submit form, repeat until output matches template",
                ]
                mode_label = "Start from email"
            elif start_from_mode == "analyze":
                steps_list = [
                    "1. Skip form + email (file already available)",
                    "2. Analyze file against template",
                    "3. Generate code fix via Claude Code",
                    "4. Create PR, CI, merge",
                    "5. Wait for deploy",
                    "6. Re-submit form, repeat until output matches template",
                ]
                mode_label = "Start from analysis"
            else:
                steps_list = [
                    "1. Submit form on frontend",
                    "2. Wait for email output",
                    "3. Analyze against template",
                    "4. Generate code fix via Claude Code",
                    "5. Create PR, CI, merge",
                    "6. Wait for deploy",
                    "7. Repeat until output matches template",
                ]
                mode_label = "Full loop"

            plan_summary = (
                f"Feedback Loop: {service_name}\n"
                f"Mode: {mode_label}\n"
                f"Form: {form_summary}\n"
                f"Railway: {railway_url or 'browser fallback'}\n"
                f"Steps:\n"
                + "\n".join(f"  {s}" for s in steps_list)
                + f"\nMax iterations: 10"
            )
            approval_result = await self._wait_for_plan_approval(task, plan_summary, start_time)
            if approval_result is not None:
                return approval_result

            # Extract skip params
            start_from = form_data.pop("start_from", None)
            existing_file_path = form_data.pop("existing_file_path", None)

            # T1: Create cancel_token linked to agent's cancellation state
            cancel_token = {"cancelled": False}

            # Monitor cancellation in background
            async def _monitor_cancel():
                while not cancel_token["cancelled"]:
                    if self._cancelled:
                        cancel_token["cancelled"] = True
                        break
                    await asyncio.sleep(0.5)

            cancel_monitor = asyncio.create_task(_monitor_cancel())

            try:
                result = await run_feedback_loop(
                    service_name=service_name,
                    form_data=form_data,
                    railway_service_url=railway_url,
                    health_check_url=railway_url,
                    on_progress=on_progress,
                    start_from=start_from,
                    existing_file_path=existing_file_path,
                    cancel_token=cancel_token,
                )
            finally:
                cancel_token["cancelled"] = True
                cancel_monitor.cancel()
                try:
                    await cancel_monitor
                except asyncio.CancelledError:
                    pass

            # A5: Normalize result — handle both object attrs and dict access
            if hasattr(result, 'success'):
                _success = result.success
                _summary = result.summary
                _iterations = result.iterations
                _prs_merged = result.prs_merged
            elif isinstance(result, dict):
                _success = result.get("success", False)
                _summary = result.get("summary", "")
                _iterations = result.get("iterations", 0)
                _prs_merged = result.get("prs_merged", 0)
            else:
                _success = False
                _summary = f"Unexpected result type: {type(result)}"
                _iterations = 0
                _prs_merged = 0

            elapsed = int(time.time() - start_time)
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.COMPLETED if _success else TaskStatus.FAILED,
                summary=_summary,
                iterations=_iterations,
                prs_merged=_prs_merged,
                elapsed_seconds=elapsed,
            )

        except Exception as e:
            logger.error(f"Feedback loop failed: {e}")
            elapsed = int(time.time() - start_time)
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary=f"Feedback loop error: {e}",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=elapsed,
            )

    async def _run_plan_task(self, task: Task, start_time: float) -> TaskResult:
        """Run a plan-based task."""

        # Step 1: Get complete plan from Claude (ONE call)
        print("\n>>> Getting plan from Claude...")
        # Issue 19 fix: Add timeout to run_in_executor to prevent indefinite hang
        try:
            steps = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None, get_plan_from_claude, self.config, task.description
                ),
                timeout=180  # 3 minute timeout for plan generation
            )
        except asyncio.TimeoutError:
            logger.error("Plan generation timed out after 180 seconds")
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Plan generation timed out",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=int(time.time() - start_time),
            )

        if not steps:
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Could not generate plan",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=int(time.time() - start_time),
            )

        # L4: flag if fallback
        is_fallback = (len(steps) == 1 and steps[0].get("params", {}).get("error"))
        if is_fallback:
            logger.warning(f"Using fallback plan: {steps[0]['params'].get('error', '')}")

        print(f"\n>>> Plan has {len(steps)} steps:")
        for i, step in enumerate(steps):
            print(f"  {i+1}. {step['action']}: {step.get('params', {})}")

        # Plan approval: format steps and wait for user
        plan_lines = []
        for i, step in enumerate(steps):
            params = step.get('params', {})
            param_summary = ", ".join(f"{k}={v}" for k, v in params.items()) if params else ""
            plan_lines.append(f"Step {i+1}: {step['action']} - {param_summary}")
        plan_summary = "\n".join(plan_lines)
        approval_result = await self._wait_for_plan_approval(task, plan_summary, start_time)
        if approval_result is not None:
            return approval_result

        # Step 2: Execute each step
        for i, step in enumerate(steps):
            # B9: Check cancellation between steps
            if self._cancelled:
                elapsed = int(time.time() - start_time)
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.FAILED,
                    summary="Task cancelled by user",
                    iterations=i,
                    prs_merged=0,
                    elapsed_seconds=elapsed,
                )

            elapsed = int(time.time() - start_time)
            action_name = step.get('action', 'unknown')

            print(f"\n>>> Executing step {i+1}/{len(steps)}: {action_name}")

            # Send progress update
            await self.send_update(TaskUpdate(
                task_id=task.id,
                status=TaskStatus.RUNNING,
                message=f"Step {i+1}: {action_name}",
                screenshot_base64="",
                iteration=i+1,
                prs_merged=0,
                elapsed_seconds=elapsed,
            ))

            # Check if done
            if action_name == "done":
                error_msg = step.get("params", {}).get("error")
                if error_msg:
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.FAILED,
                        summary=f"Fallback plan error: {error_msg}",
                        iterations=i+1,
                        prs_merged=0,
                        elapsed_seconds=elapsed,
                    )
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.COMPLETED,
                    summary=f"Completed {i} steps successfully",
                    iterations=i+1,
                    prs_merged=0,
                    elapsed_seconds=elapsed,
                )

            # Check guardrails
            context = await get_screen_context()
            guardrail = check_action(
                step,
                current_window_title=context.window_title,
                current_url=context.window_url,
            )

            if not guardrail.allowed:
                logger.error(f"BLOCKED: {guardrail.message}")
                continue

            # Execute action
            try:
                result = await execute_action(step)
                if result.get("success"):
                    logger.info(f"Step {i+1} succeeded")
                else:
                    logger.warning(f"Step {i+1} failed: {result.get('error')}")
            except Exception as e:
                logger.error(f"Step {i+1} error: {e}")

            # Small delay between steps
            await asyncio.sleep(0.5)

        # All steps completed
        elapsed = int(time.time() - start_time)
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.COMPLETED,
            summary=f"Executed {len(steps)} steps",
            iterations=len(steps),
            prs_merged=0,
            elapsed_seconds=elapsed,
        )

    async def _handle_screenshot_request(self):
        """B8: Handle screenshot_request message."""
        try:
            screen = await screenshot()
            msg = encode_message(MESSAGE_TYPES.get("SCREENSHOT_RESPONSE", "screenshot_response"), {
                "screenshot": screen,
            })
            await self._safe_send(msg)
        except Exception as e:
            logger.error(f"Screenshot request failed: {e}")

    async def listen_for_tasks(self):
        """A1: Listen loop with shutdown event check."""
        await self.connect_to_host()
        print("Agent listening for tasks...")

        # A1: Check shutdown event in loop condition
        while not self._shutdown_event.is_set():
            try:
                # H16: add recv timeout with reconnect (A1: shorter timeout to check shutdown)
                try:
                    message = await asyncio.wait_for(self.ws.recv(), timeout=5)
                except asyncio.TimeoutError:
                    # A1: Check shutdown on timeout
                    if self._shutdown_event.is_set():
                        break
                    # Send a ping to check connection liveness (only every ~24 timeouts = ~2min)
                    # A1: Use lock-protected increment instead of hasattr check
                    async with self._ping_counter_lock:
                        self._ping_counter += 1
                        should_ping = self._ping_counter >= 24
                        if should_ping:
                            self._ping_counter = 0
                    if should_ping:
                        try:
                            pong = await self.ws.ping()
                            await asyncio.wait_for(pong, timeout=10)
                        except Exception:
                            logger.warning("Connection stale (recv timeout). Reconnecting...")
                            await self.connect_to_host()
                    continue

                msg_type, payload = decode_message(message)

                if msg_type == MESSAGE_TYPES.get("NEW_TASK", "new_task"):
                    task = Task.from_dict(payload)
                    logger.info(f"Received task: {task.id}")
                    # D9: Use lock for concurrent task handling
                    async with self._task_lock:
                        # A4: Cancel previous task before replacing to prevent memory leak
                        if self._current_task_handle and not self._current_task_handle.done():
                            logger.warning("Already processing a task, cancelling previous task")
                            self._current_task_handle.cancel()
                            try:
                                await asyncio.wait_for(self._current_task_handle, timeout=2)
                            except (asyncio.TimeoutError, asyncio.CancelledError):
                                pass  # Task cancelled or timed out, proceed
                        # B10: Run task in separate asyncio.Task so message loop continues
                        self._current_task_handle = asyncio.create_task(
                            self._execute_and_report(task)
                        )

                elif msg_type == MESSAGE_TYPES.get("CANCEL_TASK", "cancel_task"):
                    # B9: Set cancellation flag
                    logger.info("Task cancellation requested")
                    self._cancelled = True
                    if self._current_task_handle and not self._current_task_handle.done():
                        self._current_task_handle.cancel()

                # B8: Handle additional message types
                elif msg_type == MESSAGE_TYPES.get("PLAN_APPROVED", "plan_approved"):
                    logger.info("Plan approved by host")
                    self._plan_approved = True
                    self._plan_event.set()

                elif msg_type == MESSAGE_TYPES.get("PLAN_REJECTED", "plan_rejected"):
                    logger.info(f"Plan rejected: {payload.get('feedback', '')}")
                    self._plan_approved = False
                    self._plan_event.set()

                elif msg_type == MESSAGE_TYPES.get("USER_INPUT", "user_input"):
                    logger.info(f"User input received: {payload.get('input', '')[:100]}")

                elif msg_type == MESSAGE_TYPES.get("SCREENSHOT_REQUEST", "screenshot_request"):
                    await self._handle_screenshot_request()

                elif msg_type == MESSAGE_TYPES.get("SHUTDOWN", "shutdown"):
                    logger.info("Shutdown requested by host")
                    self._shutdown_event.set()
                    break

            except websockets.ConnectionClosed:
                logger.warning("Connection lost. Reconnecting...")
                # T3: Unblock any pending plan approval to prevent 300s hang
                self._plan_approved = False
                self._plan_event.set()
                if self._shutdown_event.is_set():
                    break
                await self.connect_to_host()
            except Exception as e:
                logger.error(f"Error: {e}")
                # B1: Close WebSocket on exception before retry
                await self.close()
                if self._shutdown_event.is_set():
                    break
                await asyncio.sleep(1)
                try:
                    await self.connect_to_host()
                except ConnectionError:
                    logger.error("Failed to reconnect, shutting down")
                    break

        # A1: Cleanup on shutdown
        logger.info("Listen loop terminated, cleaning up...")
        await self.close()

    async def _execute_and_report(self, task: Task):
        """B10: Execute task and send result without blocking message loop."""
        _start = time.time()
        try:
            result = await self.run_task(task)
            await self.send_result(result)
        except asyncio.CancelledError:
            logger.info("Task was cancelled")
            await self.send_result(TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Task cancelled",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=int(time.time() - _start),
            ))
        except Exception as e:
            logger.error(f"Task execution error: {e}")
            await self.send_result(TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary=f"Error: {e}",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=int(time.time() - _start),
            ))


async def main():
    config = load_config()

    # Verify Claude Code CLI (async)
    try:
        proc = await asyncio.create_subprocess_exec(
            config.claude_code_path, "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        print(f"Claude Code CLI: {stdout.decode().strip()} (path: {config.claude_code_path})")
    except Exception as e:
        print(f"WARNING: Claude Code CLI check failed: {e}")
        print(f"  Tried path: {config.claude_code_path}")
        print(f"  Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code")

    print(f"Host WebSocket URL: {config.host_ws_url}")
    print(f"ABORT: Move mouse to TOP-LEFT corner")

    agent = Agent(config)

    # A1: Setup signal handlers for graceful shutdown
    import signal

    def signal_handler(sig, frame):
        logger.info(f"Received signal {sig}, initiating shutdown...")
        agent._shutdown_event.set()

    # Register signal handlers (works on Unix, limited on Windows)
    try:
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
    except (AttributeError, ValueError):
        pass  # Windows may not support all signals

    try:
        await agent.listen_for_tasks()
    except asyncio.CancelledError:
        # C3: Re-raise CancelledError after cleanup to allow proper cancellation propagation
        logger.info("Main task cancelled")
        raise
    except ConnectionError as e:
        logger.error(f"Connection error: {e}")
    finally:
        await agent.close()


if __name__ == "__main__":
    asyncio.run(main())
