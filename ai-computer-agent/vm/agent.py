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


def load_config():
    from config import AgentConfig as CfgAgentConfig
    return CfgAgentConfig(
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://localhost:3000/agent"),
    )


def _is_feedback_loop_task(description: str) -> bool:
    """Detect whether a task should be handled by the feedback loop runner."""
    desc_lower = description.lower()
    return any(kw in desc_lower for kw in FEEDBACK_LOOP_KEYWORDS)


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
    """Run Claude Code CLI as an async subprocess (B7 fix)."""
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
    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
    return stdout.decode().strip()


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
        except json.JSONDecodeError:
            pass

    # Method 2: Find individual JSON objects with "action" field
    remaining = response
    while '"action"' in remaining:
        idx = remaining.find('{')
        if idx == -1:
            break
        obj_str = extract_json_object(remaining[idx:])
        if obj_str and '"action"' in obj_str:
            try:
                obj = json.loads(obj_str)
                if 'action' in obj:
                    steps.append(normalize_action(obj))
            except json.JSONDecodeError:
                pass
        remaining = remaining[idx + 1:]

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
    url_match = re.search(r'https?://\S+', task_description)
    if url_match:
        steps.append({"action": "open_url", "params": {"url": url_match.group(0)}})
        steps.append({"action": "wait", "params": {"seconds": 2}})

    # Check for text to type
    type_match = re.search(r'type\s+["\']?([^"\']+)["\']?|["\']([^"\']+)["\']', task_lower)
    if type_match:
        text = type_match.group(1) or type_match.group(2)
        steps.append({"action": "type", "params": {"text": text}})
    elif "hello world" in task_lower:
        steps.append({"action": "type", "params": {"text": "Hello World"}})

    if not steps:
        # H7: Return error instead of silently doing nothing
        logger.error(f"Could not create fallback plan for: {task_description[:100]}")
        return [{"action": "done", "params": {"error": f"Unrecognized task: {task_description[:200]}"}}]

    steps.append({"action": "done", "params": {}})

    return steps


class Agent:
    # Issue 26 fix: Max queue size to prevent memory leak during disconnection
    MAX_SEND_QUEUE_SIZE = 1000

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
        """Connect to host with exponential backoff."""
        backoff = 2
        max_backoff = 60
        while True:
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
            except Exception as e:
                logger.warning(f"Connection failed: {e}. Retrying in {backoff}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, max_backoff)

    async def _flush_send_queue(self):
        """Send any queued messages after reconnect. Issue 17/22 fix: Uses lock."""
        async with self._send_queue_lock:
            while self._send_queue and self.ws:
                msg = self._send_queue.pop(0)
                try:
                    await self.ws.send(msg)
                except Exception as e:
                    logger.error(f"Failed to flush queued message: {e}")
                    self._send_queue.insert(0, msg)
                    break

    async def _safe_send(self, msg: str):
        """H18: Send with error handling — queue on failure. Issue 17/22/26 fix: Uses lock and bounds queue."""
        try:
            if self.ws:
                await self.ws.send(msg)
            else:
                async with self._send_queue_lock:
                    # Issue 26 fix: Bound queue size to prevent memory leak
                    if len(self._send_queue) >= self.MAX_SEND_QUEUE_SIZE:
                        logger.warning(f"Send queue full ({self.MAX_SEND_QUEUE_SIZE}), dropping oldest message")
                        self._send_queue.pop(0)
                    self._send_queue.append(msg)
                async with self._reconnect_lock:
                    self._needs_reconnect = True
        except Exception as e:
            logger.error(f"Send failed, queuing: {e}")
            async with self._send_queue_lock:
                if len(self._send_queue) >= self.MAX_SEND_QUEUE_SIZE:
                    self._send_queue.pop(0)
                self._send_queue.append(msg)
            async with self._reconnect_lock:
                self._needs_reconnect = True

    async def send_update(self, update: TaskUpdate):
        msg = encode_message(MESSAGE_TYPES["TASK_UPDATE"], update.to_dict())
        await self._safe_send(msg)

    async def send_result(self, result: TaskResult):
        msg = encode_message(MESSAGE_TYPES["TASK_RESULT"], result.to_dict())
        await self._safe_send(msg)

    async def run_task(self, task: Task) -> TaskResult:
        """Execute task — dispatches to feedback loop or plan-based execution."""

        self.current_task = task
        self._cancelled = False
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
            desc_lower = task.description.lower()
            service_name = None
            for kw in FEEDBACK_LOOP_KEYWORDS:
                if kw in desc_lower and kw not in ("feedback loop", "feedback-loop"):
                    service_name = kw
                    break
            if not service_name:
                service_name = "target-v6"  # default

            # Issue 12: Parse and validate task context
            form_data = {}
            if task.context:
                try:
                    form_data = json.loads(task.context) if isinstance(task.context, str) else task.context
                except (json.JSONDecodeError, TypeError):
                    form_data = {"business": task.description}

            # Validate required fields for form submission
            required_fields = ["email"]
            missing = [f for f in required_fields if not form_data.get(f) and not form_data.get(f.capitalize())]
            if missing:
                logger.warning(
                    f"Task context missing required fields: {missing}. "
                    f"Form submission may fail. Context: {form_data}"
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

            result = await run_feedback_loop(
                service_name=service_name,
                form_data=form_data,
                railway_service_url=railway_url,
                health_check_url=railway_url,
                on_progress=on_progress,
            )

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
        await self.connect_to_host()
        print("Agent listening for tasks...")

        while True:
            try:
                # H16: add recv timeout with reconnect
                try:
                    message = await asyncio.wait_for(self.ws.recv(), timeout=120)
                except asyncio.TimeoutError:
                    # Send a ping to check connection liveness
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

                elif msg_type == MESSAGE_TYPES.get("PLAN_REJECTED", "plan_rejected"):
                    logger.info(f"Plan rejected: {payload.get('feedback', '')}")
                    self._cancelled = True

                elif msg_type == MESSAGE_TYPES.get("USER_INPUT", "user_input"):
                    logger.info(f"User input received: {payload.get('input', '')[:100]}")

                elif msg_type == MESSAGE_TYPES.get("SCREENSHOT_REQUEST", "screenshot_request"):
                    await self._handle_screenshot_request()

            except websockets.ConnectionClosed:
                logger.warning("Connection lost. Reconnecting...")
                await self.connect_to_host()
            except Exception as e:
                logger.error(f"Error: {e}")
                await asyncio.sleep(1)

    async def _execute_and_report(self, task: Task):
        """B10: Execute task and send result without blocking message loop."""
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
                elapsed_seconds=0,
            ))
        except Exception as e:
            logger.error(f"Task execution error: {e}")
            await self.send_result(TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary=f"Error: {e}",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=0,
            ))


async def main():
    config = load_config()

    # Verify Claude Code CLI (async)
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        print(f"Claude Code CLI: {stdout.decode().strip()}")
    except Exception as e:
        print(f"WARNING: Claude Code CLI check failed: {e}")
        print(f"  Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code")

    print(f"Host WebSocket URL: {config.host_ws_url}")
    print(f"ABORT: Move mouse to TOP-LEFT corner")

    agent = Agent(config)
    await agent.listen_for_tasks()


if __name__ == "__main__":
    asyncio.run(main())
