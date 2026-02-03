"""
Abstract Output Analyzer - Base interface for all output analyzers.

All analyzers must implement:
- analyze(): Compare output against template
- get_supported_extensions(): List of file extensions handled
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("output_analyzer")


class Severity(Enum):
    """Issue severity levels"""
    CRITICAL = "critical"  # Must fix - blocks release
    HIGH = "high"          # Should fix - significant quality issue
    MEDIUM = "medium"      # Nice to fix - noticeable issue
    LOW = "low"            # Minor - cosmetic or edge case


@dataclass
class Discrepancy:
    """A single discrepancy found during analysis"""
    severity: Severity
    category: str          # e.g., "missing_data", "format_error", "formula_error"
    location: str          # e.g., "Slide 3", "Sheet 'Data' Row 15", "Page 2"
    expected: str
    actual: str
    suggestion: str        # Actionable fix for Claude Code

    def to_dict(self) -> Dict[str, Any]:
        return {
            "severity": self.severity.value,
            "category": self.category,
            "location": self.location,
            "expected": self.expected,
            "actual": self.actual,
            "suggestion": self.suggestion,
        }


@dataclass
class AnalysisResult:
    """Result from analyzing an output file"""
    output_file: str
    output_type: str       # pptx, xlsx, pdf, html
    template_name: str
    passed: bool
    total_checks: int
    passed_checks: int
    discrepancies: List[Discrepancy] = field(default_factory=list)
    summary: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def critical_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.CRITICAL)

    @property
    def high_count(self) -> int:
        return sum(1 for d in self.discrepancies if d.severity == Severity.HIGH)

    @property
    def pass_rate(self) -> float:
        if self.total_checks == 0:
            return 0.0
        return self.passed_checks / self.total_checks

    def to_dict(self) -> Dict[str, Any]:
        return {
            "output_file": self.output_file,
            "output_type": self.output_type,
            "template_name": self.template_name,
            "passed": self.passed,
            "total_checks": self.total_checks,
            "passed_checks": self.passed_checks,
            "pass_rate": self.pass_rate,
            "critical_count": self.critical_count,
            "high_count": self.high_count,
            "discrepancies": [d.to_dict() for d in self.discrepancies],
            "summary": self.summary,
            "metadata": self.metadata,
        }


class AbstractOutputAnalyzer(ABC):
    """
    Abstract base class for output analyzers.

    Subclasses must implement:
    - analyze(): Perform analysis
    - get_supported_extensions(): Return list of handled extensions
    """

    def __init__(self):
        self.logger = logging.getLogger(self.__class__.__name__)

    @abstractmethod
    async def analyze(
        self,
        file_path: str,
        template: Any,
    ) -> AnalysisResult:
        """
        Analyze an output file against a template.

        Args:
            file_path: Path to the output file
            template: Template to compare against (type depends on analyzer)

        Returns:
            AnalysisResult with pass/fail status and discrepancies
        """
        pass

    @abstractmethod
    def get_supported_extensions(self) -> List[str]:
        """
        Get list of file extensions this analyzer supports.

        Returns:
            List of extensions (e.g., [".pptx", ".ppt"])
        """
        pass

    def can_handle(self, file_path: str) -> bool:
        """Check if this analyzer can handle the given file"""
        file_path_lower = file_path.lower()
        return any(
            file_path_lower.endswith(ext)
            for ext in self.get_supported_extensions()
        )

    def _create_result(
        self,
        file_path: str,
        template_name: str,
        discrepancies: List[Discrepancy],
        total_checks: int,
        metadata: Optional[Dict] = None,
    ) -> AnalysisResult:
        """Helper to create a standardized AnalysisResult"""
        passed_checks = total_checks - len(discrepancies)

        # Determine if passed (no critical issues, <10% high issues)
        critical = sum(1 for d in discrepancies if d.severity == Severity.CRITICAL)
        high = sum(1 for d in discrepancies if d.severity == Severity.HIGH)
        passed = critical == 0 and high <= max(1, total_checks * 0.1)

        # Generate summary
        summary = self._generate_summary(discrepancies, total_checks, passed)

        return AnalysisResult(
            output_file=file_path,
            output_type=self._get_output_type(),
            template_name=template_name,
            passed=passed,
            total_checks=total_checks,
            passed_checks=passed_checks,
            discrepancies=discrepancies,
            summary=summary,
            metadata=metadata or {},
        )

    def _get_output_type(self) -> str:
        """Get the output type for this analyzer"""
        extensions = self.get_supported_extensions()
        if extensions:
            return extensions[0].lstrip(".")
        return "unknown"

    def _generate_summary(
        self,
        discrepancies: List[Discrepancy],
        total_checks: int,
        passed: bool
    ) -> str:
        """Generate a human-readable summary"""
        if passed:
            return f"Passed: {total_checks - len(discrepancies)}/{total_checks} checks passed"

        critical = sum(1 for d in discrepancies if d.severity == Severity.CRITICAL)
        high = sum(1 for d in discrepancies if d.severity == Severity.HIGH)
        medium = sum(1 for d in discrepancies if d.severity == Severity.MEDIUM)
        low = sum(1 for d in discrepancies if d.severity == Severity.LOW)

        parts = []
        if critical:
            parts.append(f"{critical} critical")
        if high:
            parts.append(f"{high} high")
        if medium:
            parts.append(f"{medium} medium")
        if low:
            parts.append(f"{low} low")

        return f"Failed: {', '.join(parts)} issues found"


class AnalyzerRegistry:
    """
    Registry for output analyzers.

    Automatically selects the appropriate analyzer based on file extension.
    """

    def __init__(self):
        self._analyzers: Dict[str, AbstractOutputAnalyzer] = {}

    def register(self, analyzer: AbstractOutputAnalyzer):
        """Register an analyzer for its supported extensions"""
        for ext in analyzer.get_supported_extensions():
            ext = ext.lower()
            if not ext.startswith("."):
                ext = "." + ext
            self._analyzers[ext] = analyzer
            logger.info(f"Registered {analyzer.__class__.__name__} for {ext}")

    def get_analyzer(self, file_path: str) -> Optional[AbstractOutputAnalyzer]:
        """Get analyzer for a file based on its extension"""
        file_path_lower = file_path.lower()
        for ext, analyzer in self._analyzers.items():
            if file_path_lower.endswith(ext):
                return analyzer
        return None

    def get_analyzer_by_type(self, output_type: str) -> Optional[AbstractOutputAnalyzer]:
        """Get analyzer by output type (e.g., 'pdf', 'html')"""
        ext = "." + output_type.lower().lstrip(".")
        return self._analyzers.get(ext)

    def list_supported_types(self) -> List[str]:
        """List all supported file types"""
        return list(self._analyzers.keys())


# Global registry instance
_registry = AnalyzerRegistry()


def get_registry() -> AnalyzerRegistry:
    """Get the global analyzer registry"""
    return _registry
