"""
Retry/Recovery Module

Provides generic retry with exponential backoff and step-level timeout
for the feedback loop.
"""

import asyncio
import logging
from typing import Callable, Any, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("retry")


async def retry_with_backoff(
    fn: Callable,
    max_retries: int = 3,
    initial_delay: float = 2.0,
    backoff_factor: float = 2.0,
    step_timeout: float = 300.0,
    step_name: str = "step",
    min_timeout: float = 30.0,  # Category 3 fix: Minimum timeout to prevent infinite wait
    max_delay: float = 300.0,  # M14/M21 fix: Cap maximum delay to prevent unbounded waits
) -> Any:
    """
    Retry an async function with exponential backoff.

    Args:
        fn: Async callable to retry
        max_retries: Maximum number of attempts (must be >= 1)
        initial_delay: Initial delay between retries (seconds)
        backoff_factor: Multiply delay by this factor each retry
        step_timeout: Max time per attempt (seconds), 0 = use min_timeout
        step_name: Name for logging
        min_timeout: Minimum timeout when step_timeout is 0
        max_delay: Maximum delay between retries (seconds), caps exponential growth

    Returns:
        Result of fn()

    Raises:
        ValueError: If max_retries < 1
        Last exception if all retries exhausted
    """
    # Category 3 fix: Validate max_retries to prevent infinite loop or no retries
    if max_retries < 1:
        raise ValueError(f"max_retries must be >= 1, got {max_retries}")

    last_error: Exception = RuntimeError(f"No retries attempted for {step_name}")

    # Category 3 fix: step_timeout=0 should use min_timeout, not infinite wait
    effective_timeout = step_timeout if step_timeout > 0 else min_timeout
    if step_timeout == 0:
        logger.warning(f"{step_name}: step_timeout=0 interpreted as {min_timeout}s (not infinite)")

    for attempt in range(max_retries):
        try:
            result = await asyncio.wait_for(fn(), timeout=effective_timeout)
            if attempt > 0:
                logger.info(f"{step_name}: succeeded on attempt {attempt + 1}")
            return result

        except asyncio.TimeoutError:
            last_error = TimeoutError(f"{step_name} timed out after {effective_timeout}s")
            logger.warning(f"{step_name}: timed out (attempt {attempt + 1}/{max_retries})")
        except Exception as e:
            last_error = e
            logger.warning(f"{step_name}: failed (attempt {attempt + 1}/{max_retries}): {e}")

        if attempt < max_retries - 1:
            # M14/M21 fix: Cap delay to prevent unbounded exponential growth
            delay = min(initial_delay * (backoff_factor ** attempt), max_delay)
            logger.info(f"{step_name}: retrying in {delay:.1f}s")
            await asyncio.sleep(delay)

    raise last_error
