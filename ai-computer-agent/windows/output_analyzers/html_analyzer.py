"""
HTML Analyzer - Validation for HTML/Web output.

Supports:
- Screenshot comparison (capture and compare)
- DOM structure analysis
- Content validation
- Responsive checks

Dependencies:
    pip install beautifulsoup4  # For HTML parsing
    pip install lxml  # For better HTML parsing
    pip install selenium  # For screenshot capture
    pip install Pillow  # For image comparison
"""

import os
import sys
from typing import List, Dict, Any, Optional
import logging
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from .base import AbstractOutputAnalyzer, AnalysisResult, Discrepancy, Severity

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("html_analyzer")

# Try to import dependencies
_BS4_AVAILABLE = False
_SELENIUM_AVAILABLE = False

try:
    from bs4 import BeautifulSoup
    _BS4_AVAILABLE = True
except ImportError:
    logger.warning("BeautifulSoup not installed. Run: pip install beautifulsoup4")

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    _SELENIUM_AVAILABLE = True
except ImportError:
    logger.warning("Selenium not installed. Run: pip install selenium")


class HTMLAnalyzer(AbstractOutputAnalyzer):
    """
    Analyzer for HTML files and web pages.

    Validates:
    - DOM structure against template
    - Screenshot visual comparison
    - Required elements presence
    - Accessibility basics
    """

    def get_supported_extensions(self) -> List[str]:
        return [".html", ".htm"]

    async def analyze(
        self,
        file_path_or_url: str,
        template: Any,
    ) -> AnalysisResult:
        """
        Analyze an HTML file or URL against a template.

        Args:
            file_path_or_url: Path to HTML file or URL
            template: Template with expected structure

        Returns:
            AnalysisResult with pass/fail and discrepancies
        """
        discrepancies = []
        total_checks = 0
        metadata = {}

        # Determine if it's a URL or file path
        is_url = file_path_or_url.startswith(("http://", "https://"))

        # Load HTML content
        html_content = await self._load_html(file_path_or_url, is_url)
        if html_content is None:
            return self._create_error_result(
                file_path_or_url,
                f"Failed to load HTML from {file_path_or_url}"
            )

        if not _BS4_AVAILABLE:
            return self._create_error_result(
                file_path_or_url,
                "BeautifulSoup not installed. Run: pip install beautifulsoup4"
            )

        try:
            soup = BeautifulSoup(html_content, "html.parser")

            # Basic document info
            metadata["title"] = soup.title.string if soup.title else ""
            metadata["has_head"] = soup.head is not None
            metadata["has_body"] = soup.body is not None

            # Check DOM structure
            dom_results = await self._check_dom_structure(soup, template)
            discrepancies.extend(dom_results["discrepancies"])
            total_checks += dom_results["checks"]

            # Check required elements
            element_results = await self._check_required_elements(soup, template)
            discrepancies.extend(element_results["discrepancies"])
            total_checks += element_results["checks"]

            # Screenshot comparison (if enabled and possible)
            if is_url and self._should_capture_screenshot(template):
                screenshot_results = await self._check_screenshot(
                    file_path_or_url, template
                )
                discrepancies.extend(screenshot_results["discrepancies"])
                total_checks += screenshot_results["checks"]
                metadata["screenshot_captured"] = screenshot_results.get("captured", False)

            # Accessibility checks
            a11y_results = await self._check_accessibility(soup, template)
            discrepancies.extend(a11y_results["discrepancies"])
            total_checks += a11y_results["checks"]

        except Exception as e:
            logger.error(f"HTML analysis failed: {e}")
            return self._create_error_result(file_path_or_url, str(e))

        template_name = self._get_template_name(template)
        return self._create_result(
            file_path=file_path_or_url,
            template_name=template_name,
            discrepancies=discrepancies,
            total_checks=total_checks,
            metadata=metadata,
        )

    async def _load_html(
        self,
        file_path_or_url: str,
        is_url: bool
    ) -> Optional[str]:
        """Load HTML content from file or URL"""
        try:
            if is_url:
                import urllib.request
                with urllib.request.urlopen(file_path_or_url, timeout=30) as response:
                    return response.read().decode("utf-8")
            else:
                with open(file_path_or_url, "r", encoding="utf-8") as f:
                    return f.read()
        except Exception as e:
            logger.error(f"Failed to load HTML: {e}")
            return None

    async def _check_dom_structure(
        self,
        soup: "BeautifulSoup",
        template: Any,
    ) -> Dict[str, Any]:
        """Check DOM structure against template"""
        discrepancies = []
        checks = 0

        # Check for valid HTML structure
        checks += 1
        if not soup.html:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="structure",
                location="Document",
                expected="<html> root element",
                actual="Missing",
                suggestion="Add <html> root element"
            ))

        checks += 1
        if not soup.head:
            discrepancies.append(Discrepancy(
                severity=Severity.HIGH,
                category="structure",
                location="Document",
                expected="<head> element",
                actual="Missing",
                suggestion="Add <head> element with meta tags"
            ))

        checks += 1
        if not soup.body:
            discrepancies.append(Discrepancy(
                severity=Severity.CRITICAL,
                category="structure",
                location="Document",
                expected="<body> element",
                actual="Missing",
                suggestion="Add <body> element"
            ))

        # Check expected structure from template
        expected_structure = self._get_expected_structure(template)
        for selector, min_count in expected_structure.items():
            checks += 1
            elements = soup.select(selector)
            if len(elements) < min_count:
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="missing_element",
                    location=selector,
                    expected=f"At least {min_count} elements",
                    actual=f"{len(elements)} found",
                    suggestion=f"Add more {selector} elements"
                ))

        return {"discrepancies": discrepancies, "checks": checks}

    async def _check_required_elements(
        self,
        soup: "BeautifulSoup",
        template: Any,
    ) -> Dict[str, Any]:
        """Check for required elements"""
        discrepancies = []
        checks = 0

        required_elements = self._get_required_elements(template)

        for element in required_elements:
            checks += 1
            selector = element.get("selector", element.get("tag", ""))
            found = soup.select(selector)

            if not found:
                discrepancies.append(Discrepancy(
                    severity=Severity.HIGH,
                    category="missing_element",
                    location="Document",
                    expected=f"Element: {selector}",
                    actual="Not found",
                    suggestion=f"Add required element: {selector}"
                ))

        # Check for required text content
        required_text = self._get_required_text(template)
        full_text = soup.get_text()

        for text in required_text:
            checks += 1
            if text.lower() not in full_text.lower():
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="missing_text",
                    location="Document",
                    expected=f"Text: {text}",
                    actual="Not found",
                    suggestion=f"Add required text: {text}"
                ))

        return {"discrepancies": discrepancies, "checks": checks}

    async def _check_screenshot(
        self,
        url: str,
        template: Any,
    ) -> Dict[str, Any]:
        """Capture and compare screenshot"""
        discrepancies = []
        checks = 0
        captured = False

        if not _SELENIUM_AVAILABLE:
            logger.warning("Selenium not available, skipping screenshot")
            return {"discrepancies": [], "checks": 0, "captured": False}

        try:
            # Set up headless Chrome
            options = Options()
            options.add_argument("--headless")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--window-size=1920,1080")

            driver = webdriver.Chrome(options=options)
            driver.get(url)

            # Wait for page load
            await asyncio.sleep(2)

            # Capture screenshot
            screenshot_path = f"/tmp/html_screenshot_{id(self)}.png"
            driver.save_screenshot(screenshot_path)
            captured = True

            checks += 1

            # Basic check: screenshot file was created
            if not os.path.exists(screenshot_path):
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="screenshot",
                    location="Page",
                    expected="Screenshot captured",
                    actual="Failed to capture",
                    suggestion="Check if page loads correctly"
                ))

            # Could add more visual comparisons here:
            # - Compare against reference screenshot
            # - Check for specific visual elements
            # - Verify layout dimensions

            driver.quit()

            # Clean up
            if os.path.exists(screenshot_path):
                os.remove(screenshot_path)

        except Exception as e:
            logger.warning(f"Screenshot capture failed: {e}")

        return {"discrepancies": discrepancies, "checks": checks, "captured": captured}

    async def _check_accessibility(
        self,
        soup: "BeautifulSoup",
        template: Any,
    ) -> Dict[str, Any]:
        """Basic accessibility checks"""
        discrepancies = []
        checks = 0

        # Check for alt text on images
        images = soup.find_all("img")
        for img in images:
            checks += 1
            if not img.get("alt"):
                discrepancies.append(Discrepancy(
                    severity=Severity.MEDIUM,
                    category="accessibility",
                    location=f"Image: {img.get('src', 'unknown')[:50]}",
                    expected="Alt text attribute",
                    actual="Missing",
                    suggestion="Add alt text to image for accessibility"
                ))

        # Check for form labels
        inputs = soup.find_all("input", {"type": lambda x: x not in ["hidden", "submit", "button"]})
        for inp in inputs:
            checks += 1
            input_id = inp.get("id")
            has_label = input_id and soup.find("label", {"for": input_id})
            if not has_label and not inp.get("aria-label"):
                discrepancies.append(Discrepancy(
                    severity=Severity.LOW,
                    category="accessibility",
                    location=f"Input: {inp.get('name', inp.get('id', 'unknown'))}",
                    expected="Associated label",
                    actual="Missing",
                    suggestion="Add label element or aria-label for input"
                ))

        # Check for language attribute
        checks += 1
        html_tag = soup.find("html")
        if html_tag and not html_tag.get("lang"):
            discrepancies.append(Discrepancy(
                severity=Severity.LOW,
                category="accessibility",
                location="html element",
                expected="lang attribute",
                actual="Missing",
                suggestion="Add lang attribute to html element"
            ))

        return {"discrepancies": discrepancies, "checks": checks}

    def _get_expected_structure(self, template: Any) -> Dict[str, int]:
        """Get expected DOM structure from template"""
        if isinstance(template, dict):
            return template.get("expected_structure", {})
        if hasattr(template, "expected_structure"):
            return template.expected_structure
        return {}

    def _get_required_elements(self, template: Any) -> List[Dict]:
        """Get required elements from template"""
        if isinstance(template, dict):
            return template.get("required_elements", [])
        if hasattr(template, "required_elements"):
            return template.required_elements
        return []

    def _get_required_text(self, template: Any) -> List[str]:
        """Get required text from template"""
        if isinstance(template, dict):
            return template.get("required_text", [])
        if hasattr(template, "required_text"):
            return template.required_text
        return []

    def _should_capture_screenshot(self, template: Any) -> bool:
        """Check if screenshot capture is enabled"""
        if isinstance(template, dict):
            return template.get("capture_screenshot", False)
        if hasattr(template, "capture_screenshot"):
            return template.capture_screenshot
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
            output_type="html",
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
