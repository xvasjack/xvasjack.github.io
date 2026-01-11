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
        # Very strict JSON-only prompt
        full_prompt = f"""You are a computer automation assistant. You must respond with ONLY a JSON object.

TASK: {prompt}

RULES:
1. Output ONLY valid JSON - no other text, no explanation, no markdown
2. Do NOT actually perform the action - just tell me what action to take
3. I will execute the action for you

RESPOND WITH THIS EXACT FORMAT:
{{"action":"ACTION_NAME","params":{{}},"note":"brief status"}}

ACTION_NAME options:
- "open_app" with params {{"name":"notepad"}}
- "type" with params {{"text":"your text here"}}
- "press" with params {{"key":"enter"}}
- "hotkey" with params {{"keys":["ctrl","s"]}}
- "wait" with params {{"seconds":2}}
- "done" with params {{}}

ONLY OUTPUT THE JSON:"""

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
            output = result.stdout.strip()
            print(f"=== Claude Code Raw Output ({len(output)} chars) ===")
            print(output[:1000])
            print("=== End Raw Output ===")

            # Try to extract the text response from JSON format
            try:
                cli_response = json.loads(output)
                print(f"Parsed as JSON. Type: {type(cli_response).__name__}")

                # Claude Code JSON format has response in 'result' or 'content'
                if isinstance(cli_response, dict):
                    print(f"Dict keys: {list(cli_response.keys())}")
                    if 'result' in cli_response:
                        return cli_response['result']
                    elif 'content' in cli_response:
                        return cli_response['content']
                    elif 'text' in cli_response:
                        return cli_response['text']
                    elif 'message' in cli_response:
                        return cli_response['message']

                # If it's a list of messages, get the last assistant message
                if isinstance(cli_response, list):
                    print(f"List with {len(cli_response)} items")
                    for msg in reversed(cli_response):
                        if isinstance(msg, dict):
                            print(f"  Item keys: {list(msg.keys())}, role: {msg.get('role')}")
                            if msg.get('role') == 'assistant':
                                content = msg.get('content', '')
                                if isinstance(content, list):
                                    for c in content:
                                        if isinstance(c, dict) and c.get('type') == 'text':
                                            return c.get('text', '')
                                elif isinstance(content, str):
                                    return content
                            # Also check for 'message' field pattern
                            if msg.get('type') == 'assistant' and 'message' in msg:
                                return msg['message']

                # If parsed but structure unknown, return stringified
                print(f"Unknown JSON structure, returning as string")
                return json.dumps(cli_response)

            except json.JSONDecodeError as e:
                print(f"Not valid JSON: {e}")
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
        """Ask Claude Code what to do next"""

        # Build simple context prompt
        context_prompt = f"""Task: {task.description}
Step: {iteration}
Active window: {screen_context.get('window_title', 'Unknown')}

What's the next action to complete this task?"""

        # Add conversation history context
        if self.conversation_history:
            history_text = "\n\nPrevious actions:\n"
            for entry in self.conversation_history[-5:]:  # Last 5 actions
                if 'action' in entry:
                    result = entry.get('result', 'ok')
                    history_text += f"- {entry['action']}: {result}\n"
                elif 'content' in entry:
                    history_text += f"- {entry['content']}\n"
            context_prompt += history_text

        # Call Claude Code CLI
        response_text = self._call_claude_code(context_prompt)

        # Parse response
        try:
            # Try to find JSON in the response - handle nested braces properly
            import re

            # Method 1: Try to parse the entire response as JSON first
            try:
                action = json.loads(response_text.strip())
                if self._is_valid_action(action):
                    self.conversation_history.append(action)
                    return action
            except json.JSONDecodeError:
                pass

            # Method 2: Find JSON by tracking brace depth
            json_obj = self._extract_json_object(response_text)
            if json_obj:
                action = json.loads(json_obj)
                if self._is_valid_action(action):
                    self.conversation_history.append(action)
                    return action

            # Method 3: Try greedy regex as fallback
            json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', response_text)
            if json_match:
                action = json.loads(json_match.group())
                if self._is_valid_action(action):
                    self.conversation_history.append(action)
                    return action

            logger.error(f"No valid JSON found in response: {response_text[:1000]}")
            return {
                "thinking": f"Failed to parse response. Raw: {response_text[:200]}",
                "action": "stuck",
                "params": {},
                "progress_note": "Internal error - could not parse Claude response",
                "satisfied": False
            }
        except json.JSONDecodeError as e:
            logger.error(f"JSON parse error: {e}\nResponse: {response_text[:500]}")
            return {
                "thinking": f"JSON parse error: {e}",
                "action": "stuck",
                "params": {},
                "progress_note": "Internal error - JSON parse failed",
                "satisfied": False
            }

    def _is_valid_action(self, obj: dict) -> bool:
        """Check if parsed object looks like a valid action"""
        if not isinstance(obj, dict):
            return False
        # Must have 'action' field with valid value
        valid_actions = {'click', 'double_click', 'right_click', 'type', 'press',
                        'hotkey', 'scroll', 'wait', 'focus_window', 'open_url',
                        'open_app', 'done', 'stuck', 'ask_user'}
        if obj.get('action') in valid_actions:
            # Normalize to expected format
            if 'thinking' not in obj:
                obj['thinking'] = obj.get('note', '')
            if 'progress_note' not in obj:
                obj['progress_note'] = obj.get('note', '')
            if 'satisfied' not in obj:
                obj['satisfied'] = obj.get('action') == 'done'
            if 'params' not in obj:
                obj['params'] = {}
            return True
        return False

    def _extract_json_object(self, text: str) -> Optional[str]:
        """Extract first valid JSON object by tracking brace depth"""
        start_idx = text.find('{')
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

            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    return text[start_idx:i+1]

        return None

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
                # Record result in the action for history
                if result.get("success"):
                    action['result'] = 'success'
                    logger.info(f"Action succeeded: {action.get('action')}")
                else:
                    action['result'] = f"failed: {result.get('error')}"
                    logger.warning(f"Action failed: {result.get('error')}")
            except Exception as e:
                action['result'] = f"error: {e}"
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
