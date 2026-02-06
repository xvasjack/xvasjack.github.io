"""
Feedback Loop Runner

Connects the FeedbackLoop orchestrator to concrete implementations:
- Frontend form submission via PyAutoGUI
- Gmail email checking via browser automation
- Output analysis via file readers
- Fix generation via Claude Code CLI
- PR operations via gh CLI
- Log checking via Railway CLI or health endpoints
"""

import asyncio
import os
import re
import sys
import time
from typing import Callable, Dict, List, Optional, Any
import logging

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from feedback_loop import FeedbackLoop, LoopConfig, LoopResult
from actions.frontend_api import submit_form_api
from actions.gmail_api import wait_for_email_api, HAS_GMAIL_API
from actions.claude_code import run_claude_code, improve_output
from actions.github import merge_pr, wait_for_ci, get_ci_error_logs
from template_comparison import compare_output_to_template as compare_output, auto_detect_template
from file_readers.pptx_reader import analyze_pptx
from file_readers.xlsx_reader import analyze_xlsx
from file_readers.docx_reader import analyze_docx

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("feedback_loop_runner")

# Issue history and pattern detection
try:
    from issue_pattern_detector import load_history, append_iteration, detect_patterns, generate_fix_context, categorize_issue
    HAS_ISSUE_DETECTOR = True
except ImportError:
    HAS_ISSUE_DETECTOR = False
    logger.warning("issue_pattern_detector not available")


# In-memory storage for git diffs per iteration (not persisted — reset each loop run)
_recent_diffs: List[str] = []

# Import shared fabrication patterns (single source of truth)
try:
    from fabrication_patterns import check_fabrication as _shared_check_fabrication, FABRICATION_PATTERNS
except ImportError:
    logger.warning("fabrication_patterns module not found — using inline fallback")
    FABRICATION_PATTERNS = [
        r"https?://www\.\w+-\w+-\w+\.com\.\w{2}",
        r"getFallback\w*Content|getDefault\w*Data",
        r"fallback(?:Result|Data|Companies|Regulations)",
    ]
    _shared_check_fabrication = None

# Import WSL-aware helpers for auto-revert
try:
    from shared.cli_utils import get_repo_cwd, get_subprocess_cwd, is_wsl_mode
except ImportError:
    get_repo_cwd = None
    get_subprocess_cwd = None
    is_wsl_mode = None


async def _auto_revert_last_commit() -> bool:
    """Revert the last commit and push, to undo fabricated content.
    WSL-aware: handles both Windows-calling-WSL and native Linux.
    Returns True if revert succeeded."""
    try:
        repo_path = get_repo_cwd() if get_repo_cwd else os.path.expanduser("~/xvasjack.github.io")
        win_cwd, wsl_cwd = get_subprocess_cwd() if get_subprocess_cwd else (repo_path, None)

        if wsl_cwd:
            # WSL mode: call git through wsl
            revert_cmd = ["wsl", "--cd", wsl_cwd, "-e", "git", "revert", "HEAD", "--no-edit"]
            push_cmd = ["wsl", "--cd", wsl_cwd, "-e", "git", "push"]
            effective_cwd = None
        else:
            revert_cmd = ["git", "revert", "HEAD", "--no-edit"]
            push_cmd = ["git", "push"]
            effective_cwd = win_cwd or repo_path

        # Revert
        proc = await asyncio.create_subprocess_exec(
            *revert_cmd, cwd=effective_cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            logger.error(f"git revert failed: {stderr.decode()[:200]}")
            return False

        # Push the revert
        proc = await asyncio.create_subprocess_exec(
            *push_cmd, cwd=effective_cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            logger.error(f"git push (revert) failed: {stderr.decode()[:200]}")
            return False

        logger.info("Auto-revert: fabricated commit reverted and pushed")
        return True
    except Exception as e:
        logger.error(f"Auto-revert failed: {e}")
        return False


def _validate_no_fabrication(git_diff: str) -> Optional[str]:
    """Validate that a git diff does not contain fabricated content.
    Returns error message if fabrication detected, None otherwise."""
    if not git_diff:
        return None

    # Use shared module (has broader patterns)
    if _shared_check_fabrication is not None:
        return _shared_check_fabrication(git_diff)

    # Fallback: local check
    for pattern in FABRICATION_PATTERNS:
        match = re.search(pattern, git_diff, re.IGNORECASE)
        if match:
            return f"FABRICATION DETECTED in commit: Pattern matched '{match.group(0)[:50]}'"

    return None


async def _check_backend_alive(service_name: str) -> dict:
    """Health check during email wait to detect container restart."""
    try:
        from config import RAILWAY_URLS
    except ImportError:
        return {"alive": True, "reason": "config not available"}
    base_url = RAILWAY_URLS.get(service_name)
    if not base_url:
        return {"alive": True, "reason": "no URL configured"}
    health_url = base_url.rstrip("/") + "/health"
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-sS", "--max-time", "5", "-o", "/dev/null",
            "-w", "%{http_code}", health_url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        code = stdout.decode().strip() if stdout else ""
        if code.startswith("2"):
            return {"alive": True, "reason": f"HTTP {code}"}
        return {"alive": False, "reason": f"HTTP {code}"}
    except Exception as e:
        return {"alive": False, "reason": str(e)}


# Scope routing: map issue categories to source files
SCOPE_FILES = {
    "research": "research-orchestrator.js, ai-clients.js",
    "synthesis": "research-orchestrator.js, ppt-single-country.js",
    "layout": "ppt-utils.js, ppt-single-country.js, template-patterns.json",
    "formatting": "template-patterns.json, ppt-utils.js",
    "mixed": "research-orchestrator.js, ppt-single-country.js, ppt-utils.js, template-patterns.json",
}
SCOPE_DONT_TOUCH = {
    "research": "ppt-single-country.js, ppt-utils.js, template-patterns.json",
    "synthesis": "template-patterns.json, ppt-utils.js",
    "layout": "research-orchestrator.js, ai-clients.js",
    "formatting": "research-orchestrator.js, ai-clients.js, ppt-single-country.js",
    "mixed": "",  # No restrictions — issues span multiple areas
}


def _classify_fix_scope(issues: List[str]) -> str:
    """Classify issues into dominant scope: research|synthesis|layout|formatting|mixed."""
    if not HAS_ISSUE_DETECTOR:
        return "layout"
    counts = {"research": 0, "synthesis": 0, "layout": 0, "formatting": 0}
    for issue in issues:
        cat = categorize_issue(str(issue))
        if cat in ("empty_data", "api_failure"):
            counts["research"] += 1
        elif cat in ("content_depth", "insight_missing", "research_quality"):
            counts["synthesis"] += 1
        elif cat in ("pattern_selection", "chart_error", "table_overflow"):
            counts["layout"] += 1
        elif cat == "layout_formatting":
            counts["formatting"] += 1
    total = sum(counts.values())
    if total == 0:
        return "layout"
    dominant = max(counts, key=counts.get)
    # Fix 5: When no single category dominates (>60%), use mixed scope
    if counts[dominant] / total < 0.6:
        return "mixed"
    return dominant


# Fix 6: Tell agent EXACTLY what to modify within each scope (prompt vs code vs config)
SCOPE_WHAT_TO_CHANGE = {
    "research": (
        "CHANGE TYPE: AI prompt text + API query parameters\n"
        "WHERE: The prompt strings inside synthesizePolicy(), synthesizeMarket(), "
        "synthesizeCompetitors(), synthesizeSummary() in research-orchestrator.js\n"
        "Look for the 'DEPTH REQUIREMENTS' sections inside each prompt string.\n"
        "Also check: search query construction in research-agents.js\n"
        "DO NOT add code workarounds to pad thin content — fix the prompt that generates it."
    ),
    "synthesis": (
        "CHANGE TYPE: AI prompt text OR data-passing code\n"
        "WHERE: If content is thin/generic -> edit prompt strings in research-orchestrator.js "
        "(synthesize* functions, DEPTH REQUIREMENTS sections)\n"
        "If content exists but gets lost during slide generation -> edit data mapping in "
        "ppt-single-country.js (how research results are read and placed on slides)\n"
        "DO NOT add enrichDescription-style workarounds that pad thin data with generic text."
    ),
    "layout": (
        "CHANGE TYPE: JavaScript layout logic OR JSON config\n"
        "WHERE: choosePattern() in ppt-utils.js (pattern selection logic), "
        "slide building functions in ppt-single-country.js (element positioning), "
        "or pattern definitions in template-patterns.json (position/size values)\n"
        "DO NOT touch research-orchestrator.js prompts."
    ),
    "formatting": (
        "CHANGE TYPE: JSON config values OR pptxgenjs parameters\n"
        "WHERE: template-patterns.json (font sizes, colors, positions) OR "
        "pptxgenjs calls in ppt-utils.js (addText, addShape params)\n"
        "DO NOT touch research content or prompts."
    ),
    "mixed": (
        "CHANGE TYPE: Mixed — issues span multiple areas\n"
        "Analyze each issue independently and change the appropriate layer:\n"
        "- Content quality issues -> edit AI prompt text in research-orchestrator.js\n"
        "- Layout issues -> edit ppt-utils.js or template-patterns.json\n"
        "- Data loss issues -> trace the data flow from research-orchestrator.js through "
        "ppt-single-country.js to find where data gets dropped"
    ),
}


# 0.7: Wrap browser imports in try/except — GUI deps may not be available
HAS_BROWSER = False
try:
    from actions.frontend import submit_form as frontend_submit_form
    from actions.gmail import (
        open_gmail, search_emails, open_first_email,
        download_attachment, wait_for_download, get_recent_downloads,
    )
    HAS_BROWSER = True
except ImportError:
    logger.warning("Browser automation not available (missing pyautogui/win32gui)")
    frontend_submit_form = None
    open_gmail = search_emails = open_first_email = None
    download_attachment = wait_for_download = get_recent_downloads = None


# =============================================================================
# CONFIGURATION
# =============================================================================

FRONTEND_URL = os.environ.get("FRONTEND_URL", "https://xvasjack.github.io")

# S2: Map service names to email subject search hints (backend emails use human-readable subjects)
SERVICE_EMAIL_SUBJECTS = {
    "target-v3": "[V3]",
    "target-v4": "[V4]",
    "target-v5": "[V5]",
    "target-v6": "[V6]",
    "market-research": "Market Research:",
    "profile-slides": "Profile Slides:",
    "trading-comparable": "Trading Comps:",
    "validation": "Speeda List Validation:",
    "due-diligence": "DD Report:",
    "utb": "utb",
}

# Issue 5: Map service names to template names in template_comparison.TEMPLATES
SERVICE_TO_TEMPLATE = {
    "target-v3": "target-search",
    "target-v4": "target-search",
    "target-v5": "target-search",
    "target-v6": "target-search",
    "market-research": "market-research",
    "profile-slides": "profile-slides",
    "trading-comparable": "trading-comps",
    "validation": "validation-results",
    "due-diligence": "dd-report",
    "utb": None,  # needs template
}


# =============================================================================
# CALLBACK IMPLEMENTATIONS
# =============================================================================


async def submit_form_callback(
    service_name: str,
    form_data: Dict[str, str],
) -> Dict[str, Any]:
    """
    Submit form — API POST first, browser fallback.
    Issue 2: Direct HTTP POST to Railway backend.
    Issue 7: Fallback to browser automation if API fails.
    """
    # Primary: Direct API POST
    try:
        result = await submit_form_api(service_name, form_data)
        if result.get("success"):
            logger.info(f"API POST succeeded for {service_name}")
            return result
        logger.warning(f"API POST failed: {result.get('error')} — falling back to browser")
    except Exception as e:
        logger.warning(f"API POST error: {e} — falling back to browser")

    # Fallback: Browser automation
    url_map = {
        "target-v3": "find-target.html",
        "target-v4": "find-target-v4.html",
        "target-v5": "find-target-v5.html",
        "target-v6": "find-target-v6.html",
        "market-research": "market-research.html",
        "profile-slides": "profile-slides.html",
        "trading-comparable": "trading-comparable.html",
        "validation": "validation.html",
        "due-diligence": "due-diligence.html",
        "utb": "utb.html",
    }

    page = url_map.get(service_name, f"{service_name}.html")
    url = f"{FRONTEND_URL}/{page}"

    # 0.7: Check browser is available before attempting
    if not HAS_BROWSER or frontend_submit_form is None:
        return {"success": False, "error": "API submission failed and browser automation not available"}

    # F9: Wrap browser fallback in try/except to prevent unhandled crash
    try:
        return await frontend_submit_form(url, form_data)
    except Exception as e:
        logger.error(f"Browser fallback failed: {e}")
        return {"success": False, "error": f"Both API and browser submission failed: {e}"}


async def wait_for_email_callback(
    service_name: str,
    timeout_minutes: int = 65,
    skip_email_ids: set = None,
    after_epoch: int = None,
) -> Dict[str, Any]:
    """
    Wait for automation output email.
    Issue 3: Gmail API first, browser fallback.
    Issue 7: Fallback to checking Downloads folder.
    """
    logger.info(f"Waiting for {service_name} email (timeout: {timeout_minutes}m)")

    # 1.1: Use AGENT_DOWNLOAD_PATH if set
    download_dir = os.environ.get("AGENT_DOWNLOAD_PATH", os.path.expanduser("~/Downloads"))

    # Primary: Gmail API
    if HAS_GMAIL_API:
        try:
            subject_hint = SERVICE_EMAIL_SUBJECTS.get(service_name, service_name)
            query = f"subject:({subject_hint}) has:attachment in:anywhere"

            async def check_alive():
                return await _check_backend_alive(service_name)

            result = await wait_for_email_api(
                query=query,
                download_dir=download_dir,
                timeout_minutes=timeout_minutes,
                poll_interval=30,
                skip_email_ids=skip_email_ids,
                after_epoch=after_epoch,
                liveness_check=check_alive,
                liveness_check_interval=3,
            )
            if result.get("backend_died"):
                logger.error("Backend died during email wait — skipping browser fallback")
                return result
            if result.get("success"):
                # Fix 3: Detect backend failure emails by subject
                if "failed" in result.get("subject", "").lower():
                    logger.warning(f"Backend sent failure email: {result.get('subject')}")
                    return {
                        "success": False,
                        "error": f"Backend sent failure email: {result.get('subject')}",
                        "email_id": result.get("email_id"),
                        "backend_failure_email": True,
                    }
                logger.info(f"Gmail API downloaded: {result.get('file_path')}")
                return result
            logger.warning(f"Gmail API failed: {result.get('error')} — falling back to browser")
        except Exception as e:
            logger.warning(f"Gmail API error: {e} — falling back to browser")

    # Fallback: Browser automation
    if not HAS_BROWSER:
        logger.warning("Browser automation not available, skipping browser email fallback")
    else:
        deadline_browser = time.time() + (timeout_minutes * 60)
        poll_interval_browser = 30

    deadline = time.time() + (timeout_minutes * 60)
    poll_interval = 30

    while HAS_BROWSER and time.time() < deadline:
        try:
            await open_gmail()
            await asyncio.sleep(2)

            subject_hint = SERVICE_EMAIL_SUBJECTS.get(service_name, service_name)
            query = f"subject:({subject_hint}) has:attachment in:anywhere"
            await search_emails(query)
            await asyncio.sleep(2)

            await open_first_email()
            await asyncio.sleep(1)

            await download_attachment()
            await asyncio.sleep(1)

            downloaded = await wait_for_download(timeout_seconds=60)

            if downloaded:
                files = get_recent_downloads(max_age_minutes=2)
                if files:
                    logger.info(f"Downloaded: {files[0]}")
                    return {
                        "success": True,
                        "file_path": files[0],
                        "all_files": files,
                    }

        except Exception as e:
            # F57: Re-raise auth/login errors — retrying won't fix them
            err_str = str(e).lower()
            if any(kw in err_str for kw in ("auth", "login", "credential", "permission", "forbidden", "401", "403")):
                logger.error(f"Email auth/login error (not retrying): {e}")
                return {"success": False, "error": f"Authentication error: {e}"}
            logger.warning(f"Email check failed: {e}")

        # Issue 7: Also check Downloads folder for recent files
        # Stale-state fix (bug 4): Only accept files modified AFTER after_epoch
        try:
            if os.path.exists(download_dir):
                import glob
                patterns = [f"{download_dir}/*.pptx", f"{download_dir}/*.xlsx", f"{download_dir}/*.docx"]
                for pattern in patterns:
                    for f in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
                        file_mtime = os.path.getmtime(f)
                        # Reject files from before the form submission epoch
                        if after_epoch and file_mtime < after_epoch:
                            continue
                        age = time.time() - file_mtime
                        # Category 8 fix: Use more precise filename matching
                        fname_lower = os.path.basename(f).lower().replace("-", "").replace("_", "")
                        # Issue 100/24/32 fix: Check service_name is not None before string ops
                        if not service_name:
                            continue
                        svc_lower = service_name.replace("-", "").replace("_", "")
                        # Require the service name to appear as a distinct part, not just substring
                        # F58: Extended download window from 2min to 10min
                        if age < 600 and (svc_lower in fname_lower or fname_lower.startswith(svc_lower)):
                            logger.info(f"Found in Downloads: {f}")
                            return {"success": True, "file_path": f}

                # 1.2: Recency-only fallback — only accept files newer than after_epoch
                for pattern in patterns:
                    for f in sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True):
                        file_mtime = os.path.getmtime(f)
                        if after_epoch and file_mtime < after_epoch:
                            continue
                        age = time.time() - file_mtime
                        if age < 120:
                            logger.info(f"Found recent file in Downloads (no name match, <2min): {f}")
                            return {"success": True, "file_path": f}
        except Exception as e:
            # Category 8 fix: Log download check errors instead of silently swallowing
            logger.debug(f"Download folder check failed: {e}")

        logger.info(f"No email yet, waiting {poll_interval}s...")
        await asyncio.sleep(poll_interval)

    return {
        "success": False,
        "error": f"Email not received within {timeout_minutes} minutes",
    }


async def analyze_output_callback(
    file_path: str,
    service_name: str,
    template_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Analyze downloaded output file against template"""
    logger.info(f"Analyzing output: {file_path}")

    if not os.path.exists(file_path):
        return {
            "issues": [f"File not found: {file_path}"],
            "analysis": None,
        }

    try:
        # Read file based on extension
        ext = os.path.splitext(file_path)[1].lower()

        if ext == ".pptx":
            raw = analyze_pptx(file_path)
            analysis = raw.to_dict() if hasattr(raw, 'to_dict') else raw
        elif ext in (".xlsx", ".xls"):
            raw = analyze_xlsx(file_path)
            analysis = raw.to_dict() if hasattr(raw, 'to_dict') else raw
        elif ext == ".docx":
            raw = analyze_docx(file_path)
            analysis = raw.to_dict() if hasattr(raw, 'to_dict') else raw
        else:
            return {
                "issues": [f"Unsupported file type: {ext}"],
                "analysis": None,
            }

        # Ensure analysis is a plain dict
        # B6: Use dataclasses.asdict() as fallback since vars() fails on dataclasses
        if not isinstance(analysis, dict):
            if hasattr(analysis, 'to_dict'):
                analysis = analysis.to_dict()
            else:
                import dataclasses
                if dataclasses.is_dataclass(analysis):
                    analysis = dataclasses.asdict(analysis)
                else:
                    analysis = vars(analysis)

        # Issue 5: Map service name to template name
        template = template_name or SERVICE_TO_TEMPLATE.get(service_name)
        if template is None:
            # Try auto-detection
            template = auto_detect_template(file_path, analysis)
        if template is None:
            return {
                "issues": ["No template available for this service — manual review needed"],
                "analysis": analysis,
            }

        # Issue 10: compare_output returns ComparisonResult object, not dict
        comparison_result = compare_output(analysis, template)

        # Prioritize and limit to top 5 issues per iteration
        if hasattr(comparison_result, 'prioritize_and_limit'):
            comparison_result = comparison_result.prioritize_and_limit(max_issues=5)

        # Use ComparisonResult's structured output
        issues = [d.to_comment() for d in comparison_result.discrepancies]

        return {
            "issues": issues,
            "passed": comparison_result.passed,
            "analysis": analysis,
            "comparison": comparison_result.to_dict(),
            "fix_prompt": comparison_result.generate_claude_code_prompt(),
        }

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        return {
            "issues": [f"Analysis error: {str(e)}"],
            "analysis": None,
        }


def _load_template_reference(service_name: str) -> str:
    """Load the relevant section from template_reference.md for a service."""
    ref_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template_reference.md")
    if not os.path.exists(ref_path):
        return ""

    try:
        with open(ref_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return ""

    # Map service names to section headers in template_reference.md
    section_map = {
        "target-v3": "Target Search",
        "target-v4": "Target Search",
        "target-v5": "Target Search",
        "target-v6": "Target Search",
        "market-research": "Market Research",
        "profile-slides": "Profile Slides",
        "due-diligence": "Due Diligence Report",
    }

    header_keyword = section_map.get(service_name)
    if not header_keyword:
        return ""

    # Extract the relevant section (## header to next ## header)
    lines = content.split("\n")
    capturing = False
    section_lines = []
    for line in lines:
        if line.startswith("## ") and header_keyword.lower() in line.lower():
            capturing = True
            section_lines.append(line)
            continue
        if capturing and line.startswith("## "):
            break
        if capturing:
            section_lines.append(line)

    if not section_lines:
        return ""

    return "\n".join(section_lines).strip()


def _load_formatting_spec(service_name: str) -> str:
    """Load MARKET_RESEARCH_FORMATTING_SPEC.md when formatting issues detected."""
    spec_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "MARKET_RESEARCH_FORMATTING_SPEC.md"
    )
    if not os.path.exists(spec_path):
        return ""
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            content = f.read()
        # Fix 2: Load full spec — chart guidelines, insight framework, slide type
        # templates, and quality checklist are directly relevant to common failures
        # (insufficient_data_visualization, missing_strategic_insights).
        # Prompt size is already capped by _build_prompt's 50K truncation.
        return content.strip()
    except Exception:
        return ""


def _has_formatting_issues(issues: List[str]) -> bool:
    """Check if any issues are formatting-related"""
    formatting_keywords = [
        "overflow", "overlap", "font_size", "font_family", "color_mismatch",
        "header_line", "title_font", "subtitle_font", "bold_mismatch",
        "text_overflow", "content_overlap", "formatting",
    ]
    for issue in issues:
        if any(kw in issue.lower() for kw in formatting_keywords):
            return True
    return False


async def _diagnose_root_cause(
    issues: List[str],
    service_name: str,
    iteration: int,
) -> Dict[str, Any]:
    """
    Think-first step: Diagnose root cause before attempting fix.
    Returns diagnosis with recommended strategy.
    """
    logger.info("Diagnosing root cause...")

    # Check for known patterns first
    if HAS_ISSUE_DETECTOR:
        try:
            from issue_pattern_detector import get_successful_fix_for_issues
            past_fix = get_successful_fix_for_issues(issues)
            if past_fix:
                logger.info(f"Using past pattern: {past_fix.get('strategy', '')[:50]}...")
                return {
                    "diagnosis": past_fix.get("diagnosis", ""),
                    "strategy": past_fix.get("strategy", ""),
                    "from_memory": True,
                    "confidence": "high",
                }
        except (ImportError, Exception) as e:
            logger.debug(f"Pattern memory check failed: {e}")

    # Categorize issues by type
    issue_categories = {}
    for issue in issues:
        if HAS_ISSUE_DETECTOR:
            cat = categorize_issue(issue)
        else:
            cat = "unknown"
        issue_categories.setdefault(cat, []).append(issue)

    # Determine dominant category
    dominant = max(issue_categories.keys(), key=lambda k: len(issue_categories[k])) if issue_categories else "unknown"

    # Build diagnosis based on category patterns
    diagnosis_map = {
        "empty_data": "Research pipeline returning empty results. Root cause likely in query construction or API connectivity.",
        "content_depth": "Content is shallow/generic. Research queries may be too broad or synthesis prompts lack depth guidance.",
        "pattern_selection": "Wrong layout pattern selected. Data classifier (choosePattern) misidentifying data type.",
        "layout_formatting": "Formatting mismatch. Pattern definitions may not match reference template positions.",
        "api_failure": "API errors. Check rate limits, key validity, or model availability.",
        "research_quality": "Research returning low-quality results. Queries may need more specificity.",
        "insight_missing": "Missing business insights. Synthesis step not generating 'so what' implications.",
        "chart_error": "Chart generation failing. Check data format matches chart type expectations.",
        "table_overflow": "Table content exceeds bounds. Need to adjust sizing or split across slides.",
    }

    # Fix 8: Specific function/file references so the agent knows exactly where to look
    strategy_map = {
        "empty_data": (
            "1) Check research-orchestrator.js: are the search queries in research-agents.js returning results? "
            "2) Check ai-clients.js: is the API response being parsed correctly? "
            "3) Check research-orchestrator.js orchestrateResearch(): is the pipeline sequencing correct?"
        ),
        "content_depth": (
            "1) Edit the PROMPT TEXT in research-orchestrator.js synthesizeMarket() — "
            "find the 'DEPTH REQUIREMENTS' section and add more specific requirements. "
            "2) Also check synthesizePolicy() and synthesizeCompetitors() prompts. "
            "3) Do NOT add code in ppt-single-country.js to pad thin content — fix the prompt."
        ),
        "pattern_selection": (
            "1) Review choosePattern() in ppt-utils.js — the dataType being assigned doesn't match actual data. "
            "2) Verify the data classification logic matches template-patterns.json pattern names. "
            "3) Check ppt-single-country.js for where dataType is set before choosePattern() is called."
        ),
        "layout_formatting": (
            "1) Re-extract positions from reference PPTX into template-patterns.json. "
            "2) Check ppt-utils.js addText/addShape calls — are they reading from template-patterns.json? "
            "3) Match x/y/w/h/fontSize values in ppt-utils.js to the spec in template-patterns.json."
        ),
        "api_failure": "1) Check API key validity, 2) Check rate limits in ai-clients.js, 3) Add fallback provider chain",
        "research_quality": (
            "1) Edit search query construction in research-agents.js — use more specific terms with year ranges. "
            "2) Verify Kimi API in ai-clients.js is returning web search results (not just training data). "
            "3) Check research-orchestrator.js for where search results are filtered or truncated."
        ),
        "insight_missing": (
            "1) Edit the PROMPT TEXT in research-orchestrator.js synthesizeSummary() — "
            "add explicit 'so what' and 'now what' prompting. "
            "2) Look for the insight generation section in the prompt string. "
            "3) Add examples of what good insights look like (specific data + implication + timing)."
        ),
        "chart_error": (
            "1) Validate data format in ppt-single-country.js before calling addChart(). "
            "2) Check series/categories arrays are not empty and values are numeric. "
            "3) Check ppt-utils.js chart helper functions for type mismatches."
        ),
        "table_overflow": (
            "1) Increase maxH in template-patterns.json for the relevant pattern. "
            "2) Reduce fontSize in ppt-utils.js table rendering calls. "
            "3) Add slide-splitting logic in ppt-single-country.js when row count exceeds threshold."
        ),
    }

    return {
        "diagnosis": diagnosis_map.get(dominant, f"Mixed issues dominated by {dominant}"),
        "strategy": strategy_map.get(dominant, "Investigate root cause in relevant pipeline stage"),
        "dominant_category": dominant,
        "issue_breakdown": {k: len(v) for k, v in issue_categories.items()},
        "from_memory": False,
        "confidence": "medium" if iteration <= 2 else "low",
    }


def _build_deep_analysis_context(analysis: Dict[str, Any], diagnosis: Optional[Dict] = None) -> str:
    """Build context showing the agent what was actually produced and where quality dropped.

    Combines output excerpts + diagnostic scores + diagnosis steps into one block.
    Budget: ~3KB. Only meaningful for content/insight issues.
    """
    if not analysis:
        return ""
    comparison = analysis.get("comparison", {})
    raw = analysis.get("analysis", {})
    if not raw:
        return ""

    lines = ["\n\n## Content Pipeline Diagnostic"]

    # Scores
    depth = comparison.get("content_depth_score", "?")
    insight = comparison.get("insight_score", "?")
    lines.append(f"- Content depth score: {depth}/100")
    lines.append(f"- Insight quality score: {insight}/10")

    # What's specifically missing
    if comparison.get("missing_regulations"):
        lines.append(f"- MISSING: Named regulations with years (found {comparison.get('regulation_count', 0)}, need >=3)")
    if comparison.get("missing_data_points"):
        lines.append(f"- MISSING: Quantified data points (found {comparison.get('data_point_count', 0)}, need >=15)")
    if comparison.get("missing_companies"):
        lines.append(f"- MISSING: Named companies (found {comparison.get('company_indicator_count', 0)}, need >=3)")

    # Actual output excerpts — show what was ACTUALLY generated
    slides_data = raw.get("slides", []) if isinstance(raw, dict) else []
    if slides_data:
        # Slide structure
        titles = [s.get("title", "(no title)") for s in slides_data]
        lines.append(f"\n### Slide Structure ({len(slides_data)} slides)")
        for i, t in enumerate(titles[:20], 1):
            lines.append(f"  {i}. {t}")

        # Thinnest content slides (skip title slide)
        content_slides = [s for s in slides_data if s.get("number", 0) > 1]
        content_slides.sort(key=lambda s: len(s.get("all_text", "") or ""))
        thinnest = content_slides[:3]
        if thinnest:
            lines.append(f"\n### Thinnest Slides (actual output text)")
            for s in thinnest:
                text = (s.get("all_text", "") or "")[:500]
                word_count = len(text.split())
                lines.append(f"\n**Slide {s.get('number', '?')} ({word_count} words): {s.get('title', '(no title)')}**")
                lines.append(f"```\n{text}\n```")

        # Total word count
        total_words = sum(len((s.get("all_text", "") or "").split()) for s in slides_data)
        lines.append(f"\n- Total word count across all slides: {total_words}")
    elif not slides_data:
        lines.append("\n- No slides found in output")

    # Diagnosis steps
    lines.append(f"\n### DIAGNOSE before fixing:")
    lines.append("1. Read research-orchestrator.js synthesize*() — does the DEPTH REQUIREMENTS section ask for what's missing?")
    lines.append("2. YES requirements exist but output thin → research data itself is sparse → fix search queries in research-agents.js")
    lines.append("3. NO requirements don't exist → add them to the prompt")
    lines.append("4. If data IS in the research output but NOT on slides → ppt-single-country.js is dropping it")

    return "\n".join(lines)


async def generate_fix_callback(
    issues: List[str],
    analysis: Dict[str, Any],
    service_name: str,
    iteration: int = 0,
    form_data: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Generate fix using Claude Code CLI"""
    logger.info(f"Generating fix for {len(issues)} issues")

    # THINK FIRST: Diagnose root cause before fixing
    diagnosis = await _diagnose_root_cause(issues, service_name, iteration)
    diagnosis_context = ""
    if diagnosis:
        if diagnosis.get("from_memory"):
            logger.info(f"Using past pattern for {diagnosis.get('dominant_category', 'issues')}")
        else:
            logger.info(f"Diagnosing root cause... Category: {diagnosis.get('dominant_category', 'unknown')}")

        diagnosis_context = (
            f"\n\n## Root Cause Diagnosis (think first)\n"
            f"**Diagnosis**: {diagnosis.get('diagnosis', 'Unknown')}\n"
            f"**Recommended Strategy**: {diagnosis.get('strategy', 'Investigate')}\n"
            f"**Confidence**: {diagnosis.get('confidence', 'low')}\n"
        )
        if diagnosis.get("from_memory"):
            diagnosis_context += "**Source**: Previously successful fix pattern\n"

        # Add required analysis template for structured thinking
        diagnosis_context += (
            "\n\n## Required Analysis (complete BEFORE writing code)\n"
            "1. Root cause: [which function in which file loses/corrupts the data?]\n"
            "2. Why previous fixes failed: [what did they change vs what should change?]\n"
            "3. My approach: [file:function to modify, and WHY]\n"
            "4. Fabrication check: Does this add any hardcoded content strings? [YES=STOP / NO=proceed]\n"
            "5. Generalization check: Will this work for other countries/industries? [YES/NO]\n"
        )

    # Load content depth reference for this service
    template_ref = _load_template_reference(service_name)
    ref_context = ""
    if template_ref:
        ref_context = (
            f"\n\n## Content Quality Reference\n"
            f"The output must meet this content depth standard:\n\n"
            f"{template_ref}\n"
        )

    # Load formatting spec when formatting issues are present
    formatting_context = ""
    if _has_formatting_issues(issues):
        fmt_spec = _load_formatting_spec(service_name)
        if fmt_spec:
            formatting_context = (
                f"\n\n## Formatting Specification (from reference template)\n"
                f"Fix formatting to match this spec. These values were extracted from the approved reference template.\n\n"
                f"{fmt_spec}\n\n"
                f"### pptxgenjs-specific fix hints:\n"
                f"- Text overflow: reduce text length, or increase `h` parameter on the text shape\n"
                f"- Content overlap: adjust `y` parameter so that y + h of shape A < y of shape B\n"
                f"- Wrong color: use hex string without '#' prefix, e.g. `color: '1F497D'`\n"
                f"- Wrong font size: set `fontSize` in points, e.g. `fontSize: 24`\n"
                f"- Missing header line: add `slide.addShape('line', {{...}})` after title\n"
                f"- Wrong font: set `fontFace: 'Segoe UI'` on all text elements\n"
            )

    # Issue 11: Use structured fix_prompt from ComparisonResult if available
    fix_prompt = analysis.get("fix_prompt") if analysis else None

    # Build previous diff context
    diff_context = ""
    if iteration > 1 and len(_recent_diffs) >= iteration - 1:
        prev_diff = _recent_diffs[iteration - 2]  # 0-indexed
        if prev_diff:
            diff_context = (
                f"\n\n## PREVIOUS FIX (iteration {iteration - 1}) — Code That Was Changed\n"
                f"```diff\n{prev_diff[:8000]}\n```\n"
                f"This did NOT fully resolve the issues. Do NOT repeat the same change.\n"
                f"If the same file was changed, try a DIFFERENT approach in that file.\n"
            )

    # Fix 3: Iteration delta tracking — show what improved/worsened since last fix
    delta_context = ""
    if iteration > 1 and HAS_ISSUE_DETECTOR:
        try:
            history = load_history()
            if len(history) >= 2:
                prev_issues = set(history[-2].get("specificFailures", []))
                curr_issues = set(issues[:10])
                resolved = prev_issues - curr_issues
                new_issues = curr_issues - prev_issues
                persisted = prev_issues & curr_issues
                if resolved or new_issues:
                    delta_context = (
                        f"\n\n## Iteration Delta (what changed since last fix)\n"
                        f"- Resolved ({len(resolved)}): {'; '.join(list(resolved)[:3]) or 'none'}\n"
                        f"- NEW issues ({len(new_issues)}): {'; '.join(list(new_issues)[:3]) or 'none'}\n"
                        f"- Still broken ({len(persisted)}): {'; '.join(list(persisted)[:3]) or 'none'}\n"
                    )
        except Exception as e:
            logger.debug(f"Delta tracking failed: {e}")

    # Scope routing — skip for crash/failure fixes (crash could be in any file)
    if analysis and analysis.get("crash_fix"):
        scope_context = (
            "\n\n## FIX SCOPE: ALL FILES IN backend/market-research/ (CRASH FIX)\n"
            "Backend crashed or failed — investigate ALL source files for the root cause.\n"
            "Key files by pipeline stage:\n"
            "- Scope parsing: research-framework.js\n"
            "- Research agents: research-agents.js, ai-clients.js\n"
            "- Synthesis: research-orchestrator.js\n"
            "- PPT generation: ppt-single-country.js, ppt-multi-country.js, ppt-utils.js\n"
            "- Email: shared/email.js\n"
            "- Server/orchestrator: server.js\n"
        )
    else:
        scope = _classify_fix_scope(issues)
        dont_touch = SCOPE_DONT_TOUCH.get(scope, '')
        scope_context = (
            f"\n\n## FIX SCOPE: {scope.upper()}\n"
            f"START with these files: {SCOPE_FILES.get(scope, '')}\n"
        )
        if dont_touch:
            scope_context += f"Do NOT touch: {dont_touch}\n"
        # Fix 6: Inject what-to-change guidance
        what_to_change = SCOPE_WHAT_TO_CHANGE.get(scope, "")
        if what_to_change:
            scope_context += f"\n## What to Change (IMPORTANT)\n{what_to_change}\n"

    # Issue history and pattern detection context
    history_context = ""
    if HAS_ISSUE_DETECTOR:
        try:
            # Append current iteration to history (include git_diff for oscillation detection)
            # Fix 1: Use field names that detect_patterns() actually reads
            comparison = analysis.get("comparison", {}) if analysis else {}
            append_iteration({
                "specificFailures": issues[:10],
                "fixesAttempted": [analysis.get("fix_prompt", "")[:200]] if analysis else [],
                "iteration": iteration,
                "git_diff": _recent_diffs[iteration - 1] if iteration <= len(_recent_diffs) else "",
                "contentDepthScore": comparison.get("content_depth_score"),
                "insightScore": comparison.get("insight_score"),
                "patternMatchScore": comparison.get("pattern_match_score"),
            })

            # Detect patterns from history (bug fix: pass load_history() not empty call)
            history = load_history()
            patterns = detect_patterns(history)
            if patterns:
                fix_ctx = generate_fix_context(history)
                if fix_ctx:
                    history_context = (
                        f"\n\n## Issue History Analysis\n"
                        f"{fix_ctx}\n"
                        f"\n### Priority Rules:\n"
                        f"- If content empty → fix research pipeline (research-orchestrator.js)\n"
                        f"- If layout wrong → fix pattern selection (ppt-utils.js choosePattern)\n"
                        f"- If formatting off → re-check pattern definitions (template-patterns.json)\n"
                        f"- If same issue 3+ times → CHANGE APPROACH, don't patch\n"
                    )
        except Exception as e:
            logger.warning(f"Issue pattern detection failed: {e}")

    # Deep analysis context for content/insight issues — show agent what was actually produced
    deep_analysis_context = ""
    if diagnosis and diagnosis.get("dominant_category") in (
        "content_depth", "insight_missing", "research_quality", "empty_data"
    ):
        deep_analysis_context = _build_deep_analysis_context(analysis, diagnosis)

    # Original user request context — what was the user asking for?
    request_context = ""
    if form_data:
        user_request = form_data.get("prompt") or ""
        if not user_request:
            parts = [form_data.get("Business", ""), form_data.get("Country", "")]
            user_request = " in ".join(p for p in parts if p).strip()
        if user_request:
            request_context = (
                f"\n\n## Original User Request\n"
                f"The user asked for: {user_request[:500]}\n"
                f"VERIFY: Is the output about THIS topic? If it discusses a different country/industry, "
                f"the research queries in research-agents.js need to be fixed.\n"
            )

    if fix_prompt and fix_prompt != "No issues found. Output matches template.":
        # Use the ComparisonResult's built-in prompt (has severity grouping, locations, suggestions)
        iteration_context = ""
        if iteration > 1:
            iteration_context = (
                f"\n\nThis is fix attempt #{iteration}. "
                f"Previous attempts fixed some issues but these remain — "
                f"the root cause may be deeper than a surface-level fix."
            )
        result = await run_claude_code(
            fix_prompt + diagnosis_context + ref_context + formatting_context + history_context + diff_context + delta_context + scope_context + deep_analysis_context + request_context + iteration_context,
            service_name=service_name,
            iteration=iteration,
            previous_issues="\n".join(issues) if issues else None,
        )
    else:
        # Fallback to improve_output with generic prompt
        iteration_context = ""
        if iteration > 1:
            iteration_context = (
                f" This is fix attempt #{iteration}. "
                f"Previous attempts fixed some issues but these remain — "
                f"the root cause may be deeper than a surface-level fix."
            )

        expected_outcome = (
            f"Output from {service_name} must match the reference template in both "
            f"content quality (depth, specificity, actionable insights) and visual formatting "
            f"(layout, fonts, spacing, data tables). No critical or major discrepancies.{iteration_context}"
            f"{diagnosis_context}"
            f"{ref_context}"
            f"{formatting_context}"
            f"{history_context}"
            f"{diff_context}"
            f"{delta_context}"
            f"{scope_context}"
            f"{deep_analysis_context}"
            f"{request_context}"
        )

        result = await improve_output(
            service_name=service_name,
            current_issues=issues,
            expected_outcome=expected_outcome,
            iteration=iteration,
            previous_issues="\n".join(issues) if issues else None,
        )

    # Store current iteration's git diff for future iterations
    git_diff = ""
    full_git_diff = ""
    if result is not None:
        git_diff = getattr(result, 'git_diff', '') or ''
        full_git_diff = getattr(result, 'full_git_diff', '') or git_diff
    # Ensure list is long enough
    while len(_recent_diffs) < iteration:
        _recent_diffs.append("")
    _recent_diffs[iteration - 1] = git_diff

    # ESCAPE VALVE: Check if agent signaled "cannot fix"
    if result and result.success and "CANNOT_FIX.md" in (full_git_diff or git_diff):
        logger.warning("Agent signaled: cannot fix without human help")
        return {
            "success": False,
            "pr_number": None,
            "description": "Agent created CANNOT_FIX.md — needs human intervention",
            "git_diff": git_diff,
            "error": "Agent needs human help",
            "needs_human": True,
        }

    # FABRICATION VALIDATION: Reject diffs containing fabricated content + auto-revert
    if result and result.success:
        fabrication_error = _validate_no_fabrication(full_git_diff)
        if fabrication_error:
            logger.error(f"Fix REJECTED + REVERTING: {fabrication_error}")
            reverted = await _auto_revert_last_commit()
            revert_msg = " (commit reverted)" if reverted else " (REVERT FAILED — bad commit still on main!)"
            return {
                "success": False,
                "pr_number": None,
                "description": f"Fix rejected{revert_msg}: {fabrication_error}",
                "git_diff": git_diff,
                "error": fabrication_error,
                "fabrication_reverted": reverted,
            }

    # Category 1 fix: Check result.output not None before slice
    output_desc = ""
    if result is not None and result.output is not None:
        output_desc = result.output[:2000]

    return {
        "success": result.success if result else False,
        "pr_number": None,  # Push-to-main: no PRs
        "description": output_desc,
        "git_diff": git_diff,  # For issue_pattern_detector oscillation detection
        "error": result.error if result else "No result returned",
    }


async def get_logs_callback(
    service_name: str,
    railway_service_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Check logs for errors after deployment.

    Uses Claude Code CLI to run `railway logs` if Railway CLI is available,
    otherwise checks the health endpoint for error indicators.
    """
    logger.info(f"Checking logs for {service_name}")

    # Method 1: Try Railway CLI via Claude Code
    try:
        result = await run_claude_code(
            f"Check Railway logs for the {service_name} service.\n\n"
            f"STEPS:\n"
            f"1. Run: railway logs --latest 100\n"
            f"2. Analyze output for ERRORS (not just warnings)\n\n"
            f"CRITICAL ERROR TYPES TO LOOK FOR:\n"
            f"- Crashes: segfault, unhandled exception, OOM kill, SIGTERM\n"
            f"- Deployment: failed to start, port conflict, missing env vars\n"
            f"- Runtime: repeated errors, timeouts, connection failures, ECONNREFUSED\n\n"
            f"REPORT FORMAT:\n"
            f"For each critical error found, report:\n"
            f"- Error type (crash/deployment/runtime)\n"
            f"- Error message (exact text)\n"
            f"- Frequency (how many times in the logs?)\n"
            f"- Root cause hypothesis (one sentence)\n\n"
            f"If no critical errors: report 'No critical errors found' with a brief summary of log activity.\n"
            f"Focus on errors from the CURRENT deployment, not old entries.\n\n"
            f"Do NOT make any code changes.",
            service_name=service_name,
            timeout_seconds=300,  # F10: Increased from 60s — Railway logs can be slow
        )

        if result.success and result.output:
            has_errors = any(
                keyword in result.output.lower()
                for keyword in ["error", "crash", "oom", "fatal", "unhandled", "sigterm"]
            )
            return {
                "has_errors": has_errors,
                "logs": result.output[:2000],
                "errors": [result.output[:500]] if has_errors else [],
            }
    except Exception as e:
        logger.warning(f"Railway log check failed: {e}")

    # Method 2: Check health endpoint
    if railway_service_url:
        health_url = railway_service_url.rstrip("/") + "/health"
        try:
            proc = await asyncio.create_subprocess_exec(
                "curl", "-sf", "--max-time", "10", health_url,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                return {
                    "has_errors": True,
                    "logs": f"Health check failed: {stderr.decode()[:500]}",
                    "errors": ["Health endpoint not responding"],
                }

            return {
                "has_errors": False,
                "logs": stdout.decode()[:500],
                "errors": [],
            }
        except Exception as e:
            logger.warning(f"Health check failed: {e}")

    # Method 3: No log checking available
    logger.info("No log checking method available")
    return {
        "has_errors": False,
        "logs": "",
        "errors": [],
    }


# =============================================================================
# RUNNER
# =============================================================================


async def run_feedback_loop(
    service_name: str,
    form_data: Dict[str, str],
    max_iterations: int = 10,
    health_check_url: Optional[str] = None,
    railway_service_url: Optional[str] = None,
    on_progress: Optional[Callable] = None,
    start_from: Optional[str] = None,
    existing_file_path: Optional[str] = None,
    cancel_token: Optional[dict] = None,
    task_id: str = "",
) -> LoopResult:
    """
    Run the complete feedback loop for a service.

    Args:
        service_name: Service to test/fix
        form_data: Form fields to submit
        max_iterations: Max fix iterations
        health_check_url: URL to poll after deployment
        railway_service_url: Railway service base URL
        on_progress: Callback for progress updates

    Returns:
        LoopResult with success status and stats
    """
    # Reset in-memory diff storage for this loop run
    global _recent_diffs
    _recent_diffs = []

    # F46: Validate start_from values
    VALID_START_FROM = {None, "email_check", "analyze"}
    if start_from not in VALID_START_FROM:
        logger.error(f"Invalid start_from value: '{start_from}'. Valid: {VALID_START_FROM}")
        return LoopResult(
            success=False, iterations=0, prs_merged=0,
            summary=f"Error: Invalid start_from='{start_from}'",
            elapsed_seconds=0,
        )

    # A6: Validate service_name is not None or empty
    if not service_name or not service_name.strip():
        logger.error("service_name is required but was None or empty")
        return LoopResult(
            success=False,
            iterations=0,
            prs_merged=0,
            summary="Error: Missing required service_name",
            elapsed_seconds=0,
        )

    # Issue 6: Pass research config
    config = LoopConfig(
        service_name=service_name,
        max_iterations=max_iterations,
        health_check_url=health_check_url,
        railway_service_url=railway_service_url,
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        max_research_attempts=2,
    )

    # Issue 8: Check for interrupted loop state
    # Stale-state fix: only resume if BOTH service_name AND task_id match
    resume_from = 0
    saved = None
    saved_issue_tracker = None
    saved_prs_merged = 0
    try:
        from loop_state import load_loop_state, clear_loop_state
        saved = load_loop_state()
        if saved and saved.service_name == service_name and saved.task_id == task_id and task_id:
            logger.info(f"Resuming same task (id={task_id}): iteration={saved.iteration}")
            resume_from = max(0, saved.iteration - 1)
            saved_issue_tracker = saved.issue_tracker
            saved_prs_merged = saved.prs_merged
        elif saved:
            # Different task — clear stale state and start fresh
            logger.info(f"New task (id={task_id}) — clearing stale state from task {saved.task_id}")
            clear_loop_state()
            saved = None
    except Exception as e:
        logger.warning(f"Failed to check loop state: {e}")

    iteration_counter = [resume_from]
    # Stale-state fix (bug 3): Restore seen_email_ids from saved state on resume
    seen_email_ids = set(saved.seen_email_ids) if saved and saved.seen_email_ids else set()
    # Stale-state fix (bug 5): Restore last_fix_deployed_epoch from saved state on resume
    last_fix_deployed_epoch = [saved.last_fix_deployed_epoch if saved else 0]
    # Stale-state fix (bug 2): Always use current time — never inherit stale epoch
    loop_start_epoch = int(time.time())

    async def submit():
        return await submit_form_callback(service_name, form_data)

    async def wait_email():
        # Always use loop_start_epoch as floor — prevents picking up stale emails
        # after resume or on iteration 1 before any fix is deployed
        epoch = max(last_fix_deployed_epoch[0], loop_start_epoch)
        result = await wait_for_email_callback(
            service_name,
            skip_email_ids=seen_email_ids,
            after_epoch=epoch,
        )
        # Track this email ID so next iteration skips it
        if result.get("success") and result.get("email_id"):
            seen_email_ids.add(result["email_id"])
            state_extras["seen_email_ids"] = list(seen_email_ids)
            logger.info(f"Tracked email {result['email_id']} — {len(seen_email_ids)} seen total")
        return result

    async def analyze(file_path):
        # Issue 9: Try learned template first
        analysis_result = await analyze_output_callback(file_path, service_name)

        # Category 5 fix: Wrap callback in try/except
        try:
            from template_learner import TemplateManager, compare_with_learned_template
            manager = TemplateManager()
            learned = manager.get_template(f"{service_name}-learned")
            if learned and analysis_result and analysis_result.get("analysis"):
                learned_comparison = compare_with_learned_template(
                    analysis_result["analysis"] if isinstance(analysis_result["analysis"], dict)
                    else analysis_result["analysis"].to_dict()
                    if hasattr(analysis_result["analysis"], "to_dict")
                    else analysis_result["analysis"],
                    learned,
                )
                # Merge learned template issues
                if learned_comparison and learned_comparison.get("issues"):
                    analysis_result.setdefault("issues", []).extend(
                        [i.get("message", str(i)) for i in learned_comparison["issues"] if i]
                    )
                logger.info(f"Learned template score: {learned_comparison.get('score') if learned_comparison else 'N/A'}")
        except Exception as e:
            logger.warning(f"Learned template comparison failed: {e}")

        return analysis_result

    async def fix(issues, analysis):
        # Category 10 fix: Increment counter after validation, not before
        # First validate inputs
        if not issues and not (analysis and analysis.get("fix_prompt")):
            logger.warning("fix called with no issues and no fix_prompt")
            return {"success": False, "error": "No issues to fix"}

        iteration_counter[0] += 1
        result = await generate_fix_callback(
            issues, analysis, service_name, iteration_counter[0],
            form_data=form_data,
        )
        # After a successful fix+push, record timestamp so next iteration
        # only accepts emails arriving after the new code was deployed
        if result and result.get("success"):
            last_fix_deployed_epoch[0] = int(time.time())
            state_extras["last_fix_deployed_epoch"] = last_fix_deployed_epoch[0]
        return result

    async def merge(pr_number):
        return await merge_pr(pr_number)

    async def ci(pr_number):
        return await wait_for_ci(pr_number)

    async def logs():
        return await get_logs_callback(service_name, railway_service_url)

    # Skip-to mode: wrap callbacks to skip steps on first iteration
    _first_iteration_done = [False]

    if start_from in ("email_check", "analyze"):
        real_submit = submit
        async def submit():
            if not _first_iteration_done[0]:
                return {"success": True, "skipped": True}
            return await real_submit()

    # 3.9: start_from="analyze" without file should error, not silently fall through
    if start_from == "analyze" and not existing_file_path:
        logger.error("start_from='analyze' requires existing_file_path")
        return LoopResult(
            success=False, iterations=0, prs_merged=0,
            summary="Error: start_from='analyze' requires existing_file_path",
            elapsed_seconds=0,
        )

    if start_from == "analyze" and existing_file_path:
        real_wait = wait_email
        async def wait_email():
            if not _first_iteration_done[0]:
                return {"success": True, "file_path": existing_file_path, "skipped": True}
            return await real_wait()

    # Mark first iteration done inside fix callback
    real_fix = fix
    async def fix(issues, analysis):
        _first_iteration_done[0] = True
        return await real_fix(issues, analysis)

    # Stale-state fix: shared extras dict that closures update, persisted via FeedbackLoop._save_state
    state_extras = {
        "task_id": task_id,
        "seen_email_ids": list(seen_email_ids),
        "last_fix_deployed_epoch": last_fix_deployed_epoch[0],
    }

    loop = FeedbackLoop(
        config=config,
        submit_form=submit,
        wait_for_email=wait_email,
        analyze_output=analyze,
        generate_fix=fix,
        merge_pr=merge,
        wait_for_ci=ci,
        check_logs=logs,
        on_progress=on_progress,
        state_extras=state_extras,
    )

    # C8: Restore state from saved loop if resuming
    if saved_issue_tracker:
        loop.issue_tracker.update(saved_issue_tracker)
    if saved_prs_merged:
        loop.prs_merged = saved_prs_merged

    result = await loop.run(cancel_token=cancel_token, resume_from=resume_from)

    # Issue 9: Learn from successful output
    # A8: Guard against empty iterations list before accessing [-1]
    if result.success and loop.iterations and len(loop.iterations) > 0:
        last_iter = loop.iterations[-1]
        if last_iter and last_iter.output_file:
            try:
                api_key = os.environ.get("ANTHROPIC_API_KEY")
                if api_key:
                    from template_learner import TemplateLearner
                    learner = TemplateLearner(api_key)
                    await learner.learn_from_file(
                        last_iter.output_file,
                        f"{service_name}-learned",
                        description=f"Learned from successful {service_name} output",
                    )
                    logger.info(f"Learned template saved for {service_name}")
            except Exception as e:
                logger.warning(f"Failed to learn template: {e}")

        # Save successful fix to memory for future reuse
        if HAS_ISSUE_DETECTOR and len(loop.iterations) > 1:
            try:
                from issue_pattern_detector import save_successful_fix
                # Get the issues and fix from the iteration before success
                prev_iter = loop.iterations[-2] if len(loop.iterations) >= 2 else None
                if prev_iter and prev_iter.issues:
                    save_successful_fix(
                        issues=prev_iter.issues,
                        fix_description=getattr(prev_iter, 'fix_description', '') or '',
                        git_diff=_recent_diffs[-1] if _recent_diffs else '',
                        service_name=service_name,
                    )
                    logger.info("Saved successful fix to memory")
            except Exception as e:
                logger.warning(f"Failed to save fix to memory: {e}")

    return result
