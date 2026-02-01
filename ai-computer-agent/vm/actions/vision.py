"""Vision helper — use Claude Code CLI to find UI elements on screen."""

import asyncio
import base64
import os
import re
import sys
import tempfile
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from config import CLAUDE_MODEL
except ImportError:
    CLAUDE_MODEL = "opus"

from shared.cli_utils import build_claude_cmd, get_claude_code_path, is_wsl_mode, to_wsl_path

logger = logging.getLogger("vision")

CLAUDE_CODE_PATH = get_claude_code_path()


def _get_screen_resolution() -> str:
    """Return current screen resolution string, falling back to 1920x1080."""
    try:
        import subprocess
        # Try xdpyinfo first (X11)
        result = subprocess.run(
            ["xdpyinfo"], capture_output=True, text=True, timeout=3
        )
        match = re.search(r"dimensions:\s+(\d+x\d+)", result.stdout)
        if match:
            return match.group(1)
    except Exception:
        pass
    try:
        import subprocess
        # Try xrandr
        result = subprocess.run(
            ["xrandr", "--current"], capture_output=True, text=True, timeout=3
        )
        match = re.search(r"(\d{3,4}x\d{3,4})\s+\d+\.\d+\*", result.stdout)
        if match:
            return match.group(1)
    except Exception:
        pass
    return "1920x1080"  # H19: hardcoded fallback — update if default resolution changes



async def find_element(description: str, screenshot_b64: str = None) -> tuple:
    """
    Find a UI element on screen using Claude vision.
    Returns (x, y) coordinates or None.
    """
    if not screenshot_b64:
        from computer_use import screenshot
        screenshot_b64 = await screenshot()

    fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="agent_vision_")
    try:
        # Category 1 fix: Catch base64 decode errors
        # Category 2 fix: Ensure file descriptor is closed even on decode failure
        try:
            decoded_data = base64.b64decode(screenshot_b64)
        except Exception as e:
            os.close(fd)  # Close fd before cleanup
            logger.error(f"Failed to decode screenshot: {e}")
            return None

        try:
            f = os.fdopen(fd, "wb")
        except Exception:
            os.close(fd)
            raise
        with f:
            f.write(decoded_data)

        # Fix #5: Convert Windows temp path to WSL path so Claude in WSL can read it
        readable_path = to_wsl_path(tmp_path) if is_wsl_mode(CLAUDE_CODE_PATH) else tmp_path

        prompt = (
            f"Read the file at {readable_path} — it is a screenshot of a desktop application or browser window. "
            # H19: Resolution is passed as a hint; ideally query actual resolution at runtime
            f"The screen resolution is approximately {_get_screen_resolution()}.\n\n"
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

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *build_claude_cmd(CLAUDE_CODE_PATH, "--print",
                "--model", CLAUDE_MODEL,
                "--allowedTools", "Read",
                prompt),  # positional arg MUST be last
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=45)
            output = stdout.decode().strip()

            # Category 5 fix: Log stderr for diagnostics
            if stderr:
                stderr_text = stderr.decode().strip()
                if stderr_text:
                    logger.debug(f"Vision stderr: {stderr_text}")

            if "NONE" in output.upper():
                return None

            # Category 8 fix: Regex should accept single-digit coordinates
            match = re.search(r'(\d{1,4})\s*,\s*(\d{1,4})', output)
            if match:
                x, y = int(match.group(1)), int(match.group(2))
                # IV-7: Validate coordinates are positive (0,0 is usually invalid UI coordinate)
                if x < 0 or y < 0:
                    logger.warning(f"Vision returned negative coordinates: ({x}, {y})")
                    return None
                # IV-2: Validate coordinates are within reasonable screen bounds
                MAX_X, MAX_Y = 3840, 2160  # Support up to 4K displays
                if x > MAX_X or y > MAX_Y:
                    logger.warning(f"Vision returned out-of-bounds coordinates: ({x}, {y})")
                    return None
                return (x, y)
            return None
        except asyncio.TimeoutError:
            # Category 2 fix: Kill subprocess on timeout
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            logger.error("Vision subprocess timed out")
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
        from computer_use import screenshot
        screenshot_b64 = await screenshot()

    fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="agent_vision_")
    try:
        # Category 1 fix: Catch base64 decode errors
        try:
            decoded_data = base64.b64decode(screenshot_b64)
        except Exception as e:
            os.close(fd)
            logger.error(f"Failed to decode screenshot: {e}")
            return ""

        try:
            f = os.fdopen(fd, "wb")
        except Exception:
            os.close(fd)
            raise
        with f:
            f.write(decoded_data)

        # Fix #5: Convert Windows temp path to WSL path so Claude in WSL can read it
        readable_path = to_wsl_path(tmp_path) if is_wsl_mode(CLAUDE_CODE_PATH) else tmp_path

        prompt = (
            f"Read the file at {readable_path} — it is a screenshot of a desktop application or browser window.\n\n"
            f"QUESTION: {question}\n\n"
            f"Answer rules:\n"
            f"- If the question asks for a status (e.g., inbox vs login), answer with EXACTLY one keyword "
            f"from the options given in the question.\n"
            f"- If the question is yes/no, answer exactly YES or NO.\n"
            f"- If the question asks what you see, describe in one short sentence (max 15 words).\n"
            f"- If the answer is unclear or the element is not visible, answer: UNCLEAR\n"
            f"- Do NOT guess. Only report what is visibly on screen."
        )

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *build_claude_cmd(CLAUDE_CODE_PATH, "--print",
                "--model", CLAUDE_MODEL,
                "--allowedTools", "Read",
                prompt),  # positional arg MUST be last
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

            # RL-6: Log stderr for diagnostics (symmetry with find_element)
            if stderr:
                stderr_text = stderr.decode().strip()
                if stderr_text:
                    logger.debug(f"Vision question stderr: {stderr_text}")

            return stdout.decode().strip()
        except asyncio.TimeoutError:
            # Category 2 fix: Kill subprocess on timeout
            if proc and proc.returncode is None:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass
            logger.error("Vision question subprocess timed out")
            return ""
        except Exception as e:
            logger.error(f"Vision question failed: {e}")
            return ""
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
