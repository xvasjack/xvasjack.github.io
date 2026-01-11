"""
Feedback Loop Runner - Integrates the feedback loop with action modules.

This is the glue layer that:
1. Creates a FeedbackLoopManager
2. Wires up callbacks to actual action implementations
3. Runs the autonomous loop
"""

import asyncio
import os
import sys
from typing import Dict, Any, Optional
from datetime import datetime
import logging

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from feedback_loop import FeedbackLoopManager, LoopConfig, create_loop_config
from template_comparison import compare_output_to_template, TEMPLATES
from file_readers.pptx_reader import analyze_pptx
from file_readers.xlsx_reader import analyze_xlsx
from actions.claude_code import run_claude_code, fix_pptx_output, ClaudeCodeResult
from actions.outlook import (
    open_outlook_web, search_emails, open_latest_email,
    download_attachment, DOWNLOAD_PATH
)
from actions.frontend import submit_form, wait_for_form_submission
from actions.github import merge_pr, get_pr_status, wait_for_ci

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("feedback_loop_runner")


# =============================================================================
# CALLBACK IMPLEMENTATIONS
# =============================================================================


async def test_frontend_callback(
    service_name: str,
    test_input: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Test a service via the frontend.

    Args:
        service_name: Name of the service (e.g., "target-v6")
        test_input: Form data to submit

    Returns:
        {success: bool, error: str}
    """
    logger.info(f"Testing {service_name} with input: {test_input}")

    # Map service to frontend URL
    frontend_urls = {
        "target-v3": "https://xvasjack.github.io/find-target.html",
        "target-v4": "https://xvasjack.github.io/find-target-v4.html",
        "target-v5": "https://xvasjack.github.io/find-target-v5.html",
        "target-v6": "https://xvasjack.github.io/find-target-v6.html",
        "profile-slides": "https://xvasjack.github.io/profile-slides.html",
        "market-research": "https://xvasjack.github.io/market-research.html",
        "validation": "https://xvasjack.github.io/validation.html",
        "trading-comparable": "https://xvasjack.github.io/trading-comparable.html",
        "utb": "https://xvasjack.github.io/utb.html",
        "due-diligence": "https://xvasjack.github.io/due-diligence.html",
    }

    url = frontend_urls.get(service_name)
    if not url:
        return {"success": False, "error": f"Unknown service: {service_name}"}

    try:
        result = await submit_form(url, test_input)
        return {"success": result.get("success", False)}
    except Exception as e:
        logger.error(f"Frontend test failed: {e}")
        return {"success": False, "error": str(e)}


async def download_email_callback(
    service_name: str,
    timeout_minutes: int
) -> Dict[str, Any]:
    """
    Wait for and download output email.

    Args:
        service_name: Service name to filter emails
        timeout_minutes: Max time to wait

    Returns:
        {success: bool, file_path: str}
    """
    logger.info(f"Waiting for email from {service_name} (timeout: {timeout_minutes}m)")

    # Subject patterns by service
    subject_patterns = {
        "target-v3": "target search result",
        "target-v4": "target search result",
        "target-v5": "target search result",
        "target-v6": "target search result",
        "profile-slides": "profile slides",
        "market-research": "market research",
        "validation": "validation result",
        "trading-comparable": "trading comp",
        "utb": "utb analysis",
        "due-diligence": "due diligence",
    }

    subject = subject_patterns.get(service_name, service_name)

    start_time = asyncio.get_event_loop().time()
    timeout_seconds = timeout_minutes * 60

    while True:
        elapsed = asyncio.get_event_loop().time() - start_time
        if elapsed > timeout_seconds:
            return {"success": False, "error": "Timeout waiting for email"}

        try:
            # Open Outlook and search
            await open_outlook_web()
            await search_emails(f"subject:{subject} hasattachment:true")
            await asyncio.sleep(2)

            # Open latest email
            await open_latest_email()
            await asyncio.sleep(1)

            # Download attachment
            result = await download_attachment()

            if result and result.get("file_path"):
                return {"success": True, "file_path": result["file_path"]}

        except Exception as e:
            logger.warning(f"Email check failed: {e}")

        # Wait before next check
        logger.info(f"No email yet. Checking again in 30s... ({int(elapsed)}s elapsed)")
        await asyncio.sleep(30)


async def analyze_output_callback(
    file_path: str,
    template_name: str
) -> Dict[str, Any]:
    """
    Analyze output file against template.

    Args:
        file_path: Path to the output file
        template_name: Name of template to compare against

    Returns:
        ComparisonResult as dict
    """
    logger.info(f"Analyzing {file_path} against template {template_name}")

    try:
        # Analyze based on file type
        if file_path.lower().endswith(".pptx"):
            analysis = analyze_pptx(file_path)
        elif file_path.lower().endswith(".xlsx"):
            analysis = analyze_xlsx(file_path)
        else:
            return {
                "passed": False,
                "discrepancies": [{
                    "severity": "critical",
                    "category": "unsupported_format",
                    "suggestion": f"Unsupported file format: {file_path}"
                }]
            }

        # Compare to template
        result = compare_output_to_template(analysis, template_name)
        return result.to_dict()

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        return {
            "passed": False,
            "discrepancies": [{
                "severity": "critical",
                "category": "analysis_error",
                "suggestion": f"Analysis failed: {str(e)}"
            }]
        }


async def send_to_claude_code_callback(prompt: str) -> Dict[str, Any]:
    """
    Send a fix prompt to Claude Code CLI.

    Args:
        prompt: The prompt describing what to fix

    Returns:
        {success: bool, pr_number: int, output: str}
    """
    logger.info(f"Sending to Claude Code: {prompt[:100]}...")

    try:
        result: ClaudeCodeResult = await run_claude_code(prompt)

        return {
            "success": result.success,
            "pr_number": result.pr_number,
            "output": result.output,
            "error": result.error,
        }
    except Exception as e:
        logger.error(f"Claude Code failed: {e}")
        return {"success": False, "error": str(e)}


async def merge_pr_callback(pr_number: int) -> Dict[str, Any]:
    """
    Wait for CI and merge a PR.

    Args:
        pr_number: The PR number to merge

    Returns:
        {success: bool, merge_error: bool, error_type: str, error_message: str}
    """
    logger.info(f"Handling PR #{pr_number}")

    try:
        # Wait for CI to pass
        ci_result = await wait_for_ci(pr_number, timeout_minutes=10)

        if not ci_result.get("passed"):
            return {
                "success": False,
                "merge_error": True,
                "error_type": "ci_failure",
                "error_message": ci_result.get("error", "CI failed"),
            }

        # Merge the PR
        merge_result = await merge_pr(pr_number)

        if not merge_result.get("success"):
            return {
                "success": False,
                "merge_error": True,
                "error_type": merge_result.get("error_type", "merge_failure"),
                "error_message": merge_result.get("error", "Merge failed"),
            }

        return {"success": True}

    except Exception as e:
        logger.error(f"PR handling failed: {e}")
        return {
            "success": False,
            "merge_error": True,
            "error_type": "exception",
            "error_message": str(e),
        }


async def get_logs_callback() -> Dict[str, Any]:
    """
    Get Railway logs for the current service.

    Returns:
        {has_errors: bool, logs: str, error_summary: str}
    """
    # This would use the railway CLI or API
    # For now, return empty logs
    logger.info("Checking Railway logs...")
    return {"has_errors": False, "logs": ""}


async def research_callback(prompt: str) -> Dict[str, Any]:
    """
    Research a stuck issue using web search and docs.

    Args:
        prompt: Research question

    Returns:
        {new_approach: str}
    """
    logger.info(f"Researching: {prompt[:100]}...")

    # Use Claude Code for research
    research_prompt = f"""Research this issue and suggest a new approach:

{prompt}

Search the codebase and suggest a foundational fix, not just a patch.
"""

    try:
        result = await run_claude_code(research_prompt)
        if result.success:
            return {"new_approach": result.output}
        return {"new_approach": None}
    except Exception as e:
        return {"new_approach": None, "error": str(e)}


async def status_update_callback(status: Dict[str, Any]):
    """
    Handle status updates (send to host).

    Args:
        status: Status dict with state, iteration, issues
    """
    logger.info(f"Status: {status}")
    # In full implementation, this would send to the WebSocket host


# =============================================================================
# RUNNER
# =============================================================================


async def run_feedback_loop(
    service_name: str,
    business: str,
    country: str,
    email: str,
    exclusion: str = "",
    max_iterations: int = 10,
    max_duration_minutes: int = 180,
) -> Dict[str, Any]:
    """
    Run a complete feedback loop for a service.

    Args:
        service_name: Service to test (e.g., "target-v6")
        business: Business description
        country: Target country
        email: Email to receive results
        exclusion: Companies to exclude
        max_iterations: Max fix iterations
        max_duration_minutes: Max total time

    Returns:
        Final result dict
    """
    logger.info(f"Starting feedback loop for {service_name}")
    logger.info(f"Business: {business}, Country: {country}")

    # Create config
    config = create_loop_config(
        service_name=service_name,
        business=business,
        country=country,
        exclusion=exclusion,
        email=email,
        max_iterations=max_iterations,
        max_duration_minutes=max_duration_minutes,
    )

    # Create manager
    manager = FeedbackLoopManager(config)

    # Wire up callbacks
    manager.on_test_frontend = test_frontend_callback
    manager.on_download_email = download_email_callback
    manager.on_analyze_output = analyze_output_callback
    manager.on_send_to_claude_code = send_to_claude_code_callback
    manager.on_merge_pr = merge_pr_callback
    manager.on_get_logs = get_logs_callback
    manager.on_research = research_callback
    manager.on_status_update = status_update_callback

    # Run the loop
    result = await manager.run()

    logger.info(f"Feedback loop completed: {result['status']}")
    logger.info(f"Iterations: {result['iterations']}, PRs: {result.get('prs_merged', 0)}")

    return result


# =============================================================================
# CLI INTERFACE
# =============================================================================


async def main():
    """CLI entry point"""
    import argparse

    parser = argparse.ArgumentParser(description="Run automated feedback loop")
    parser.add_argument("--service", required=True, help="Service name (e.g., target-v6)")
    parser.add_argument("--business", required=True, help="Business description")
    parser.add_argument("--country", required=True, help="Target country")
    parser.add_argument("--email", required=True, help="Email for results")
    parser.add_argument("--exclusion", default="", help="Companies to exclude")
    parser.add_argument("--max-iterations", type=int, default=10, help="Max fix iterations")
    parser.add_argument("--max-duration", type=int, default=180, help="Max duration in minutes")

    args = parser.parse_args()

    result = await run_feedback_loop(
        service_name=args.service,
        business=args.business,
        country=args.country,
        email=args.email,
        exclusion=args.exclusion,
        max_iterations=args.max_iterations,
        max_duration_minutes=args.max_duration,
    )

    print("\n" + "=" * 60)
    print("FEEDBACK LOOP RESULT")
    print("=" * 60)
    print(f"Status: {result['status']}")
    print(f"Iterations: {result['iterations']}")
    print(f"Duration: {result.get('duration_minutes', 0):.1f} minutes")
    print(f"Issues found: {result.get('issues_found', 0)}")
    print(f"Issues resolved: {result.get('issues_resolved', 0)}")

    if result.get('recurring_issues'):
        print("\nRecurring Issues:")
        for issue in result['recurring_issues']:
            print(f"  - {issue['description']} ({issue['occurrences']} times)")


if __name__ == "__main__":
    asyncio.run(main())
