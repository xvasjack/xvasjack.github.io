"""
Desktop Notifications - Windows toast notifications for the VM agent.

Provides notifications for:
- Plan proposals (new task plan ready for review)
- Approval requests (when human input needed)
- Task completion
- Step progress updates
- Errors that require attention

Uses win10toast for Windows 10+ toast notifications.
Falls back to a simpler approach if not available.
"""

import logging
import webbrowser
from typing import Optional, Dict, Any, Callable

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("notify")


# Try to import notification libraries
_NOTIFICATION_LIB = None
_toaster = None

try:
    # Try win10toast-click first (supports action buttons)
    from win10toast_click import ToastNotifier
    _NOTIFICATION_LIB = "win10toast_click"
    _toaster = ToastNotifier()
except ImportError:
    try:
        from win10toast import ToastNotifier
        _NOTIFICATION_LIB = "win10toast"
        _toaster = ToastNotifier()
    except ImportError:
        try:
            from plyer import notification as plyer_notification
            _NOTIFICATION_LIB = "plyer"
        except ImportError:
            try:
                # Fallback: use Windows ctypes
                import ctypes
                _NOTIFICATION_LIB = "ctypes"
            except ImportError:
                _NOTIFICATION_LIB = None

# Store pending callbacks for click actions
_pending_callbacks: Dict[str, Callable] = {}


def _show_notification(
    title: str,
    message: str,
    duration: int = 10,
    icon_path: Optional[str] = None
) -> bool:
    """
    Internal function to show a notification using available library.

    Args:
        title: Notification title
        message: Notification message
        duration: How long to show (seconds)
        icon_path: Optional path to icon

    Returns:
        True if notification was shown
    """
    logger.info(f"Notification: {title} - {message}")

    if _NOTIFICATION_LIB == "win10toast":
        try:
            _toaster.show_toast(
                title,
                message,
                duration=duration,
                icon_path=icon_path,
                threaded=True  # Non-blocking
            )
            return True
        except Exception as e:
            logger.warning(f"win10toast failed: {e}")

    elif _NOTIFICATION_LIB == "plyer":
        try:
            plyer_notification.notify(
                title=title,
                message=message,
                timeout=duration,
                app_icon=icon_path,
            )
            return True
        except Exception as e:
            logger.warning(f"plyer failed: {e}")

    elif _NOTIFICATION_LIB == "ctypes":
        try:
            # L9: Use non-blocking print instead of blocking MessageBoxW
            # MessageBoxW blocks the entire agent until user dismisses it
            logger.info(f"[NOTIFICATION] {title}: {message}")
            print(f"[NOTIFICATION] {title}: {message}")
            return True
        except Exception as e:
            logger.warning(f"ctypes notification failed: {e}")

    # Ultimate fallback: just print
    print(f"\n{'='*60}")
    print(f"NOTIFICATION: {title}")
    print(f"{'='*60}")
    print(message)
    print(f"{'='*60}\n")

    return False


def _show_notification_with_click(
    title: str,
    message: str,
    duration: int = 10,
    callback: Optional[Callable] = None,
    icon_path: Optional[str] = None
) -> bool:
    """
    Show a notification with click callback support.

    Args:
        title: Notification title
        message: Notification message
        duration: How long to show (seconds)
        callback: Function to call when notification is clicked
        icon_path: Optional path to icon

    Returns:
        True if notification was shown
    """
    logger.info(f"Notification (clickable): {title} - {message}")

    if _NOTIFICATION_LIB == "win10toast_click" and callback:
        try:
            _toaster.show_toast(
                title,
                message,
                duration=duration,
                icon_path=icon_path,
                threaded=True,
                callback_on_click=callback
            )
            return True
        except Exception as e:
            logger.warning(f"win10toast_click failed: {e}")

    # Fall back to regular notification
    return _show_notification(title, message, duration, icon_path)


def notify_plan_ready(
    plan_id: str,
    goal: str,
    steps_count: int,
    estimated_minutes: int,
    host_url: str = "http://localhost:3000"
) -> bool:
    """
    Show notification that a new plan is ready for review.

    Args:
        plan_id: Unique plan identifier
        goal: Plan goal description
        steps_count: Number of steps in plan
        estimated_minutes: Estimated duration
        host_url: URL of the host UI

    Returns:
        True if notification was shown
    """
    title = "New Task Plan Ready"
    message = f"{goal[:50]}...\n\n{steps_count} steps, ~{estimated_minutes} min\n\nClick to review"

    def on_click():
        """Open plan in browser when notification clicked"""
        plan_url = f"{host_url}/plan/{plan_id}"
        try:
            webbrowser.open(plan_url)
        except Exception as e:
            logger.warning(f"Failed to open browser: {e}")

    return _show_notification_with_click(
        title=title,
        message=message,
        duration=15,
        callback=on_click
    )


def notify_step_started(
    step_number: int,
    action: str,
    description: str
) -> bool:
    """
    Show notification that a plan step has started.

    Args:
        step_number: Current step number
        action: Action being performed
        description: Human-readable description

    Returns:
        True if notification was shown
    """
    title = f"Step {step_number}: {action}"
    message = description[:100]

    return _show_notification(
        title=title,
        message=message,
        duration=5
    )


def notify_step_completed(
    step_number: int,
    action: str,
    success: bool,
    result_summary: Optional[str] = None
) -> bool:
    """
    Show notification that a plan step has completed.

    Args:
        step_number: Completed step number
        action: Action that was performed
        success: Whether step succeeded
        result_summary: Optional summary of result

    Returns:
        True if notification was shown
    """
    if success:
        title = f"Step {step_number} Complete"
        icon = "[OK]"
    else:
        title = f"Step {step_number} Failed"
        icon = "[FAIL]"

    message = f"{icon} {action}"
    if result_summary:
        message += f"\n\n{result_summary[:80]}"

    return _show_notification(
        title=title,
        message=message,
        duration=5
    )


def notify_decision_made(
    category: str,
    chosen: str,
    reasoning: str
) -> bool:
    """
    Show notification about a decision the agent made.

    Args:
        category: Type of decision
        chosen: What was chosen
        reasoning: Why (truncated)

    Returns:
        True if notification was shown
    """
    title = f"Decision: {category}"
    message = f"Chose: {chosen}\n\nWhy: {reasoning[:80]}..."

    return _show_notification(
        title=title,
        message=message,
        duration=8
    )


def notify_approval_needed(
    message: str,
    iteration: int = 0,
    issues_count: int = 0
) -> bool:
    """
    Show notification that human approval is needed.

    Args:
        message: Description of what needs approval
        iteration: Current iteration number
        issues_count: Number of issues found

    Returns:
        True if notification was shown
    """
    title = "🔔 Agent Needs Approval"

    if iteration > 0:
        title = f"🔔 Approval Needed (Iteration {iteration})"

    full_message = message
    if issues_count > 0:
        full_message = f"{message}\n\n{issues_count} issues found - review required."

    return _show_notification(
        title=title,
        message=full_message,
        duration=15  # Keep visible longer for important notifications
    )


def notify_task_complete(
    task_name: str,
    success: bool = True,
    iterations: int = 0,
    prs_merged: int = 0
) -> bool:
    """
    Show notification that a task has completed.

    Args:
        task_name: Name/description of the task
        success: Whether it succeeded
        iterations: Number of iterations taken
        prs_merged: Number of PRs merged

    Returns:
        True if notification was shown
    """
    if success:
        title = "✅ Task Completed Successfully"
        message = f"{task_name}\n\nIterations: {iterations}\nPRs Merged: {prs_merged}"
    else:
        title = "❌ Task Failed"
        message = f"{task_name}\n\nThe task could not be completed. Check the logs for details."

    return _show_notification(
        title=title,
        message=message,
        duration=10
    )


def notify_error(
    error_message: str,
    context: Optional[str] = None
) -> bool:
    """
    Show notification for an error that needs attention.

    Args:
        error_message: Description of the error
        context: Optional context about what was happening

    Returns:
        True if notification was shown
    """
    title = "⚠️ Agent Error"
    message = error_message

    if context:
        message = f"{context}\n\n{error_message}"

    return _show_notification(
        title=title,
        message=message,
        duration=15
    )


def notify_stuck(
    issue_description: str,
    occurrences: int,
    suggestion: Optional[str] = None
) -> bool:
    """
    Show notification when the agent is stuck on a recurring issue.

    Args:
        issue_description: Description of the recurring issue
        occurrences: How many times it has occurred
        suggestion: Optional suggestion for resolution

    Returns:
        True if notification was shown
    """
    title = f"🔄 Agent Stuck ({occurrences}x)"
    message = f"Recurring issue:\n{issue_description}"

    if suggestion:
        message += f"\n\nSuggestion: {suggestion}"

    return _show_notification(
        title=title,
        message=message,
        duration=20  # Keep visible longer
    )


def notify_waiting(
    what_for: str,
    elapsed_minutes: int = 0,
    timeout_minutes: int = 45
) -> bool:
    """
    Show notification that agent is waiting for something.

    Args:
        what_for: What the agent is waiting for
        elapsed_minutes: Minutes elapsed so far
        timeout_minutes: Total timeout

    Returns:
        True if notification was shown
    """
    title = "⏳ Agent Waiting"
    remaining = timeout_minutes - elapsed_minutes
    message = f"Waiting for: {what_for}\n\nElapsed: {elapsed_minutes} min\nRemaining: {remaining} min"

    return _show_notification(
        title=title,
        message=message,
        duration=5
    )


def notify_iteration_complete(
    iteration: int,
    passed: bool,
    issues_remaining: int
) -> bool:
    """
    Show notification when a feedback loop iteration completes.

    Args:
        iteration: Iteration number
        passed: Whether the output passed validation
        issues_remaining: Number of issues still to fix

    Returns:
        True if notification was shown
    """
    if passed:
        title = f"✅ Iteration {iteration} Passed"
        message = "Output matches template. Awaiting approval to finalize."
    else:
        title = f"🔧 Iteration {iteration} Complete"
        message = f"{issues_remaining} issues remaining. Generating fix..."

    return _show_notification(
        title=title,
        message=message,
        duration=8
    )


# Test function
if __name__ == "__main__":
    print(f"Notification library: {_NOTIFICATION_LIB}")

    # Test notifications
    notify_approval_needed(
        "The output has been analyzed and needs your review.",
        iteration=3,
        issues_count=5
    )

    import time
    time.sleep(2)

    notify_task_complete(
        "Target Search V6",
        success=True,
        iterations=4,
        prs_merged=3
    )
