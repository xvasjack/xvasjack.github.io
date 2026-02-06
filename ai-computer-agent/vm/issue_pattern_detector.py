"""
Issue Pattern Detector for Market Research Feedback Loop

Analyzes issue-history.json to detect recurring failure patterns.
When the same issue recurs 3+ times, it recommends changing the approach
rather than continuing to patch.

Categories of patterns:
- Content depth consistently low → research prompts failing
- Pattern selection wrong → data classification misidentifying types
- Layout issues → pattern formatting not matching template
- API failures → model or endpoint issues
"""

import json
import os
import logging
from typing import List, Dict, Any, Optional
from collections import Counter
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("issue_pattern_detector")

HISTORY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "backend", "market-research", "issue-history.json"
)

# Successful fix memory — stores fixes that worked so we don't reinvent the wheel
SUCCESS_MEMORY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "successful_fixes.json"
)


class IssueCategory:
    CONTENT_DEPTH = "content_depth"
    PATTERN_SELECTION = "pattern_selection"
    LAYOUT_FORMATTING = "layout_formatting"
    API_FAILURE = "api_failure"
    EMPTY_DATA = "empty_data"
    RESEARCH_QUALITY = "research_quality"
    INSIGHT_MISSING = "insight_missing"
    CHART_ERROR = "chart_error"
    TABLE_OVERFLOW = "table_overflow"
    UNKNOWN = "unknown"


def load_history(path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Load issue history from JSON file"""
    p = path or HISTORY_PATH
    if not os.path.exists(p):
        return []
    try:
        with open(p, 'r') as f:
            data = json.load(f)
        return data.get("iterations", []) if isinstance(data, dict) else data
    except (json.JSONDecodeError, IOError) as e:
        logger.error(f"Failed to load history: {e}")
        return []


def append_iteration(iteration: Dict[str, Any], path: Optional[str] = None) -> None:
    """Append a new iteration to the history file"""
    p = path or HISTORY_PATH
    history = {"iterations": []}
    if os.path.exists(p):
        try:
            with open(p, 'r') as f:
                history = json.load(f)
        except (json.JSONDecodeError, IOError):
            history = {"iterations": []}

    if not isinstance(history, dict):
        history = {"iterations": history if isinstance(history, list) else []}

    if "iterations" not in history:
        history["iterations"] = []

    iteration["timestamp"] = datetime.utcnow().isoformat()
    history["iterations"].append(iteration)

    # Keep last 50 iterations max
    history["iterations"] = history["iterations"][-50:]

    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        json.dump(history, f, indent=2)


# =============================================================================
# SUCCESSFUL FIX MEMORY — Learn from what worked
# =============================================================================


def load_success_memory(path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Load successful fix memory"""
    p = path or SUCCESS_MEMORY_PATH
    if not os.path.exists(p):
        return []
    try:
        with open(p, 'r') as f:
            data = json.load(f)
        return data.get("fixes", []) if isinstance(data, dict) else data
    except (json.JSONDecodeError, IOError) as e:
        logger.error(f"Failed to load success memory: {e}")
        return []


def save_successful_fix(
    issues: List[str],
    fix_description: str,
    git_diff: str,
    service_name: str,
    diagnosis: str = "",
    strategy: str = "",
    path: Optional[str] = None,
) -> None:
    """
    Record a successful fix for future reuse.
    Called when a fix iteration passes validation.
    """
    p = path or SUCCESS_MEMORY_PATH
    memory = {"fixes": []}
    if os.path.exists(p):
        try:
            with open(p, 'r') as f:
                memory = json.load(f)
        except (json.JSONDecodeError, IOError):
            memory = {"fixes": []}

    if not isinstance(memory, dict):
        memory = {"fixes": memory if isinstance(memory, list) else []}

    # Build issue signature for matching
    categories = [categorize_issue(i) for i in issues if i]
    dominant_cat = max(set(categories), key=categories.count) if categories else "unknown"

    fix_record = {
        "timestamp": datetime.utcnow().isoformat(),
        "service_name": service_name,
        "issues": issues[:10],  # Limit stored issues
        "issue_categories": list(set(categories)),
        "dominant_category": dominant_cat,
        "issue_signature": _hash_issues(issues),
        "fix_description": fix_description[:500],
        "git_diff": git_diff[:2000],  # Truncate large diffs
        "diagnosis": diagnosis,
        "strategy": strategy,
    }

    memory.setdefault("fixes", []).append(fix_record)

    # Keep last 100 successful fixes
    memory["fixes"] = memory["fixes"][-100:]

    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        json.dump(memory, f, indent=2)

    logger.info(f"Saved successful fix for {dominant_cat} issues")


def get_successful_fix_for_issues(
    issues: List[str],
    service_name: Optional[str] = None,
    path: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Find a past successful fix that matches current issues.

    Matching priority:
    1. Exact issue signature match (same issues)
    2. Same dominant category + similar issue count
    3. Same service + dominant category

    Returns the best matching fix record or None.
    """
    memory = load_success_memory(path)
    if not memory:
        return None

    # Build current issue profile
    categories = [categorize_issue(i) for i in issues if i]
    dominant_cat = max(set(categories), key=categories.count) if categories else "unknown"
    current_sig = _hash_issues(issues)

    best_match = None
    best_score = 0

    for fix in memory:
        score = 0

        # Exact signature match = instant win
        if fix.get("issue_signature") == current_sig:
            logger.info("Using past pattern... (exact match)")
            return fix

        # Category match
        if fix.get("dominant_category") == dominant_cat:
            score += 3

        # Service match
        if service_name and fix.get("service_name") == service_name:
            score += 2

        # Category overlap
        fix_cats = set(fix.get("issue_categories", []))
        current_cats = set(categories)
        overlap = len(fix_cats & current_cats)
        score += overlap

        if score > best_score:
            best_score = score
            best_match = fix

    # Require minimum score of 3 to suggest a past fix
    if best_score >= 3 and best_match:
        logger.info(f"Using past pattern... (score={best_score})")
        return best_match

    return None


def categorize_issue(issue_text: str) -> str:
    """Categorize an issue string into a known category"""
    text = issue_text.lower()

    if any(kw in text for kw in ["empty", "no data", "hollow", "missing data", "null", "undefined",
                                      "missing section", "missing_sections",
                                      "insufficient_slides", "insufficient slides"]):
        return IssueCategory.EMPTY_DATA
    if any(kw in text for kw in ["shallow", "generic", "thin", "depth", "superficial", "not specific"]):
        return IssueCategory.CONTENT_DEPTH
    if any(kw in text for kw in ["wrong pattern", "misclassified", "wrong layout", "pattern mismatch"]):
        return IssueCategory.PATTERN_SELECTION
    if any(kw in text for kw in ["overflow", "overlap", "positioning", "formatting", "font", "color",
                                      "bold", "italic", "alignment", "spacing", "margin", "fill", "mismatch"]):
        return IssueCategory.LAYOUT_FORMATTING
    if any(kw in text for kw in ["api error", "rate limit", "timeout", "503", "500", "connection"]):
        return IssueCategory.API_FAILURE
    if any(kw in text for kw in ["research", "search", "query", "kimi", "web search"]):
        return IssueCategory.RESEARCH_QUALITY
    if any(kw in text for kw in ["insight", "callout", "so what", "implication", "takeaway"]):
        return IssueCategory.INSIGHT_MISSING
    if any(kw in text for kw in ["chart", "graph", "visualization", "axis", "legend"]):
        return IssueCategory.CHART_ERROR
    if any(kw in text for kw in ["table", "row", "column", "cell", "truncat"]):
        return IssueCategory.TABLE_OVERFLOW

    return IssueCategory.UNKNOWN


def _hash_issues(issues: List[str]) -> str:
    """Hash issue list for oscillation comparison.
    Same algorithm as feedback_loop._get_issue_key — reimplemented to avoid circular import."""
    import hashlib
    normalized = [i.strip().lower() for i in issues if i]
    return hashlib.sha256(";".join(sorted(normalized)).encode()).hexdigest()


def detect_oscillation(history: List[Dict[str, Any]], window: int = 6) -> Optional[Dict[str, str]]:
    """
    Detect oscillation patterns in recent history.

    Method 1: Issue hash cycling (A→B→A pattern)
    Method 2: Git diff hash repeat (same diff applied twice)
    Method 3: Category sequence alternation (formatting→content→formatting)

    Returns dict with 'message' and 'recommendation' if oscillation detected, else None.
    """
    if len(history) < 3:
        return None

    recent = history[-window:]

    # Method 1: Issue hash cycling
    hashes = []
    for it in recent:
        issues = it.get("issues", it.get("specificFailures", []))
        hashes.append(_hash_issues(issues))

    for n in range(2, len(hashes)):
        if hashes[n] == hashes[n - 2] and hashes[n] != hashes[n - 1]:
            return {
                "method": "issue_hash_cycle",
                "message": f"Issues are cycling: iteration {n-1} and {n+1} have identical issues but {n} is different (A→B→A pattern).",
                "recommendation": "The fix is flip-flopping. Address BOTH sides simultaneously — the fix for A is causing B and vice versa.",
            }

    # Method 2: Diff hash repeat
    diff_hashes = {}
    for idx, it in enumerate(recent):
        diff = it.get("git_diff", "")
        if diff:
            import hashlib
            dh = hashlib.sha256(diff.encode()).hexdigest()
            if dh in diff_hashes:
                return {
                    "method": "diff_repeat",
                    "message": f"Same code diff applied at iterations {diff_hashes[dh]+1} and {idx+1}.",
                    "recommendation": "Identical fix was applied twice — it clearly doesn't work. Try a fundamentally different approach.",
                }
            diff_hashes[dh] = idx

    # Method 3: Category sequence alternation
    cat_sequences = []
    for it in recent:
        issues = it.get("issues", it.get("specificFailures", []))
        cats = Counter(categorize_issue(str(i)) for i in issues if i)
        dominant = cats.most_common(1)[0][0] if cats else "unknown"
        cat_sequences.append(dominant)

    if len(cat_sequences) >= 4:
        # Check for A,B,A,B pattern
        distinct = set(cat_sequences[-4:])
        if len(distinct) == 2:
            seq = cat_sequences[-4:]
            if seq[0] == seq[2] and seq[1] == seq[3] and seq[0] != seq[1]:
                return {
                    "method": "category_alternation",
                    "message": f"Issue categories are alternating: {seq[0]}→{seq[1]}→{seq[0]}→{seq[1]}.",
                    "recommendation": f"Fixing {seq[0]} issues creates {seq[1]} issues and vice versa. Find the shared root cause.",
                }

    return None


def detect_patterns(history: List[Dict[str, Any]], window: int = 5) -> Dict[str, Any]:
    """
    Analyze recent history to detect recurring patterns.

    Args:
        history: List of iteration records
        window: How many recent iterations to analyze

    Returns:
        Dict with detected patterns, recommendations, and severity
    """
    if not history:
        return {"patterns": [], "recommendations": [], "severity": "none"}

    recent = history[-window:]

    # Collect all issues and their categories
    all_issues = []
    category_counts = Counter()
    fix_attempts = []
    scores = {"content_depth": [], "insight": [], "pattern_match": []}

    for iteration in recent:
        failures = iteration.get("specificFailures", [])
        for failure in failures:
            cat = categorize_issue(failure)
            category_counts[cat] += 1
            all_issues.append({"text": failure, "category": cat})

        fix_attempts.extend(iteration.get("fixesAttempted", []))

        if "contentDepthScore" in iteration:
            scores["content_depth"].append(iteration["contentDepthScore"])
        if "insightScore" in iteration:
            scores["insight"].append(iteration["insightScore"])
        if "patternMatchScore" in iteration:
            scores["pattern_match"].append(iteration["patternMatchScore"])

    patterns = []
    recommendations = []
    severity = "low"

    # Pattern 1: Same category 3+ times → change approach
    for cat, count in category_counts.items():
        if count >= 3:
            severity = "critical"
            patterns.append({
                "type": "recurring_failure",
                "category": cat,
                "count": count,
                "message": f"{cat} has failed {count} times in last {window} iterations"
            })
            recommendations.append(_get_approach_change_recommendation(cat))

    # Pattern 2: Content depth consistently low
    if scores["content_depth"] and len(scores["content_depth"]) >= 3:
        avg = sum(scores["content_depth"]) / len(scores["content_depth"])
        if avg < 40:
            severity = "critical"
            patterns.append({
                "type": "consistently_low_score",
                "metric": "content_depth",
                "average": round(avg, 1),
                "message": f"Content depth avg {avg:.0f}/100 across {len(scores['content_depth'])} iterations"
            })
            recommendations.append(
                "Research prompts are failing to produce deep content. "
                "Try: (1) Different research queries with more specific terms, "
                "(2) Switch synthesis model (Gemini → DeepSeek or vice versa), "
                "(3) Add explicit examples of desired output depth to prompts."
            )

    # Pattern 3: Insight scores consistently low
    if scores["insight"] and len(scores["insight"]) >= 3:
        avg = sum(scores["insight"]) / len(scores["insight"])
        if avg < 30:
            if severity != "critical":
                severity = "high"
            patterns.append({
                "type": "consistently_low_score",
                "metric": "insight",
                "average": round(avg, 1),
                "message": f"Insight generation avg {avg:.0f}/100"
            })
            recommendations.append(
                "Insight generation is weak. Add explicit 'so what' prompting: "
                "'For each data point, explain what it means for [client] entering [market].'"
            )

    # Pattern 4: Same fix attempted multiple times without improvement
    fix_counter = Counter(fix_attempts)
    for fix, count in fix_counter.items():
        if count >= 2:
            if severity != "critical":
                severity = "high"
            patterns.append({
                "type": "repeated_fix",
                "fix": fix,
                "count": count,
                "message": f"Fix '{fix[:80]}' attempted {count} times without resolving"
            })
            recommendations.append(
                f"Stop patching with '{fix[:50]}...'. The root cause is different. "
                "Investigate the upstream data pipeline, not the symptom."
            )

    return {
        "patterns": patterns,
        "recommendations": recommendations,
        "severity": severity,
        "categoryCounts": dict(category_counts),
        "recentScores": {k: v for k, v in scores.items() if v},
    }


def _get_approach_change_recommendation(category: str) -> str:
    """Get specific recommendation for recurring failure category"""
    recs = {
        IssueCategory.CONTENT_DEPTH: (
            "Content depth keeps failing. STOP patching prompts. Instead: "
            "(1) Check if research queries return useful data, "
            "(2) Try different AI model for synthesis, "
            "(3) Add few-shot examples of deep content to prompts."
        ),
        IssueCategory.EMPTY_DATA: (
            "Data keeps coming back empty. Root cause is likely: "
            "(1) Research queries too narrow/specific, "
            "(2) API rate limits silently returning empty, "
            "(3) JSON parsing failing silently. Check research-orchestrator logs."
        ),
        IssueCategory.PATTERN_SELECTION: (
            "Pattern selection keeps mismatching. The data classifier is wrong. "
            "Review choosePattern() logic — the dataType being assigned doesn't match actual data."
        ),
        IssueCategory.LAYOUT_FORMATTING: (
            "Layout issues persist. Re-extract positions from template PPTX. "
            "The pattern definitions in template-patterns.json may not match the reference."
        ),
        IssueCategory.API_FAILURE: (
            "API failures recurring. Check: (1) API key validity, "
            "(2) Rate limits, (3) Model availability. Consider adding fallback chain."
        ),
        IssueCategory.RESEARCH_QUALITY: (
            "Research quality consistently poor. Try: "
            "(1) More specific search queries with year ranges, "
            "(2) Different search topics, "
            "(3) Verify Kimi API is returning web search results."
        ),
        IssueCategory.INSIGHT_MISSING: (
            "Insights keep missing. Add explicit insight generation step: "
            "After each data block, prompt 'What does this mean for [client]?'"
        ),
        IssueCategory.CHART_ERROR: (
            "Chart errors recurring. Check: (1) Data format matches chart type expectations, "
            "(2) Series/categories arrays not empty, (3) Numeric values are actually numbers."
        ),
        IssueCategory.TABLE_OVERFLOW: (
            "Table overflow keeps happening. (1) Increase maxH, "
            "(2) Reduce font size, (3) Split across slides when data exceeds threshold."
        ),
    }
    return recs.get(category, f"Recurring {category} failures. Investigate root cause, not symptoms.")


def generate_fix_context(history: List[Dict[str, Any]], window: int = 3) -> str:
    """
    Generate context string for the fix generator (Claude Code).
    Includes last N iterations, detected patterns, and priority instructions.
    """
    recent = history[-window:] if len(history) >= window else history
    pattern_analysis = detect_patterns(history, window=min(5, len(history)))

    context_parts = []

    # Last iterations summary
    context_parts.append("## Recent Iteration History")
    for i, iteration in enumerate(recent):
        context_parts.append(f"\n### Iteration {iteration.get('number', i+1)}")
        context_parts.append(f"- Content Depth: {iteration.get('contentDepthScore', 'N/A')}/100")
        context_parts.append(f"- Insight Score: {iteration.get('insightScore', 'N/A')}/100")
        context_parts.append(f"- Pattern Match: {iteration.get('patternMatchScore', 'N/A')}/100")
        failures = iteration.get("specificFailures", [])
        if failures:
            context_parts.append(f"- Failures: {'; '.join(failures[:5])}")
        fixes = iteration.get("fixesAttempted", [])
        if fixes:
            context_parts.append(f"- Fixes tried: {'; '.join(fixes[:3])}")

    # Pattern analysis
    if pattern_analysis["patterns"]:
        context_parts.append("\n## Detected Recurring Patterns (IMPORTANT)")
        for p in pattern_analysis["patterns"]:
            context_parts.append(f"- **{p['type']}**: {p['message']}")

        context_parts.append("\n## Recommendations (FOLLOW THESE)")
        for r in pattern_analysis["recommendations"]:
            context_parts.append(f"- {r}")

    # Oscillation detection
    oscillation = detect_oscillation(history)
    if oscillation:
        context_parts.append("\n\n## ⚠ OSCILLATION DETECTED ⚠")
        context_parts.append(f"{oscillation['message']}")
        context_parts.append(f"REQUIRED ACTION: {oscillation['recommendation']}")
        context_parts.append("The fix agent MUST address BOTH sides of the oscillation simultaneously.")

    # Priority instruction
    context_parts.append("\n## Priority Instruction")
    context_parts.append(
        "If content empty → fix research pipeline (queries, API, parsing). "
        "If layout wrong → fix pattern selection (choosePattern logic). "
        "If formatting off → re-check pattern definitions (template-patterns.json). "
        "If insights missing → add insight generation prompts. "
        "DO NOT keep patching the same approach if it has failed 3+ times."
    )

    return "\n".join(context_parts)


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else HISTORY_PATH
    history = load_history(path)

    if not history:
        print("No history found.")
        sys.exit(0)

    analysis = detect_patterns(history)
    print(json.dumps(analysis, indent=2))

    if analysis["patterns"]:
        print("\n--- Fix Context ---")
        print(generate_fix_context(history))
