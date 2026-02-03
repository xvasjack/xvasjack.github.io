"""
Analyzer Registry - Central registration and dispatch for output analyzers.

Provides:
- Auto-detection by file extension
- Lazy loading of analyzers
- Template resolution
"""

import os
import sys
from typing import Optional, Dict, Any

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from .base import AbstractOutputAnalyzer, AnalyzerRegistry, AnalysisResult, get_registry

# Import analyzers for registration
_analyzers_loaded = False


def _load_analyzers():
    """Lazy load and register all analyzers"""
    global _analyzers_loaded
    if _analyzers_loaded:
        return

    registry = get_registry()

    # Import and register each analyzer
    try:
        from .pptx_analyzer import PPTXAnalyzer
        registry.register(PPTXAnalyzer())
    except ImportError as e:
        pass  # PPTX analyzer optional

    try:
        from .xlsx_analyzer import XLSXAnalyzer
        registry.register(XLSXAnalyzer())
    except ImportError as e:
        pass  # XLSX analyzer optional

    try:
        from .pdf_analyzer import PDFAnalyzer
        registry.register(PDFAnalyzer())
    except ImportError as e:
        pass  # PDF analyzer optional

    try:
        from .html_analyzer import HTMLAnalyzer
        registry.register(HTMLAnalyzer())
    except ImportError as e:
        pass  # HTML analyzer optional

    _analyzers_loaded = True


def get_analyzer(file_path_or_type: str) -> Optional[AbstractOutputAnalyzer]:
    """
    Get the appropriate analyzer for a file or type.

    Args:
        file_path_or_type: Either a file path or type name (e.g., "pdf")

    Returns:
        The appropriate analyzer, or None if not found
    """
    _load_analyzers()
    registry = get_registry()

    # Check if it's a file path (has extension)
    if "." in file_path_or_type:
        return registry.get_analyzer(file_path_or_type)
    else:
        # It's a type name
        return registry.get_analyzer_by_type(file_path_or_type)


def register_analyzer(analyzer: AbstractOutputAnalyzer):
    """
    Register a custom analyzer.

    Args:
        analyzer: The analyzer to register
    """
    registry = get_registry()
    registry.register(analyzer)


async def analyze_output(
    file_path: str,
    template_name: str,
    template_config: Optional[Dict[str, Any]] = None,
) -> AnalysisResult:
    """
    Analyze an output file using the appropriate analyzer.

    This is the main entry point for output analysis.

    Args:
        file_path: Path to the output file
        template_name: Name of the template to compare against
        template_config: Optional template configuration override

    Returns:
        AnalysisResult with pass/fail and discrepancies

    Raises:
        ValueError: If no analyzer found for file type
    """
    _load_analyzers()

    analyzer = get_analyzer(file_path)
    if analyzer is None:
        # Try to get extension
        ext = os.path.splitext(file_path)[1] if "." in file_path else ""
        raise ValueError(f"No analyzer found for file type: {ext or file_path}")

    # Get template configuration
    template = _get_template(template_name, template_config)

    # Run analysis
    return await analyzer.analyze(file_path, template)


def _get_template(
    template_name: str,
    template_config: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Get template configuration by name.

    Args:
        template_name: Name of the template
        template_config: Optional override configuration

    Returns:
        Template configuration dict
    """
    # Try to import from template_comparison
    try:
        from template_comparison import TEMPLATES
        if template_name in TEMPLATES:
            template = TEMPLATES[template_name]
            if template_config:
                # Merge with override
                return {**template.__dict__, **template_config}
            return template
    except ImportError:
        pass

    # Return provided config or empty
    return template_config or {"name": template_name}


def list_supported_types() -> list:
    """List all supported output types"""
    _load_analyzers()
    return get_registry().list_supported_types()
