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
try:
    import pyautogui
    import pygetwindow as gw
    import mss
    from PIL import Image
    import win32gui
    import win32process
    import psutil
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run: pip install pyautogui pygetwindow mss pillow pywin32 psutil")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("computer_use")

# Safety settings for pyautogui
pyautogui.FAILSAFE = True  # Move mouse to corner to abort
pyautogui.PAUSE = 0.1  # Small pause between actions


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
    with mss.mss() as sct:
        if region:
            monitor = {"left": region[0], "top": region[1], "width": region[2], "height": region[3]}
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
    logger.info(f"Clicking at ({x}, {y}) with {button} button, {clicks} times")
    pyautogui.click(x=x, y=y, button=button, clicks=clicks)
    await asyncio.sleep(0.1)


async def double_click(x: int, y: int):
    """Double click at specified coordinates"""
    logger.info(f"Double clicking at ({x}, {y})")
    pyautogui.doubleClick(x=x, y=y)
    await asyncio.sleep(0.1)


async def right_click(x: int, y: int):
    """Right click at specified coordinates"""
    logger.info(f"Right clicking at ({x}, {y})")
    pyautogui.rightClick(x=x, y=y)
    await asyncio.sleep(0.1)


async def move_to(x: int, y: int, duration: float = 0.2):
    """Move mouse to specified coordinates"""
    pyautogui.moveTo(x=x, y=y, duration=duration)
    await asyncio.sleep(0.05)


async def scroll(clicks: int, x: Optional[int] = None, y: Optional[int] = None):
    """
    Scroll the mouse wheel.
    Positive clicks = scroll up, negative = scroll down.
    """
    logger.info(f"Scrolling {clicks} clicks at ({x}, {y})")
    if x is not None and y is not None:
        pyautogui.scroll(clicks, x=x, y=y)
    else:
        pyautogui.scroll(clicks)
    await asyncio.sleep(0.1)


async def drag(start_x: int, start_y: int, end_x: int, end_y: int, duration: float = 0.5):
    """Drag from start to end coordinates"""
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
    Uses interval between keystrokes to appear more natural.
    """
    logger.info(f"Typing text: {text[:50]}...")
    pyautogui.write(text, interval=interval)
    await asyncio.sleep(0.1)


async def press_key(key: str):
    """Press a single key (e.g., 'enter', 'tab', 'escape')"""
    logger.info(f"Pressing key: {key}")
    pyautogui.press(key)
    await asyncio.sleep(0.05)


async def hotkey(*keys: str):
    """Press a keyboard shortcut (e.g., 'ctrl', 'c' for Ctrl+C)"""
    logger.info(f"Pressing hotkey: {'+'.join(keys)}")
    pyautogui.hotkey(*keys)
    await asyncio.sleep(0.1)


# =============================================================================
# WINDOW MANAGEMENT
# =============================================================================


def get_all_windows() -> List[WindowInfo]:
    """Get list of all visible windows"""
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
                except Exception:
                    pass
        return True

    win32gui.EnumWindows(callback, None)
    return windows


async def focus_window(title_pattern: str) -> bool:
    """Focus a window by title pattern"""
    windows = get_all_windows()

    for window in windows:
        if title_pattern.lower() in window.title.lower():
            try:
                win32gui.SetForegroundWindow(window.handle)
                await asyncio.sleep(0.2)
                return True
            except Exception as e:
                logger.warning(f"Could not focus window: {e}")

    return False


async def open_application(app_name: str):
    """Open an application via Windows search"""
    logger.info(f"Opening application: {app_name}")

    # Press Win key to open start menu
    await hotkey("win")
    await asyncio.sleep(0.5)

    # Type app name
    await type_text(app_name)
    await asyncio.sleep(0.3)

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

    # Open new tab and navigate
    await hotkey("ctrl", "t")
    await asyncio.sleep(0.3)

    # Clear address bar and type URL
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
    except Exception:
        await press_key("escape")
        return ""


# =============================================================================
# WAIT UTILITIES
# =============================================================================


async def wait_for_window(title_pattern: str, timeout: int = 30) -> bool:
    """Wait for a window with matching title to appear"""
    start_time = time.time()

    while time.time() - start_time < timeout:
        windows = get_all_windows()
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
        if action_type == "click":
            await click(params["x"], params["y"], params.get("button", "left"))
        elif action_type == "double_click":
            await double_click(params["x"], params["y"])
        elif action_type == "right_click":
            await right_click(params["x"], params["y"])
        elif action_type == "type":
            await type_text(params["text"])
        elif action_type == "press":
            await press_key(params["key"])
        elif action_type == "hotkey":
            await hotkey(*params["keys"])
        elif action_type == "scroll":
            await scroll(params["clicks"], params.get("x"), params.get("y"))
        elif action_type == "wait":
            await wait(params.get("seconds", 1))
        elif action_type == "open_url":
            await open_url_in_browser(params["url"])
        elif action_type == "focus_window":
            success = await focus_window(params["title"])
            if not success:
                return {"success": False, "error": f"Window not found: {params['title']}"}
        elif action_type == "open_app":
            await open_application(params["name"])
        else:
            return {"success": False, "error": f"Unknown action type: {action_type}"}

        return {"success": True}

    except Exception as e:
        logger.error(f"Error executing action {action_type}: {e}")
        return {"success": False, "error": str(e)}
