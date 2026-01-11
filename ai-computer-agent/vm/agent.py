"""
Main Agent Loop - The brain that orchestrates computer use.

This is the core loop that:
1. Takes screenshots
2. Sends to Claude Code CLI for analysis (uses Max plan, no API cost)
3. Executes Claude's recommended actions
4. Checks guardrails before every action
5. Reports progress back to host

NOTE: Uses Claude Code CLI instead of direct Anthropic API.
This means it uses your Anthropic Max subscription, not API credits.
"""

import asyncio
import json
import time
import os
import sys
import tempfile
import base64
import subprocess
import re
from typing import Optional
from dataclasses import dataclass
import logging
import websockets

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.protocol import (
    Task, TaskStatus, TaskUpdate, TaskResult,
    MESSAGE_TYPES, encode_message, decode_message
)
from computer_use import (
    get_screen_context, screenshot, execute_action,
    focus_window, open_url_in_browser
)
from guardrails import (
    check_action, check_email_before_open, GuardrailResult,
    is_allowed, CONFIG, update_config
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agent")


# =============================================================================
# CONFIGURATION
# =============================================================================


@dataclass
class AgentConfig:
    """Agent configuration - no API key needed, uses Claude Code CLI"""
    host_ws_url: str = "ws://192.168.1.100:3000/agent"  # Your host PC IP
    claude_code_path: str = "claude"  # Path to Claude Code CLI
    screenshot_dir: str = ""  # Where to save screenshots for analysis
    max_tokens: int = 4096
    screenshot_scale: float = 0.75  # Reduce size to save tokens


def load_config() -> AgentConfig:
    return AgentConfig(
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://192.168.1.100:3000/agent"),
        claude_code_path=os.environ.get("CLAUDE_CODE_PATH", "claude"),
        screenshot_dir=os.environ.get("SCREENSHOT_DIR", tempfile.gettempdir()),
    )


# =============================================================================
# SYSTEM PROMPT FOR CLAUDE CODE
# =============================================================================


SYSTEM_PROMPT = """You are an AI agent controlling a Windows computer to help with software development tasks.

Your capabilities:
- Analyze screenshots to understand what's on screen
- Decide actions: click, type, scroll, keyboard shortcuts
- Navigate browsers (GitHub, Railway, Gmail, custom frontend)
- Open and interact with desktop applications (Gmail, File Explorer)
- Download and analyze files (PPT, Excel)

Your task loop:
1. Analyze the current screen (screenshot provided as file path)
2. Decide the next action to achieve the goal
3. Return your decision as JSON

STRICT RULES:
- NEVER access Microsoft Teams - it is strictly forbidden
- NEVER compose, draft, reply to, or send any emails
- ONLY read emails from authorized senders (GitHub notifications, automation outputs)
- NEVER access billing or payment pages
- NEVER access Slack, Discord, WhatsApp, Telegram, or other chat apps
- ONLY access Downloads folder and designated shared folders for files

When analyzing emails:
- Only open emails that appear to be from automation systems
- Look for subjects containing: "target", "search", "market research", "profile", "trading comp", "validation", "due diligence"
- If an email doesn't match these patterns, skip it

Response format (JSON only, no other text):
{
    "thinking": "What I see on screen and my reasoning",
    "action": "click|double_click|right_click|type|press|hotkey|scroll|wait|focus_window|open_url|open_app|done|stuck|ask_user",
    "params": {
        // For click/double_click/right_click: {"x": 100, "y": 200}
        // For type: {"text": "hello world"}
        // For press: {"key": "enter"}
        // For hotkey: {"keys": ["ctrl", "c"]}
        // For scroll: {"clicks": -3, "x": 500, "y": 300}
        // For wait: {"seconds": 2}
        // For focus_window: {"title": "Chrome"}
        // For open_url: {"url": "https://github.com"}
        // For open_app: {"name": "Gmail"}
        // For done/stuck/ask_user: {}
    },
    "progress_note": "Brief status update for the user",
    "satisfied": false
}

Set "satisfied": true when the task is complete and output meets requirements.
RESPOND WITH JSON ONLY. No explanations before or after."""


# =============================================================================
# CLAUDE CODE CLI WRAPPER
# =============================================================================


class ClaudeCodeAgent:
    """
    Uses Claude Code CLI instead of direct Anthropic API.
    This uses your Anthropic Max subscription, not API credits.
    """

    def __init__(self, config: AgentConfig):
        self.config = config
        self.conversation_history = []
        self.screenshot_counter = 0

    def reset_conversation(self):
        """Clear conversation history for new task"""
        self.conversation_history = []
        self.screenshot_counter = 0

    def _save_screenshot(self, screenshot_base64: str) -> str:
        """Save screenshot to file and return path"""
        self.screenshot_counter += 1
        filename = f"agent_screenshot_{self.screenshot_counter}.png"
        filepath = os.path.join(self.config.screenshot_dir, filename)

        # Decode and save
        image_data = base64.b64decode(screenshot_base64)
        with open(filepath, 'wb') as f:
            f.write(image_data)

        return filepath

    async def _run_claude_code(self, prompt: str, timeout_seconds: int = 120) -> str:
        """Run Claude Code CLI and return response"""
        try:
            process = await asyncio.create_subprocess_exec(
                self.config.claude_code_path,
                "--print",
                "--message", prompt,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=timeout_seconds
                )
            except asyncio.TimeoutError:
                process.kill()
                return '{"action": "stuck", "thinking": "Claude Code CLI timed out", "params": {}, "progress_note": "Timeout", "satisfied": false}'

            output = stdout.decode("utf-8", errors="replace")

            if process.returncode != 0:
                logger.warning(f"Claude Code returned non-zero: {stderr.decode()}")

            return output

        except FileNotFoundError:
            logger.error(f"Claude Code CLI not found at {self.config.claude_code_path}")
            return '{"action": "stuck", "thinking": "Claude Code CLI not found", "params": {}, "progress_note": "CLI not found", "satisfied": false}'
        except Exception as e:
            logger.error(f"Claude Code error: {e}")
            return f'{{"action": "stuck", "thinking": "Error: {str(e)}", "params": {{}}, "progress_note": "Error", "satisfied": false}}'

    async def get_next_action(
        self,
        task: Task,
        screen_context: dict,
        iteration: int,
        elapsed_seconds: int,
        prs_merged: int,
    ) -> dict:
        """Ask Claude Code what to do next based on current screen"""

        # Save screenshot to file
        screenshot_path = self._save_screenshot(screen_context["screenshot_base64"])

        # Build prompt with screenshot reference
        prompt = f"""{SYSTEM_PROMPT}

CURRENT TASK: {task.description}
PLAN: {task.approved_plan or 'No plan yet'}
CONTEXT: {task.context or 'None'}

CURRENT STATE:
- Iteration: {iteration}
- Time elapsed: {elapsed_seconds // 60}m {elapsed_seconds % 60}s
- Max duration: {task.max_duration_minutes} minutes
- PRs merged so far: {prs_merged}
- Active window: {screen_context.get('window_title', 'Unknown')}
- Current URL: {screen_context.get('window_url', 'N/A')}
- Mouse position: ({screen_context.get('mouse_x', 0)}, {screen_context.get('mouse_y', 0)})
- Screen size: {screen_context.get('screen_width', 1920)}x{screen_context.get('screen_height', 1080)}

SCREENSHOT: Please read the image file at {screenshot_path} to see the current screen.

Based on the screenshot and current state, what action should I take next?
RESPOND WITH JSON ONLY."""

        # Add conversation context if exists
        if self.conversation_history:
            history_text = "\n\nPREVIOUS ACTIONS:\n"
            for entry in self.conversation_history[-5:]:  # Last 5 actions
                history_text += f"- {entry.get('action', 'unknown')}: {entry.get('progress_note', '')}\n"
            prompt = prompt.replace("RESPOND WITH JSON ONLY.", history_text + "\nRESPOND WITH JSON ONLY.")

        # Call Claude Code CLI
        response = await self._run_claude_code(prompt)

        # Parse JSON from response
        try:
            # Try to find JSON in the response
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                result = json.loads(json_match.group())
                self.conversation_history.append(result)
                return result
            else:
                logger.error(f"No JSON found in response: {response[:500]}")
                return {
                    "thinking": "Failed to parse response",
                    "action": "stuck",
                    "params": {},
                    "progress_note": "Internal error - could not parse Claude response",
                    "satisfied": False
                }
        except json.JSONDecodeError as e:
            logger.error(f"JSON parse error: {e}")
            return {
                "thinking": f"JSON parse error: {e}",
                "action": "stuck",
                "params": {},
                "progress_note": "Internal error - JSON parse failed",
                "satisfied": False
            }

    async def create_plan(self, task_description: str) -> str:
        """Ask Claude Code to create a plan for the task"""
        prompt = f"""You are planning an automation task. Create a clear, step-by-step plan.
Be specific about what windows/apps to open, what to click, what to type.
Consider error cases and how to handle them.
Keep the plan concise but complete.

TASK: {task_description}

Create a step-by-step plan:"""

        return await self._run_claude_code(prompt)


# =============================================================================
# MAIN AGENT LOOP
# =============================================================================


class Agent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.claude = ClaudeCodeAgent(config)
        self.current_task: Optional[Task] = None
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.running = False
        self.prs_merged = 0

    async def connect_to_host(self):
        """Connect to the host controller via WebSocket"""
        while True:
            try:
                self.ws = await websockets.connect(self.config.host_ws_url)
                logger.info(f"Connected to host at {self.config.host_ws_url}")
                return
            except Exception as e:
                logger.warning(f"Could not connect to host: {e}. Retrying in 5s...")
                await asyncio.sleep(5)

    async def send_update(self, update: TaskUpdate):
        """Send status update to host"""
        if self.ws:
            try:
                msg = encode_message(MESSAGE_TYPES["TASK_UPDATE"], update.to_dict())
                await self.ws.send(msg)
            except Exception as e:
                logger.error(f"Failed to send update: {e}")

    async def send_result(self, result: TaskResult):
        """Send final result to host"""
        if self.ws:
            try:
                msg = encode_message(MESSAGE_TYPES["TASK_RESULT"], result.to_dict())
                await self.ws.send(msg)
            except Exception as e:
                logger.error(f"Failed to send result: {e}")

    async def run_task(self, task: Task) -> TaskResult:
        """Main task execution loop"""

        self.current_task = task
        self.claude.reset_conversation()
        self.prs_merged = 0

        start_time = time.time()
        max_duration_seconds = task.max_duration_minutes * 60
        iteration = 0

        logger.info(f"Starting task: {task.description}")
        logger.info(f"Plan: {task.approved_plan}")
        logger.info(f"Max duration: {task.max_duration_minutes} minutes")

        while True:
            iteration += 1
            elapsed = int(time.time() - start_time)

            # Check timeout
            if elapsed >= max_duration_seconds:
                logger.warning("Task timeout reached")
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.TIMEOUT,
                    summary=f"Timeout after {iteration} iterations",
                    iterations=iteration,
                    prs_merged=self.prs_merged,
                    elapsed_seconds=elapsed,
                )

            # Get screen context
            try:
                context = await get_screen_context()
                screen_dict = {
                    "screenshot_base64": context.screenshot_base64,
                    "window_title": context.window_title,
                    "window_url": context.window_url,
                    "screen_width": context.screen_width,
                    "screen_height": context.screen_height,
                    "mouse_x": context.mouse_x,
                    "mouse_y": context.mouse_y,
                    "active_process": context.active_process,
                }
            except Exception as e:
                logger.error(f"Failed to get screen context: {e}")
                await asyncio.sleep(1)
                continue

            # Check guardrails on current window
            window_check = check_action(
                {"action": "view"},
                current_window_title=context.window_title,
                current_url=context.window_url,
            )

            if not window_check.allowed:
                logger.error(f"GUARDRAIL: Currently viewing blocked content: {window_check.message}")
                # Try to close/navigate away
                from computer_use import hotkey
                await hotkey("alt", "F4")
                await asyncio.sleep(0.5)
                continue

            # Ask Claude Code what to do
            try:
                action = await self.claude.get_next_action(
                    task=task,
                    screen_context=screen_dict,
                    iteration=iteration,
                    elapsed_seconds=elapsed,
                    prs_merged=self.prs_merged,
                )
            except Exception as e:
                logger.error(f"Claude Code error: {e}")
                await asyncio.sleep(2)
                continue

            logger.info(f"Iteration {iteration}: {action.get('progress_note', 'No note')}")

            # Send update to host
            await self.send_update(TaskUpdate(
                task_id=task.id,
                status=TaskStatus.RUNNING,
                message=action.get("progress_note", ""),
                screenshot_base64=context.screenshot_base64,
                iteration=iteration,
                prs_merged=self.prs_merged,
                elapsed_seconds=elapsed,
            ))

            # Check if done
            if action.get("action") == "done" or action.get("satisfied"):
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.COMPLETED,
                    summary=action.get("thinking", "Task completed"),
                    iterations=iteration,
                    prs_merged=self.prs_merged,
                    elapsed_seconds=elapsed,
                )

            # Check if stuck
            if action.get("action") == "stuck":
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.STUCK,
                    summary=action.get("thinking", "Agent is stuck"),
                    iterations=iteration,
                    prs_merged=self.prs_merged,
                    elapsed_seconds=elapsed,
                )

            # Check if needs user input
            if action.get("action") == "ask_user":
                await self.send_update(TaskUpdate(
                    task_id=task.id,
                    status=TaskStatus.PAUSED,
                    message=f"Need user input: {action.get('thinking', '')}",
                    screenshot_base64=context.screenshot_base64,
                    iteration=iteration,
                    prs_merged=self.prs_merged,
                    elapsed_seconds=elapsed,
                ))
                # Wait for user response...
                await asyncio.sleep(5)
                continue

            # Check guardrails before executing action
            guardrail_result = check_action(
                action,
                current_window_title=context.window_title,
                current_url=context.window_url,
            )

            if not guardrail_result.allowed:
                logger.error(f"GUARDRAIL BLOCKED: {guardrail_result.message}")
                # Add to conversation so Claude knows
                self.claude.conversation_history.append({
                    "action": "blocked",
                    "progress_note": f"BLOCKED: {guardrail_result.message}"
                })
                continue

            # Execute the action
            try:
                result = await execute_action(action)
                if not result.get("success"):
                    logger.warning(f"Action failed: {result.get('error')}")
                    self.claude.conversation_history.append({
                        "action": action.get("action"),
                        "progress_note": f"FAILED: {result.get('error')}"
                    })
            except Exception as e:
                logger.error(f"Error executing action: {e}")

            # Track PR merges
            if "merge" in action.get("thinking", "").lower() and "success" in str(result).lower():
                self.prs_merged += 1

            # Small delay before next iteration
            await asyncio.sleep(0.5)

    async def listen_for_tasks(self):
        """Listen for tasks from host"""
        await self.connect_to_host()

        while True:
            try:
                message = await self.ws.recv()
                msg_type, payload = decode_message(message)

                if msg_type == MESSAGE_TYPES["NEW_TASK"]:
                    task = Task.from_dict(payload)
                    logger.info(f"Received new task: {task.id}")

                    result = await self.run_task(task)
                    await self.send_result(result)

                elif msg_type == MESSAGE_TYPES["CANCEL_TASK"]:
                    logger.info("Task cancelled by host")
                    self.running = False

                elif msg_type == MESSAGE_TYPES["PLAN_APPROVED"]:
                    if self.current_task:
                        self.current_task.approved_plan = payload.get("plan")
                        self.current_task.status = TaskStatus.RUNNING

            except websockets.ConnectionClosed:
                logger.warning("Connection to host lost. Reconnecting...")
                await self.connect_to_host()
            except Exception as e:
                logger.error(f"Error in task listener: {e}")
                await asyncio.sleep(1)


# =============================================================================
# ENTRY POINT
# =============================================================================


async def main():
    config = load_config()

    # Check if Claude Code CLI is available
    try:
        result = subprocess.run(
            [config.claude_code_path, "--version"],
            capture_output=True,
            timeout=10
        )
        if result.returncode == 0:
            logger.info(f"Claude Code CLI found: {result.stdout.decode().strip()}")
        else:
            logger.warning("Claude Code CLI returned non-zero, but continuing anyway")
    except FileNotFoundError:
        print(f"ERROR: Claude Code CLI not found at '{config.claude_code_path}'")
        print("Make sure Claude Code is installed and in your PATH")
        print("Or set CLAUDE_CODE_PATH environment variable")
        sys.exit(1)
    except Exception as e:
        logger.warning(f"Could not verify Claude Code CLI: {e}")

    agent = Agent(config)
    await agent.listen_for_tasks()


if __name__ == "__main__":
    asyncio.run(main())
