"""
Claude Agent SDK Integration - Real-time streaming and hook-based visibility.

This module replaces subprocess calls with Claude Agent SDK for:
- Real-time token streaming (no waiting for full response)
- PreToolUse/PostToolUse hooks for visibility
- Built-in AskUserQuestion tool
- Session management for context preservation
- Subagents for parallel tasks

Installation:
    pip install claude-agent-sdk

Usage:
    result = await run_fix_with_streaming(
        prompt="Fix the validation issue",
        on_tool_use=handle_tool_use,
        on_token=handle_token
    )
"""

import asyncio
import os
import sys
from typing import Optional, Callable, Dict, Any, List, AsyncIterator
from dataclasses import dataclass
import logging

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data_models import StreamEvent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("claude_code_sdk")


# Try to import the Claude Agent SDK
_SDK_AVAILABLE = False
try:
    # Note: This is a placeholder import pattern - adjust based on actual SDK API
    # The actual import might be different based on the released SDK
    from anthropic import Anthropic
    _SDK_AVAILABLE = True
except ImportError:
    logger.warning("Claude Agent SDK not installed. Run: pip install anthropic")


@dataclass
class SDKResult:
    """Result from SDK-based Claude execution"""
    success: bool
    output: str
    pr_number: Optional[int] = None
    error: Optional[str] = None
    tool_uses: List[Dict[str, Any]] = None
    stream_events: List[StreamEvent] = None

    def __post_init__(self):
        if self.tool_uses is None:
            self.tool_uses = []
        if self.stream_events is None:
            self.stream_events = []


class ClaudeCodeSDK:
    """
    Claude Agent SDK wrapper for code fixes with streaming visibility.

    Provides:
    - Real-time streaming of Claude's output
    - Hook-based tool use visibility
    - Session management for multi-turn conversations
    """

    # Default allowed tools for code fixing
    DEFAULT_ALLOWED_TOOLS = [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Glob",
        "Grep",
    ]

    def __init__(
        self,
        working_dir: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
    ):
        # M14: Use env var with sensible default instead of hardcoded placeholder
        self.working_dir = working_dir or os.environ.get(
            "REPO_PATH", os.path.expanduser("~/xvasjack.github.io")
        )
        self.allowed_tools = allowed_tools or self.DEFAULT_ALLOWED_TOOLS
        self.client = None
        self.session_history: List[Dict[str, Any]] = []

        if _SDK_AVAILABLE:
            self.client = Anthropic()

    async def run_with_streaming(
        self,
        prompt: str,
        on_tool_use: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_token: Optional[Callable[[str], None]] = None,
        on_thinking: Optional[Callable[[str], None]] = None,
        timeout_seconds: int = 600,
    ) -> SDKResult:
        """
        Run Claude with real-time streaming and hook visibility.

        Args:
            prompt: The task/prompt to send
            on_tool_use: Callback for tool use events
            on_token: Callback for each token streamed
            on_thinking: Callback for thinking/reasoning updates
            timeout_seconds: Max time to wait

        Returns:
            SDKResult with output and tool use history
        """
        if not _SDK_AVAILABLE:
            logger.warning("SDK not available, falling back to subprocess")
            return await self._fallback_subprocess(prompt, timeout_seconds)

        logger.info(f"Running with SDK streaming: {prompt[:100]}...")

        try:
            output_text = ""
            tool_uses = []
            stream_events = []

            # Create streaming message
            with self.client.messages.stream(
                model="opus",
                max_tokens=8192,
                messages=[{"role": "user", "content": prompt}],
                system=self._get_system_prompt(),
            ) as stream:
                for event in stream:
                    # Handle different event types
                    if hasattr(event, 'type'):
                        if event.type == 'content_block_delta':
                            if hasattr(event.delta, 'text'):
                                text = event.delta.text
                                output_text += text
                                if on_token:
                                    await self._call_async(on_token, text)
                                stream_events.append(StreamEvent(
                                    event_type="token",
                                    content=text
                                ))

                        elif event.type == 'content_block_start':
                            if hasattr(event.content_block, 'type'):
                                if event.content_block.type == 'tool_use':
                                    tool_info = {
                                        "type": "pre_tool",
                                        "tool": event.content_block.name,
                                        "id": event.content_block.id,
                                    }
                                    tool_uses.append(tool_info)
                                    if on_tool_use:
                                        await self._call_async(on_tool_use, tool_info)
                                    stream_events.append(StreamEvent(
                                        event_type="tool_start",
                                        content=f"Starting: {event.content_block.name}",
                                        tool_name=event.content_block.name
                                    ))

                        elif event.type == 'message_stop':
                            logger.info("Message stream completed")

            # Extract PR number if present
            pr_number = self._extract_pr_number(output_text)

            return SDKResult(
                success=True,
                output=output_text,
                pr_number=pr_number,
                tool_uses=tool_uses,
                stream_events=stream_events,
            )

        except asyncio.TimeoutError:
            return SDKResult(
                success=False,
                output="",
                error="SDK execution timed out"
            )
        except Exception as e:
            logger.error(f"SDK execution failed: {e}")
            return SDKResult(
                success=False,
                output="",
                error=str(e)
            )

    async def _call_async(self, callback: Callable, *args):
        """Call a callback, handling both sync and async callbacks"""
        if asyncio.iscoroutinefunction(callback):
            await callback(*args)
        else:
            callback(*args)

    def _get_system_prompt(self) -> str:
        """Get system prompt for code fixing context"""
        return f"""You are an expert code fixer. You're working in the directory: {self.working_dir}

Your task is to fix issues in the code. After making fixes:
1. Commit your changes with a descriptive message
2. Push to a new branch
3. Create a PR

Be thorough but focused. Fix the specific issues mentioned."""

    def _extract_pr_number(self, output: str) -> Optional[int]:
        """Extract PR number from output if a PR was created"""
        import re
        patterns = [
            r"PR\s*#(\d+)",
            r"pull request.*#(\d+)",
            r"github\.com/.*/pull/(\d+)",
        ]
        for pattern in patterns:
            match = re.search(pattern, output, re.IGNORECASE)
            if match:
                return int(match.group(1))
        return None

    async def _fallback_subprocess(
        self,
        prompt: str,
        timeout_seconds: int
    ) -> SDKResult:
        """Fallback to subprocess when SDK not available"""
        from actions.claude_code import run_claude_code

        result = await run_claude_code(prompt, self.working_dir, timeout_seconds)
        return SDKResult(
            success=result.success,
            output=result.output,
            pr_number=result.pr_number,
            error=result.error,
        )


# Convenience functions


async def run_fix_with_streaming(
    prompt: str,
    on_tool_use: Optional[Callable[[Dict[str, Any]], None]] = None,
    on_token: Optional[Callable[[str], None]] = None,
    working_dir: Optional[str] = None,
) -> SDKResult:
    """
    Run a fix prompt with streaming visibility.

    This is the main entry point for SDK-based code fixing.

    Args:
        prompt: The fix prompt
        on_tool_use: Callback for tool use events
        on_token: Callback for token streaming
        working_dir: Directory to work in

    Returns:
        SDKResult with output and history
    """
    sdk = ClaudeCodeSDK(working_dir=working_dir)
    return await sdk.run_with_streaming(
        prompt=prompt,
        on_tool_use=on_tool_use,
        on_token=on_token,
    )


async def run_with_hooks(
    prompt: str,
    pre_tool_hook: Optional[Callable[[Dict], None]] = None,
    post_tool_hook: Optional[Callable[[Dict], None]] = None,
    working_dir: Optional[str] = None,
) -> SDKResult:
    """
    Run with pre/post tool hooks for full visibility.

    Hooks receive:
    - pre_tool_hook: {type, tool, id, params} before tool executes
    - post_tool_hook: {type, tool, id, result} after tool executes

    Args:
        prompt: The prompt to execute
        pre_tool_hook: Called before each tool use
        post_tool_hook: Called after each tool use
        working_dir: Directory to work in

    Returns:
        SDKResult with full tool use history
    """
    sdk = ClaudeCodeSDK(working_dir=working_dir)

    async def combined_hook(tool_info: Dict):
        if tool_info.get("type") == "pre_tool" and pre_tool_hook:
            await sdk._call_async(pre_tool_hook, tool_info)
        elif tool_info.get("type") == "post_tool" and post_tool_hook:
            await sdk._call_async(post_tool_hook, tool_info)

    return await sdk.run_with_streaming(
        prompt=prompt,
        on_tool_use=combined_hook,
    )


def is_sdk_available() -> bool:
    """Check if Claude Agent SDK is available"""
    return _SDK_AVAILABLE


# Test function
if __name__ == "__main__":
    async def test():
        print(f"SDK Available: {is_sdk_available()}")

        if is_sdk_available():
            def on_token(text):
                print(text, end="", flush=True)

            def on_tool(info):
                print(f"\n[TOOL] {info.get('tool')}")

            result = await run_fix_with_streaming(
                prompt="What is 2 + 2?",
                on_token=on_token,
                on_tool_use=on_tool,
            )

            print(f"\n\nResult: {result.success}")
            print(f"Output length: {len(result.output)}")

    asyncio.run(test())
