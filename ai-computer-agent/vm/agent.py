"""
Main Agent Loop - The brain that orchestrates computer use.

This is the core loop that:
1. Takes screenshots
2. Sends to Claude Code CLI for analysis (uses your Max subscription!)
3. Executes Claude's recommended actions
4. Checks guardrails before every action
5. Reports progress back to host

NOTE: This version uses Claude Code CLI instead of direct API calls,
so it uses your Claude Max subscription instead of API credits.
"""

import asyncio
import json
import time
import os
import sys
import subprocess
import tempfile
import base64
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
    host_ws_url: str = "ws://192.168.1.100:3000/agent"  # Your host PC IP
    claude_code_path: str = "claude"  # Path to Claude Code CLI
    screenshot_dir: str = ""  # Where to save screenshots for Claude to read
    working_dir: str = ""  # Working directory for Claude Code


# Load config from environment or file
def load_config() -> AgentConfig:
    # Default screenshot dir to temp
    screenshot_dir = os.environ.get("SCREENSHOT_DIR", tempfile.gettempdir())
    working_dir = os.environ.get("WORKING_DIR", os.getcwd())

    return AgentConfig(
        host_ws_url=os.environ.get("HOST_WS_URL", "ws://192.168.1.100:3000/agent"),
        claude_code_path=os.environ.get("CLAUDE_CODE_PATH", "claude"),
        screenshot_dir=screenshot_dir,
        working_dir=working_dir,
    )


# =============================================================================
# CLAUDE CODE CLI INTERACTION
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

Response format (JSON ONLY - no other text):
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


class ClaudeCodeAgent:
    """
    Uses Claude Code CLI instead of direct API calls.
    This uses your Claude Max subscription instead of API credits!
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
        filename = f"screen_{self.screenshot_counter}.png"
        filepath = os.path.join(self.config.screenshot_dir, filename)

        # Decode and save
        image_data = base64.b64decode(screenshot_base64)
        with open(filepath, "wb") as f:
            f.write(image_data)

        return filepath

    def _call_claude_code(self, prompt: str, screenshot_path: Optional[str] = None) -> str:
        """
        Call Claude Code CLI with a prompt.
        Uses --print flag to get output without interactive mode.
        """
        # Build the full prompt
        if screenshot_path:
            full_prompt = f"""CRITICAL INSTRUCTION: Output ONLY valid JSON. No markdown, no explanation, no text before or after.

Read this image: {screenshot_path}

Task: {prompt}

You must output exactly one JSON object in this format:
{{"thinking":"your analysis","action":"ACTION","params":{{}},"progress_note":"status","satisfied":false}}

Valid ACTION values: open_app, type, click, press, hotkey, done, stuck
- For open_app: {{"name":"notepad"}}
- For type: {{"text":"Hello World"}}
- For click: {{"x":100,"y":200}}
- For press: {{"key":"enter"}}
- For done: {{}}

Output ONLY the JSON object now:"""
        else:
            full_prompt = prompt

        try:
            # Call Claude Code CLI with --print and --output-format json
            result = subprocess.run(
                [
                    self.config.claude_code_path,
                    "--print",  # Non-interactive, just print response
                    "--output-format", "json",  # Get structured JSON output
                    "--dangerously-skip-permissions",  # Skip permission prompts
                    "-p", full_prompt,
                ],
                capture_output=True,
                text=True,
                timeout=120,  # 2 minute timeout
                cwd=self.config.working_dir,
            )

            if result.returncode != 0:
                logger.error(f"Claude Code CLI error: {result.stderr}")
                return json.dumps({
                    "thinking": f"Claude Code CLI error: {result.stderr}",
                    "action": "stuck",
                    "params": {},
                    "progress_note": "CLI error",
                    "satisfied": False
                })

            # Parse the JSON output format from Claude Code
            output = result.stdout
            print(f"Raw Claude output: {output[:500]}...")  # Debug

            # Try to extract the text response from JSON format
            try:
                cli_response = json.loads(output)
                # Claude Code JSON format has response in 'result' or 'content'
                if isinstance(cli_response, dict):
                    if 'result' in cli_response:
                        return cli_response['result']
                    elif 'content' in cli_response:
                        return cli_response['content']
                    elif 'text' in cli_response:
                        return cli_response['text']
                # If it's a list of messages, get the last assistant message
                if isinstance(cli_response, list):
                    for msg in reversed(cli_response):
                        if isinstance(msg, dict) and msg.get('role') == 'assistant':
                            content = msg.get('content', '')
                            if isinstance(content, list):
                                for c in content:
                                    if isinstance(c, dict) and c.get('type') == 'text':
                                        return c.get('text', '')
                            return content
            except json.JSONDecodeError:
                pass  # Fall through to return raw output

            return output

        except subprocess.TimeoutExpired:
            logger.error("Claude Code CLI timeout")
            return json.dumps({
                "thinking": "Claude Code CLI timed out",
                "action": "stuck",
                "params": {},
                "progress_note": "Timeout",
                "satisfied": False
            })
        except FileNotFoundError:
            logger.error(f"Claude Code CLI not found at: {self.config.claude_code_path}")
            return json.dumps({
                "thinking": "Claude Code CLI not installed or not in PATH",
                "action": "stuck",
                "params": {},
                "progress_note": "CLI not found",
                "satisfied": False
            })
        except Exception as e:
            logger.error(f"Error calling Claude Code: {e}")
            return json.dumps({
                "thinking": f"Error: {str(e)}",
                "action": "stuck",
                "params": {},
                "progress_note": "Error",
                "satisfied": False
            })

    async def get_next_action(
        self,
        task: Task,
        screen_context: dict,
        iteration: int,
        elapsed_seconds: int,
        prs_merged: int,
    ) -> dict:
        """Ask Claude Code what to do next based on current screen"""

        # Save screenshot to file so Claude Code can read it
        screenshot_path = self._save_screenshot(screen_context["screenshot_base64"])

        # Build context for Claude
        context_prompt = f"""{SYSTEM_PROMPT}

Current state:
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

What action should I take next?"""

        # Add conversation history context
        if self.conversation_history:
            history_text = "\n\nPrevious actions in this session:\n"
            for entry in self.conversation_history[-5:]:  # Last 5 actions
                history_text += f"- {entry.get('action', 'unknown')}: {entry.get('progress_note', '')}\n"
            context_prompt += history_text

        # Call Claude Code CLI
        response_text = self._call_claude_code(context_prompt, screenshot_path)

        # Parse response
        try:
            # Try to find JSON in the response
            import re
            json_match = re.search(r'\{[\s\S]*\}', response_text)
            if json_match:
                action = json.loads(json_match.group())
                self.conversation_history.append(action)
                return action
            else:
                logger.error(f"No JSON found in response: {response_text[:500]}")
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

Task: {task_description}"""

        response = self._call_claude_code(prompt)
        return response


# =============================================================================
# MAIN AGENT LOOP
# =============================================================================


class Agent:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.claude = ClaudeCodeAgent(config)  # Uses Claude Code CLI (your subscription!)
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
        print("Agent is listening for tasks...")

        while True:
            try:
                print("Waiting for message from host...")
                message = await self.ws.recv()
                print(f"Received raw message: {message[:200]}...")
                msg_type, payload = decode_message(message)
                print(f"Message type: {msg_type}, Expected: {MESSAGE_TYPES['NEW_TASK']}")

                if msg_type == MESSAGE_TYPES["NEW_TASK"]:
                    task = Task.from_dict(payload)
                    print(f"Task parsed successfully: {task.id}")
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

    # Check that Claude Code CLI is available
    try:
        result = subprocess.run(
            [config.claude_code_path, "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"Using Claude Code CLI: {result.stdout.strip()}")
            print("This uses your Claude Max subscription - no extra API costs!")
        else:
            print(f"WARNING: Claude Code CLI returned error: {result.stderr}")
    except FileNotFoundError:
        print("ERROR: Claude Code CLI not found!")
        print("Please install Claude Code: npm install -g @anthropic-ai/claude-code")
        print("Or set CLAUDE_CODE_PATH environment variable to the correct path")
        sys.exit(1)
    except Exception as e:
        print(f"WARNING: Could not verify Claude Code CLI: {e}")

    agent = Agent(config)
    await agent.listen_for_tasks()


if __name__ == "__main__":
    asyncio.run(main())
