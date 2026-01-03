"""
Self-Research Module

When the agent is stuck on a recurring issue, this module:
1. Analyzes the pattern of failures
2. Searches for solutions (web, docs, codebase)
3. Proposes foundational changes
4. Suggests alternative approaches

This is the "think differently" capability.
"""

import asyncio
from typing import List, Dict, Any, Optional
from dataclasses import dataclass
import logging
from anthropic import Anthropic

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("research")


@dataclass
class ResearchContext:
    """Context for a research session"""
    issue_description: str
    issue_category: str
    occurrences: int
    previous_attempts: List[str]
    code_context: Optional[str] = None
    error_logs: Optional[str] = None
    service_name: Optional[str] = None


@dataclass
class ResearchResult:
    """Result of research"""
    root_cause_analysis: str
    alternative_approaches: List[Dict[str, str]]
    recommended_approach: Optional[Dict[str, str]]
    code_changes_suggested: List[str]
    needs_foundational_change: bool
    confidence: float  # 0-1


class ResearchAgent:
    """
    Agent that researches solutions when stuck.

    Uses Claude to:
    1. Analyze failure patterns
    2. Search for solutions
    3. Propose new approaches
    """

    def __init__(self, anthropic_api_key: str):
        self.client = Anthropic(api_key=anthropic_api_key)

    async def research_issue(
        self,
        context: ResearchContext
    ) -> ResearchResult:
        """
        Research a stuck issue and propose solutions.
        """
        logger.info(f"Researching issue: {context.issue_description}")

        # Build research prompt
        prompt = self._build_research_prompt(context)

        # Ask Claude to research
        response = self.client.messages.create(
            model="claude-opus-4-5-20250514",
            max_tokens=4096,
            system="""You are a senior software architect debugging a recurring issue.

Your task is to:
1. Analyze WHY the issue keeps recurring despite fixes
2. Identify if the fundamental approach is wrong
3. Research alternative solutions
4. Propose a fix that addresses the ROOT CAUSE, not symptoms

Be critical and honest. If the current approach is fundamentally flawed, say so.
If a complete rewrite of a component is needed, recommend it.

Consider:
- Are we using the right libraries/APIs?
- Is the architecture appropriate?
- Should we add validation/retry logic?
- Would an iterative AI approach help?
- Are there race conditions or timing issues?

Output JSON:
{
    "root_cause_analysis": "why this keeps happening",
    "is_fundamental_flaw": true/false,
    "alternative_approaches": [
        {"name": "approach name", "description": "...", "pros": "...", "cons": "..."}
    ],
    "recommended_approach": {"name": "...", "implementation": "step by step"},
    "code_changes": ["specific change 1", "specific change 2"],
    "confidence": 0.8
}
""",
            messages=[{"role": "user", "content": prompt}]
        )

        # Parse response
        result = self._parse_research_response(response.content[0].text)

        return result

    def _build_research_prompt(self, context: ResearchContext) -> str:
        """Build the research prompt"""
        prompt = f"""
## Recurring Issue Analysis

**Issue:** {context.issue_description}
**Category:** {context.issue_category}
**Times occurred:** {context.occurrences}
**Service:** {context.service_name or 'Unknown'}

### Previous Fix Attempts
{chr(10).join(f'- {attempt}' for attempt in context.previous_attempts) if context.previous_attempts else 'None recorded'}

"""

        if context.code_context:
            prompt += f"""
### Relevant Code
```
{context.code_context[:3000]}
```

"""

        if context.error_logs:
            prompt += f"""
### Error Logs
```
{context.error_logs[:2000]}
```

"""

        prompt += """
### Questions to Answer

1. **Root Cause**: Why does this issue keep recurring? What's the underlying problem?

2. **Pattern Analysis**: Is there a pattern in the failures? (timing, data, conditions)

3. **Approach Review**: Is the current implementation approach fundamentally correct?

4. **Alternative Solutions**: What other ways could we solve this?
   - Different libraries?
   - Different architecture?
   - Iterative AI processing?
   - Pre-validation?
   - Retry logic?

5. **Recommendation**: What specific change would fix this permanently?

Please analyze deeply and provide actionable recommendations.
"""

        return prompt

    def _parse_research_response(self, response: str) -> ResearchResult:
        """Parse Claude's research response"""
        import json
        import re

        try:
            # Find JSON in response
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                data = json.loads(json_match.group())

                return ResearchResult(
                    root_cause_analysis=data.get("root_cause_analysis", ""),
                    alternative_approaches=data.get("alternative_approaches", []),
                    recommended_approach=data.get("recommended_approach"),
                    code_changes_suggested=data.get("code_changes", []),
                    needs_foundational_change=data.get("is_fundamental_flaw", False),
                    confidence=data.get("confidence", 0.5),
                )
        except json.JSONDecodeError:
            pass

        # Fallback: extract what we can
        return ResearchResult(
            root_cause_analysis=response[:500],
            alternative_approaches=[],
            recommended_approach=None,
            code_changes_suggested=[],
            needs_foundational_change=False,
            confidence=0.3,
        )

    async def generate_fix_from_research(
        self,
        context: ResearchContext,
        research: ResearchResult
    ) -> str:
        """
        Generate a specific fix prompt based on research.

        This creates a prompt for Claude Code that implements
        the recommended approach.
        """
        if not research.recommended_approach:
            return self._generate_generic_fix(context, research)

        approach = research.recommended_approach
        prompt = f"""
## Implementing New Approach

Based on analysis, we're changing how we handle: {context.issue_description}

### Root Cause
{research.root_cause_analysis}

### New Approach: {approach.get('name', 'Revised Implementation')}
{approach.get('implementation', approach.get('description', ''))}

### Specific Changes Needed
{chr(10).join(f'- {change}' for change in research.code_changes_suggested)}

### Instructions
1. This is a FOUNDATIONAL change, not a patch
2. Review the existing code and understand current approach
3. Implement the new approach described above
4. Add appropriate tests
5. Commit with message explaining the architectural change

Service: {context.service_name}
"""
        return prompt

    def _generate_generic_fix(
        self,
        context: ResearchContext,
        research: ResearchResult
    ) -> str:
        """Generate a generic fix prompt when no specific recommendation"""
        return f"""
## Fix Recurring Issue

This issue has occurred {context.occurrences} times despite previous fixes.

**Issue:** {context.issue_description}

**Root Cause Analysis:**
{research.root_cause_analysis}

**Alternative Approaches to Consider:**
{chr(10).join(f'- {a.get("name")}: {a.get("description")}' for a in research.alternative_approaches[:3])}

**Suggested Changes:**
{chr(10).join(f'- {change}' for change in research.code_changes_suggested)}

Please:
1. Review the root cause analysis
2. Consider the alternative approaches
3. Implement a fix that addresses the ROOT CAUSE
4. Don't just patch symptoms - fix the underlying issue

Service: {context.service_name}
"""


# =============================================================================
# SPECIFIC RESEARCH PATTERNS
# =============================================================================


COMMON_ISSUES_AND_SOLUTIONS = {
    "missing_logos": {
        "likely_causes": [
            "Logo URL is invalid or returns 404",
            "Logo fetch timeout",
            "Logo URL blocked by CORS",
            "Clearbit/logo API rate limited",
        ],
        "solutions": [
            "Add logo URL validation before use",
            "Implement fallback to placeholder image",
            "Use multiple logo sources (Clearbit, Google, company website)",
            "Add retry logic with exponential backoff",
            "Cache successful logo fetches",
        ],
    },

    "missing_websites": {
        "likely_causes": [
            "Search API not returning website field",
            "Website field has wrong key name",
            "Company has social media URL instead of website",
        ],
        "solutions": [
            "Add website extraction from multiple fields",
            "Filter social media URLs",
            "Use company domain extraction from email",
            "Add manual website search fallback",
        ],
    },

    "duplicate_companies": {
        "likely_causes": [
            "No deduplication logic",
            "Dedup by name only (misses variations)",
            "Multiple API sources returning same company",
        ],
        "solutions": [
            "Dedupe by normalized company name",
            "Dedupe by website domain",
            "Dedupe by company registration number if available",
            "Use fuzzy matching for name similarity",
        ],
    },

    "insufficient_results": {
        "likely_causes": [
            "Search query too restrictive",
            "API pagination not handled",
            "Too many results filtered out",
            "API rate limiting",
        ],
        "solutions": [
            "Broaden search terms",
            "Handle API pagination properly",
            "Reduce filter strictness",
            "Add fallback to secondary search API",
            "Implement retry on rate limit",
        ],
    },

    "blocked_domain_urls": {
        "likely_causes": [
            "Using LinkedIn/Wikipedia as 'company website'",
            "No URL validation",
            "Search results include directory sites",
        ],
        "solutions": [
            "Add blocked domain list",
            "Extract actual company domain from directory page",
            "Prefer .com/.co domains over social media",
            "Add URL classification",
        ],
    },

    "ci_failure": {
        "likely_causes": [
            "Test assertions too strict",
            "Missing test mocks for external APIs",
            "Lint errors",
            "Type errors",
        ],
        "solutions": [
            "Run tests locally before pushing",
            "Add/update test mocks",
            "Run lint --fix before commit",
            "Add pre-commit hooks",
        ],
    },

    "merge_conflict": {
        "likely_causes": [
            "Multiple PRs modifying same file",
            "Branch not rebased on main",
            "Generated file conflicts",
        ],
        "solutions": [
            "Fetch and rebase before pushing",
            "Resolve conflicts preferring PR changes",
            "Regenerate generated files after merge",
        ],
    },
}


def get_known_solutions(issue_category: str) -> Optional[Dict]:
    """Get known solutions for common issues"""
    return COMMON_ISSUES_AND_SOLUTIONS.get(issue_category)


async def quick_research(
    issue_category: str,
    issue_description: str
) -> Dict[str, Any]:
    """
    Quick research using known patterns.
    Falls back to AI research if unknown issue.
    """
    known = get_known_solutions(issue_category)

    if known:
        return {
            "source": "known_patterns",
            "likely_causes": known["likely_causes"],
            "solutions": known["solutions"],
            "recommended": known["solutions"][0] if known["solutions"] else None,
        }

    # Unknown issue - would need AI research
    return {
        "source": "unknown",
        "needs_ai_research": True,
        "issue_category": issue_category,
        "issue_description": issue_description,
    }
