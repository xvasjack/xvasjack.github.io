"""
Template Comparison System

Compares actual output (PPT/Excel) against expected templates/criteria.
Generates specific, actionable feedback for Claude Code to fix.
"""

import json
import os
import re
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("template_comparison")


class Severity(Enum):
    CRITICAL = "critical"  # Must fix - blocks release
    HIGH = "high"          # Should fix - significant quality issue
    MEDIUM = "medium"      # Nice to fix - noticeable issue
    LOW = "low"            # Minor - cosmetic or edge case


@dataclass
class Discrepancy:
    """A single discrepancy between output and template"""
    severity: Severity
    category: str  # e.g., "missing_data", "format_error", "broken_link"
    location: str  # e.g., "Slide 3", "Sheet 'Companies' Row 15"
    expected: str
    actual: str
    suggestion: str  # Actionable fix suggestion for Claude Code

    def to_dict(self) -> Dict[str, Any]:
        return {
            "severity": self.severity.value,
            "category": self.category,
            "location": self.location,
            "expected": self.expected,
            "actual": self.actual,
            "suggestion": self.suggestion,
        }

    def to_comment(self) -> str:
        """Format as a comment for Claude Code"""
        return f"[{self.severity.value.upper()}] {self.category} at {self.location}: Expected '{self.expected}', got '{self.actual}'. Suggestion: {self.suggestion}"


@dataclass
class ComparisonResult:
    """Result of comparing output against template"""
    output_file: str
    template_name: str
    passed: bool
    total_checks: int
    passed_checks: int
    discrepancies: List[Discrepancy] = field(default_factory=list)
    summary: str = ""

    @property
    def critical_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.CRITICAL)

    @property
    def high_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.HIGH)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "output_file": self.output_file,
            "template_name": self.template_name,
            "passed": self.passed,
            "total_checks": self.total_checks,
            "passed_checks": self.passed_checks,
            "critical_issues": self.critical_count,
            "high_issues": self.high_count,
            "total_issues": len(self.discrepancies),
            "discrepancies": [d.to_dict() for d in self.discrepancies],
            "summary": self.summary,
        }

    def prioritize_and_limit(self, max_issues=5):
        """Return self with issues sorted by severity, top N marked as 'fix now'.
        All issues remain visible for context but only top N should be fixed this round."""
        if len(self.discrepancies) <= max_issues:
            return self
        severity_order = {Severity.CRITICAL: 0, Severity.HIGH: 1, Severity.MEDIUM: 2, Severity.LOW: 3}
        self.discrepancies = sorted(self.discrepancies, key=lambda d: severity_order.get(d.severity, 4))
        self._fix_now_count = max_issues
        return self

    def generate_claude_code_prompt(self) -> str:
        """Generate a prompt for Claude Code to fix the issues"""
        if not self.discrepancies:
            return "No issues found. Output matches template."

        fix_now_count = getattr(self, '_fix_now_count', None)
        total_count = len(self.discrepancies)

        prompt = f"""Fix the following issues in the output generation code:

Output file: {self.output_file}
Template: {self.template_name}
Total issues: {total_count} ({self.critical_count} critical, {self.high_count} high)

"""

        if fix_now_count and fix_now_count < total_count:
            prompt += f"FOCUS: Fix ONLY the top {fix_now_count} issues below (marked [FIX NOW]).\n"
            prompt += f"The remaining {total_count - fix_now_count} issues are shown for context only — do NOT fix them this round.\n"
            prompt += "Keep your diff as SMALL as possible.\n\n"

        for idx, d in enumerate(self.discrepancies):
            tag = "[FIX NOW]" if fix_now_count is None or idx < fix_now_count else "[CONTEXT ONLY]"
            sev = d.severity.value.upper()
            prompt += f"- {tag} [{sev}] **{d.category}** at {d.location}\n"
            prompt += f"  - Expected: {d.expected}\n"
            prompt += f"  - Actual: {d.actual}\n"
            prompt += f"  - Fix: {d.suggestion}\n\n"

        prompt += """
Please:
1. Identify the root cause in the code
2. Fix the issues marked [FIX NOW]
3. Commit and push changes
"""

        return prompt


# =============================================================================
# TEMPLATE DEFINITIONS
# =============================================================================


@dataclass
class PPTTemplate:
    """Template for PowerPoint output validation"""
    name: str
    min_slides: int = 10
    max_slides: int = 50
    min_companies: int = 20
    require_logos: bool = True
    require_websites: bool = True
    require_descriptions: bool = True
    logo_min_size: int = 50  # pixels

    # Reference PPTX for formatting comparison (path relative to repo root)
    reference_pptx_path: Optional[str] = None

    # Expected slide structure
    expected_slides: List[Dict[str, Any]] = field(default_factory=list)

    # Required fields per company
    required_company_fields: List[str] = field(default_factory=lambda: [
        "name", "website", "description"
    ])

    # Content depth settings
    min_words_per_description: int = 40
    min_content_paragraphs: int = 3
    require_actionable_content: bool = False
    content_depth_keywords: List[str] = field(default_factory=lambda: [
        "recommend", "opportunity", "strategy", "market size",
        "growth", "competitive", "next steps", "should consider",
        "potential", "outlook", "forecast", "implication"
    ])
    shallow_content_phrases: List[str] = field(default_factory=lambda: [
        "is a company that", "was founded in", "is located in",
        "is a leading", "provides services"
    ])

    # URL validation
    blocked_domains: List[str] = field(default_factory=lambda: [
        "facebook.com", "linkedin.com", "twitter.com",
        "wikipedia.org", "bloomberg.com", "crunchbase.com"
    ])


@dataclass
class ExcelTemplate:
    """Template for Excel output validation"""
    name: str
    required_sheets: List[str] = field(default_factory=list)
    min_rows_per_sheet: Dict[str, int] = field(default_factory=dict)

    # Required columns per sheet
    required_columns: Dict[str, List[str]] = field(default_factory=dict)

    # Data validation rules
    url_columns: List[str] = field(default_factory=lambda: ["website", "url", "web"])
    numeric_columns: List[str] = field(default_factory=lambda: ["revenue", "employees", "year"])

    # No empty values allowed in these columns
    no_empty_columns: List[str] = field(default_factory=lambda: ["company", "name"])


@dataclass
class DOCXTemplate:
    """Template for Word document (DD Report) validation"""
    name: str

    # Cover page requirements
    expected_title: str = "PRE-DUE DILIGENCE REPORT"
    require_prepared_for: bool = True
    require_purpose: bool = True
    require_confidential: bool = True

    # Section number requirements
    expected_sections: Dict[str, str] = field(default_factory=lambda: {
        "financials": "4",  # Should start with 4
        "predd_workplan": "4.9",
        "future_plans": "8"
    })

    # Competition table requirements
    competition_table_columns: int = 5  # Service Segment, Growth (CAGR %), Demand Driver, Market Competition, Market Position
    competition_table_headers: List[str] = field(default_factory=lambda: [
        "Service Segment", "Growth", "CAGR", "Demand Driver"
    ])

    # Financial table requirements
    financial_header_format: str = "SGD ('000)"

    # Pre-DD Workplan requirements
    predd_standard_rows: List[str] = field(default_factory=lambda: [
        "customer analysis",
        "pipeline analysis",
        "pricing power",
        "unit economics",
        "billing",
        "forecast",
        "partner ecosystem"
    ])


# =============================================================================
# PRE-DEFINED TEMPLATES FOR YOUR SERVICES
# =============================================================================


TEMPLATES = {
    "target-search": PPTTemplate(
        name="Target Search Results",
        min_slides=15,
        max_slides=60,
        min_companies=20,
        require_logos=True,
        require_websites=True,
        require_descriptions=True,
        required_company_fields=["name", "website", "description", "country"],
        blocked_domains=[
            "facebook.com", "linkedin.com", "twitter.com",
            "wikipedia.org", "bloomberg.com", "crunchbase.com",
            "zoominfo.com", "dnb.com"
        ],
    ),

    "profile-slides": PPTTemplate(
        name="Company Profile Slides",
        min_slides=5,
        max_slides=30,
        min_companies=1,  # Usually single company
        require_logos=True,
        require_websites=True,
        require_descriptions=True,
        required_company_fields=["name", "website", "description", "financials"],
        min_words_per_description=40,
        min_content_paragraphs=2,
        require_actionable_content=False,
        content_depth_keywords=[
            "revenue", "EBITDA", "margin", "growth", "employees",
            "market share", "competitive", "strategic", "acquisition",
        ],
        shallow_content_phrases=[
            "is a company that", "was founded in", "is located in",
            "is a leading",
        ],
    ),

    "market-research": PPTTemplate(
        name="Market Research Report",
        min_slides=10,
        max_slides=40,
        min_companies=0,  # Market research is section-based, not company-per-slide
        require_logos=False,  # Market research may not have logos
        require_websites=True,
        require_descriptions=True,
        reference_pptx_path="251219_Escort_Phase 1 Market Selection_V3.pptx",
        min_words_per_description=50,
        min_content_paragraphs=3,
        require_actionable_content=True,
        content_depth_keywords=[
            "recommend", "opportunity", "strategy", "market size",
            "growth", "competitive", "next steps", "should consider",
            "potential", "outlook", "forecast", "implication",
            "CAGR", "TAM", "SAM", "market share",
        ],
        shallow_content_phrases=[
            "is a company that", "was founded in", "is located in",
            "is a leading", "provides services",
        ],
    ),

    "validation-results": ExcelTemplate(
        name="Validation Results",
        required_sheets=["Results", "Summary"],
        min_rows_per_sheet={"Results": 5, "Summary": 1},
        required_columns={
            "Results": ["company", "website", "status", "notes"],
            "Summary": ["total", "valid", "invalid"],
        },
        no_empty_columns=["company", "status"],
    ),

    "trading-comps": ExcelTemplate(
        name="Trading Comparables",
        required_sheets=["Comparables"],
        min_rows_per_sheet={"Comparables": 5},
        required_columns={
            "Comparables": ["company", "ticker", "market_cap", "revenue", "ebitda"],
        },
        numeric_columns=["market_cap", "revenue", "ebitda", "ev"],
    ),

    "dd-report": DOCXTemplate(
        name="Due Diligence Report",
        expected_title="PRE-DUE DILIGENCE REPORT",
        require_prepared_for=True,
        require_purpose=True,
        require_confidential=True,
        expected_sections={
            "financials": "4",
            "predd_workplan": "4.9",
            "future_plans": "8"
        },
        competition_table_columns=5,
        competition_table_headers=["Service Segment", "Growth", "CAGR", "Demand Driver"],
        financial_header_format="SGD ('000)",
        predd_standard_rows=[
            "customer analysis",
            "pipeline analysis",
            "pricing power",
            "unit economics",
            "billing",
            "forecast",
            "partner ecosystem"
        ],
    ),
}


# =============================================================================
# REFERENCE PPTX MAPPING (per service)
# =============================================================================

SERVICE_REFERENCE_PPTX = {
    "market-research": "251219_Escort_Phase 1 Market Selection_V3.pptx",
    "profile-slides": "YCP profile slide template v3.pptx",
    "target-search": "YCP Target List Slide Template.pptx",
    "trading-comps": "trading comps slide ref.pptx",
}


def _resolve_reference_pptx(template_name: str, reference_path: Optional[str] = None) -> Optional[str]:
    """Resolve reference PPTX path relative to repo root"""
    path = reference_path or SERVICE_REFERENCE_PPTX.get(template_name)
    if not path:
        return None

    # Try repo root (2 levels up from vm/)
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    full_path = os.path.join(repo_root, path)
    if os.path.exists(full_path):
        return full_path

    # Try current directory
    if os.path.exists(path):
        return os.path.abspath(path)

    logger.debug(f"Reference PPTX not found: {path}")
    return None


def _compare_formatting_profiles(
    reference_profile,
    output_profile,
) -> List["Discrepancy"]:
    """Compare two FormattingProfiles and return formatting discrepancies"""
    discrepancies = []

    if not reference_profile or not output_profile:
        return discrepancies

    # --- TEXT OVERFLOW (CRITICAL) ---
    if output_profile.overflow_shapes:
        overflow_slides = set()
        worst_overflow = 0
        for ov in output_profile.overflow_shapes:
            overflow_slides.add(ov["slide"])
            worst_overflow = max(worst_overflow, ov.get("overflow_lines", 0))

        discrepancies.append(Discrepancy(
            severity=Severity.CRITICAL,
            category="text_overflow",
            location=f"Slides {', '.join(str(s) for s in sorted(overflow_slides)[:10])}",
            expected="All text fits within shape boundaries",
            actual=f"{len(output_profile.overflow_shapes)} shapes overflow across {len(overflow_slides)} slides (worst: {worst_overflow} extra lines)",
            suggestion=(
                f"Reduce text or increase shape height. In pptxgenjs: increase `h` parameter or reduce `fontSize`. "
                f"Overflow on slides: {sorted(overflow_slides)[:5]}. "
                f"Consider splitting content across multiple slides if text is too long."
            ),
        ))

    # --- CONTENT OVERLAP (HIGH) ---
    if output_profile.overlap_pairs:
        overlap_slides = set()
        for op in output_profile.overlap_pairs:
            overlap_slides.add(op["slide"])

        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="content_overlap",
            location=f"Slides {', '.join(str(s) for s in sorted(overlap_slides)[:10])}",
            expected="No overlapping content shapes",
            actual=f"{len(output_profile.overlap_pairs)} overlapping shape pairs on {len(overlap_slides)} slides",
            suggestion=(
                f"Adjust `y` positions so shapes don't overlap. Each shape's y + h must be less than the next shape's y. "
                f"Overlap on slides: {sorted(overlap_slides)[:5]}."
            ),
        ))

    # --- HEADER STYLING (HIGH) ---
    # Title font size mismatch
    if reference_profile.title_font_size_pt and output_profile.title_font_size_pt:
        ref_size = reference_profile.title_font_size_pt
        out_size = output_profile.title_font_size_pt
        if abs(ref_size - out_size) > 2:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="title_font_size_mismatch",
                location="Presentation-wide",
                expected=f"Title font size: {ref_size}pt (from reference template)",
                actual=f"Title font size: {out_size}pt",
                suggestion=f"Change title fontSize to {ref_size} in pptxgenjs slide generation.",
            ))

    # Title color mismatch
    if reference_profile.title_font_color_hex and output_profile.title_font_color_hex:
        ref_color = reference_profile.title_font_color_hex.upper()
        out_color = output_profile.title_font_color_hex.upper()
        if ref_color != out_color:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="title_color_mismatch",
                location="Presentation-wide",
                expected=f"Title color: #{ref_color} (from reference template)",
                actual=f"Title color: #{out_color}",
                suggestion=f"Change title color to '#{ref_color}' in pptxgenjs. Use `color: '{ref_color}'`.",
            ))

    # Title bold mismatch
    if reference_profile.title_font_bold is not None and output_profile.title_font_bold is not None:
        if reference_profile.title_font_bold != output_profile.title_font_bold:
            expected_bold = "bold" if reference_profile.title_font_bold else "not bold"
            actual_bold = "bold" if output_profile.title_font_bold else "not bold"
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="title_bold_mismatch",
                location="Presentation-wide",
                expected=f"Title should be {expected_bold} (from reference template)",
                actual=f"Title is {actual_bold}",
                suggestion=f"Set title `bold: {str(reference_profile.title_font_bold).lower()}` in pptxgenjs.",
            ))

    # Subtitle font size mismatch
    if reference_profile.subtitle_font_size_pt and output_profile.subtitle_font_size_pt:
        ref_size = reference_profile.subtitle_font_size_pt
        out_size = output_profile.subtitle_font_size_pt
        if abs(ref_size - out_size) > 2:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="subtitle_font_size_mismatch",
                location="Presentation-wide",
                expected=f"Subtitle font size: {ref_size}pt (from reference template)",
                actual=f"Subtitle font size: {out_size}pt",
                suggestion=f"Change subtitle/message fontSize to {ref_size} in pptxgenjs.",
            ))

    # Subtitle color mismatch
    if reference_profile.subtitle_font_color_hex and output_profile.subtitle_font_color_hex:
        ref_color = reference_profile.subtitle_font_color_hex.upper()
        out_color = output_profile.subtitle_font_color_hex.upper()
        if ref_color != out_color:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="subtitle_color_mismatch",
                location="Presentation-wide",
                expected=f"Subtitle color: #{ref_color} (from reference template)",
                actual=f"Subtitle color: #{out_color}",
                suggestion=f"Change subtitle/message color to '#{ref_color}' in pptxgenjs.",
            ))

    # --- HEADER LINE COUNT (HIGH) ---
    if reference_profile.header_line_count_mode > 0:
        # Check how many output slides have the expected header line count
        ref_line_count = reference_profile.header_line_count_mode
        slides_missing_lines = 0
        total_content_slides = 0
        for sf in output_profile.slides:
            if sf.slide_number == 1:
                continue  # skip title slide
            total_content_slides += 1
            if sf.header_line_count < ref_line_count:
                slides_missing_lines += 1

        if total_content_slides > 0 and slides_missing_lines > total_content_slides * 0.3:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_header_lines",
                location=f"{slides_missing_lines}/{total_content_slides} content slides",
                expected=f"{ref_line_count} header divider line(s) per slide (from reference template)",
                actual=f"{slides_missing_lines} slides missing header lines",
                suggestion=(
                    f"Add a horizontal line shape under the title area. "
                    f"Reference y position: {reference_profile.header_line_y_positions}. "
                    f"In pptxgenjs: use `slide.addShape('line', {{x: 0.35, y: {reference_profile.header_line_y_positions[0] if reference_profile.header_line_y_positions else 1.1}, w: 9.3, h: 0, line: {{color: '1F497D', width: 2.5}}}})` on each content slide."
                ),
            ))

    # --- FONT FAMILY (MEDIUM) ---
    if reference_profile.font_family and output_profile.font_family:
        if reference_profile.font_family.lower() != output_profile.font_family.lower():
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="font_family_mismatch",
                location="Presentation-wide",
                expected=f"Font: {reference_profile.font_family} (from reference template)",
                actual=f"Font: {output_profile.font_family}",
                suggestion=f"Change fontFace to '{reference_profile.font_family}' in pptxgenjs.",
            ))

    return discrepancies


# =============================================================================
# PER-SLIDE PATTERN MATCHING (Part 4)
# =============================================================================

_cached_patterns = None


def _load_template_patterns() -> Optional[dict]:
    """Load template-patterns.json for per-slide comparison."""
    global _cached_patterns
    if _cached_patterns is not None:
        return _cached_patterns

    # repo_root: 2 levels up from vm/
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    patterns_path = os.path.join(repo_root, "backend", "market-research", "template-patterns.json")
    if not os.path.exists(patterns_path):
        logger.debug(f"template-patterns.json not found at {patterns_path}")
        return None
    try:
        with open(patterns_path, "r", encoding="utf-8") as f:
            _cached_patterns = json.load(f)
        return _cached_patterns
    except Exception as e:
        logger.warning(f"Failed to load template-patterns.json: {e}")
        return None


def _get_slide_title_text(slide_fmt) -> Optional[str]:
    """Get title text from a SlideFormatting by finding the topmost large-font text shape."""
    best = None
    best_score = -1
    for sf in slide_fmt.shapes:
        if sf.text_content and sf.top < 0.8:
            score = sf.font_size_pt or 0
            if score > best_score:
                best_score = score
                best = sf.text_content
    return best


def _classify_output_slide(slide_fmt) -> Optional[str]:
    """Classify an output slide into a pattern name based on shape fingerprinting.

    Returns pattern name or None if unclassifiable.
    """
    # Count shapes by type
    type_counts = {}
    for sf in slide_fmt.shapes:
        type_counts[sf.shape_type] = type_counts.get(sf.shape_type, 0) + 1

    chart_count = type_counts.get("chart", 0)
    table_count = type_counts.get("table", 0)
    text_count = type_counts.get("text_box", 0) + type_counts.get("placeholder", 0)
    total_shapes = len(slide_fmt.shapes)

    # Rule 1: slide 1 = cover
    if slide_fmt.slide_number == 1:
        return "cover"

    # Rule 2: TOC/divider — title contains "table of contents"
    title_text = _get_slide_title_text(slide_fmt)
    if title_text and "table of contents" in title_text.lower():
        return "toc_divider"

    # Rule 3: dual chart
    if chart_count >= 2:
        return "dual_chart_financial"

    # Rule 4: single chart
    if chart_count == 1:
        # Check for right-side text shapes (insight panels)
        right_text = [sf for sf in slide_fmt.shapes
                      if sf.shape_type in ("text_box", "placeholder")
                      and sf.left > 7.5 and sf.text_length > 0]
        if right_text:
            return "chart_insight_panels"
        return "chart_callout_boxes"

    # Rule 5: table, no charts
    if table_count >= 1 and chart_count == 0:
        # Check for narrow left-column label shapes with fill
        label_shapes = [sf for sf in slide_fmt.shapes
                        if sf.shape_type in ("text_box", "placeholder")
                        and sf.width < 2.5 and sf.fill_color_hex is not None
                        and sf.left < 1.0]
        if label_shapes:
            return "label_row_table"
        return "data_table_reference"

    # Rule 6: 2x2 matrix — 4 similarly-sized shapes in grid layout
    content_shapes = [sf for sf in slide_fmt.shapes
                      if sf.shape_type in ("text_box", "placeholder", "group")
                      and sf.top > 1.0 and sf.height > 1.0 and sf.width > 2.0]
    if len(content_shapes) == 4:
        widths = [sf.width for sf in content_shapes]
        heights = [sf.height for sf in content_shapes]
        if max(widths) - min(widths) < 2.0 and max(heights) - min(heights) < 1.5:
            return "matrix_2x2"

    # Rule 7: mostly text
    if text_count >= 3 and table_count == 0 and chart_count == 0:
        return "text_policy_block"

    # Rule 8: few shapes, likely a divider/section break
    if total_shapes <= 5 and text_count >= 1:
        return "toc_divider"

    return None


def _compare_slide_to_pattern(slide_fmt, pattern_name: str, pattern_spec: dict) -> List["Discrepancy"]:
    """Compare a single slide against its pattern spec from template-patterns.json.

    Returns list of discrepancies found.
    """
    discrepancies = []
    elements = pattern_spec.get("elements", {})
    slide_loc = f"Slide {slide_fmt.slide_number}"

    # Helper: find shape by type
    def find_shapes_by_type(stype):
        return [sf for sf in slide_fmt.shapes if sf.shape_type == stype]

    # Helper: find title shape
    def find_title_shape():
        for sf in slide_fmt.shapes:
            if sf.text_content and sf.top < 0.8 and sf.font_size_pt and sf.font_size_pt >= 14:
                return sf
        return None

    # Check title position if spec has it
    title_spec = elements.get("title") or elements.get("sectionTitle") or elements.get("countryTitle")
    if title_spec:
        title_shape = find_title_shape()
        if title_shape:
            spec_y = title_spec.get("y", 0)
            if abs(title_shape.top - spec_y) > 0.3:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="title_position_mismatch",
                    location=slide_loc,
                    expected=f"Title y={spec_y}\"",
                    actual=f"Title y={title_shape.top}\"",
                    suggestion=f"Move title to y={spec_y} on {slide_loc}.",
                ))

    # Check content area position
    content_spec = elements.get("contentArea")
    if content_spec:
        content_y = content_spec.get("y", 1.3)
        # Find first content shape below title
        content_shapes = [sf for sf in slide_fmt.shapes
                          if sf.top > 0.8 and sf.shape_type in ("text_box", "table", "placeholder")]
        if content_shapes:
            first_content = min(content_shapes, key=lambda s: s.top)
            if abs(first_content.top - content_y) > 0.3:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="content_position_mismatch",
                    location=slide_loc,
                    expected=f"Content starts at y={content_y}\"",
                    actual=f"Content starts at y={first_content.top}\"",
                    suggestion=f"Move content area to y={content_y} on {slide_loc}.",
                ))

    # Check chart presence and dimensions
    chart_spec = elements.get("chart")
    if chart_spec:
        chart_shapes = find_shapes_by_type("chart")
        if not chart_shapes:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_chart",
                location=slide_loc,
                expected=f"Chart expected (pattern: {pattern_name})",
                actual="No chart found",
                suggestion=f"Add chart to {slide_loc} using addChart() in pptxgenjs.",
            ))
        else:
            cs = chart_shapes[0]
            spec_w = chart_spec.get("w")
            spec_h = chart_spec.get("h")
            if spec_w and abs(cs.width - spec_w) > 0.5:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="chart_size_mismatch",
                    location=slide_loc,
                    expected=f"Chart width={spec_w}\"",
                    actual=f"Chart width={cs.width}\"",
                    suggestion=f"Resize chart to w={spec_w} on {slide_loc}.",
                ))
            if spec_h and abs(cs.height - spec_h) > 0.5:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="chart_size_mismatch",
                    location=slide_loc,
                    expected=f"Chart height={spec_h}\"",
                    actual=f"Chart height={cs.height}\"",
                    suggestion=f"Resize chart to h={spec_h} on {slide_loc}.",
                ))

    # Check table presence and width
    table_spec = elements.get("table")
    if table_spec:
        table_shapes = find_shapes_by_type("table")
        if not table_shapes:
            # Only flag if this pattern type expects a table as primary content
            if pattern_name in ("label_row_table", "data_table_reference",
                                "data_table_highlighted", "glossary_table"):
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="missing_table",
                    location=slide_loc,
                    expected=f"Table expected (pattern: {pattern_name})",
                    actual="No table found",
                    suggestion=f"Add table to {slide_loc} using addTable() in pptxgenjs.",
                ))
        else:
            ts = table_shapes[0]
            spec_w = table_spec.get("w")
            if spec_w and abs(ts.width - spec_w) > 0.5:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="table_width_mismatch",
                    location=slide_loc,
                    expected=f"Table width={spec_w}\"",
                    actual=f"Table width={ts.width}\"",
                    suggestion=f"Resize table to w={spec_w} on {slide_loc}.",
                ))

    return discrepancies


# =============================================================================
# COMPARISON FUNCTIONS
# =============================================================================


def compare_pptx_to_template(
    pptx_analysis: Dict[str, Any],
    template: PPTTemplate
) -> ComparisonResult:
    """
    Compare PPTX analysis results against a template.

    Args:
        pptx_analysis: Output from pptx_reader.analyze_pptx()
        template: Template to compare against

    Returns:
        ComparisonResult with discrepancies
    """
    discrepancies = []
    total_checks = 0
    passed_checks = 0

    # Check slide count
    total_checks += 1
    slide_count = pptx_analysis.get("slide_count", 0)
    if slide_count < template.min_slides:
        discrepancies.append(Discrepancy(
            severity=Severity.CRITICAL,
            category="insufficient_slides",
            location="Presentation",
            expected=f"At least {template.min_slides} slides",
            actual=f"{slide_count} slides",
            suggestion=f"Generate more company slides. Current: {slide_count}, Required: {template.min_slides}"
        ))
    elif slide_count > template.max_slides:
        discrepancies.append(Discrepancy(
            severity=Severity.MEDIUM,
            category="too_many_slides",
            location="Presentation",
            expected=f"At most {template.max_slides} slides",
            actual=f"{slide_count} slides",
            suggestion="Consider consolidating or filtering companies"
        ))
    else:
        passed_checks += 1

    # Check company count
    total_checks += 1
    companies = pptx_analysis.get("companies", [])
    if len(companies) < template.min_companies:
        discrepancies.append(Discrepancy(
            severity=Severity.CRITICAL,
            category="insufficient_companies",
            location="Presentation",
            expected=f"At least {template.min_companies} companies",
            actual=f"{len(companies)} companies",
            suggestion=f"Search is returning too few results. Check search parameters and API calls."
        ))
    else:
        passed_checks += 1

    # Check logos
    # Category 6 fix: Zero companies should not pass logo validation
    if template.require_logos:
        total_checks += 1
        if not companies:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="no_companies_for_logo_check",
                location="Presentation",
                expected="Companies to validate logos",
                actual="0 companies found",
                suggestion="Cannot validate logos when no companies are present"
            ))
        else:
            companies_without_logos = [c for c in companies if not c.get("has_logo")]
            if companies_without_logos:
                missing_pct = len(companies_without_logos) / max(len(companies), 1) * 100
                # LB-8: Use >= for consistent threshold comparison
                severity = Severity.CRITICAL if missing_pct >= 50 else Severity.HIGH if missing_pct >= 20 else Severity.MEDIUM
                discrepancies.append(Discrepancy(
                    severity=severity,
                    category="missing_logos",
                    location="Multiple slides",
                    expected="All companies should have logos",
                    actual=f"{len(companies_without_logos)} companies without logos ({missing_pct:.0f}%)",
                    suggestion="Check logo fetching logic. Ensure fallback to placeholder if logo not found."
                ))
            else:
                passed_checks += 1

    # Check websites
    if template.require_websites:
        total_checks += 1
        companies_without_websites = [c for c in companies if not c.get("website")]
        if companies_without_websites:
            missing_names = [c.get("name", "Unknown") for c in companies_without_websites[:5]]
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_websites",
                location="Multiple slides",
                expected="All companies should have website URLs",
                actual=f"{len(companies_without_websites)} companies without websites: {', '.join(missing_names)}...",
                suggestion="Ensure website field is populated from search results. Add validation before adding company."
            ))
        else:
            passed_checks += 1

    # Check for blocked domains in websites
    total_checks += 1
    bad_urls = []
    for company in companies:
        website = company.get("website") or ""
        for blocked in template.blocked_domains:
            if blocked in website.lower():
                bad_urls.append({
                    "company": company.get("name"),
                    "url": website,
                    "blocked": blocked
                })

    if bad_urls:
        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="blocked_domain_urls",
            location="Multiple companies",
            expected="Company websites should be actual company domains",
            actual=f"{len(bad_urls)} companies have social/directory URLs: {bad_urls[0]['company']} -> {bad_urls[0]['url']}",
            suggestion=f"Filter out URLs containing: {', '.join(template.blocked_domains[:3])}. Find actual company website."
        ))
    else:
        passed_checks += 1

    # Check for duplicate companies
    # Category 11 fix: Duplicate names should preserve original case for reporting
    # LB-7: Use Counter instead of list.count() to avoid O(n^2) complexity
    from collections import Counter
    total_checks += 1
    names_lower = [c.get("name", "").lower().strip() for c in companies]
    names_original = {c.get("name", "").lower().strip(): c.get("name", "") for c in companies}
    name_counts = Counter(names_lower)
    duplicates = [names_original.get(name, name) for name, count in name_counts.items() if count > 1]
    if duplicates:
        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="duplicate_companies",
            location="Presentation",
            expected="No duplicate companies",
            actual=f"Found duplicates: {', '.join(duplicates[:3])}",
            suggestion="Add deduplication logic by company name and website domain."
        ))
    else:
        passed_checks += 1

    # ==========================================================================
    # CONTENT DEPTH CHECKS
    # ==========================================================================

    # Check description word count
    total_checks += 1
    if companies:
        shallow_descriptions = []
        for c in companies:
            desc = c.get("description", "") or ""
            word_count = len(desc.split())
            if word_count < template.min_words_per_description:
                shallow_descriptions.append(c.get("name", "Unknown"))

        shallow_pct = len(shallow_descriptions) / max(len(companies), 1) * 100
        if shallow_pct > 30:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="shallow_descriptions",
                location="Multiple slides",
                expected=f"Descriptions with {template.min_words_per_description}+ words each",
                actual=f"{len(shallow_descriptions)}/{len(companies)} companies ({shallow_pct:.0f}%) have thin descriptions",
                suggestion=(
                    f"Expand company descriptions to {template.min_words_per_description}+ words. "
                    f"Include specific metrics (revenue, growth rate, market share), strategic context, "
                    f"and why the company is relevant. Shallow: {', '.join(shallow_descriptions[:5])}"
                ),
            ))
        else:
            passed_checks += 1
    else:
        passed_checks += 1

    # Check slide content depth (paragraphs per content slide)
    total_checks += 1
    slides = pptx_analysis.get("slides", [])
    if slides:
        thin_slides = []
        content_slides = []
        for i, slide in enumerate(slides):
            slide_type = (slide.get("type", "") or "").lower()
            # Skip title slides, divider slides, section headers
            if any(kw in slide_type for kw in ("title", "divider", "section", "header")):
                continue
            content_slides.append(i)
            # Count text blocks/paragraphs
            text_blocks = slide.get("text_blocks", [])
            paragraphs = slide.get("paragraphs", [])
            text_count = len(text_blocks) if text_blocks else len(paragraphs) if paragraphs else 0
            # Fallback: count from all_text split by newlines
            if text_count == 0:
                all_text = slide.get("all_text", "") or ""
                text_count = len([p for p in all_text.split("\n") if p.strip()])
            if text_count < template.min_content_paragraphs:
                thin_slides.append(i + 1)  # 1-indexed for reporting

        if content_slides:
            thin_pct = len(thin_slides) / max(len(content_slides), 1) * 100
            if thin_pct > 30:
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="thin_slides",
                    location=f"Slides {', '.join(str(s) for s in thin_slides[:5])}...",
                    expected=f"{template.min_content_paragraphs}+ text blocks per content slide",
                    actual=f"{len(thin_slides)}/{len(content_slides)} content slides ({thin_pct:.0f}%) have insufficient content",
                    suggestion=(
                        f"Add more substantive content to thin slides. Each content slide should have "
                        f"at least {template.min_content_paragraphs} text blocks with market data, "
                        f"analysis, or strategic context."
                    ),
                ))
            else:
                passed_checks += 1
        else:
            passed_checks += 1
    else:
        passed_checks += 1

    # Check for actionable content (keywords indicating substance)
    if template.require_actionable_content:
        total_checks += 1
        slides_with_actionable = 0
        total_content_slides = 0

        for slide in slides:
            slide_type = (slide.get("type", "") or "").lower()
            if any(kw in slide_type for kw in ("title", "divider", "section", "header")):
                continue
            total_content_slides += 1
            all_text = (slide.get("all_text", "") or "").lower()
            if any(kw in all_text for kw in template.content_depth_keywords):
                slides_with_actionable += 1

        if total_content_slides > 0:
            actionable_pct = slides_with_actionable / total_content_slides * 100
            if actionable_pct < 20:
                discrepancies.append(Discrepancy(
                    severity=Severity.CRITICAL,
                    category="missing_actionable_insights",
                    location="Presentation-wide",
                    expected="20%+ of content slides with actionable language (recommendations, strategy, outlook)",
                    actual=f"Only {slides_with_actionable}/{total_content_slides} slides ({actionable_pct:.0f}%) contain actionable content",
                    suggestion=(
                        "Add strategic recommendations, market outlook, and next steps. "
                        "Use language like 'recommend', 'opportunity', 'should consider', 'growth potential', "
                        "'strategic fit', 'next steps'. Every content slide should answer 'so what?'"
                    ),
                ))
            else:
                passed_checks += 1
        else:
            passed_checks += 1

    # Check for generic/shallow text patterns in descriptions
    total_checks += 1
    if companies and template.shallow_content_phrases:
        generic_companies = []
        for c in companies:
            desc = (c.get("description", "") or "").lower()
            if any(phrase in desc for phrase in template.shallow_content_phrases):
                generic_companies.append(c.get("name", "Unknown"))

        generic_pct = len(generic_companies) / max(len(companies), 1) * 100
        if generic_pct > 50:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="generic_content",
                location="Multiple slides",
                expected="Descriptions with specific metrics and strategic context",
                actual=f"{len(generic_companies)}/{len(companies)} companies ({generic_pct:.0f}%) have generic filler text",
                suggestion=(
                    "Replace generic descriptions ('is a company that', 'was founded in', 'is a leading') "
                    "with specific data: revenue figures, growth rates, market share, competitive positioning. "
                    f"Generic: {', '.join(generic_companies[:5])}"
                ),
            ))
        else:
            passed_checks += 1
    else:
        passed_checks += 1

    # ==========================================================================
    # MARKET RESEARCH: CONTENT DEPTH + PATTERN MATCH SCORING
    # ==========================================================================

    if template.name == "Market Research Report":
        total_checks += 1
        # Content depth scoring based on research quality
        all_text = " ".join(
            (slide.get("all_text", "") or "").lower()
            for slide in slides
        )
        
        # Check for named regulations with years (policy depth)
        import re as _re
        regulation_pattern = r'\b(act|law|decree|regulation|ordinance|directive)\b.*?\b(19|20)\d{2}\b'
        named_regulations = len(_re.findall(regulation_pattern, all_text))
        
        # Check for numeric data series (market depth)
        number_pattern = r'\b\d+[\.,]?\d*\s*(%|billion|million|MW|GW|TWh|mtoe|bcm|USD|JPY|EUR)\b'
        data_points = len(_re.findall(number_pattern, all_text, _re.IGNORECASE))
        
        # Check for named companies (competitor depth)
        # Look for company indicators followed by proper nouns
        company_indicators = ["co.", "corp", "ltd", "inc", "group", "holdings", "plc", "gmbh", "sa", "ag"]
        named_companies = sum(1 for ind in company_indicators if ind in all_text)
        
        # Score content depth
        depth_score = 0
        depth_failures = []
        
        if named_regulations >= 3:
            depth_score += 30
        elif named_regulations >= 1:
            depth_score += 15
        else:
            depth_failures.append(f"Policy depth: only {named_regulations} named regulations (need ≥3)")
        
        if data_points >= 15:
            depth_score += 40
        elif data_points >= 5:
            depth_score += 20
        else:
            depth_failures.append(f"Market depth: only {data_points} quantified data points (need ≥15)")
        
        if named_companies >= 3:
            depth_score += 30
        elif named_companies >= 1:
            depth_score += 15
        else:
            depth_failures.append(f"Competitor depth: only {named_companies} named companies (need ≥3)")
        
        if depth_score < 50:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="shallow_research_content",
                location="Presentation-wide",
                expected="Deep research: ≥3 named regulations, ≥15 data points, ≥3 named companies",
                actual=f"Content depth score: {depth_score}/100. {'; '.join(depth_failures)}",
                suggestion=(
                    "Research content is too shallow. Fix the research pipeline: "
                    "1) Add specific regulation names with years and decree numbers. "
                    "2) Include quantified market data (market size in $, growth rates, capacity in MW/GW). "
                    "3) Name specific competitor companies with revenue, market share, entry details. "
                    "Each section needs 'so what' insights connecting data to client implications."
                ),
            ))
        else:
            passed_checks += 1
        
        # Check for insight quality (pattern match)
        total_checks += 1
        insight_keywords = [
            "implication", "opportunity", "barrier", "recommend",
            "should", "risk", "advantage", "critical", "timing",
            "window", "first mover", "competitive edge"
        ]
        insight_count = sum(1 for kw in insight_keywords if kw in all_text)
        
        if insight_count < 5:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_strategic_insights",
                location="Presentation-wide",
                expected="Strategic insights with implications, recommendations, and timing",
                actual=f"Only {insight_count}/12 insight indicators found",
                suggestion=(
                    "Add strategic insights to each section. Every data point needs a 'so what' — "
                    "what does this mean for the client? Include timing windows, competitive advantages, "
                    "and specific recommendations with evidence."
                ),
            ))
        else:
            passed_checks += 1
        
        # Check for chart/data visualization presence
        total_checks += 1
        chart_slides = sum(
            1 for slide in slides
            if any(kw in (slide.get("all_text", "") or "").lower()
                   for kw in ["chart", "figure", "graph", "source:"])
            or slide.get("has_chart", False)
            or slide.get("chart_count", 0) > 0
        )
        
        if chart_slides < 3:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="insufficient_data_visualization",
                location="Presentation-wide",
                expected="At least 3 slides with charts/data visualizations",
                actual=f"Only {chart_slides} slides appear to have charts",
                suggestion=(
                    "Market research needs data visualization. Add charts for: "
                    "energy mix over time, market size growth, price comparisons, "
                    "competitor market share. Use pptxgenjs addChart() with the pattern library."
                ),
            ))
        else:
            passed_checks += 1

    # ==========================================================================
    # FORMATTING CHECKS (learned from reference template)
    # ==========================================================================

    try:
        from file_readers.pptx_reader import extract_formatting_profile

        # Get reference PPTX formatting profile
        ref_pptx_path = _resolve_reference_pptx(template.name, template.reference_pptx_path)
        output_path = pptx_analysis.get("file_path")

        if ref_pptx_path and output_path and os.path.exists(output_path):
            total_checks += 1  # formatting check counts as one aggregate check
            ref_profile = extract_formatting_profile(ref_pptx_path)
            out_profile = extract_formatting_profile(output_path)

            if ref_profile and out_profile:
                fmt_discrepancies = _compare_formatting_profiles(ref_profile, out_profile)
                if fmt_discrepancies:
                    discrepancies.extend(fmt_discrepancies)
                else:
                    passed_checks += 1
            else:
                passed_checks += 1  # can't check = pass
        elif output_path and os.path.exists(output_path):
            # No reference template — still check output for overflow/overlap
            total_checks += 1
            out_profile = extract_formatting_profile(output_path)
            if out_profile:
                # Only report overflow and overlap (no reference comparison)
                if out_profile.overflow_shapes:
                    overflow_slides = set(ov["slide"] for ov in out_profile.overflow_shapes)
                    discrepancies.append(Discrepancy(
                        severity=Severity.CRITICAL,
                        category="text_overflow",
                        location=f"Slides {', '.join(str(s) for s in sorted(overflow_slides)[:10])}",
                        expected="All text fits within shape boundaries",
                        actual=f"{len(out_profile.overflow_shapes)} shapes overflow across {len(overflow_slides)} slides",
                        suggestion="Reduce text length or increase shape height (h parameter in pptxgenjs).",
                    ))
                if out_profile.overlap_pairs:
                    overlap_slides = set(op["slide"] for op in out_profile.overlap_pairs)
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="content_overlap",
                        location=f"Slides {', '.join(str(s) for s in sorted(overlap_slides)[:10])}",
                        expected="No overlapping content shapes",
                        actual=f"{len(out_profile.overlap_pairs)} overlapping shape pairs",
                        suggestion="Adjust y positions so shapes don't overlap.",
                    ))
                if not out_profile.overflow_shapes and not out_profile.overlap_pairs:
                    passed_checks += 1
            else:
                passed_checks += 1
    except ImportError:
        logger.debug("pptx_reader formatting extraction not available")
    except Exception as e:
        logger.warning(f"Formatting comparison failed: {e}")

    # ==========================================================================
    # PER-SLIDE PATTERN MATCHING (market-research only)
    # ==========================================================================

    if template.name == "Market Research Report":
        try:
            from file_readers.pptx_reader import extract_formatting_profile as _efp

            output_path = pptx_analysis.get("file_path")
            if output_path and os.path.exists(output_path):
                patterns_data = _load_template_patterns()
                # Re-use out_profile if already extracted above, otherwise extract fresh
                try:
                    out_profile_for_slides = out_profile
                except NameError:
                    out_profile_for_slides = _efp(output_path)

                if patterns_data and out_profile_for_slides and out_profile_for_slides.slides:
                    patterns_dict = patterns_data.get("patterns", {})
                    total_checks += 1
                    slide_discrepancies = []

                    for slide_fmt in out_profile_for_slides.slides:
                        classified = _classify_output_slide(slide_fmt)
                        if classified and classified in patterns_dict:
                            slide_discs = _compare_slide_to_pattern(
                                slide_fmt, classified, patterns_dict[classified]
                            )
                            slide_discrepancies.extend(slide_discs)

                    if slide_discrepancies:
                        discrepancies.extend(slide_discrepancies)
                    else:
                        passed_checks += 1
        except ImportError:
            logger.debug("pptx_reader not available for per-slide matching")
        except Exception as e:
            logger.warning(f"Per-slide pattern matching failed: {e}")

    # Generate summary
    passed = len([d for d in discrepancies if d.severity == Severity.CRITICAL]) == 0

    result = ComparisonResult(
        output_file=pptx_analysis.get("file_path", "unknown"),
        template_name=template.name,
        passed=passed,
        total_checks=total_checks,
        passed_checks=passed_checks,
        discrepancies=discrepancies,
    )

    result.summary = f"Checked {total_checks} criteria, {passed_checks} passed. " \
                     f"Found {len(discrepancies)} issues ({result.critical_count} critical, {result.high_count} high)."

    return result


def compare_xlsx_to_template(
    xlsx_analysis: Dict[str, Any],
    template: ExcelTemplate
) -> ComparisonResult:
    """
    Compare XLSX analysis results against a template.
    """
    discrepancies = []
    total_checks = 0
    passed_checks = 0

    sheets = xlsx_analysis.get("sheets", [])
    # Category 6 fix: None values in sheet_names should be filtered out
    sheet_names = [s.get("name") for s in sheets if s and s.get("name") is not None]

    # Check required sheets
    for required_sheet in template.required_sheets:
        total_checks += 1
        if required_sheet not in sheet_names:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="missing_sheet",
                location="Workbook",
                expected=f"Sheet '{required_sheet}' should exist",
                actual=f"Sheet not found. Available: {', '.join(sheet_names)}",
                suggestion=f"Add sheet creation for '{required_sheet}' in Excel generation code."
            ))
        else:
            passed_checks += 1

    # Check row counts
    for sheet_name, min_rows in template.min_rows_per_sheet.items():
        total_checks += 1
        sheet = next((s for s in sheets if s.get("name") == sheet_name), None)
        if sheet:
            row_count = sheet.get("row_count", 0)
            if row_count < min_rows:
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="insufficient_rows",
                    location=f"Sheet '{sheet_name}'",
                    expected=f"At least {min_rows} data rows",
                    actual=f"{row_count} rows",
                    suggestion=f"Check data population for sheet '{sheet_name}'. May need more source data."
                ))
            else:
                passed_checks += 1

    # Check required columns
    for sheet_name, required_cols in template.required_columns.items():
        sheet = next((s for s in sheets if s.get("name") == sheet_name), None)
        if sheet:
            headers = [h.lower() for h in sheet.get("headers", [])]
            for col in required_cols:
                total_checks += 1
                if col.lower() not in headers:
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="missing_column",
                        location=f"Sheet '{sheet_name}'",
                        expected=f"Column '{col}' should exist",
                        actual=f"Column not found. Available: {', '.join(sheet.get('headers', [])[:5])}...",
                        suggestion=f"Add column '{col}' to sheet '{sheet_name}' in Excel generation."
                    ))
                else:
                    passed_checks += 1

    passed = len([d for d in discrepancies if d.severity == Severity.CRITICAL]) == 0

    result = ComparisonResult(
        output_file=xlsx_analysis.get("file_path", "unknown"),
        template_name=template.name,
        passed=passed,
        total_checks=total_checks,
        passed_checks=passed_checks,
        discrepancies=discrepancies,
    )

    result.summary = f"Checked {total_checks} criteria, {passed_checks} passed. " \
                     f"Found {len(discrepancies)} issues."

    return result


def compare_docx_to_template(
    docx_analysis: Dict[str, Any],
    template: DOCXTemplate
) -> ComparisonResult:
    """
    Compare DOCX (DD Report) analysis results against a template.

    Args:
        docx_analysis: Output from docx_reader.analyze_docx().to_dict()
        template: DOCXTemplate to compare against

    Returns:
        ComparisonResult with discrepancies
    """
    discrepancies = []
    total_checks = 0
    passed_checks = 0

    cover_page = docx_analysis.get("cover_page", {})
    sections = docx_analysis.get("sections", [])
    tables = docx_analysis.get("tables", [])

    # ========== COVER PAGE CHECKS ==========

    # Check title
    total_checks += 1
    title = cover_page.get("title", "")
    if not title:
        discrepancies.append(Discrepancy(
            severity=Severity.CRITICAL,
            category="missing_title",
            location="Cover Page",
            expected=f"Title: '{template.expected_title}'",
            actual="No title found",
            suggestion="Add cover page title 'PRE-DUE DILIGENCE REPORT' in report generation."
        ))
    elif template.expected_title.upper() not in title.upper():
        discrepancies.append(Discrepancy(
            severity=Severity.CRITICAL,
            category="wrong_title",
            location="Cover Page",
            expected=f"Title: '{template.expected_title}'",
            actual=f"Title: '{title}'",
            suggestion=f"Change cover page title from '{title}' to '{template.expected_title}' in report prompt."
        ))
    else:
        passed_checks += 1

    # Check prepared for
    if template.require_prepared_for:
        total_checks += 1
        if not cover_page.get("prepared_for"):
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_prepared_for",
                location="Cover Page",
                expected="'Prepared for [Client]' line",
                actual="Not found",
                suggestion="Add 'preparedFor' field to cover_page in report JSON."
            ))
        else:
            passed_checks += 1

    # Check purpose
    if template.require_purpose:
        total_checks += 1
        if not cover_page.get("purpose"):
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_purpose",
                location="Cover Page",
                expected="Purpose statement",
                actual="Not found",
                suggestion="Add 'purpose' field to cover_page in report JSON."
            ))
        else:
            passed_checks += 1

    # Check confidential
    if template.require_confidential:
        total_checks += 1
        if not cover_page.get("confidential"):
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="missing_confidential",
                location="Cover Page",
                expected="Confidential disclaimer",
                actual="Not found",
                suggestion="Add 'confidential' field to cover_page in report JSON."
            ))
        else:
            passed_checks += 1

    # ========== SECTION NUMBER CHECKS ==========

    # Check financials section number
    total_checks += 1
    financials_section = next(
        (s for s in sections if "financial" in s.get("title", "").lower()),
        None
    )
    expected_fin = template.expected_sections.get("financials", "4")
    if financials_section:
        fin_num = financials_section.get("number", "")
        if fin_num and not fin_num.startswith(expected_fin):
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="wrong_section_number",
                location="Financials Section",
                expected=f"Section {expected_fin}.x (e.g., 4.0 Key Financials)",
                actual=f"Section {fin_num}",
                suggestion=f"Change financials section from {fin_num} to {expected_fin}.0 in report structure."
            ))
        else:
            passed_checks += 1
    else:
        # 1.10: Missing section = failed check, not a free pass
        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="missing_section",
            location="Financials Section",
            expected=f"Section {expected_fin}.x for Financials",
            actual="Section not found",
            suggestion="Add a Financials section to the report."
        ))

    # Check Pre-DD Workplan section number
    total_checks += 1
    workplan_section = next(
        (s for s in sections if "workplan" in s.get("title", "").lower() or "pre-dd" in s.get("title", "").lower()),
        None
    )
    expected_wp = template.expected_sections.get("predd_workplan", "4.9")
    if workplan_section:
        wp_num = workplan_section.get("number", "")
        if wp_num and wp_num != expected_wp:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="wrong_section_number",
                location="Pre-DD Workplan Section",
                expected=f"Section {expected_wp}",
                actual=f"Section {wp_num}",
                suggestion=f"Change Pre-DD Workplan section from {wp_num} to {expected_wp} in report structure."
            ))
        else:
            passed_checks += 1
    else:
        # 1.10: Missing section = failed check
        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="missing_section",
            location="Pre-DD Workplan Section",
            expected=f"Section {expected_wp}",
            actual="Section not found",
            suggestion="Add a Pre-DD Workplan section to the report."
        ))

    # Check Future Plans section number
    total_checks += 1
    future_section = next(
        (s for s in sections if "future" in s.get("title", "").lower()),
        None
    )
    expected_fut = template.expected_sections.get("future_plans", "8")
    if future_section:
        fut_num = future_section.get("number", "")
        if fut_num and not fut_num.startswith(expected_fut):
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="wrong_section_number",
                location="Future Plans Section",
                expected=f"Section {expected_fut}",
                actual=f"Section {fut_num}",
                suggestion=f"Change Future Plans section from {fut_num} to {expected_fut} in report structure."
            ))
        else:
            passed_checks += 1
    else:
        # 1.10: Missing section = failed check
        discrepancies.append(Discrepancy(
            severity=Severity.HIGH,
            category="missing_section",
            location="Future Plans Section",
            expected=f"Section {expected_fut}",
            actual="Section not found",
            suggestion="Add a Future Plans section to the report."
        ))

    # ========== TABLE CHECKS ==========

    # Check Competition Landscape table
    total_checks += 1
    competition_table = next(
        (t for t in tables if any("segment" in h.lower() for h in t.get("header_row", []))),
        None
    )
    if competition_table:
        # Check for CAGR in headers
        headers = competition_table.get("header_row", [])
        has_cagr = any("cagr" in h.lower() for h in headers)
        if not has_cagr:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_cagr_header",
                location="Competition Landscape Table",
                expected="Column with 'Growth (CAGR %)' header",
                actual=f"Headers: {headers}",
                suggestion="Add 'Growth (CAGR %)' column to Competition Landscape table with values like '12-18%', '10-15%'."
            ))
        else:
            passed_checks += 1
    else:
        passed_checks += 1  # Table not found is not necessarily an error

    # Check financial tables for SGD ('000) format
    financial_tables = [t for t in tables if any("sgd" in h.lower() for h in t.get("header_row", []))]
    for ft in financial_tables:
        total_checks += 1
        headers = ft.get("header_row", [])
        has_thousands = any("'000" in h or "000)" in h for h in headers)
        if not has_thousands:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="wrong_financial_format",
                location=f"Financial Table (index {ft.get('index', '?')})",
                expected=f"Header format: '{template.financial_header_format}'",
                actual=f"Headers: {headers}",
                suggestion=f"Change financial table headers to use '{template.financial_header_format}' format."
            ))
        else:
            passed_checks += 1

    # ========== PRE-DD WORKPLAN CHECKS ==========

    total_checks += 1
    workplan_table = next(
        (t for t in tables if any("consideration" in h.lower() or "evidence" in h.lower() for h in t.get("header_row", []))),
        None
    )
    if workplan_table:
        # Check for standard rows
        sample_rows = workplan_table.get("sample_rows", [])
        all_row_text = " ".join(" ".join(row) for row in sample_rows).lower()

        missing_rows = []
        for expected_row in template.predd_standard_rows:
            if expected_row.lower() not in all_row_text:
                missing_rows.append(expected_row)

        if missing_rows and len(missing_rows) > 3:  # Allow some flexibility
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="non_standard_workplan",
                location="Pre-DD Workplan Table",
                expected=f"7 standard rows including: {', '.join(template.predd_standard_rows[:3])}...",
                actual=f"Missing rows: {', '.join(missing_rows[:3])}...",
                suggestion="Use standard Pre-DD Workplan rows: Customer analysis, Pipeline analysis, Pricing power, etc."
            ))
        else:
            passed_checks += 1
    else:
        passed_checks += 1

    # ========== GENERATE RESULT ==========

    passed = len([d for d in discrepancies if d.severity == Severity.CRITICAL]) == 0

    result = ComparisonResult(
        output_file=docx_analysis.get("file_path", "unknown"),
        template_name=template.name,
        passed=passed,
        total_checks=total_checks,
        passed_checks=passed_checks,
        discrepancies=discrepancies,
    )

    result.summary = f"DD Report Check: {total_checks} criteria, {passed_checks} passed. " \
                     f"Found {len(discrepancies)} issues ({result.critical_count} critical, {result.high_count} high)."

    return result


# =============================================================================
# MAIN COMPARISON FUNCTION
# =============================================================================


def compare_output_to_template(
    analysis: Dict[str, Any],
    template_name: str
) -> ComparisonResult:
    """
    Compare output analysis to the appropriate template.

    Args:
        analysis: Output from pptx_reader or xlsx_reader
        template_name: Name of template to use (e.g., "target-search")

    Returns:
        ComparisonResult
    """
    if template_name not in TEMPLATES:
        return ComparisonResult(
            output_file=analysis.get("file_path", "unknown"),
            template_name=template_name,
            passed=False,
            total_checks=0,
            passed_checks=0,
            discrepancies=[Discrepancy(
                severity=Severity.CRITICAL,
                category="template",
                location="N/A",
                expected="Valid template name",
                actual=template_name,
                suggestion=f"Unknown template: {template_name}. Available: {list(TEMPLATES.keys())}",
            )],
        )

    template = TEMPLATES[template_name]

    if isinstance(template, PPTTemplate):
        return compare_pptx_to_template(analysis, template)
    elif isinstance(template, ExcelTemplate):
        return compare_xlsx_to_template(analysis, template)
    elif isinstance(template, DOCXTemplate):
        return compare_docx_to_template(analysis, template)
    else:
        raise ValueError(f"Unknown template type: {type(template)}")


def auto_detect_template(file_path: str, analysis: Dict[str, Any]) -> Optional[str]:
    """
    Auto-detect which template to use based on file and content.
    """
    file_lower = file_path.lower()

    # Check file extension
    if file_lower.endswith(".pptx"):
        # Guess based on content
        companies = analysis.get("companies", [])
        slide_count = analysis.get("slide_count", 0)

        # 3.16: Use >= 10 for boundary
        if slide_count >= 10 and len(companies) >= 10:
            return "target-search"
        elif slide_count < 10:
            return "profile-slides"
        else:
            return "market-research"

    elif file_lower.endswith(".xlsx"):
        sheets = [s.get("name", "").lower() for s in analysis.get("sheets", [])]

        if "validation" in file_lower or "results" in " ".join(sheets):
            return "validation-results"
        elif "comp" in file_lower or "trading" in file_lower:
            return "trading-comps"

    elif file_lower.endswith(".docx"):
        # Check for DD report indicators
        cover_page = analysis.get("cover_page", {})
        title = cover_page.get("title", "").lower()

        if "due diligence" in title or "dd" in file_lower:
            return "dd-report"

    # M9: Return None for unrecognized files instead of wrong default
    return None
