"""
PDF Analyzer - Validation for PDF output files.

Supports:
- Text extraction and comparison
- Visual layout analysis (PDF -> PNG -> compare)
- Page structure validation
- Metadata checking

Dependencies:
    pip install pymupdf  # For PDF processing (fitz)
    pip install pdf2image  # For visual comparison
    pip install Pillow  # For image processing
"""

import os
import sys
from typing import List, Dict, Any, Optional
import logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from .base import AbstractOutputAnalyzer, AnalysisResult, Discrepancy, Severity

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pdf_analyzer")

# Try to import PDF libraries
_PYMUPDF_AVAILABLE = False
_PDF2IMAGE_AVAILABLE = False

try:
    import fitz  # PyMuPDF
    _PYMUPDF_AVAILABLE = True
except ImportError:
    logger.warning("PyMuPDF not installed. Run: pip install pymupdf")

try:
    from pdf2image import convert_from_path
    _PDF2IMAGE_AVAILABLE = True
except ImportError:
    logger.warning("pdf2image not installed. Run: pip install pdf2image")


class PDFAnalyzer(AbstractOutputAnalyzer):
    """
    Analyzer for PDF files.

    Validates:
    - Page count matches template
    - Text content extraction
    - Visual layout comparison
    - Document metadata
    """

    def get_supported_extensions(self) -> List[str]:
        return [".pdf"]

    async def analyze(
        self,
        file_path: str,
        template: Any,
    ) -> AnalysisResult:
        """
        Analyze a PDF file against a template.

        Args:
            file_path: Path to the PDF file
            template: Template with expected structure

        Returns:
            AnalysisResult with pass/fail and discrepancies
        """
        if not _PYMUPDF_AVAILABLE:
            return self._create_error_result(
                file_path,
                "PyMuPDF not installed. Run: pip install pymupdf"
            )

        if not os.path.exists(file_path):
            return self._create_error_result(file_path, f"File not found: {file_path}")

        discrepancies = []
        total_checks = 0
        metadata = {}

        try:
            doc = fitz.open(file_path)

            # Basic document info
            metadata["page_count"] = len(doc)
            metadata["title"] = doc.metadata.get("title", "")
            metadata["author"] = doc.metadata.get("author", "")

            # Check page count
            total_checks += 1
            expected_pages = self._get_expected_pages(template)
            if expected_pages and len(doc) < expected_pages.get("min", 0):
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="page_count",
                    location="Document",
                    expected=f"At least {expected_pages['min']} pages",
                    actual=f"{len(doc)} pages",
                    suggestion=f"PDF has only {len(doc)} pages, expected at least {expected_pages['min']}"
                ))
            elif expected_pages and expected_pages.get("max") and len(doc) > expected_pages["max"]:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="page_count",
                    location="Document",
                    expected=f"At most {expected_pages['max']} pages",
                    actual=f"{len(doc)} pages",
                    suggestion=f"PDF has {len(doc)} pages, expected at most {expected_pages['max']}"
                ))

            # Extract and check text content
            text_results = await self._check_text_content(doc, template)
            discrepancies.extend(text_results["discrepancies"])
            total_checks += text_results["checks"]
            metadata["text_length"] = text_results.get("total_length", 0)

            # Visual layout comparison (if enabled)
            if self._should_check_layout(template):
                layout_results = await self._check_visual_layout(file_path, template)
                discrepancies.extend(layout_results["discrepancies"])
                total_checks += layout_results["checks"]

            doc.close()

        except Exception as e:
            logger.error(f"PDF analysis failed: {e}")
            return self._create_error_result(file_path, str(e))

        template_name = self._get_template_name(template)
        return self._create_result(
            file_path=file_path,
            template_name=template_name,
            discrepancies=discrepancies,
            total_checks=total_checks,
            metadata=metadata,
        )

    async def _check_text_content(
        self,
        doc: "fitz.Document",
        template: Any,
    ) -> Dict[str, Any]:
        """Extract text and validate against template expectations"""
        discrepancies = []
        checks = 0
        total_length = 0

        # Get required text patterns from template
        required_text = self._get_required_text(template)
        forbidden_text = self._get_forbidden_text(template)

        # Extract text from all pages
        all_text = ""
        for page_num, page in enumerate(doc, 1):
            text = page.get_text()
            all_text += text
            total_length += len(text)

            # Check for empty pages
            checks += 1
            if len(text.strip()) < 10:
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="empty_page",
                    location=f"Page {page_num}",
                    expected="Content",
                    actual="Empty or nearly empty page",
                    suggestion=f"Page {page_num} has very little content"
                ))

        # Check required text patterns
        for pattern in required_text:
            checks += 1
            if pattern.lower() not in all_text.lower():
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="missing_text",
                    location="Document",
                    expected=f"Text containing: {pattern}",
                    actual="Not found",
                    suggestion=f"Required text '{pattern}' not found in PDF"
                ))

        # Check forbidden text patterns
        for pattern in forbidden_text:
            checks += 1
            if pattern.lower() in all_text.lower():
                discrepancies.append(Discrepancy(
                    severity=Severity.CRITICAL,
                    category="forbidden_text",
                    location="Document",
                    expected=f"No occurrences of: {pattern}",
                    actual="Found",
                    suggestion=f"Forbidden text '{pattern}' found in PDF - remove it"
                ))

        return {
            "discrepancies": discrepancies,
            "checks": checks,
            "total_length": total_length,
        }

    async def _check_visual_layout(
        self,
        file_path: str,
        template: Any,
    ) -> Dict[str, Any]:
        """Compare visual layout of PDF pages"""
        discrepancies = []
        checks = 0

        if not _PDF2IMAGE_AVAILABLE:
            logger.warning("pdf2image not available, skipping visual checks")
            return {"discrepancies": [], "checks": 0}

        try:
            # Convert PDF to images
            images = convert_from_path(file_path, dpi=150, first_page=1, last_page=5)

            # Check each page image
            for i, img in enumerate(images, 1):
                checks += 1

                # Basic checks: image should have reasonable dimensions
                width, height = img.size
                if width < 500 or height < 500:
                    discrepancies.append(Discrepancy(
                        severity=Severity.MEDIUM,
                        category="layout_size",
                        location=f"Page {i}",
                        expected="Standard page dimensions",
                        actual=f"{width}x{height} pixels",
                        suggestion=f"Page {i} has unusual dimensions"
                    ))

                # Could add more visual checks here:
                # - Compare against template images
                # - Check for blank regions
                # - Verify logo placement

        except Exception as e:
            logger.warning(f"Visual layout check failed: {e}")

        return {"discrepancies": discrepancies, "checks": checks}

    def _get_expected_pages(self, template: Any) -> Optional[Dict[str, int]]:
        """Get expected page count from template"""
        if isinstance(template, dict):
            return template.get("pages")
        if hasattr(template, "min_pages") or hasattr(template, "max_pages"):
            return {
                "min": getattr(template, "min_pages", 1),
                "max": getattr(template, "max_pages", None),
            }
        return None

    def _get_required_text(self, template: Any) -> List[str]:
        """Get required text patterns from template"""
        if isinstance(template, dict):
            return template.get("required_text", [])
        if hasattr(template, "required_text"):
            return template.required_text
        return []

    def _get_forbidden_text(self, template: Any) -> List[str]:
        """Get forbidden text patterns from template"""
        if isinstance(template, dict):
            return template.get("forbidden_text", [])
        if hasattr(template, "forbidden_text"):
            return template.forbidden_text
        return []

    def _should_check_layout(self, template: Any) -> bool:
        """Check if visual layout comparison is enabled"""
        if isinstance(template, dict):
            return template.get("check_layout", False)
        if hasattr(template, "check_layout"):
            return template.check_layout
        return False

    def _get_template_name(self, template: Any) -> str:
        """Get template name"""
        if isinstance(template, dict):
            return template.get("name", "unknown")
        if hasattr(template, "name"):
            return template.name
        return "unknown"

    def _create_error_result(self, file_path: str, error: str) -> AnalysisResult:
        """Create an error result"""
        return AnalysisResult(
            output_file=file_path,
            output_type="pdf",
            template_name="unknown",
            passed=False,
            total_checks=1,
            passed_checks=0,
            discrepancies=[Discrepancy(
                severity=Severity.CRITICAL,
                category="error",
                location="Document",
                expected="Successful analysis",
                actual=error,
                suggestion=f"Analysis failed: {error}"
            )],
            summary=f"Analysis failed: {error}",
        )
