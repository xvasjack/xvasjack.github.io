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
import math
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("template_comparison")

# Tolerances for formatting comparison
COLOR_TOLERANCE = 30        # Euclidean RGB distance — allows minor theme variations
FONT_SIZE_TOLERANCE = 1.5   # ±pt — rounding between pptxgenjs and python-pptx
POSITION_TOLERANCE = 0.3    # ±inches — layout engine differences


def _hex_color_distance(hex_a: str, hex_b: str) -> float:
    """Euclidean RGB distance between two hex colors. Returns 0-441."""
    if not hex_a or not hex_b:
        return 0.0
    a = hex_a.upper().lstrip('#')
    b = hex_b.upper().lstrip('#')
    if len(a) != 6 or len(b) != 6:
        return 0.0
    try:
        ra, ga, ba_ = int(a[0:2], 16), int(a[2:4], 16), int(a[4:6], 16)
        rb, gb, bb = int(b[0:2], 16), int(b[2:4], 16), int(b[4:6], 16)
        return math.sqrt((ra - rb) ** 2 + (ga - gb) ** 2 + (ba_ - bb) ** 2)
    except ValueError:
        return 0.0


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
    # Fix 10: Expose scores and detail counts for content pipeline diagnostic
    content_depth_score: Optional[int] = None
    insight_score: Optional[float] = None
    pattern_match_score: Optional[int] = None
    regulation_count: int = 0
    data_point_count: int = 0
    company_indicator_count: int = 0
    section_scores: Dict[str, Dict] = field(default_factory=dict)
    missing_sections: List[str] = field(default_factory=list)

    @property
    def critical_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.CRITICAL)

    @property
    def high_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.HIGH)

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "output_file": self.output_file,
            "template_name": self.template_name,
            "passed": self.passed,
            "total_checks": self.total_checks,
            "passed_checks": self.passed_checks,
            "critical_issues": self.critical_count,
            "high_issues": self.high_count,
            "total_issues": len(self.discrepancies),
            "discrepancies": [d_.to_dict() for d_ in self.discrepancies],
            "summary": self.summary,
        }
        # Fix 10: Expose scores and detail counts for content pipeline diagnostic
        if self.content_depth_score is not None:
            d["content_depth_score"] = self.content_depth_score
        if self.insight_score is not None:
            d["insight_score"] = self.insight_score
        if self.pattern_match_score is not None:
            d["pattern_match_score"] = self.pattern_match_score
        d["regulation_count"] = self.regulation_count
        d["data_point_count"] = self.data_point_count
        d["company_indicator_count"] = self.company_indicator_count
        # Flag missing categories for diagnostic (section-aware thresholds)
        d["missing_regulations"] = self.regulation_count < 3
        d["missing_data_points"] = self.data_point_count < 10
        d["missing_companies"] = self.company_indicator_count < 3
        if self.section_scores:
            d["section_scores"] = self.section_scores
        if self.missing_sections:
            d["missing_sections"] = self.missing_sections
        return d

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
        require_websites=False,  # A2: MR is section-based, not company-per-slide
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
        expected_slides=[
            {"type": "section_divider", "title_contains": "policy & regulation", "required": True},
            {"type": "section_divider", "title_contains": "market overview", "required": True},
            {"type": "section_divider", "title_contains": "competitive landscape", "required": True},
            {"type": "section_divider", "title_contains": "strategic analysis", "required": True},
            {"type": "section_divider", "title_contains": "recommendation", "required": True},
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
# ELEMENT-LEVEL FORMATTING CHECKS (Part 3b)
# =============================================================================


def _check_element_style(shape, element_spec: dict, slide_loc: str,
                         element_name: str, style_data: Optional[dict] = None) -> List["Discrepancy"]:
    """Check a shape's formatting against its element spec from template-patterns.json.

    Falls back to style.fonts global defaults when per-element spec doesn't define a property.
    Returns list of Discrepancy objects.
    """
    discrepancies = []
    if not shape or not element_spec:
        return discrepancies

    # Determine font role for fallback (body by default)
    fonts = (style_data or {}).get("fonts", {})
    # If element name suggests title, use title defaults; otherwise body
    font_role = "body"
    if "title" in element_name.lower() or "header" in element_name.lower():
        font_role = "title"
    elif "subtitle" in element_name.lower():
        font_role = "subtitle"
    elif "source" in element_name.lower() or "footnote" in element_name.lower():
        font_role = "source"
    role_defaults = fonts.get(font_role, {})

    # Font size check
    expected_size = element_spec.get("fontSize") or role_defaults.get("size")
    if expected_size and shape.font_size_pt:
        if abs(shape.font_size_pt - expected_size) > FONT_SIZE_TOLERANCE:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="font_size_mismatch",
                location=slide_loc,
                expected=f"{element_name} fontSize={expected_size}pt",
                actual=f"{element_name} fontSize={shape.font_size_pt}pt",
                suggestion=f"Change fontSize to {expected_size} for {element_name} in pptxgenjs.",
            ))

    # Font color check
    expected_color = element_spec.get("color") or role_defaults.get("color")
    if expected_color and shape.font_color_hex:
        dist = _hex_color_distance(expected_color, shape.font_color_hex)
        if dist > COLOR_TOLERANCE:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="font_color_mismatch",
                location=slide_loc,
                expected=f"{element_name} color=#{expected_color}",
                actual=f"{element_name} color=#{shape.font_color_hex}",
                suggestion=f"Change color to '{expected_color}' for {element_name} in pptxgenjs.",
            ))

    # Bold check
    expected_bold = element_spec.get("bold")
    if expected_bold is not None and shape.font_bold is not None:
        if expected_bold != shape.font_bold:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="bold_mismatch",
                location=slide_loc,
                expected=f"{element_name} bold={expected_bold}",
                actual=f"{element_name} bold={shape.font_bold}",
                suggestion=f"Set bold: {str(expected_bold).lower()} for {element_name} in pptxgenjs.",
            ))

    # Italic check
    expected_italic = element_spec.get("italic")
    if expected_italic is not None:
        # font_bold is extracted but italic isn't directly — check via font_name proxy
        pass  # Italic detection requires additional extraction; skip false positives

    # Fill color check
    expected_fill = element_spec.get("fill")
    if expected_fill and shape.fill_color_hex:
        dist = _hex_color_distance(expected_fill, shape.fill_color_hex)
        if dist > COLOR_TOLERANCE:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="fill_color_mismatch",
                location=slide_loc,
                expected=f"{element_name} fill=#{expected_fill}",
                actual=f"{element_name} fill=#{shape.fill_color_hex}",
                suggestion=f"Change fill to '{expected_fill}' for {element_name} in pptxgenjs addShape/addText.",
            ))

    # Alignment check
    expected_align = element_spec.get("align")
    if expected_align and shape.paragraph_alignment:
        if expected_align.lower() != shape.paragraph_alignment.lower():
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="alignment_mismatch",
                location=slide_loc,
                expected=f"{element_name} align={expected_align}",
                actual=f"{element_name} align={shape.paragraph_alignment}",
                suggestion=f"Set align: '{expected_align}' for {element_name} in pptxgenjs.",
            ))

    # Line spacing check
    expected_spacing = element_spec.get("lineSpacing")
    if expected_spacing and shape.line_spacing:
        if abs(shape.line_spacing - expected_spacing) > expected_spacing * 0.15:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="line_spacing_mismatch",
                location=slide_loc,
                expected=f"{element_name} lineSpacing={expected_spacing}",
                actual=f"{element_name} lineSpacing={shape.line_spacing}",
                suggestion=f"Set lineSpacingMultiple: {expected_spacing} for {element_name}.",
            ))

    return discrepancies


def _find_shape_for_element(slide_fmt, elem_name: str, elem_spec: dict) -> Optional[Any]:
    """Match an output shape to a template element by position+type proximity.

    Filters by shape_type to avoid matching wrong shape type.
    Returns the best matching ShapeFormatting or None.
    """
    if not elem_spec or not slide_fmt:
        return None

    spec_x = elem_spec.get("x")
    spec_y = elem_spec.get("y")
    if spec_x is None and spec_y is None:
        return None

    # Determine expected shape type from element name
    expected_types = None
    name_lower = elem_name.lower()
    if "chart" in name_lower:
        expected_types = {"chart"}
    elif "table" in name_lower:
        expected_types = {"table"}
    elif any(kw in name_lower for kw in ["diagram", "picture", "image", "logo"]):
        expected_types = {"picture", "group"}
    else:
        expected_types = {"text_box", "placeholder"}

    best_shape = None
    best_dist = float("inf")

    for sf in slide_fmt.shapes:
        if expected_types and sf.shape_type not in expected_types:
            continue
        dx = (sf.left - spec_x) if spec_x is not None else 0
        dy = (sf.top - spec_y) if spec_y is not None else 0
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < best_dist and dist < POSITION_TOLERANCE * 3:  # 0.9" max match distance
            best_dist = dist
            best_shape = sf

    return best_shape


def _check_cross_slide_consistency(profile, patterns_data: dict) -> List["Discrepancy"]:
    """Check cross-slide consistency of body font, sizes, margins, and spacing.

    Runs after per-slide checks. Uses style.fonts spec as ground truth.
    """
    discrepancies = []
    if not profile or not profile.slides:
        return discrepancies

    style = patterns_data.get("style", {})
    fonts = style.get("fonts", {})
    body_spec = fonts.get("body", {})
    expected_body_family = body_spec.get("family")
    expected_body_size = body_spec.get("size")

    # Collect stats from non-cover slides (skip slide 1)
    body_fonts = []
    body_sizes = []
    left_margins = []
    slide_vertical_gaps = []

    for sf in profile.slides:
        if sf.slide_number == 1:
            continue  # skip cover slide
        for shape in sf.shapes:
            if shape.shape_type not in ("text_box", "placeholder"):
                continue
            if shape.text_length == 0:
                continue
            # Skip title shapes (top < 0.8")
            if shape.top < 0.8:
                continue
            font = shape.dominant_font_name or shape.font_name
            if font:
                body_fonts.append(font)
            if shape.font_size_pt:
                body_sizes.append(shape.font_size_pt)
            if shape.left is not None:
                left_margins.append(round(shape.left, 1))

        # Vertical spacing between content shapes on this slide
        content_shapes = sorted(
            [s for s in sf.shapes if s.shape_type in ("text_box", "table", "placeholder")
             and s.top > 0.8 and s.height > 0],
            key=lambda s: s.top
        )
        for i in range(len(content_shapes) - 1):
            gap = content_shapes[i + 1].top - (content_shapes[i].top + content_shapes[i].height)
            slide_vertical_gaps.append(gap)

    # Body font family consistency
    if expected_body_family and body_fonts:
        from collections import Counter
        font_counts = Counter(body_fonts)
        wrong_font_count = sum(c for f, c in font_counts.items()
                               if f.lower() != expected_body_family.lower())
        if len(body_fonts) > 0 and wrong_font_count / len(body_fonts) > 0.2:
            top_wrong = [(f, c) for f, c in font_counts.most_common()
                         if f.lower() != expected_body_family.lower()]
            wrong_name = top_wrong[0][0] if top_wrong else "unknown"
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="inconsistent_body_font",
                location="Presentation-wide",
                expected=f"Body font: {expected_body_family} (style.fonts.body)",
                actual=f"{wrong_font_count}/{len(body_fonts)} body shapes use {wrong_name}",
                suggestion=f"Change fontFace to '{expected_body_family}' in all addText/addShape calls in ppt-utils.js.",
            ))

    # Body font size outliers
    if expected_body_size and body_sizes:
        outliers = [s for s in body_sizes if abs(s - expected_body_size) > 3]
        if len(body_sizes) > 0 and len(outliers) / len(body_sizes) > 0.15:
            discrepancies.append(Discrepancy(
                severity=Severity.MEDIUM,
                category="inconsistent_body_font_size",
                location="Presentation-wide",
                expected=f"Body fontSize: {expected_body_size}pt (style.fonts.body)",
                actual=f"{len(outliers)}/{len(body_sizes)} body shapes deviate >3pt from spec",
                suggestion=f"Normalize body fontSize to {expected_body_size} across all content slides.",
            ))

    # Left margin consistency (expected: 0.4" from template-patterns)
    expected_left = 0.4
    if left_margins:
        misaligned = [m for m in left_margins if abs(m - expected_left) > POSITION_TOLERANCE]
        if len(left_margins) > 0 and len(misaligned) / len(left_margins) > 0.2:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="inconsistent_left_margin",
                location="Presentation-wide",
                expected=f"Left margin: {expected_left}\" (from template-patterns.json)",
                actual=f"{len(misaligned)}/{len(left_margins)} shapes misaligned",
                suggestion=f"Set x: {expected_left} consistently in pptxgenjs addText/addShape calls.",
            ))

    # Vertical spacing consistency
    if slide_vertical_gaps:
        import statistics
        if len(slide_vertical_gaps) >= 3:
            try:
                stdev = statistics.stdev(slide_vertical_gaps)
                if stdev > 0.3:
                    discrepancies.append(Discrepancy(
                        severity=Severity.MEDIUM,
                        category="uneven_vertical_spacing",
                        location="Presentation-wide",
                        expected="Consistent vertical spacing between shapes (stdev <0.3\")",
                        actual=f"Vertical gap stdev={stdev:.2f}\"",
                        suggestion="Normalize y positions so gaps between shapes are consistent.",
                    ))
            except Exception:
                pass

    return discrepancies


def _check_footer_and_source(slide_fmt, patterns_data: dict) -> List["Discrepancy"]:
    """Validate source footnote and header line styling per slide."""
    discrepancies = []
    style = patterns_data.get("style", {})
    slide_loc = f"Slide {slide_fmt.slide_number}"

    # Source footnote: shapes at y > 6.5
    source_spec = style.get("sourceFootnote", {})
    expected_src_size = source_spec.get("fontSize")
    expected_src_color = source_spec.get("color")
    if expected_src_size or expected_src_color:
        for sf in slide_fmt.shapes:
            if sf.shape_type not in ("text_box", "placeholder"):
                continue
            if sf.top < 6.5:
                continue
            if sf.text_content and "source" in (sf.text_content or "").lower():
                if expected_src_size and sf.font_size_pt:
                    if abs(sf.font_size_pt - expected_src_size) > FONT_SIZE_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.LOW,
                            category="source_footnote_size",
                            location=slide_loc,
                            expected=f"Source footnote fontSize={expected_src_size}pt",
                            actual=f"Source footnote fontSize={sf.font_size_pt}pt",
                            suggestion=f"Set source footnote fontSize to {expected_src_size}.",
                        ))
                if expected_src_color and sf.font_color_hex:
                    dist = _hex_color_distance(expected_src_color, sf.font_color_hex)
                    if dist > COLOR_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.LOW,
                            category="source_footnote_color",
                            location=slide_loc,
                            expected=f"Source footnote color=#{expected_src_color}",
                            actual=f"Source footnote color=#{sf.font_color_hex}",
                            suggestion=f"Set source footnote color to '{expected_src_color}'.",
                        ))
                break  # only check first source-like shape

    # Header line color/thickness
    header_spec = style.get("headerLine", {})
    expected_line_color = header_spec.get("color")
    expected_line_thickness = header_spec.get("thickness")
    if expected_line_color or expected_line_thickness:
        for sf in slide_fmt.shapes:
            if sf.shape_type != "line":
                continue
            if not (0.5 <= sf.top <= 1.8):
                continue
            # This is a header line
            if expected_line_color and sf.border_color_hex:
                dist = _hex_color_distance(expected_line_color, sf.border_color_hex)
                if dist > COLOR_TOLERANCE:
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="header_line_color_mismatch",
                        location=slide_loc,
                        expected=f"Header line color=#{expected_line_color}",
                        actual=f"Header line color=#{sf.border_color_hex}",
                        suggestion=f"Set header line color to '{expected_line_color}' in pptxgenjs addShape('line').",
                    ))
            if expected_line_thickness and sf.border_width_pt:
                if abs(sf.border_width_pt - expected_line_thickness) > 1:
                    discrepancies.append(Discrepancy(
                        severity=Severity.MEDIUM,
                        category="header_line_thickness_mismatch",
                        location=slide_loc,
                        expected=f"Header line thickness={expected_line_thickness}pt",
                        actual=f"Header line thickness={sf.border_width_pt}pt",
                        suggestion=f"Set header line width to {expected_line_thickness} in pptxgenjs.",
                    ))
            break  # only check first header line


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


def _compare_slide_to_pattern(slide_fmt, pattern_name: str, pattern_spec: dict,
                              patterns_data: Optional[dict] = None) -> List["Discrepancy"]:
    """Compare a single slide against its pattern spec from template-patterns.json.

    Returns list of discrepancies found.
    """
    discrepancies = []
    elements = pattern_spec.get("elements", {})
    slide_loc = f"Slide {slide_fmt.slide_number}"
    style_data = (patterns_data or {}).get("style", {})

    # Helper: find shape by type
    def find_shapes_by_type(stype):
        return [sf for sf in slide_fmt.shapes if sf.shape_type == stype]

    # Helper: find title shape
    def find_title_shape():
        for sf in slide_fmt.shapes:
            if sf.text_content and sf.top < 0.8 and sf.font_size_pt and sf.font_size_pt >= 14:
                return sf
        return None

    # Helper: find nearest shape by position
    def find_nearest_shape(x, y, shape_types=None, max_dist=0.9):
        best, best_d = None, float("inf")
        for sf in slide_fmt.shapes:
            if shape_types and sf.shape_type not in shape_types:
                continue
            d = math.sqrt((sf.left - x) ** 2 + (sf.top - y) ** 2)
            if d < best_d and d < max_dist:
                best, best_d = sf, d
        return best

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

    # Check table presence, width, and cell styling
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

            # Table cell styling checks
            expected_hdr_fill = table_spec.get("headerFill") or table_spec.get("labelFill")
            if expected_hdr_fill and ts.table_header_fill_hex:
                dist = _hex_color_distance(expected_hdr_fill, ts.table_header_fill_hex)
                if dist > COLOR_TOLERANCE:
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="table_header_fill_mismatch",
                        location=slide_loc,
                        expected=f"Table header fill=#{expected_hdr_fill}",
                        actual=f"Table header fill=#{ts.table_header_fill_hex}",
                        suggestion=f"Set table header fill to '{expected_hdr_fill}' in addTable() options.",
                    ))

            expected_hdr_color = table_spec.get("headerColor") or table_spec.get("labelColor")
            if expected_hdr_color and ts.table_header_font_color_hex:
                dist = _hex_color_distance(expected_hdr_color, ts.table_header_font_color_hex)
                if dist > COLOR_TOLERANCE:
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="table_header_color_mismatch",
                        location=slide_loc,
                        expected=f"Table header text color=#{expected_hdr_color}",
                        actual=f"Table header text color=#{ts.table_header_font_color_hex}",
                        suggestion=f"Set table header text color to '{expected_hdr_color}' in addTable().",
                    ))

            expected_alt_fill = table_spec.get("altRowFill")
            if expected_alt_fill and ts.table_body_alt_row_fill_hex:
                dist = _hex_color_distance(expected_alt_fill, ts.table_body_alt_row_fill_hex)
                if dist > COLOR_TOLERANCE:
                    discrepancies.append(Discrepancy(
                        severity=Severity.MEDIUM,
                        category="table_alt_row_fill_mismatch",
                        location=slide_loc,
                        expected=f"Table alt row fill=#{expected_alt_fill}",
                        actual=f"Table alt row fill=#{ts.table_body_alt_row_fill_hex}",
                        suggestion=f"Set table alternating row fill to '{expected_alt_fill}'.",
                    ))

    # =====================================================================
    # DICT ELEMENT STYLE CHECKS — check each named element with style props
    # =====================================================================
    skip_elements = {"title", "sectionTitle", "countryTitle", "table", "chart",
                     "contentArea", "quadrants", "insightPanels", "rows",
                     "sectionItems", "chevronFlow", "comparisonSplit",
                     "annotations", "subVariations"}

    for elem_name, elem_spec in elements.items():
        if elem_name in skip_elements:
            continue
        if not isinstance(elem_spec, dict):
            continue
        # Only check elements that have style properties
        has_style = any(k in elem_spec for k in
                        ["fontSize", "color", "bold", "italic", "fill", "align", "lineSpacing"])
        if not has_style:
            continue

        matched_shape = _find_shape_for_element(slide_fmt, elem_name, elem_spec)
        if matched_shape:
            discrepancies.extend(
                _check_element_style(matched_shape, elem_spec, slide_loc, elem_name, style_data)
            )

    # =====================================================================
    # ARRAY ELEMENT CHECKS — quadrants, insightPanels, rows
    # =====================================================================

    # Quadrants (matrix_2x2)
    quadrants = elements.get("quadrants")
    if isinstance(quadrants, list):
        for i, q_spec in enumerate(quadrants):
            qx, qy = q_spec.get("x", 0), q_spec.get("y", 0)
            q_fill = q_spec.get("fill")
            matched = find_nearest_shape(qx, qy, {"text_box", "placeholder"})
            if matched and q_fill and matched.fill_color_hex:
                dist = _hex_color_distance(q_fill, matched.fill_color_hex)
                if dist > COLOR_TOLERANCE:
                    label = q_spec.get("label", f"quadrant_{i}")
                    discrepancies.append(Discrepancy(
                        severity=Severity.HIGH,
                        category="fill_color_mismatch",
                        location=slide_loc,
                        expected=f"Quadrant '{label}' fill=#{q_fill}",
                        actual=f"Quadrant fill=#{matched.fill_color_hex}",
                        suggestion=f"Set quadrant '{label}' fill to '{q_fill}' in addShape().",
                    ))

    # Insight panels (chart_insight_panels)
    insight_panels = elements.get("insightPanels")
    if isinstance(insight_panels, list):
        for i, panel in enumerate(insight_panels):
            blue_bar = panel.get("blueBar", {})
            bar_color = blue_bar.get("color")
            bar_x = blue_bar.get("x", panel.get("x", 0))
            bar_y = blue_bar.get("y", panel.get("y", 0))
            if bar_color:
                # Blue bars are narrow shapes — look for shapes near the position
                bar_shape = find_nearest_shape(bar_x, bar_y)
                if bar_shape and bar_shape.fill_color_hex:
                    dist = _hex_color_distance(bar_color, bar_shape.fill_color_hex)
                    if dist > COLOR_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.HIGH,
                            category="fill_color_mismatch",
                            location=slide_loc,
                            expected=f"Insight panel {i+1} bar color=#{bar_color}",
                            actual=f"Bar fill=#{bar_shape.fill_color_hex}",
                            suggestion=f"Set insight panel blue bar fill to '{bar_color}'.",
                        ))

    # Case study rows
    rows_spec = elements.get("rows")
    label_style = elements.get("labelStyle", {})
    content_style = elements.get("contentStyle", {})
    if isinstance(rows_spec, list) and (label_style or content_style):
        expected_label_fill = label_style.get("fill")
        expected_content_fill = content_style.get("fill")
        for i, row in enumerate(rows_spec):
            label_x = row.get("labelX", 0.4)
            label_y = row.get("y", 0)
            # Find label shape
            if expected_label_fill:
                label_shape = find_nearest_shape(label_x, label_y, {"text_box", "placeholder"})
                if label_shape and label_shape.fill_color_hex:
                    dist = _hex_color_distance(expected_label_fill, label_shape.fill_color_hex)
                    if dist > COLOR_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.HIGH,
                            category="fill_color_mismatch",
                            location=slide_loc,
                            expected=f"Row label fill=#{expected_label_fill}",
                            actual=f"Row {i+1} label fill=#{label_shape.fill_color_hex}",
                            suggestion=f"Set case study row label fill to '{expected_label_fill}'.",
                        ))
                        break  # one example is enough

    # =====================================================================
    # NESTED ELEMENT STYLE CHECKS — bulletPanel, chartLeft.chartTitle, etc.
    # =====================================================================

    # bulletPanel (chart_side_bullets)
    bullet_panel = elements.get("bulletPanel")
    if isinstance(bullet_panel, dict) and bullet_panel.get("x") is not None:
        bp_shape = find_nearest_shape(
            bullet_panel.get("x", 0), bullet_panel.get("y", 0),
            {"text_box", "placeholder"}
        )
        if bp_shape:
            # Check nested properties
            for prop, key in [("headerFontSize", "font_size_pt"), ("headerColor", "font_color_hex")]:
                expected = bullet_panel.get(prop)
                if not expected:
                    continue
                if prop.endswith("FontSize") and bp_shape.font_size_pt:
                    if abs(bp_shape.font_size_pt - expected) > FONT_SIZE_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.MEDIUM,
                            category="font_size_mismatch",
                            location=slide_loc,
                            expected=f"bulletPanel {prop}={expected}",
                            actual=f"bulletPanel fontSize={bp_shape.font_size_pt}",
                            suggestion=f"Set bulletPanel {prop} to {expected}.",
                        ))
                elif prop.endswith("Color") and bp_shape.font_color_hex:
                    dist = _hex_color_distance(expected, bp_shape.font_color_hex)
                    if dist > COLOR_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.HIGH,
                            category="font_color_mismatch",
                            location=slide_loc,
                            expected=f"bulletPanel {prop}=#{expected}",
                            actual=f"bulletPanel color=#{bp_shape.font_color_hex}",
                            suggestion=f"Set bulletPanel color to '{expected}'.",
                        ))

    # chartLeft/chartRight with nested chartTitle (dual_chart_financial)
    for chart_key in ("chartLeft", "chartRight"):
        chart_elem = elements.get(chart_key)
        if not isinstance(chart_elem, dict):
            continue
        chart_title_spec = chart_elem.get("chartTitle")
        if isinstance(chart_title_spec, dict):
            # chartTitle is displayed as text near the chart — find by position
            cx, cy = chart_elem.get("x", 0), chart_elem.get("y", 0)
            nearby_text = find_nearest_shape(cx, cy - 0.3, {"text_box", "placeholder"})
            if not nearby_text:
                nearby_text = find_nearest_shape(cx, cy, {"text_box", "placeholder"})
            if nearby_text:
                discrepancies.extend(
                    _check_element_style(nearby_text, chart_title_spec, slide_loc,
                                         f"{chart_key}.chartTitle", style_data)
                )

    # metricsRow (dual_chart_financial)
    metrics_spec = elements.get("metricsRow")
    if isinstance(metrics_spec, dict):
        metric_color = metrics_spec.get("metricValueColor")
        metric_size = metrics_spec.get("metricValueFontSize")
        if metric_color or metric_size:
            my = metrics_spec.get("y", 5.5)
            # Find shapes near metrics row y position
            metric_shapes = [sf for sf in slide_fmt.shapes
                             if sf.shape_type in ("text_box", "placeholder")
                             and abs(sf.top - my) < POSITION_TOLERANCE]
            for ms in metric_shapes[:3]:
                if metric_size and ms.font_size_pt:
                    if abs(ms.font_size_pt - metric_size) > FONT_SIZE_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.MEDIUM,
                            category="font_size_mismatch",
                            location=slide_loc,
                            expected=f"metricsRow valueFontSize={metric_size}",
                            actual=f"Metric fontSize={ms.font_size_pt}",
                            suggestion=f"Set metric value fontSize to {metric_size}.",
                        ))
                        break
                if metric_color and ms.font_color_hex:
                    dist = _hex_color_distance(metric_color, ms.font_color_hex)
                    if dist > COLOR_TOLERANCE:
                        discrepancies.append(Discrepancy(
                            severity=Severity.HIGH,
                            category="font_color_mismatch",
                            location=slide_loc,
                            expected=f"metricsRow valueColor=#{metric_color}",
                            actual=f"Metric color=#{ms.font_color_hex}",
                            suggestion=f"Set metric value color to '{metric_color}'.",
                        ))
                        break

    # Section divider background check (toc_divider)
    if pattern_name == "toc_divider" and hasattr(slide_fmt, 'background_fill_hex'):
        if slide_fmt.background_fill_hex:
            # toc_divider backgrounds are often navy
            section_items = elements.get("sectionItems", {})
            highlight_color = section_items.get("highlightColor")
            # Background should be a dark color if set — flag if unexpected
            # (Specific expected bg varies; only flag if clearly wrong)

    return discrepancies


def _count_regulations(text: str) -> int:
    """Count named regulations with years in text."""
    reg_keywords = r'(?:act|law|decree|regulation|ordinance|directive|plan|policy|code|standard)'
    pattern = (
        rf'\b{reg_keywords}\b.{{0,60}}?\b(?:19|20)\d{{2}}\b'
        rf'|\b(?:19|20)\d{{2}}\b.{{0,60}}?\b{reg_keywords}\b'
    )
    matches = re.findall(pattern, text.lower())
    return len(matches)


def _count_data_points(text: str) -> int:
    """Count quantified data points with units in text."""
    pattern = (
        r'(?:\$|US\$|€|£|¥|₹|฿|Rp\.?\s?)?'
        r'\d{1,3}(?:[,\.]\d{3})*(?:\.\d+)?'
        r'\s*'
        r'(?:%'
        r'|(?:billion|million|trillion|thousand'
        r'|bn|mn|B|M|K|T'
        r'|MW|GW|kW|TW|TWh|GWh|MWh|kWh'
        r'|mtoe|mtpa|bcm|bbl|tcf'
        r'|USD|JPY|EUR|GBP|THB|VND|IDR|PHP|SGD|MYR'
        r')\b)'
    )
    return len(re.findall(pattern, text, re.IGNORECASE))


def _count_companies(text: str) -> int:
    """Count distinct named companies in text. Requires ORIGINAL CASE text."""
    suffix_re = re.compile(
        r'([A-Z][A-Za-z\s&\.\-]{1,40}?'
        r'(?:Co\.|Corp\.?|Ltd\.?|Inc\.?|Group|Holdings|PLC|GmbH|SA|AG))(?:\b|[,.\s]|$)',
        re.DOTALL
    )
    suffixed = set(m.strip() for m in suffix_re.findall(text))

    acronym_re = re.compile(r'\b[A-Z]{3,}\b')
    non_company = {
        'CAGR','USD','EUR','JPY','GBP','THB','VND','IDR','GW','MW','TWH',
        'LNG','GDP','BOI','ISO','ESG','ESCO','TAM','SAM','IRR','ROI','EPC',
        'PPP','IPP','SPP','VSPP','API','CEO','CFO','COO','CTO','B2B','B2C',
        'THE','AND','FOR','BUT','NOT','ALL','ANY','WHO','HOW','WHY','HAS',
        'ASEAN','APEC','OECD','IMF','ADB',
    }
    acronyms = set(acronym_re.findall(text)) - non_company

    for sname in suffixed:
        acronyms -= {a for a in acronyms if a in sname}

    return len(suffixed) + len(acronyms)


# =============================================================================
# SECTION-AWARE SCORING FOR MARKET RESEARCH
# =============================================================================

MARKET_RESEARCH_SECTIONS = {
    "policy": {
        "divider_keywords": ["policy & regulation", "policy and regulation"],
        "checks": {
            "regulations": {"min": 3, "weight": 30},
            "data_points": {"min": 3, "weight": 10},
        },
        "min_slides": 2,
    },
    "market": {
        "divider_keywords": ["market overview"],
        "checks": {
            "data_points": {"min": 10, "weight": 40},
        },
        "min_slides": 3,
    },
    "competitive": {
        "divider_keywords": ["competitive landscape"],
        "checks": {
            "companies": {"min": 3, "weight": 30},
        },
        "min_slides": 2,
    },
    "strategic": {
        "divider_keywords": ["strategic analysis"],
        "checks": {
            "data_points": {"min": 3, "weight": 15},
        },
        "min_slides": 2,
    },
    "recommendations": {
        "divider_keywords": ["recommendation"],
        "checks": {},
        "min_slides": 2,
    },
}


def _assign_slides_to_sections(slides: List[Dict]) -> Dict[str, List[Dict]]:
    """Assign slides to sections based on section divider detection."""
    sections: Dict[str, List[Dict]] = {k: [] for k in MARKET_RESEARCH_SECTIONS}
    sections["preamble"] = []
    sections["appendix"] = []

    current_section = "preamble"

    for slide in slides:
        title = (slide.get("title") or "").lower()
        all_text = (slide.get("all_text") or "").lower()
        text_to_check = title or all_text[:200]

        # Check if this is a section divider
        matched_section = None
        for section_key, section_def in MARKET_RESEARCH_SECTIONS.items():
            for kw in section_def["divider_keywords"]:
                if kw in text_to_check:
                    matched_section = section_key
                    break
            if matched_section:
                break

        if matched_section:
            current_section = matched_section
            continue  # divider itself not added to section content

        if current_section in sections:
            sections[current_section].append(slide)

    return sections


def _score_section(section_key: str, slides: List[Dict], section_def: dict) -> tuple:
    """Score a section's content depth. Returns (score, max_score, failures, counts)."""
    combined_text = " ".join((s.get("all_text") or "") for s in slides)
    original_text = combined_text
    lower_text = combined_text.lower()

    score = 0
    max_score = 0
    failures = []
    counts = {}

    for check_name, check_def in section_def.get("checks", {}).items():
        weight = check_def.get("weight", 10)
        min_val = check_def["min"]
        max_score += weight

        if check_name == "regulations":
            count = _count_regulations(lower_text)
            counts["regulations"] = count
            if count >= min_val:
                score += weight
            elif count >= 1:
                score += weight // 2
            else:
                failures.append(f"Policy section: {count} named regulations (need >={min_val})")

        elif check_name == "data_points":
            count = _count_data_points(lower_text)
            counts["data_points"] = count
            if count >= min_val:
                score += weight
            elif count >= min_val // 3:
                score += weight // 2
            else:
                failures.append(f"{section_key.title()} section: {count} data points (need >={min_val})")

        elif check_name == "companies":
            count = _count_companies(original_text)
            counts["companies"] = count
            if count >= min_val:
                score += weight
            elif count >= 1:
                score += weight // 2
            else:
                failures.append(f"Competitive section: {count} named companies (need >={min_val})")

    min_slides = section_def.get("min_slides", 1)
    if len(slides) < min_slides:
        failures.append(f"{section_key.title()} section: only {len(slides)} slides (need >={min_slides})")

    return score, max_score, failures, counts


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

    # Tracking vars for market research scores (populated inside MR block)
    _mr_depth_score = None
    _mr_insight_score = None
    _mr_regulation_count = 0
    _mr_data_point_count = 0
    _mr_company_indicator_count = 0

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
    companies = pptx_analysis.get("companies", [])
    # A2: Skip company-specific checks when min_companies=0 (e.g., market research)
    if template.min_companies > 0:
        total_checks += 1
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
    else:
        # A2: min_companies=0 — skip all company checks, count as passed
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
    # MARKET RESEARCH: SECTION-AWARE CONTENT DEPTH SCORING
    # ==========================================================================

    _mr_section_scores = {}
    _mr_missing_sections = []

    if template.name == "Market Research Report":
        # Assign slides to sections based on divider detection
        section_map = _assign_slides_to_sections(slides)

        # Check section presence
        total_checks += 1
        sections_found = [k for k in MARKET_RESEARCH_SECTIONS if len(section_map.get(k, [])) > 0]
        sections_missing = [k for k in MARKET_RESEARCH_SECTIONS if len(section_map.get(k, [])) == 0]
        _mr_missing_sections = sections_missing

        if sections_missing:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="missing_sections",
                location="Presentation structure",
                expected=f"All 5 sections: {', '.join(MARKET_RESEARCH_SECTIONS.keys())}",
                actual=f"Missing: {', '.join(sections_missing)}. Found: {', '.join(sections_found) or 'none'}",
                suggestion=(
                    f"Missing section dividers or content for: {', '.join(sections_missing)}. "
                    "Each section needs a divider slide with the section title, followed by content slides."
                ),
            ))
        else:
            passed_checks += 1

        # Score each section
        total_checks += 1
        total_depth_score = 0
        total_max_score = 0
        all_depth_failures = []

        for section_key, section_def in MARKET_RESEARCH_SECTIONS.items():
            section_slides = section_map.get(section_key, [])
            score, max_score, failures, counts = _score_section(section_key, section_slides, section_def)
            total_depth_score += score
            total_max_score += max_score
            all_depth_failures.extend(failures)
            _mr_section_scores[section_key] = {
                "score": score, "max_score": max_score,
                "slide_count": len(section_slides), **counts,
            }

        # Extract per-section counts for backward compat
        _mr_depth_score = total_depth_score
        _mr_regulation_count = _mr_section_scores.get("policy", {}).get("regulations", 0)
        _mr_data_point_count = _mr_section_scores.get("market", {}).get("data_points", 0)
        _mr_company_indicator_count = _mr_section_scores.get("competitive", {}).get("companies", 0)

        if total_max_score > 0 and total_depth_score < total_max_score * 0.5:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="shallow_research_content",
                location="Per-section analysis",
                expected=f"Section depth score >={total_max_score * 0.5:.0f}/{total_max_score}",
                actual=f"Score: {total_depth_score}/{total_max_score}. {'; '.join(all_depth_failures)}",
                suggestion=(
                    "Research content is too shallow in specific sections: "
                    + "; ".join(all_depth_failures) + ". "
                    "Fix the research pipeline for the failing sections."
                ),
            ))
        else:
            passed_checks += 1

        # Insight quality scoring — scoped to Strategic + Recommendations sections
        total_checks += 1
        insight_sections_text = " ".join(
            (s.get("all_text") or "")
            for k in ("strategic", "recommendations")
            for s in section_map.get(k, [])
        ).lower()

        insight_keywords = [
            "implication", "opportunity", "barrier", "recommend",
            "should", "risk", "advantage", "critical", "timing",
            "window", "first mover", "competitive edge"
        ]
        INSIGHT_QUALITY_SIGNALS = [
            (r"\b(19|20)\d{2}\b", 1),
            (r"\$[\d,]+|\d+\s*(?:billion|million)", 2),
            (r"\d+(?:\.\d+)?%", 1),
            (r"(?:within|by|before)\s+\d{4}|(?:\d+[-\u2013]\d+)\s*months?", 2),
            (r"(?:should|must|recommend|advise)\s+\w+", 1),
            (r"(?:because|due to|driven by|as a result|therefore|consequently)", 2),
            (r"(?:however|but|despite|although|conversely)", 1),
        ]

        paragraphs = [p.strip() for p in insight_sections_text.split("\n") if len(p.strip()) > 30]
        insight_paragraphs = [p for p in paragraphs if any(kw in p for kw in insight_keywords)]

        para_scores = []
        best_data_excerpt = ""
        for para in insight_paragraphs:
            s = sum(w for pat, w in INSIGHT_QUALITY_SIGNALS if re.search(pat, para, re.IGNORECASE))
            para_scores.append(s)
            if s > 0 and not best_data_excerpt and len(para) < 200:
                best_data_excerpt = para[:150]

        avg_quality = sum(para_scores) / max(len(para_scores), 1)
        _mr_insight_score = round(avg_quality, 1)
        insight_count = len(insight_paragraphs)
        with_numbers = sum(1 for s in para_scores if s >= 2)
        with_timing = sum(1 for para in insight_paragraphs
                         if re.search(r"(?:within|by|before)\s+\d{4}|(?:\d+[-\u2013]\d+)\s*months?", para, re.IGNORECASE))

        if avg_quality < 4 or insight_count < 3:
            specifics = []
            if insight_count > 0:
                specifics.append(f"{with_numbers}/{insight_count} insight paragraphs contain numbers or dates")
                specifics.append(f"{with_timing}/{insight_count} contain timing windows")
            else:
                specifics.append("0 paragraphs contain insight language")
            suggestion = f"Insights lack specificity — {'; '.join(specifics)}. "
            if best_data_excerpt:
                suggestion += (
                    f"Example from THIS output: '{best_data_excerpt[:100]}...'\n"
                    f"A deep insight: '[data point] growing at X% suggests a Y-month window "
                    f"for first-mover advantage, because [regulation] takes effect in [year]'\n"
                )
            suggestion += "Every insight needs: 1) So what? (implication) 2) Now what? (action) 3) By when? (timing)"
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="missing_strategic_insights",
                location="Strategic + Recommendations sections",
                expected="Strategic insights with avg quality score >=4/10",
                actual=f"Insight quality: avg {avg_quality:.1f}/10, {insight_count} paragraphs, {with_numbers} with data",
                suggestion=suggestion,
            ))
        else:
            passed_checks += 1

        # Chart check — scoped to Market section
        total_checks += 1
        market_slides = section_map.get("market", [])
        chart_slides = sum(
            1 for slide in market_slides
            if any(kw in (slide.get("all_text", "") or "").lower()
                   for kw in ["chart", "figure", "graph", "source:"])
            or slide.get("has_chart", False)
            or slide.get("has_image", False)
            or slide.get("chart_count", 0) > 0
        )
        if chart_slides < 2:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="insufficient_data_visualization",
                location="Market Overview section",
                expected="At least 2 Market slides with charts/data visualizations",
                actual=f"Only {chart_slides} Market slides appear to have charts",
                suggestion=(
                    "Market section needs data visualization. Add charts for: "
                    "market size growth, energy mix, price trends, demand projections. "
                    "Use pptxgenjs addChart() with the pattern library."
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
                                slide_fmt, classified, patterns_dict[classified],
                                patterns_data=patterns_data,
                            )
                            slide_discrepancies.extend(slide_discs)

                        # Footer + source footnote + header line checks (all slides except cover)
                        if slide_fmt.slide_number > 1:
                            slide_discrepancies.extend(
                                _check_footer_and_source(slide_fmt, patterns_data)
                            )

                    if slide_discrepancies:
                        discrepancies.extend(slide_discrepancies)
                    else:
                        passed_checks += 1

                    # Cross-slide consistency checks
                    total_checks += 1
                    consistency_discs = _check_cross_slide_consistency(
                        out_profile_for_slides, patterns_data
                    )
                    if consistency_discs:
                        discrepancies.extend(consistency_discs)
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

    # Populate market research scores on result
    result.content_depth_score = _mr_depth_score
    result.insight_score = _mr_insight_score
    result.regulation_count = _mr_regulation_count
    result.data_point_count = _mr_data_point_count
    result.company_indicator_count = _mr_company_indicator_count
    result.section_scores = _mr_section_scores
    result.missing_sections = _mr_missing_sections

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
