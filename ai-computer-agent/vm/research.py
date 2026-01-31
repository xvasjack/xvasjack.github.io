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
        # H15: Use AsyncAnthropic for use in async functions
        try:
            from anthropic import AsyncAnthropic
            self.client = AsyncAnthropic(api_key=anthropic_api_key)
            self._async = True
        except ImportError:
            self.client = Anthropic(api_key=anthropic_api_key)
            self._async = False

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

        # H15: Use async client if available
        from config import CLAUDE_MODEL
        if self._async:
            response = await self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=4096,
                system="""You are a senior software architect debugging a RECURRING production issue.

Your task is CRITICAL ROOT-CAUSE ANALYSIS:
1. Analyze the PATTERN of failures — what's consistent across occurrences?
2. Identify the ROOT CAUSE — not symptoms, but the underlying architectural or code flaw
3. Assess whether the current approach is fundamentally wrong
4. Generate 2-3 alternative solutions with honest trade-offs
5. Recommend ONE approach with step-by-step implementation and risk assessment

RULES:
- Be critical and honest. If the approach is fundamentally flawed, say so.
- If a complete rewrite is needed, recommend it with migration plan.
- Don't recommend band-aids that mask deeper issues.
- Consider: could this fix break something else? Assess collateral risk.

Consider:
- Are we using the right libraries/APIs for this problem?
- Is the architecture appropriate, or does it need redesign?
- Are there race conditions, timing issues, or resource contention?
- Would validation/retry logic help, or does it hide the real problem?

Output JSON:
{
    "root_cause_analysis": "specific concrete reason this keeps failing, with evidence",
    "pattern": "when/how it fails — what's consistent across failures",
    "is_fundamental_flaw": true/false,
    "alternative_approaches": [
        {"name": "approach name", "description": "...", "pros": "...", "cons": "...", "effort": "low/medium/high"}
    ],
    "recommended_approach": {"name": "...", "implementation": "step by step", "risk": "what could go wrong", "mitigation": "how to reduce risk"},
    "code_changes": ["specific change 1", "specific change 2"],
    "confidence": 0.8,
    "confidence_reason": "why this confidence level"
}""",
                messages=[{"role": "user", "content": prompt}]
            )
        else:
            import asyncio
            # RC-3: Wrap blocking executor call with timeout to prevent indefinite hangs
            response = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(
                    None, lambda: self.client.messages.create(
                        model=CLAUDE_MODEL,
                        max_tokens=4096,
                        system="""You are a senior software architect debugging a RECURRING production issue.

Your task is CRITICAL ROOT-CAUSE ANALYSIS:
1. Analyze the PATTERN of failures — what's consistent across occurrences?
2. Identify the ROOT CAUSE — not symptoms, but the underlying architectural or code flaw
3. Assess whether the current approach is fundamentally wrong
4. Generate 2-3 alternative solutions with honest trade-offs
5. Recommend ONE approach with step-by-step implementation and risk assessment

RULES:
- Be critical and honest. If the approach is fundamentally flawed, say so.
- If a complete rewrite is needed, recommend it with migration plan.
- Don't recommend band-aids that mask deeper issues.
- Consider: could this fix break something else? Assess collateral risk.

Consider:
- Are we using the right libraries/APIs for this problem?
- Is the architecture appropriate, or does it need redesign?
- Are there race conditions, timing issues, or resource contention?
- Would validation/retry logic help, or does it hide the real problem?

Output JSON:
{
    "root_cause_analysis": "specific concrete reason this keeps failing, with evidence",
    "pattern": "when/how it fails — what's consistent across failures",
    "is_fundamental_flaw": true/false,
    "alternative_approaches": [
        {"name": "approach name", "description": "...", "pros": "...", "cons": "...", "effort": "low/medium/high"}
    ],
    "recommended_approach": {"name": "...", "implementation": "step by step", "risk": "what could go wrong", "mitigation": "how to reduce risk"},
    "code_changes": ["specific change 1", "specific change 2"],
    "confidence": 0.8,
    "confidence_reason": "why this confidence level"
}
""",
                        messages=[{"role": "user", "content": prompt}]
                    )
                ),
                timeout=120  # RC-3: 2-minute timeout for API call
            )

        # Parse response - validate content exists before accessing
        # Issue 9/94 fix: Check response.content is non-empty list
        # EH-4: Simplified redundant check - `not x` already handles empty sequences
        if not response.content:
            logger.warning("Empty response from AI research")
            return ResearchResult(
                root_cause_analysis="AI returned empty response",
                alternative_approaches=[],
                recommended_approach=None,
                code_changes_suggested=[],
                needs_foundational_change=False,
                confidence=0.0,
            )

        # Issue 79 fix: Check content[0] has 'text' attribute (could be ToolUse block)
        first_block = response.content[0]
        if not hasattr(first_block, 'text'):
            logger.warning(f"Response content[0] is not TextBlock: {type(first_block)}")
            return ResearchResult(
                root_cause_analysis=f"AI returned non-text response: {type(first_block).__name__}",
                alternative_approaches=[],
                recommended_approach=None,
                code_changes_suggested=[],
                needs_foundational_change=False,
                confidence=0.0,
            )

        result = self._parse_research_response(first_block.text)

        return result

    def _build_research_prompt(self, context: ResearchContext) -> str:
        """Build the research prompt"""
        prompt = f"""
RECURRING ISSUE INVESTIGATION
=============================

**Issue**: {context.issue_description}
**Service**: {context.service_name or 'Unknown'}
**Occurrences**: {context.occurrences} times
**Category**: {context.issue_category}

FAILURE HISTORY (previous fix attempts that did NOT prevent recurrence):
{chr(10).join(f'- {attempt}' for attempt in context.previous_attempts) if context.previous_attempts else 'No previous attempts recorded — this is the first investigation'}

"""

        if context.code_context:
            prompt += f"""
RELEVANT CODE:
```
{context.code_context[:3000]}
```

"""

        if context.error_logs:
            prompt += f"""
ERROR LOGS:
```
{context.error_logs[:2000]}
```

"""

        prompt += """
YOUR ANALYSIS (answer ALL — be specific, not generic):

1. PATTERN ANALYSIS:
   - WHEN does it fail? After specific actions? Under specific conditions?
   - WHAT data/conditions trigger it? What's the common factor across failures?
   - WHY did previous fixes not prevent recurrence? What did they miss?

2. ROOT CAUSE (go deep):
   - What is the UNDERLYING problem, not just the symptom?
   - Is it a design flaw, wrong library choice, timing issue, or missing validation?
   - Could this be a cascade from an earlier unrelated problem?

3. APPROACH ASSESSMENT:
   - Is the current architecture fundamentally suitable for this problem?
   - Would retry logic SOLVE the problem or just HIDE it?
   - Is there a simpler approach that eliminates this class of failure entirely?

4. ALTERNATIVE SOLUTIONS (evaluate 2-3):
   - For each: pros, cons, implementation effort (low/medium/high), and risk level
   - Which approach actually prevents recurrence vs just masking it?

5. RECOMMENDED FIX:
   - What specific, concrete change eliminates this permanently?
   - Where in the code does this change need to happen? (file/function)
   - How would you TEST that the fix works and prevents recurrence?
   - What's the risk of this change? How to mitigate?

CRITICAL: Do NOT recommend quick band-aid fixes. Address the UNDERLYING issue.
If the architecture needs redesign, say so clearly with migration steps.
"""

        return prompt

    def _parse_research_response(self, response: str) -> ResearchResult:
        """Parse Claude's research response"""
        import json
        import re

        try:
            # Find JSON in response
            # M10: Use json.JSONDecoder for safe extraction instead of greedy regex
            decoder = json.JSONDecoder()
            brace_idx = response.find('{')
            json_match = None
            if brace_idx >= 0:
                try:
                    obj, _ = decoder.raw_decode(response[brace_idx:])
                    json_match = type('Match', (), {'group': lambda self: json.dumps(obj)})()
                except json.JSONDecodeError:
                    json_match = re.search(r'\{[\s\S]*?\}', response)
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
IMPLEMENT ARCHITECTURAL FIX
============================

ISSUE: {context.issue_description}
SERVICE: {context.service_name}
OCCURRENCES: {context.occurrences} times (previous fixes failed to prevent recurrence)

ROOT CAUSE (from analysis):
{research.root_cause_analysis}

NEW APPROACH: {approach.get('name', 'Revised Implementation')}
{approach.get('implementation', approach.get('description', ''))}

SPECIFIC CHANGES REQUIRED:
{chr(10).join(f'- {change}' for change in research.code_changes_suggested)}

IMPLEMENTATION STEPS:
1. UNDERSTAND current code:
   - Read how {context.issue_description} is currently handled in backend/{context.service_name}/
   - Identify ALL places that need changes (grep for related patterns — don't miss any)

2. IMPLEMENT the new approach:
   - Make changes incrementally — each logical change as a small commit
   - Test after each change to catch regressions early

3. ADD TESTS:
   - Add a regression test that specifically reproduces the original failure
   - Add unit tests for new logic
   - Run full test suite: npm test

4. VALIDATE no regressions:
   - All existing tests must still pass
   - The specific failure scenario must now succeed

5. COMMIT AND PR:
   - Branch: claude/{context.service_name}-fix-[issue-type]
   - Commit message format:
     Fix: {context.service_name} - [brief root cause description]

     Root cause: [1-2 sentences]
     Change: [what changed and why]
   - Create PR with clear description

CRITICAL:
- This is a FOUNDATIONAL change, not a patch. Don't cut corners.
- If you discover the research was wrong during implementation, stop and explain why.
- Do NOT merge to main if tests fail.
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
