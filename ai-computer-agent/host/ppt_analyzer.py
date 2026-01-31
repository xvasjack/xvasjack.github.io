"""
PPT Visual Analyzer - Template-based comparison using Claude Vision API.

This module runs on the HOST machine and:
1. Receives screenshot paths from the VM via shared folder
2. Loads template screenshots for comparison
3. Sends both to Claude Vision API for analysis
4. Returns structured issue list for code fixes

The shared folder (C:\agent-shared = Z:\ on host) bridges VM and host.
"""

import os
import base64
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ppt_analyzer")

# Configuration
SHARED_FOLDER = os.environ.get("SHARED_FOLDER", "/mnt/c/agent-shared")
TEMPLATE_FOLDER = os.path.join(SHARED_FOLDER, "templates")
DOWNLOAD_FOLDER = os.path.join(SHARED_FOLDER, "downloads")


def check_claude_cli() -> bool:
    """
    Check if Claude Code CLI is available.

    Returns True if CLI is available, False otherwise.
    """
    import subprocess
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            logger.info(f"Claude Code CLI available: {result.stdout.strip()}")
            return True
    except Exception as e:
        logger.error(f"Claude Code CLI not available: {e}")
    return False


@dataclass
class SlideIssue:
    """An issue found in a slide"""
    slide_number: int
    severity: str  # critical, major, minor
    category: str  # layout, content, styling, missing, extra
    description: str
    suggestion: str
    template_reference: Optional[str] = None


@dataclass
class AnalysisResult:
    """Result of PPT visual analysis"""
    passed: bool
    total_slides: int
    issues: List[SlideIssue]
    summary: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "total_slides": self.total_slides,
            "issues": [asdict(i) for i in self.issues],
            "summary": self.summary,
        }


def load_image_as_base64(image_path: str) -> str:
    """Load an image file and return as base64 string"""
    with open(image_path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def get_image_media_type(image_path: str) -> str:
    """Get the media type for an image"""
    ext = Path(image_path).suffix.lower()
    media_types = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    return media_types.get(ext, "image/png")


def sample_slides(screenshots: List[str], max_count: int = 5) -> List[str]:
    """
    Sample representative slides: first + last + evenly distributed middle.

    This reduces API tokens by sending fewer images while maintaining coverage
    of the presentation structure.

    Args:
        screenshots: List of screenshot paths (sorted by slide order)
        max_count: Maximum number of slides to return

    Returns:
        Sampled list of screenshot paths
    """
    if len(screenshots) <= max_count:
        return screenshots

    sampled = [screenshots[0]]  # First slide

    if max_count > 2:
        # Evenly distribute middle slides (excluding first and last)
        middle_count = max_count - 2
        step = (len(screenshots) - 1) / (max_count - 1)
        for i in range(1, max_count - 1):
            idx = int(i * step)
            if idx > 0 and idx < len(screenshots) - 1:
                sampled.append(screenshots[idx])

    sampled.append(screenshots[-1])  # Last slide

    logger.info(f"Sampled {len(sampled)} slides from {len(screenshots)} total")
    return sampled


def get_template_screenshots(template_name: str) -> List[str]:
    """
    Get template screenshot paths for a given template name.

    Templates are stored in: {SHARED_FOLDER}/templates/{template_name}/
    With files named: slide_01.png, slide_02.png, etc.
    """
    template_dir = os.path.join(TEMPLATE_FOLDER, template_name)

    if not os.path.exists(template_dir):
        logger.warning(f"Template directory not found: {template_dir}")
        return []

    screenshots = sorted([
        os.path.join(template_dir, f)
        for f in os.listdir(template_dir)
        if f.endswith(".png")
    ])

    logger.info(f"Found {len(screenshots)} template slides for {template_name}")
    return screenshots


def get_service_specific_criteria(service_name: str) -> str:
    """Get service-specific analysis criteria."""
    criteria = {
        "market-research": """
MARKET RESEARCH SPECIFIC CRITERIA (CRITICAL):
Evaluate the WHOLE PRESENTATION as business intelligence output, not just layout.

1. CONTENT DEPTH (40% weight):
   - Market size analysis: quantified TAM/SAM/SOM with specific data points
   - Competitive landscape: named competitors, market position analysis
   - Trends: specific emerging trends with evidence, not generic statements
   - Customer segments: detailed buyer personas, use cases, pain points
   - SHALLOW EXAMPLE (FAIL): "Growing market with opportunities"
   - DEEP EXAMPLE (PASS): "$45B TAM (Gartner 2024), 12% CAGR, dominated by X/Y/Z players"

2. INSIGHTS QUALITY (30% weight):
   - Actionability: recommendations explain WHO should do WHAT and WHY
   - Data-driven: statistics cited with sources, not speculation
   - Specificity: naming specific companies, markets, metrics — not generic phrases
   - GENERIC EXAMPLE (FAIL): "Focus on digital transformation"
   - SPECIFIC EXAMPLE (PASS): "Target mid-market SaaS in APAC, $2-10M ARR, potential 3x ROI"

3. STORY FLOW (20% weight):
   - Narrative structure: problem -> analysis -> findings -> recommendations
   - Each slide builds on previous, not isolated data points
   - Conclusion ties back to specific, actionable next steps

4. FORMATTING (10% weight):
   - Consistent fonts, colors, spacing across all slides
   - Professional appearance — no broken tables, truncated text, or alignment issues
   - Visual hierarchy: important data stands out, not buried in walls of text

5. Data Accuracy (MEDIUM priority):
   - Facts should be correct and sourced where possible
   - Numbers/statistics should appear reasonable and properly formatted
""",
        "profile-slides": """
PROFILE SLIDES SPECIFIC CRITERIA:
1. Company information accuracy and completeness
2. Financial data formatting and correctness
3. Visual consistency with template branding
4. Section completeness (overview, financials, key metrics)
""",
        "target-v6": """
TARGET SEARCH SPECIFIC CRITERIA:
1. Company list completeness and relevance
2. Data accuracy (websites, descriptions)
3. Proper deduplication
4. Formatting matches template style
""",
        "trading-comparable": """
TRADING COMPS SPECIFIC CRITERIA:
1. Financial metrics accuracy
2. Peer selection appropriateness
3. Valuation multiples calculation
4. Table formatting and alignment
""",
    }
    return criteria.get(service_name, """
GENERAL CRITERIA:
1. Layout matches template
2. Content completeness
3. Styling consistency
4. Data accuracy
""")


def analyze_with_claude_cli(
    output_screenshots: List[str],
    template_screenshots: List[str],
    service_name: str = "unknown"
) -> AnalysisResult:
    """
    Compare output screenshots using Claude Code CLI with visual analysis.

    Claude Code CLI can read image files directly. We pass the file paths
    and ask it to visually compare output vs template.
    """
    import subprocess

    logger.info(f"Analyzing with Claude Code CLI (visual comparison)")

    # Build prompt with image file paths
    # Claude CLI will read these images using its Read tool
    # Sample slides for token efficiency
    sampled_templates = sample_slides(template_screenshots, max_count=5)
    sampled_outputs = sample_slides(output_screenshots, max_count=5)
    template_list = "\n".join([f"- {p}" for p in sampled_templates])
    output_list = "\n".join([f"- {p}" for p in sampled_outputs])

    # Get service-specific criteria
    specific_criteria = get_service_specific_criteria(service_name)

    prompt = f"""You are a senior quality analyst comparing PowerPoint automation output against a reference template for a {service_name} service.

TEMPLATE SLIDES (reference — what output SHOULD look like):
{template_list}

OUTPUT SLIDES (actual generated output to evaluate):
{output_list}

{specific_criteria}

ANALYSIS INSTRUCTIONS:
1. Read EVERY image file using the Read tool — both template and output
2. Analyze the WHOLE PRESENTATION as a cohesive narrative (not just slide-by-slide)
3. Compare output against template on these dimensions:
   - Content depth and thoroughness (are insights as deep as template?)
   - Data quality and specificity (named companies, specific metrics, not generic)
   - Narrative flow (logical progression from intro to conclusion)
   - Visual formatting (fonts, colors, spacing, layout consistency)
   - Completeness (all expected sections present?)
4. If output has FEWER slides than template, explain what's missing and why it matters
5. If output has MORE slides than template, check if extras add value or are filler

Return ONLY a JSON object (no markdown, no explanation):
{{
    "passed": true/false,
    "summary": "2-3 sentence assessment covering content quality, depth, and formatting — not just layout",
    "issues": [
        {{
            "slide_number": 1,
            "severity": "critical/major/minor",
            "category": "content_depth/insights/story_flow/formatting/layout/data/missing/extra",
            "description": "Specific difference observed (be precise, cite what you see)",
            "suggestion": "Exact actionable fix needed"
        }}
    ]
}}

PASS CRITERIA:
- passed=true ONLY if: no critical issues AND content depth matches template AND insights are specific/actionable
- For market-research: shallow/generic analysis = FAIL even if layout is perfect
- Empty issues[] ONLY if output is indistinguishable from template quality

FAIL ON:
- Corrupted/unreadable images: return {{"passed": false, "summary": "Could not analyze: image corrupted/unreadable", "issues": []}}
- Missing critical sections that exist in template
- Generic/shallow content where template has specific/deep analysis

If output genuinely matches template quality, return {{"passed": true, "summary": "Output matches template quality — [brief reason]", "issues": []}}
"""

    try:
        # B11: Use --print --message --allowedTools Read so CLI can read image files
        # M2: Add --model flag; L10: Use --allowedTools instead of --dangerously-skip-permissions
        result = subprocess.run(
            ["claude", "--print", "--model", "opus",
             "--allowedTools", "Read",
             "--output-format", "text",
             prompt],  # positional arg MUST be last
            capture_output=True,
            text=True,
            timeout=300,  # 5 min timeout for image analysis
            cwd=SHARED_FOLDER,
        )

        response = result.stdout.strip()
        logger.info(f"Claude CLI response length: {len(response)}")

        # Extract JSON from response
        json_start = response.find("{")
        json_end = response.rfind("}") + 1

        if json_start >= 0 and json_end > json_start:
            json_str = response[json_start:json_end]
            result_data = json.loads(json_str)

            issues = [
                SlideIssue(
                    slide_number=i.get("slide_number", 0),
                    severity=i.get("severity", "minor"),
                    category=i.get("category", "unknown"),
                    description=i.get("description", ""),
                    suggestion=i.get("suggestion", ""),
                )
                for i in result_data.get("issues", [])
            ]

            return AnalysisResult(
                passed=result_data.get("passed", False),
                total_slides=len(output_screenshots),
                issues=issues,
                summary=result_data.get("summary", "Analysis complete")
            )
        else:
            logger.error(f"No JSON in Claude response: {response[:500]}")

    except subprocess.TimeoutExpired:
        logger.error("Claude CLI timed out during analysis")
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Claude response as JSON: {e}")
    except Exception as e:
        logger.error(f"Claude CLI analysis failed: {e}")

    # Fallback: return basic file check
    return AnalysisResult(
        passed=False,
        total_slides=len(output_screenshots),
        issues=[SlideIssue(
            slide_number=0,
            severity="major",
            category="error",
            description="Visual analysis failed, manual review needed",
            suggestion="Check Claude CLI output or review screenshots manually"
        )],
        summary="Analysis failed - manual review required"
    )


def analyze_with_template(
    output_screenshots: List[str],
    template_screenshots: List[str],
    service_name: str = "unknown"
) -> AnalysisResult:
    """
    Compare output screenshots against template screenshots.

    Uses Claude Code CLI for visual analysis (Max plan, no API key needed).

    Args:
        output_screenshots: List of paths to output slide screenshots
        template_screenshots: List of paths to template slide screenshots
        service_name: Name of the service for context

    Returns:
        AnalysisResult with issues found
    """
    # Use Claude Code CLI for visual analysis (default)
    return analyze_with_claude_cli(output_screenshots, template_screenshots, service_name)


def analyze_with_api(
    output_screenshots: List[str],
    template_screenshots: List[str],
    service_name: str = "unknown"
) -> AnalysisResult:
    """
    Compare using Anthropic API directly (requires ANTHROPIC_API_KEY).
    This is an alternative if CLI doesn't work well for images.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        logger.error("ANTHROPIC_API_KEY not set")
        return analyze_with_claude_cli(output_screenshots, template_screenshots, service_name)

    try:
        import anthropic
    except ImportError:
        logger.error("anthropic package not installed")
        return analyze_with_claude_cli(output_screenshots, template_screenshots, service_name)

    client = anthropic.Anthropic()

    # Get service-specific criteria
    specific_criteria = get_service_specific_criteria(service_name)

    # Build the comparison prompt
    comparison_prompt = f"""You are a senior quality analyst comparing PowerPoint automation output against a reference template for a {service_name} service.

{specific_criteria}

ANALYSIS INSTRUCTIONS:
1. Examine EVERY slide in both template and output
2. Analyze the WHOLE PRESENTATION as a cohesive narrative
3. Compare on these dimensions:
   - Content depth and thoroughness (are insights as deep as template?)
   - Data quality and specificity (named companies, specific metrics, not generic)
   - Narrative flow (logical progression from intro to conclusion)
   - Visual formatting (fonts, colors, spacing, layout consistency)
   - Completeness (all expected sections present?)
4. If output has fewer slides than template, explain what's missing
5. If output has more slides, check if extras add value or are filler

For each issue, provide:
1. Slide number (or "overall" for presentation-wide issues)
2. Severity: critical (blocks success) / major (noticeable quality gap) / minor (cosmetic)
3. Category: content_depth/insights/story_flow/formatting/layout/data/missing/extra
4. Exact description with specific evidence from what you see
5. Actionable suggestion to fix it

Output JSON:
{{
    "passed": true/false,
    "summary": "2-3 sentence assessment covering content quality, depth, and formatting",
    "issues": [
        {{
            "slide_number": 1,
            "severity": "critical",
            "category": "content_depth",
            "description": "Specific difference observed with evidence",
            "suggestion": "Exact actionable fix"
        }}
    ]
}}

PASS CRITERIA:
- passed=true ONLY if: no critical issues AND content depth matches template AND insights are specific/actionable
- For market-research: shallow/generic analysis = FAIL even if layout is perfect
- Empty issues[] ONLY if output quality is indistinguishable from template

If output passes, set passed=true with a brief explanation of why it matches.
"""

    # Build message content with images
    content = [{"type": "text", "text": comparison_prompt}]

    # Add template slides first (sampled for token efficiency)
    content.append({"type": "text", "text": "\n--- TEMPLATE SLIDES (Reference) ---\n"})
    sampled_templates = sample_slides(template_screenshots, max_count=5)
    for i, template_path in enumerate(sampled_templates, 1):
        if os.path.exists(template_path):
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": get_image_media_type(template_path),
                    "data": load_image_as_base64(template_path),
                }
            })
            content.append({"type": "text", "text": f"Template Slide {i}"})

    # Add output slides (sampled for token efficiency)
    content.append({"type": "text", "text": "\n--- OUTPUT SLIDES (To Analyze) ---\n"})
    sampled_outputs = sample_slides(output_screenshots, max_count=5)
    for i, output_path in enumerate(sampled_outputs, 1):
        if os.path.exists(output_path):
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": get_image_media_type(output_path),
                    "data": load_image_as_base64(output_path),
                }
            })
            content.append({"type": "text", "text": f"Output Slide {i}"})

    content.append({"type": "text", "text": "\nNow analyze and provide JSON response:"})

    logger.info(f"Sending {len(template_screenshots)} template + {len(output_screenshots)} output slides to Claude")

    try:
        response = client.messages.create(
            model="opus",
            max_tokens=4096,
            messages=[{"role": "user", "content": content}]
        )

        # Parse response
        response_text = response.content[0].text

        # Extract JSON from response
        json_start = response_text.find("{")
        json_end = response_text.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            json_str = response_text[json_start:json_end]
            result_data = json.loads(json_str)
        else:
            logger.error(f"No JSON found in response: {response_text[:500]}")
            return AnalysisResult(
                passed=False,
                total_slides=len(output_screenshots),
                issues=[SlideIssue(
                    slide_number=0,
                    severity="critical",
                    category="error",
                    description="Failed to parse Claude response",
                    suggestion="Check API response format"
                )],
                summary="Analysis failed: could not parse response"
            )

        # Convert to AnalysisResult
        issues = [
            SlideIssue(
                slide_number=i.get("slide_number", 0),
                severity=i.get("severity", "minor"),
                category=i.get("category", "unknown"),
                description=i.get("description", ""),
                suggestion=i.get("suggestion", ""),
            )
            for i in result_data.get("issues", [])
        ]

        return AnalysisResult(
            passed=result_data.get("passed", False),
            total_slides=len(output_screenshots),
            issues=issues,
            summary=result_data.get("summary", "Analysis complete")
        )

    except Exception as e:
        logger.error(f"Claude API error: {e}")
        return AnalysisResult(
            passed=False,
            total_slides=len(output_screenshots),
            issues=[SlideIssue(
                slide_number=0,
                severity="critical",
                category="error",
                description=f"API error: {str(e)}",
                suggestion="Check API key and connectivity"
            )],
            summary=f"Analysis failed: {str(e)}"
        )


def analyze_ppt_output(
    ppt_screenshots_folder: str,
    template_name: str,
    service_name: str = "unknown"
) -> AnalysisResult:
    """
    High-level function to analyze a PPT output folder against a template.

    Args:
        ppt_screenshots_folder: Folder containing output slide screenshots
        template_name: Name of the template to compare against
        service_name: Service name for context

    Returns:
        AnalysisResult
    """
    # Get output screenshots
    output_screenshots = sorted([
        os.path.join(ppt_screenshots_folder, f)
        for f in os.listdir(ppt_screenshots_folder)
        if f.endswith(".png")
    ])

    if not output_screenshots:
        return AnalysisResult(
            passed=False,
            total_slides=0,
            issues=[SlideIssue(
                slide_number=0,
                severity="critical",
                category="error",
                description="No output screenshots found",
                suggestion=f"Check folder: {ppt_screenshots_folder}"
            )],
            summary="No output to analyze"
        )

    # Get template screenshots
    template_screenshots = get_template_screenshots(template_name)

    if not template_screenshots:
        logger.warning(f"No template found for {template_name}, analyzing without reference")
        # Still analyze but without comparison
        return analyze_without_template(output_screenshots, service_name)

    return analyze_with_template(output_screenshots, template_screenshots, service_name)


def analyze_without_template(
    output_screenshots: List[str],
    service_name: str = "unknown"
) -> AnalysisResult:
    """
    Analyze output slides without a template reference.
    Checks for general quality issues.
    """
    try:
        import anthropic
    except ImportError:
        return AnalysisResult(
            passed=False,
            total_slides=len(output_screenshots),
            issues=[],
            summary="Cannot analyze: anthropic package not installed"
        )

    client = anthropic.Anthropic()

    prompt = f"""You are analyzing PowerPoint slides from a {service_name} automation output.
No reference template is available — evaluate standalone quality.

ANALYZE EACH SLIDE FOR:

1. CONTENT COMPLETENESS:
   - Are all expected data fields populated (not empty/placeholder)?
   - Are sections visibly incomplete (e.g., "TODO", "N/A" placeholders, blank areas)?
   - Does each slide have a clear purpose and sufficient content?

2. DATA INTEGRITY:
   - Text truncation: content cut off mid-sentence or overflowing boundaries?
   - Broken tables: misaligned columns, missing rows, garbled data?
   - Numbers/lists: readable, properly formatted, not corrupted?

3. LAYOUT & VISUAL QUALITY:
   - Consistent formatting across all slides (fonts, colors, spacing)?
   - Professional appearance: no debug text, artifacts, or rendering errors?
   - Readable: text not too small, sufficient contrast, proper alignment?

4. PRESENTATION STRUCTURE:
   - Logical flow from first slide to last (title -> content -> conclusion)?
   - Each slide is standalone and understandable?
   - No duplicate or redundant slides?

ALSO ANALYZE THE WHOLE PRESENTATION:
- Does it tell a coherent story?
- Is the overall quality suitable for professional use?

Return ONLY JSON (no markdown, no explanation):
{{
    "passed": true/false,
    "summary": "2-3 sentence assessment: is this output usable and professional?",
    "issues": [
        {{
            "slide_number": 1,
            "severity": "critical/major/minor",
            "category": "content/layout/formatting/structure/data/missing",
            "description": "Specific problem observed",
            "suggestion": "How to fix it"
        }}
    ]
}}

PASS CRITERIA: No critical issues AND content is complete enough for professional use.
FAIL CRITERIA: Any critical issue (empty slides, corrupted data, truncated content) OR major content gaps.
"""

    content = [{"type": "text", "text": prompt}]

    # Sample slides for token efficiency
    sampled_screenshots = sample_slides(output_screenshots, max_count=5)
    for i, path in enumerate(sampled_screenshots, 1):
        if os.path.exists(path):
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": get_image_media_type(path),
                    "data": load_image_as_base64(path),
                }
            })
            content.append({"type": "text", "text": f"Slide {i}"})

    try:
        response = client.messages.create(
            model="opus",
            max_tokens=4096,
            messages=[{"role": "user", "content": content}]
        )

        response_text = response.content[0].text
        json_start = response_text.find("{")
        json_end = response_text.rfind("}") + 1

        if json_start >= 0 and json_end > json_start:
            result_data = json.loads(response_text[json_start:json_end])

            issues = [
                SlideIssue(
                    slide_number=i.get("slide_number", 0),
                    severity=i.get("severity", "minor"),
                    category=i.get("category", "unknown"),
                    description=i.get("description", ""),
                    suggestion=i.get("suggestion", ""),
                )
                for i in result_data.get("issues", [])
            ]

            return AnalysisResult(
                passed=result_data.get("passed", False),
                total_slides=len(output_screenshots),
                issues=issues,
                summary=result_data.get("summary", "Analysis complete")
            )
    except Exception as e:
        logger.error(f"Analysis error: {e}")

    return AnalysisResult(
        passed=False,
        total_slides=len(output_screenshots),
        issues=[],
        summary="Analysis failed"
    )


def generate_fix_prompt(
    analysis_result: AnalysisResult,
    service_name: str,
    file_path: str
) -> str:
    """
    Generate a prompt for Claude Code to fix the identified issues.

    Args:
        analysis_result: The analysis result with issues
        service_name: Name of the service to fix
        file_path: Path to the file that was analyzed

    Returns:
        A prompt string for Claude Code
    """
    if not analysis_result.issues:
        return ""

    issues_text = "\n".join([
        f"- [{i.severity.upper()}] Slide {i.slide_number}: {i.description}\n  Suggestion: {i.suggestion}"
        for i in analysis_result.issues
    ])

    prompt = f"""Fix PowerPoint generation issues in the {service_name} service.

FILE ANALYZED: {file_path}
QUALITY SUMMARY: {analysis_result.summary}

ISSUES FOUND:
{issues_text}

INSTRUCTIONS:
1. FIND the code responsible for generating these slides:
   - Start in: backend/{service_name}/
   - Look for: slide generation, data processing, template application, PPTX creation
   - Trace the data flow: input -> processing -> slide rendering -> output

2. IDENTIFY ROOT CAUSE:
   - Do multiple issues stem from the same code bug? Fix once at the source.
   - Is this a data issue (wrong/missing data) or rendering issue (data exists but displays wrong)?
   - Check if a shared utility function is the actual source of the problem.

3. IMPLEMENT FIX:
   - Fix the root cause, not symptoms
   - Add validation to prevent recurrence where appropriate
   - Ensure fix doesn't break other services that share the same code

4. VERIFY:
   - Run tests: npm test
   - Check that existing tests still pass
   - If no tests cover this area, add a focused regression test

5. COMMIT AND PR:
   - Branch: claude/{service_name}-fix-pptx
   - Commit message: "Fix: {service_name} - [brief root cause description]"
   - Create PR with description of what was broken and how the fix prevents recurrence
"""

    return prompt


# CLI interface for testing
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Analyze PPT screenshots")
    parser.add_argument("--output-folder", required=True, help="Folder with output screenshots")
    parser.add_argument("--template", required=True, help="Template name")
    parser.add_argument("--service", default="unknown", help="Service name")

    args = parser.parse_args()

    result = analyze_ppt_output(args.output_folder, args.template, args.service)

    print("\n" + "=" * 60)
    print("PPT ANALYSIS RESULT")
    print("=" * 60)
    print(f"Passed: {result.passed}")
    print(f"Total slides: {result.total_slides}")
    print(f"Summary: {result.summary}")

    if result.issues:
        print(f"\nIssues ({len(result.issues)}):")
        for issue in result.issues:
            print(f"  [{issue.severity}] Slide {issue.slide_number}: {issue.description}")
            print(f"           Suggestion: {issue.suggestion}")

    if not result.passed:
        print("\n" + "-" * 60)
        print("FIX PROMPT:")
        print("-" * 60)
        print(generate_fix_prompt(result, args.service, args.output_folder))
