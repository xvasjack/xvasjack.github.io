"""
Computer Use Module - Screen capture and input control for Windows VM.

This module provides the low-level primitives for:
- Taking screenshots
- Moving/clicking mouse
- Typing text
- Pressing keys
- Getting window information
"""

import asyncio
import base64
import io
import time
from dataclasses import dataclass
from typing import Optional, Tuple, List
import logging

# Windows-specific imports
HAS_COMPUTER_USE = False
_IMPORT_ERROR = ""
try:
    import pyautogui
    import pygetwindow as gw
    import mss
    from PIL import Image
    import win32gui
    import win32process
    import psutil

    # B13: Safety settings inside try block so they don't crash if imports fail
    pyautogui.FAILSAFE = True  # Move mouse to corner to abort
    pyautogui.PAUSE = 0.1  # Small pause between actions
    HAS_COMPUTER_USE = True
except ImportError as e:
    _IMPORT_ERROR = str(e)
    print(f"Missing dependency: {e}")
    print("Run: pip install pyautogui pygetwindow mss pillow pywin32 psutil")


def _require_computer_use():
    """Raise RuntimeError if computer_use dependencies are not available."""
    if not HAS_COMPUTER_USE:
        raise RuntimeError(f"computer_use not available: {_IMPORT_ERROR}")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("computer_use")


@dataclass
class WindowInfo:
    title: str
    handle: int
    process_name: str
    x: int
    y: int
    width: int
    height: int


@dataclass
class ScreenContext:
    screenshot_base64: str
    window_title: str
    window_url: str  # For browsers
    screen_width: int
    screen_height: int
    mouse_x: int
    mouse_y: int
    active_process: str


# =============================================================================
# SCREENSHOT FUNCTIONS
# =============================================================================


async def screenshot(
    region: Optional[Tuple[int, int, int, int]] = None,
    scale: float = 1.0
) -> str:
    """
    Take a screenshot and return as base64.

    Args:
        region: Optional (x, y, width, height) to capture specific region
        scale: Scale factor for resizing (1.0 = original, 0.5 = half size)

    Returns:
        Base64 encoded PNG image
    """
    _require_computer_use()
    with mss.mss() as sct:
        if region:
            monitor = {"left": region[0], "top": region[1], "width": region[2], "height": region[3]}
        else:
            # DL-3: Check monitor bounds before accessing
            if len(sct.monitors) < 2:
                # Fallback to monitors[0] which is the "all monitors" combined view
                monitor = sct.monitors[0] if sct.monitors else {"left": 0, "top": 0, "width": 1920, "height": 1080}
            else:
                monitor = sct.monitors[1]  # Primary monitor

        screenshot = sct.grab(monitor)

        # Convert to PIL Image
        img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")

        # Scale if needed
        if scale != 1.0:
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.LANCZOS)

        # Convert to base64
        buffer = io.BytesIO()
        img.save(buffer, format="PNG", optimize=True)
        buffer.seek(0)

        return base64.b64encode(buffer.read()).decode("utf-8")


async def get_screen_context() -> ScreenContext:
    """Get full context about current screen state"""
    _require_computer_use()

    # Get screenshot
    screen_b64 = await screenshot(scale=0.75)  # Scale down to reduce tokens

    # Get active window info
    try:
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd)

        # Get process name
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        process = psutil.Process(pid)
        process_name = process.name()
    except Exception as e:
        logger.warning(f"Could not get window info: {e}")
        title = ""
        process_name = ""

    # Get URL if browser
    url = await get_browser_url(title)

    # Get mouse position
    mouse_x, mouse_y = pyautogui.position()

    # Get screen size
    screen_width, screen_height = pyautogui.size()

    return ScreenContext(
        screenshot_base64=screen_b64,
        window_title=title,
        window_url=url,
        screen_width=screen_width,
        screen_height=screen_height,
        mouse_x=mouse_x,
        mouse_y=mouse_y,
        active_process=process_name,
    )


async def get_browser_url(window_title: str) -> str:
    """
    Try to extract URL from browser window title.
    This is a heuristic - browsers often put URL or page title in window title.
    """
    # Common browser patterns
    browsers = ["Chrome", "Firefox", "Edge", "Brave", "Opera"]

    for browser in browsers:
        if browser.lower() in window_title.lower():
            # Many browsers format as "Page Title - Browser"
            # URL is often in the title for some pages
            # This is a best-effort extraction
            if "http" in window_title:
                # Try to extract URL from title
                import re
                match = re.search(r'https?://[^\s]+', window_title)
                if match:
                    return match.group(0)
            break

    return ""


# =============================================================================
# MOUSE FUNCTIONS
# =============================================================================


async def click(x: int, y: int, button: str = "left", clicks: int = 1):
    """Click at specified coordinates"""
    _require_computer_use()
    logger.info(f"Clicking at ({x}, {y}) with {button} button, {clicks} times")
    pyautogui.click(x=x, y=y, button=button, clicks=clicks)
    await asyncio.sleep(0.1)


async def double_click(x: int, y: int):
    """Double click at specified coordinates"""
    _require_computer_use()
    logger.info(f"Double clicking at ({x}, {y})")
    pyautogui.doubleClick(x=x, y=y)
    await asyncio.sleep(0.1)


async def right_click(x: int, y: int):
    """Right click at specified coordinates"""
    _require_computer_use()
    logger.info(f"Right clicking at ({x}, {y})")
    pyautogui.rightClick(x=x, y=y)
    await asyncio.sleep(0.1)


async def move_to(x: int, y: int, duration: float = 0.2):
    """Move mouse to specified coordinates"""
    _require_computer_use()
    pyautogui.moveTo(x=x, y=y, duration=duration)
    await asyncio.sleep(0.05)


async def scroll(clicks: int, x: Optional[int] = None, y: Optional[int] = None):
    """
    Scroll the mouse wheel.
    Positive clicks = scroll up, negative = scroll down.
    """
    _require_computer_use()
    logger.info(f"Scrolling {clicks} clicks at ({x}, {y})")
    if x is not None and y is not None:
        pyautogui.scroll(clicks, x=x, y=y)
    else:
        pyautogui.scroll(clicks)
    await asyncio.sleep(0.1)


async def drag(start_x: int, start_y: int, end_x: int, end_y: int, duration: float = 0.5):
    """Drag from start to end coordinates"""
    _require_computer_use()
    logger.info(f"Dragging from ({start_x}, {start_y}) to ({end_x}, {end_y})")
    pyautogui.moveTo(start_x, start_y)
    pyautogui.drag(end_x - start_x, end_y - start_y, duration=duration)
    await asyncio.sleep(0.1)


# =============================================================================
# KEYBOARD FUNCTIONS
# =============================================================================


async def type_text(text: str, interval: float = 0.02):
    """
    Type text character by character.
    M3: Auto-detects non-ASCII and uses clipboard paste for Unicode.
    """
    _require_computer_use()
    logger.info(f"Typing text: {text[:50]}...")
    # M3: If text contains non-ASCII, use clipboard paste
    if any(ord(c) > 127 for c in text):
        await type_text_unicode(text)
        return
    pyautogui.write(text, interval=interval)
    await asyncio.sleep(0.1)


async def type_text_unicode(text: str):
    """
    Type text that may contain Unicode characters.
    Uses clipboard paste (Ctrl+V) which supports all characters.
    F29: Saves and restores clipboard to avoid data loss.
    """
    _require_computer_use()
    logger.info(f"Typing (unicode): {text[:50]}...")
    try:
        import pyperclip
        # F29: Save original clipboard
        try:
            old_clipboard = pyperclip.paste()
        except Exception:
            old_clipboard = None
        pyperclip.copy(text)
        pyautogui.hotkey('ctrl', 'v')
        await asyncio.sleep(0.1)
        # F29: Restore original clipboard
        if old_clipboard is not None:
            try:
                pyperclip.copy(old_clipboard)
            except Exception:
                pass
    except ImportError:
        # Fallback to regular typing (will drop non-ASCII)
        logger.warning("pyperclip not installed, falling back to pyautogui.write()")
        pyautogui.write(text, interval=0.02)
        await asyncio.sleep(0.1)


async def press_key(key: str):
    """Press a single key (e.g., 'enter', 'tab', 'escape')"""
    _require_computer_use()
    logger.info(f"Pressing key: {key}")
    pyautogui.press(key)
    await asyncio.sleep(0.05)


async def hotkey(*keys: str):
    """Press a keyboard shortcut (e.g., 'ctrl', 'c' for Ctrl+C)"""
    _require_computer_use()
    logger.info(f"Pressing hotkey: {'+'.join(keys)}")
    pyautogui.hotkey(*keys)
    await asyncio.sleep(0.1)


# =============================================================================
# WINDOW MANAGEMENT
# =============================================================================


def get_all_windows() -> List[WindowInfo]:
    """Get list of all visible windows"""
    _require_computer_use()
    windows = []

    def callback(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            title = win32gui.GetWindowText(hwnd)
            if title:
                try:
                    rect = win32gui.GetWindowRect(hwnd)
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    process = psutil.Process(pid)

                    windows.append(WindowInfo(
                        title=title,
                        handle=hwnd,
                        process_name=process.name(),
                        x=rect[0],
                        y=rect[1],
                        width=rect[2] - rect[0],
                        height=rect[3] - rect[1],
                    ))
                except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                    # Expected errors - process terminated or access denied
                    logger.debug(f"Could not get process info for window '{title}': {e}")
                except Exception as e:
                    # Unexpected errors - log but continue enumeration
                    logger.warning(f"Error getting window info for '{title}': {e}")
        return True

    win32gui.EnumWindows(callback, None)
    return windows



async def get_all_windows_async() -> List[WindowInfo]:
    """C16: Async wrapper for get_all_windows to avoid blocking the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, get_all_windows)

async def focus_window(title_pattern: str) -> bool:
    """Focus a window by title pattern.
    F26: Verify focus succeeded, use Alt+Tab fallback if not.
    """
    windows = await get_all_windows_async()

    for window in windows:
        if title_pattern.lower() in window.title.lower():
            try:
                win32gui.SetForegroundWindow(window.handle)
                await asyncio.sleep(0.3)
                # F26: Verify focus actually changed
                focused = win32gui.GetForegroundWindow()
                if focused == window.handle:
                    return True
                # Fallback: Alt+Tab approach
                logger.warning(f"SetForegroundWindow silent fail, trying ShowWindow+SetForegroundWindow")
                win32gui.ShowWindow(window.handle, 9)  # SW_RESTORE
                await asyncio.sleep(0.1)
                win32gui.SetForegroundWindow(window.handle)
                await asyncio.sleep(0.3)
                return True
            except Exception as e:
                logger.warning(f"Could not focus window: {e}")

    return False


async def open_application(app_name: str):
    """Open an application via Windows search"""
    logger.info(f"Opening application: {app_name}")

    # F25: Press Win key to open start menu (increased wait for slow machines)
    await hotkey("win")
    await asyncio.sleep(1.5)

    # Type app name
    await type_text(app_name)
    await asyncio.sleep(1.0)

    # Press Enter to open
    await press_key("enter")
    await asyncio.sleep(1.0)


async def close_window():
    """Close the current window"""
    await hotkey("alt", "F4")
    await asyncio.sleep(0.2)


# =============================================================================
# BROWSER HELPERS
# =============================================================================


async def open_url_in_browser(url: str, browser: str = "chrome"):
    """Open a URL in the specified browser"""
    logger.info(f"Opening URL in {browser}: {url}")

    # Focus or open browser
    if not await focus_window(browser):
        await open_application(browser)
        await asyncio.sleep(1.5)

    # 1.7: Navigate in current tab instead of opening new tab to prevent tab accumulation
    # Focus address bar directly (no new tab)
    await hotkey("ctrl", "l")
    await asyncio.sleep(0.1)
    await type_text(url)
    await press_key("enter")
    await asyncio.sleep(1.0)


async def get_current_tab_url() -> str:
    """Try to get current browser tab URL via address bar"""
    # Focus address bar
    await hotkey("ctrl", "l")
    await asyncio.sleep(0.1)

    # Select all and copy
    await hotkey("ctrl", "a")
    await asyncio.sleep(0.05)
    await hotkey("ctrl", "c")
    await asyncio.sleep(0.1)

    # Get from clipboard
    try:
        import pyperclip
        url = pyperclip.paste()
        # Press Escape to deselect
        await press_key("escape")
        return url
    except ImportError:
        logger.warning("pyperclip not installed - cannot read clipboard")
        await press_key("escape")
        return ""
    except Exception as e:
        logger.warning(f"Failed to read URL from clipboard: {e}")
        await press_key("escape")
        return ""


# =============================================================================
# WAIT UTILITIES
# =============================================================================


async def wait_for_window(title_pattern: str, timeout: int = 30) -> bool:
    """Wait for a window with matching title to appear"""
    start_time = time.time()

    while time.time() - start_time < timeout:
        windows = await get_all_windows_async()
        for window in windows:
            if title_pattern.lower() in window.title.lower():
                return True
        await asyncio.sleep(0.5)

    return False


async def wait(seconds: float):
    """Simply wait for specified duration"""
    await asyncio.sleep(seconds)


# =============================================================================
# ACTION EXECUTOR
# =============================================================================


async def execute_action(action: dict) -> dict:
    """
    Execute an action based on the action dict from Claude.

    Returns result dict with success status.
    """
    action_type = action.get("action")
    params = action.get("params", {})

    try:
        # M8: Validate required keys before dispatch
        if action_type == "click":
            # F30: Validate coordinates > 0 to prevent FAILSAFE abort at (0,0)
            x, y = params.get("x", 0), params.get("y", 0)
            if x <= 0 or y <= 0:
                return {"success": False, "error": f"Invalid click coordinates ({x}, {y}) — must be > 0"}
            await click(x, y, params.get("button", "left"))
        elif action_type == "double_click":
            await double_click(params.get("x", 0), params.get("y", 0))
        elif action_type == "right_click":
            await right_click(params.get("x", 0), params.get("y", 0))
        elif action_type == "type":
            text = params.get("text", "")
            if not text:
                return {"success": False, "error": "Missing 'text' parameter"}
            await type_text(text)
        elif action_type == "press":
            key = params.get("key", "")
            if not key:
                return {"success": False, "error": "Missing 'key' parameter"}
            await press_key(key)
        elif action_type == "hotkey":
            keys = params.get("keys", [])
            if not keys:
                return {"success": False, "error": "Missing 'keys' parameter"}
            await hotkey(*keys)
        elif action_type == "scroll":
            await scroll(params.get("clicks", 0), params.get("x"), params.get("y"))
        elif action_type == "wait":
            await wait(params.get("seconds", 1))
        elif action_type == "open_url":
            url = params.get("url", "")
            if not url:
                return {"success": False, "error": "Missing 'url' parameter"}
            await open_url_in_browser(url)
        elif action_type == "focus_window":
            title = params.get("title", "")
            if not title:
                return {"success": False, "error": "Missing 'title' parameter"}
            success = await focus_window(title)
            if not success:
                return {"success": False, "error": f"Window not found: {title}"}
        elif action_type == "open_app":
            name = params.get("name", "")
            if not name:
                return {"success": False, "error": "Missing 'name' parameter"}
            await open_application(name)
        else:
            return {"success": False, "error": f"Unknown action type: {action_type}"}

        return {"success": True}

    except Exception as e:
        logger.error(f"Error executing action {action_type}: {e}")
        return {"success": False, "error": str(e)}
