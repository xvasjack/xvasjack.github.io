"""
Main Agent Loop - The brain that orchestrates computer use.

This is the core loop that:
1. Takes screenshots
2. Sends to Claude for analysis
3. Executes Claude's recommended actions
4. Checks guardrails before every action
5. Reports progress back to host
"""

import asyncio
import json
import time
import os
import sys
from typing import Optional
from dataclasses import dataclass
import logging
import websockets

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from anthropic import Anthropic
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
    anthropic_api_key: str
    host_ws_url: str = "ws://192.168.1.100:3000/agent"  # Your host PC IP
    model: str = "claude-opus-4-5-20250514"
    max_tokens: int = 4096
    screenshot_scale: float = 0.75  # Reduce size to save tokens


# Load config from environment or file
def load_config() -> AgentConfig:
    return AgentConfig(
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://192.168.1.100:3000/agent"),
    )


# =============================================================================
# CLAUDE INTERACTION
# =============================================================================


SYSTEM_PROMPT = """You are an AI agent controlling a Windows computer to help with software development tasks.

Your capabilities:
- Take screenshots and analyze what's on screen
- Click, type, scroll, and use keyboard shortcuts
- Navigate browsers (GitHub, Railway, Outlook Web, custom frontend)
- Open and interact with desktop applications (Outlook, File Explorer)
- Download and analyze files (PPT, Excel)
- Run Claude Code CLI to request code changes

Your task loop:
1. Analyze the current screen
2. Decide the next action to achieve the goal
3. Execute the action
4. Repeat until goal is achieved or you're stuck

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

When you encounter an error or blocker:
- Take a screenshot
- Describe the issue clearly
- Return action "stuck" with explanation

Response format (JSON):
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
        // For open_app: {"name": "Outlook"}
        // For done/stuck/ask_user: {}
    },
    "progress_note": "Brief status update for the user",
    "satisfied": false
}

Set "satisfied": true when the task is complete and output meets requirements.
"""


class ClaudeAgent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.client = Anthropic(api_key=config.anthropic_api_key)
        self.conversation_history = []

    def reset_conversation(self):
        """Clear conversation history for new task"""
        self.conversation_history = []

    async def get_next_action(
        self,
        task: Task,
        screen_context: dict,
        iteration: int,
        elapsed_seconds: int,
        prs_merged: int,
    ) -> dict:
        """Ask Claude what to do next based on current screen"""

        # Build the user message with screenshot
        user_content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": screen_context["screenshot_base64"],
                },
            },
            {
                "type": "text",
                "text": f"""Current state:
- Task: {task.description}
- Plan: {task.approved_plan or 'No plan yet'}
- Context: {task.context or 'None'}
- Iteration: {iteration}
- Time elapsed: {elapsed_seconds // 60}m {elapsed_seconds % 60}s
- Max duration: {task.max_duration_minutes} minutes
- PRs merged so far: {prs_merged}
- Active window: {screen_context.get('window_title', 'Unknown')}
- Current URL: {screen_context.get('window_url', 'N/A')}
- Mouse position: ({screen_context.get('mouse_x', 0)}, {screen_context.get('mouse_y', 0)})
- Screen size: {screen_context.get('screen_width', 1920)}x{screen_context.get('screen_height', 1080)}

What action should I take next? Respond with JSON only."""
            }
        ]

        self.conversation_history.append({
            "role": "user",
            "content": user_content
        })

        response = self.client.messages.create(
            model=self.config.model,
            max_tokens=self.config.max_tokens,
            system=SYSTEM_PROMPT,
            messages=self.conversation_history,
        )

        # Parse response
        assistant_text = response.content[0].text

        self.conversation_history.append({
            "role": "assistant",
            "content": assistant_text
        })

        # Extract JSON from response
        try:
            # Try to find JSON in the response
            import re
            json_match = re.search(r'\{[\s\S]*\}', assistant_text)
            if json_match:
                return json.loads(json_match.group())
            else:
                logger.error(f"No JSON found in response: {assistant_text}")
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
        """Ask Claude to create a plan for the task"""

        response = self.client.messages.create(
            model=self.config.model,
            max_tokens=2048,
            system="""You are planning an automation task. Create a clear, step-by-step plan.
Be specific about what windows/apps to open, what to click, what to type.
Consider error cases and how to handle them.
Keep the plan concise but complete.""",
            messages=[{
                "role": "user",
                "content": f"Create a plan for this task:\n\n{task_description}"
            }]
        )

        return response.content[0].text


# =============================================================================
# MAIN AGENT LOOP
# =============================================================================


class Agent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.claude = ClaudeAgent(config)
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
            guardrail_context = {
                "window_title": context.window_title,
                "url": context.window_url,
                "screen_text": "",  # Would need OCR for this
            }

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

            # Ask Claude what to do
            try:
                action = await self.claude.get_next_action(
                    task=task,
                    screen_context=screen_dict,
                    iteration=iteration,
                    elapsed_seconds=elapsed,
                    prs_merged=self.prs_merged,
                )
            except Exception as e:
                logger.error(f"Claude API error: {e}")
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
                # This would need to be handled via WebSocket
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
                # Tell Claude the action was blocked
                self.claude.conversation_history.append({
                    "role": "user",
                    "content": f"ACTION BLOCKED BY GUARDRAIL: {guardrail_result.message}. Please try a different approach."
                })
                continue

            # Execute the action
            try:
                result = await execute_action(action)
                if not result.get("success"):
                    logger.warning(f"Action failed: {result.get('error')}")
                    self.claude.conversation_history.append({
                        "role": "user",
                        "content": f"Action failed: {result.get('error')}. Please try again or try a different approach."
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

    if not config.anthropic_api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    agent = Agent(config)
    await agent.listen_for_tasks()


if __name__ == "__main__":
    asyncio.run(main())
