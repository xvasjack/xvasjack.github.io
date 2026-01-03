"""
PowerPoint Reader - Analyze PPTX files for quality checking.

This module extracts:
- Slide count and titles
- Company names and information
- Logo presence
- Website links
- Text content for analysis
"""

import os
import re
from typing import List, Optional, Dict, Any
from dataclasses import dataclass, field
import logging

try:
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.enum.shapes import MSO_SHAPE_TYPE
except ImportError:
    print("Missing python-pptx. Run: pip install python-pptx")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pptx_reader")


@dataclass
class SlideInfo:
    number: int
    title: Optional[str]
    text_content: List[str]
    has_image: bool
    has_table: bool
    links: List[str]


@dataclass
class CompanyInfo:
    name: str
    website: Optional[str] = None
    description: Optional[str] = None
    has_logo: bool = False
    slide_number: int = 0


@dataclass
class PPTXAnalysis:
    file_path: str
    slide_count: int
    slides: List[SlideInfo] = field(default_factory=list)
    companies: List[CompanyInfo] = field(default_factory=list)
    total_images: int = 0
    total_links: int = 0
    issues: List[str] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "file_path": self.file_path,
            "slide_count": self.slide_count,
            "company_count": len(self.companies),
            "total_images": self.total_images,
            "total_links": self.total_links,
            "issues": self.issues,
            "summary": self.summary,
            "companies": [
                {
                    "name": c.name,
                    "website": c.website,
                    "has_logo": c.has_logo,
                }
                for c in self.companies
            ]
        }


def analyze_pptx(file_path: str) -> PPTXAnalysis:
    """
    Analyze a PowerPoint file and extract relevant information.

    Args:
        file_path: Path to the PPTX file

    Returns:
        PPTXAnalysis with extracted information
    """
    logger.info(f"Analyzing PPTX: {file_path}")

    if not os.path.exists(file_path):
        return PPTXAnalysis(
            file_path=file_path,
            slide_count=0,
            issues=["File not found"],
            summary="Error: File not found"
        )

    try:
        prs = Presentation(file_path)
    except Exception as e:
        return PPTXAnalysis(
            file_path=file_path,
            slide_count=0,
            issues=[f"Could not open file: {e}"],
            summary=f"Error opening file: {e}"
        )

    analysis = PPTXAnalysis(
        file_path=file_path,
        slide_count=len(prs.slides),
    )

    total_images = 0
    total_links = 0
    companies = []

    for idx, slide in enumerate(prs.slides, 1):
        slide_info = extract_slide_info(slide, idx)
        analysis.slides.append(slide_info)

        total_images += 1 if slide_info.has_image else 0
        total_links += len(slide_info.links)

        # Try to extract company info from slide
        company = extract_company_from_slide(slide, idx)
        if company:
            companies.append(company)

    analysis.total_images = total_images
    analysis.total_links = total_links
    analysis.companies = companies

    # Check for issues
    analysis.issues = check_quality_issues(analysis)

    # Generate summary
    analysis.summary = generate_summary(analysis)

    return analysis


def extract_slide_info(slide, slide_number: int) -> SlideInfo:
    """Extract information from a single slide"""

    title = None
    text_content = []
    has_image = False
    has_table = False
    links = []

    for shape in slide.shapes:
        # Get title
        if shape.has_text_frame:
            if shape.is_placeholder and hasattr(shape, 'placeholder_format'):
                if shape.placeholder_format.type == 1:  # Title placeholder
                    title = shape.text.strip()

            # Get all text
            for paragraph in shape.text_frame.paragraphs:
                text = paragraph.text.strip()
                if text:
                    text_content.append(text)

                # Check for hyperlinks
                for run in paragraph.runs:
                    if run.hyperlink and run.hyperlink.address:
                        links.append(run.hyperlink.address)

        # Check for images
        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            has_image = True

        # Check for tables
        if shape.has_table:
            has_table = True

    return SlideInfo(
        number=slide_number,
        title=title,
        text_content=text_content,
        has_image=has_image,
        has_table=has_table,
        links=links,
    )


def extract_company_from_slide(slide, slide_number: int) -> Optional[CompanyInfo]:
    """Try to extract company information from a slide"""

    texts = []
    has_image = False
    links = []

    for shape in slide.shapes:
        if shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                text = paragraph.text.strip()
                if text:
                    texts.append(text)

                for run in paragraph.runs:
                    if run.hyperlink and run.hyperlink.address:
                        links.append(run.hyperlink.address)

        if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
            has_image = True

    if not texts:
        return None

    # First non-empty text is usually company name
    company_name = texts[0] if texts else None

    if not company_name or len(company_name) < 2:
        return None

    # Find website
    website = None
    for link in links:
        if link.startswith("http"):
            website = link
            break

    # Look for website in text
    if not website:
        for text in texts:
            url_match = re.search(r'https?://[^\s]+', text)
            if url_match:
                website = url_match.group()
                break
            # Check for domain pattern
            domain_match = re.search(r'www\.[^\s]+\.[^\s]+', text)
            if domain_match:
                website = "https://" + domain_match.group()
                break

    # Description is usually second text block
    description = texts[1] if len(texts) > 1 else None

    return CompanyInfo(
        name=company_name,
        website=website,
        description=description,
        has_logo=has_image,
        slide_number=slide_number,
    )


def check_quality_issues(analysis: PPTXAnalysis) -> List[str]:
    """Check for quality issues in the presentation"""

    issues = []

    # Check slide count
    if analysis.slide_count < 5:
        issues.append(f"Low slide count: only {analysis.slide_count} slides")

    # Check company count
    if len(analysis.companies) < 10:
        issues.append(f"Low company count: only {len(analysis.companies)} companies found")

    # Check for companies without logos
    no_logo_companies = [c for c in analysis.companies if not c.has_logo]
    if no_logo_companies:
        issues.append(f"{len(no_logo_companies)} companies without logos")

    # Check for companies without websites
    no_website_companies = [c for c in analysis.companies if not c.website]
    if no_website_companies:
        issues.append(f"{len(no_website_companies)} companies without websites")

    # Check for empty slides
    empty_slides = [s for s in analysis.slides if not s.text_content]
    if empty_slides:
        issues.append(f"{len(empty_slides)} empty slides")

    # Check for broken links (basic validation)
    for company in analysis.companies:
        if company.website:
            if not company.website.startswith("http"):
                issues.append(f"Invalid URL for {company.name}: {company.website}")

    return issues


def generate_summary(analysis: PPTXAnalysis) -> str:
    """Generate a summary of the analysis"""

    companies_with_logos = sum(1 for c in analysis.companies if c.has_logo)
    companies_with_websites = sum(1 for c in analysis.companies if c.website)

    summary = f"""PPTX Analysis Summary:
- File: {os.path.basename(analysis.file_path)}
- Slides: {analysis.slide_count}
- Companies found: {len(analysis.companies)}
- Companies with logos: {companies_with_logos}
- Companies with websites: {companies_with_websites}
- Total images: {analysis.total_images}
- Issues found: {len(analysis.issues)}

Issues:
{chr(10).join('- ' + issue for issue in analysis.issues) if analysis.issues else '- None'}

Top companies:
{chr(10).join(f'- {c.name} ({c.website or "no website"})' for c in analysis.companies[:5])}
"""

    return summary


def validate_company_links(analysis: PPTXAnalysis) -> Dict[str, bool]:
    """
    Validate that company website links are accessible.
    Returns dict of {company_name: is_valid}

    Note: This does actual HTTP requests, use sparingly.
    """
    import urllib.request
    import urllib.error

    results = {}

    for company in analysis.companies:
        if not company.website:
            results[company.name] = False
            continue

        try:
            req = urllib.request.Request(
                company.website,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            response = urllib.request.urlopen(req, timeout=10)
            results[company.name] = response.status == 200
        except (urllib.error.URLError, urllib.error.HTTPError, Exception):
            results[company.name] = False

    return results


# =============================================================================
# COMPARISON FUNCTIONS
# =============================================================================


def compare_analyses(old: PPTXAnalysis, new: PPTXAnalysis) -> Dict[str, Any]:
    """
    Compare two PPTX analyses to see if issues were fixed.

    Returns dict with comparison results.
    """
    old_companies = {c.name for c in old.companies}
    new_companies = {c.name for c in new.companies}

    return {
        "slide_count_change": new.slide_count - old.slide_count,
        "company_count_change": len(new.companies) - len(old.companies),
        "companies_added": list(new_companies - old_companies),
        "companies_removed": list(old_companies - new_companies),
        "old_issues": old.issues,
        "new_issues": new.issues,
        "issues_fixed": [i for i in old.issues if i not in new.issues],
        "new_issues_introduced": [i for i in new.issues if i not in old.issues],
        "improved": len(new.issues) < len(old.issues),
    }


# =============================================================================
# ENTRY POINT
# =============================================================================


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python pptx_reader.py <file.pptx>")
        sys.exit(1)

    analysis = analyze_pptx(sys.argv[1])
    print(analysis.summary)
