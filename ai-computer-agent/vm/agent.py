"""
AI Computer Agent - Simple plan-based automation

Architecture:
1. User submits task
2. Claude Code generates FULL plan (all steps) in ONE call
3. Agent executes steps sequentially - NO further Claude calls
4. Reports completion

This avoids the "conversational Claude" problem by only asking once.
"""

import asyncio
import json
import time
import os
import sys
import subprocess
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
from computer_use import execute_action, get_screen_context
from guardrails import check_action

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agent")


@dataclass
class AgentConfig:
    host_ws_url: str = "ws://192.168.1.100:3000/agent"
    claude_code_path: str = "claude"
    working_dir: str = ""


def load_config() -> AgentConfig:
    return AgentConfig(
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://192.168.1.100:3000/agent"),
        claude_code_path=os.environ.get("CLAUDE_CODE_PATH", "claude"),
        working_dir=os.environ.get("WORKING_DIR", os.getcwd()),
    )


def get_plan_from_claude(config: AgentConfig, task_description: str) -> List[dict]:
    """
    Call Claude Code ONCE to get a complete plan.
    Returns list of action dicts.
    """

    prompt = f"""I need to automate this Windows task: {task_description}

Write a JSON array of steps. Each step is an object with:
- "action": one of "open_app", "type", "press", "hotkey", "wait", "done"
- "params": parameters for the action

Examples:
- {{"action": "open_app", "params": {{"name": "notepad"}}}}
- {{"action": "type", "params": {{"text": "Hello World"}}}}
- {{"action": "press", "params": {{"key": "enter"}}}}
- {{"action": "hotkey", "params": {{"keys": ["ctrl", "s"]}}}}
- {{"action": "wait", "params": {{"seconds": 1}}}}
- {{"action": "done", "params": {{}}}}

Return ONLY the JSON array, nothing else. Example:
[{{"action":"open_app","params":{{"name":"notepad"}}}},{{"action":"type","params":{{"text":"Hello"}}}},{{"action":"done","params":{{}}}}]

JSON array:"""

    try:
        result = subprocess.run(
            [
                config.claude_code_path,
                "--print",
                "--output-format", "json",
                "--dangerously-skip-permissions",
                "-p", prompt,
            ],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=config.working_dir,
        )

        output = result.stdout.strip()
        print(f"=== Claude Response ({len(output)} chars) ===")
        print(output[:2000])
        print("=== End Response ===")

        # Parse Claude Code's JSON wrapper
        try:
            cli_response = json.loads(output)
            if isinstance(cli_response, dict) and 'result' in cli_response:
                output = cli_response['result']
        except json.JSONDecodeError:
            pass

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


def extract_json_array(text: str) -> Optional[str]:
    """Extract JSON array by tracking bracket depth (handles nested arrays)"""
    start_idx = text.find('[')
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
        if char == '[':
            depth += 1
        elif char == ']':
            depth -= 1
            if depth == 0:
                return text[start_idx:i+1]
    return None


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
    for match in re.finditer(r'\{[^{}]*"action"[^{}]*\}', response):
        try:
            obj = json.loads(match.group())
            if 'action' in obj:
                steps.append(normalize_action(obj))
        except json.JSONDecodeError:
            continue

    if steps:
        return steps

    # Method 3: Look for action keywords and construct steps
    response_lower = response.lower()
    if 'notepad' in response_lower:
        steps.append({"action": "open_app", "params": {"name": "notepad"}})
    elif 'chrome' in response_lower:
        steps.append({"action": "open_app", "params": {"name": "chrome"}})

    # Look for text to type in quotes
    text_match = re.search(r'["\']([^"\']+)["\']', response)
    if text_match and ('type' in response_lower or 'write' in response_lower or 'hello' in response_lower):
        steps.append({"action": "type", "params": {"text": text_match.group(1)}})

    return steps


def normalize_action(action: dict) -> dict:
    """Normalize action format"""
    result = {
        "action": action.get("action", ""),
        "params": action.get("params", {}),
    }

    # Handle nested coordinates
    if "coordinates" in result["params"]:
        coords = result["params"]["coordinates"]
        result["params"]["x"] = coords.get("x", 0)
        result["params"]["y"] = coords.get("y", 0)
        del result["params"]["coordinates"]

    # Handle target -> name mapping for open_app
    if "target" in result["params"] and "name" not in result["params"]:
        result["params"]["name"] = result["params"]["target"]

    return result


def create_fallback_plan(task_description: str) -> List[dict]:
    """Create a simple fallback plan based on keywords"""

    steps = []
    task_lower = task_description.lower()

    # Check for common patterns
    if "notepad" in task_lower:
        steps.append({"action": "open_app", "params": {"name": "notepad"}})
        steps.append({"action": "wait", "params": {"seconds": 2}})

    if "chrome" in task_lower or "browser" in task_lower:
        steps.append({"action": "open_app", "params": {"name": "chrome"}})
        steps.append({"action": "wait", "params": {"seconds": 2}})

    # Check for text to type
    type_match = re.search(r'type\s+["\']?([^"\']+)["\']?|["\']([^"\']+)["\']', task_lower)
    if type_match:
        text = type_match.group(1) or type_match.group(2)
        steps.append({"action": "type", "params": {"text": text}})
    elif "hello world" in task_lower:
        steps.append({"action": "type", "params": {"text": "Hello World"}})

    steps.append({"action": "done", "params": {}})

    return steps


class Agent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.current_task: Optional[Task] = None

    async def connect_to_host(self):
        while True:
            try:
                self.ws = await websockets.connect(self.config.host_ws_url)
                logger.info(f"Connected to host at {self.config.host_ws_url}")
                return
            except Exception as e:
                logger.warning(f"Connection failed: {e}. Retrying in 5s...")
                await asyncio.sleep(5)

    async def send_update(self, update: TaskUpdate):
        if self.ws:
            try:
                msg = encode_message(MESSAGE_TYPES["TASK_UPDATE"], update.to_dict())
                await self.ws.send(msg)
            except Exception as e:
                logger.error(f"Failed to send update: {e}")

    async def send_result(self, result: TaskResult):
        if self.ws:
            try:
                msg = encode_message(MESSAGE_TYPES["TASK_RESULT"], result.to_dict())
                await self.ws.send(msg)
            except Exception as e:
                logger.error(f"Failed to send result: {e}")

    async def run_task(self, task: Task) -> TaskResult:
        """Execute task with plan-based approach"""

        self.current_task = task
        start_time = time.time()

        logger.info(f"=== Starting task: {task.description} ===")

        # Step 1: Get complete plan from Claude (ONE call)
        print("\n>>> Getting plan from Claude...")
        steps = get_plan_from_claude(self.config, task.description)

        if not steps:
            return TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                summary="Could not generate plan",
                iterations=0,
                prs_merged=0,
                elapsed_seconds=int(time.time() - start_time),
            )

        print(f"\n>>> Plan has {len(steps)} steps:")
        for i, step in enumerate(steps):
            print(f"  {i+1}. {step['action']}: {step.get('params', {})}")

        # Step 2: Execute each step
        for i, step in enumerate(steps):
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

    async def listen_for_tasks(self):
        await self.connect_to_host()
        print("Agent listening for tasks...")

        while True:
            try:
                message = await self.ws.recv()
                msg_type, payload = decode_message(message)

                if msg_type == MESSAGE_TYPES["NEW_TASK"]:
                    task = Task.from_dict(payload)
                    logger.info(f"Received task: {task.id}")
                    result = await self.run_task(task)
                    await self.send_result(result)

                elif msg_type == MESSAGE_TYPES["CANCEL_TASK"]:
                    logger.info("Task cancelled")

            except websockets.ConnectionClosed:
                logger.warning("Connection lost. Reconnecting...")
                await self.connect_to_host()
            except Exception as e:
                logger.error(f"Error: {e}")
                await asyncio.sleep(1)


async def main():
    config = load_config()

    # Verify Claude Code CLI
    try:
        result = subprocess.run(
            [config.claude_code_path, "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        print(f"Claude Code CLI: {result.stdout.strip()}")
    except Exception as e:
        print(f"WARNING: Claude Code CLI check failed: {e}")

    agent = Agent(config)
    await agent.listen_for_tasks()


if __name__ == "__main__":
    asyncio.run(main())
