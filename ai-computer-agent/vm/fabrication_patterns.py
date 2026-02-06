"""
Shared Fabrication Detection Patterns

Single source of truth for all fabrication regex patterns.
Used by:
- agent_guard.py (PreToolUse hook — blocks before write)
- feedback_loop_runner.py (post-commit diff validation)

When adding patterns: test against known bypass strings below.
"""

import re
from typing import Optional

# --- Original patterns (caught the 7 bad commits) ---
FABRICATION_PATTERNS = [
    # Fake country-TLD URLs like www.energy-service-company.com.vn
    r"https?://www\.\w+-\w+-\w+\.com\.\w{2}",
    # Fabrication helper functions
    r"getSupplementaryTexts|getDefaultChartData|getFallback\w*Content",
    # Fake company names from bad commits
    r"Local Energy Services Co\.",
    # Estimated dollar amounts (abbreviated)
    r"\$\d+[BMK]\s*\(estimated\)",
    # Fake regulation names
    r"\w+\s+Energy\s+Conservation\s+Act",
    # Fallback variables that mask empty data
    r"fallback(?:Result|Data|Companies|Regulations)",
    # Hardcoded year arrays for fake trends
    r"\[\s*2019\s*,\s*2020\s*,\s*2021\s*,\s*2022\s*,\s*2023\s*\]",
    # Fake percentage ranges
    r"\d+(?:\.\d+)?%\s*(?:annually|per\s*year|growth)",

    # --- Broader patterns (catch bypass variants) ---

    # Dollar estimates with written-out units: "$50 million (estimated)"
    r"\$\d+\s*(?:million|billion|trillion)\s*\((?:estimated|approx)",
    # Hedged dollar amounts: "approximately $50M", "~$50M"
    r"(?:approximately|roughly|around|~)\s*\$\d+[BMK]",
    # Percentage growth — any word order: "5.3% annual growth", "5.3 percent annually"
    r"\d+(?:\.\d+)?\s*(?:percent|%)\s*(?:annual|yearly|year-over-year|growth|decline)",
    # ANY 4+ consecutive year array: [2020, 2021, 2022, 2023, 2024]
    r"\[\s*20\d{2}\s*(?:,\s*20\d{2}\s*){3,}\]",
    # Broader fake URL: www.{word}-{word}.com.{tld} or .co.{tld}
    r"https?://www\.\w{3,}-\w+\.com?\.\w{2,3}",
    # Fallback/default/placeholder/mock variable names
    r"(?:default|fallback|placeholder|sample|mock|dummy)(?:Data|Result|Companies|Content|Values|Competitors|Regulations|Statistics)",
    # Fallback/default getter functions
    r"get(?:Fallback|Default|Placeholder|Sample|Mock|Dummy)\w*\(",
]


def check_fabrication(content: str) -> Optional[str]:
    """Check content for fabrication patterns.

    Returns error message if fabrication detected, None otherwise.
    """
    if not content:
        return None

    for pattern in FABRICATION_PATTERNS:
        match = re.search(pattern, content, re.IGNORECASE)
        if match:
            return f"FABRICATION DETECTED: Pattern '{pattern}' matched '{match.group(0)[:80]}'"

    return None
