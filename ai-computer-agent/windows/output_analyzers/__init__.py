"""
Output Analyzers - Flexible validation for different output types.

Supports:
- PPTX (PowerPoint) - Template structure comparison
- XLSX (Excel) - Formula validation, data accuracy, charts
- PDF - Text extraction, visual layout, page structure
- HTML/Web - Screenshot comparison + DOM structure

Usage:
    from output_analyzers import get_analyzer, analyze_output

    # Auto-detect analyzer by extension
    result = await analyze_output("report.pdf", "target-search")

    # Or get specific analyzer
    analyzer = get_analyzer("pdf")
    result = await analyzer.analyze("report.pdf", template)
"""

from .base import AbstractOutputAnalyzer, AnalyzerRegistry
from .registry import get_analyzer, analyze_output, register_analyzer

__all__ = [
    "AbstractOutputAnalyzer",
    "AnalyzerRegistry",
    "get_analyzer",
    "analyze_output",
    "register_analyzer",
]
