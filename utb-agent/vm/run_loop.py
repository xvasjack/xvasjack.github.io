#!/usr/bin/env python3
"""One-shot feedback loop runner. Usage: python run_loop.py"""

import asyncio
import os
import sys
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feedback_loop_runner import run_feedback_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)


async def main():
    service = "market-research"
    form_data = {
        "prompt": "Vietnam energy services market assessment for a Japanese oil and gas company considering market entry. Include market sizing, competitive landscape, key players, growth drivers, regulatory environment, and strategic recommendations for entry.",
        "email": os.environ.get("USER_EMAIL", "xvasjack@gmail.com"),
    }

    print(f"\n{'='*60}")
    print(f"Starting feedback loop: {service}")
    print(f"Prompt: {form_data['prompt'][:80]}...")
    print(f"Email: {form_data['email']}")
    print(f"{'='*60}\n")

    result = await run_feedback_loop(
        service_name=service,
        form_data=form_data,
        max_iterations=10,
    )

    print(f"\n{'='*60}")
    print(f"RESULT: {'PASSED' if result.success else 'FAILED'}")
    print(f"Iterations: {result.iterations}")
    print(f"Elapsed: {result.elapsed_seconds:.0f}s")
    print(f"Summary: {result.summary}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    asyncio.run(main())
