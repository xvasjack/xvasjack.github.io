"""Vision helper — use Claude Code CLI to find UI elements on screen."""

import asyncio
import base64
import os
import re
import tempfile
import logging

logger = logging.getLogger("vision")

CLAUDE_CODE_PATH = os.environ.get("CLAUDE_CODE_PATH", "claude")
CLAUDE_MODEL = "claude-opus-4-5-20250514"


async def find_element(description: str, screenshot_b64: str = None) -> tuple:
    """
    Find a UI element on screen using Claude vision.
    Returns (x, y) coordinates or None.
    """
    if not screenshot_b64:
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from computer_use import screenshot
        screenshot_b64 = await screenshot()

    fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="agent_vision_")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(base64.b64decode(screenshot_b64))

        prompt = (
            f"Read the file at {tmp_path} — it is a screenshot of a desktop application or browser window. "
            f"The screen resolution is approximately 1920x1080.\n\n"
            f"TASK: {description}\n\n"
            f"Search for this element by examining:\n"
            f"- Text labels, button text, placeholder text\n"
            f"- UI element shapes, colors, and icons\n"
            f"- Position relative to other visible elements\n\n"
            f"Return ONLY the x,y pixel coordinates of the element's CENTER, formatted exactly as: x,y\n"
            f"Example: 542,300\n"
            f"If the element is not visible on screen, reply exactly: NONE\n"
            f"If multiple matches exist, return the most prominent or first visible one."
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                CLAUDE_CODE_PATH, "--print",
                "--model", CLAUDE_MODEL,
                "--message", prompt,
                "--allowedTools", "Read",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=45)
            output = stdout.decode().strip()

            if "NONE" in output.upper():
                return None

            match = re.search(r'(\d{2,4})\s*,\s*(\d{2,4})', output)
            if match:
                return (int(match.group(1)), int(match.group(2)))
            return None
        except Exception as e:
            logger.error(f"Vision failed: {e}")
            return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def ask_about_screen(question: str, screenshot_b64: str = None) -> str:
    """
    Ask a yes/no or short-answer question about the current screen.
    Returns the answer string.
    """
    if not screenshot_b64:
        import sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from computer_use import screenshot
        screenshot_b64 = await screenshot()

    fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="agent_vision_")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(base64.b64decode(screenshot_b64))

        prompt = (
            f"Read the file at {tmp_path} — it is a screenshot of a desktop application or browser window.\n\n"
            f"QUESTION: {question}\n\n"
            f"Answer rules:\n"
            f"- If the question asks for a status (e.g., inbox vs login), answer with EXACTLY one keyword "
            f"from the options given in the question.\n"
            f"- If the question is yes/no, answer exactly YES or NO.\n"
            f"- If the question asks what you see, describe in one short sentence (max 15 words).\n"
            f"- If the answer is unclear or the element is not visible, answer: UNCLEAR\n"
            f"- Do NOT guess. Only report what is visibly on screen."
        )

        try:
            proc = await asyncio.create_subprocess_exec(
                CLAUDE_CODE_PATH, "--print",
                "--model", CLAUDE_MODEL,
                "--message", prompt,
                "--allowedTools", "Read",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
            return stdout.decode().strip()
        except Exception as e:
            logger.error(f"Vision question failed: {e}")
            return ""
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
