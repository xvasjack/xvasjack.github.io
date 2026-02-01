"""
Template Comparison System

Compares actual output (PPT/Excel) against expected templates/criteria.
Generates specific, actionable feedback for Claude Code to fix.
"""

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

    def generate_claude_code_prompt(self) -> str:
        """Generate a prompt for Claude Code to fix the issues"""
        if not self.discrepancies:
            return "No issues found. Output matches template."

        # Group by severity
        critical = [d for d in self.discrepancies if d.severity == Severity.CRITICAL]
        high = [d for d in self.discrepancies if d.severity == Severity.HIGH]
        medium = [d for d in self.discrepancies if d.severity == Severity.MEDIUM]

        prompt = f"""Fix the following issues in the output generation code:

Output file: {self.output_file}
Template: {self.template_name}
Total issues: {len(self.discrepancies)} ({self.critical_count} critical, {self.high_count} high)

"""

        if critical:
            prompt += "## CRITICAL ISSUES (must fix)\n\n"
            for d in critical:
                prompt += f"- **{d.category}** at {d.location}\n"
                prompt += f"  - Expected: {d.expected}\n"
                prompt += f"  - Actual: {d.actual}\n"
                prompt += f"  - Fix: {d.suggestion}\n\n"

        if high:
            prompt += "## HIGH PRIORITY ISSUES\n\n"
            for d in high:
                prompt += f"- **{d.category}** at {d.location}\n"
                prompt += f"  - Expected: {d.expected}\n"
                prompt += f"  - Actual: {d.actual}\n"
                prompt += f"  - Fix: {d.suggestion}\n\n"

        if medium:
            prompt += "## MEDIUM PRIORITY ISSUES\n\n"
            for d in medium[:5]:  # Limit to top 5
                prompt += f"- {d.category} at {d.location}: {d.suggestion}\n"

        prompt += """
Please:
1. Identify the root cause in the code
2. Fix all critical and high priority issues
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

    # Expected slide structure
    expected_slides: List[Dict[str, Any]] = field(default_factory=list)

    # Required fields per company
    required_company_fields: List[str] = field(default_factory=lambda: [
        "name", "website", "description"
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
    ),

    "market-research": PPTTemplate(
        name="Market Research Report",
        min_slides=10,
        max_slides=40,
        min_companies=10,
        require_logos=False,  # Market research may not have logos
        require_websites=True,
        require_descriptions=True,
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
        website = company.get("website", "")
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
