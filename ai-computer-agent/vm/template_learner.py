"""
Template Learning System

Instead of manually defining templates, show the AI a "good" example file
and it will:
1. Analyze the structure
2. Extract patterns and rules
3. Generate a template automatically
4. Use that template for future comparisons

Usage:
    learner = TemplateLearner(anthropic_api_key)
    template = await learner.learn_from_file("examples/good_output.pptx", "target-search-v2")
    # Template is now saved and can be used for comparisons
"""

import os
import json
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
import logging

from anthropic import Anthropic

# M11: Ensure parent directory is on path for bare imports
import sys as _sys
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import file readers
from file_readers.pptx_reader import analyze_pptx
from file_readers.xlsx_reader import analyze_xlsx

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("template_learner")


# Where templates are stored
TEMPLATES_DIR = os.environ.get("TEMPLATES_DIR", "templates")


@dataclass
class LearnedTemplate:
    """A template learned from an example file"""
    name: str
    file_type: str  # "pptx" or "xlsx"
    created_at: str
    source_file: str
    description: str

    # Structure rules (auto-detected)
    structure: Dict[str, Any]

    # Quality rules (AI-generated)
    quality_rules: List[Dict[str, Any]]

    # Validation rules
    required_fields: List[str]
    blocked_patterns: List[str]

    # Thresholds
    min_items: int
    max_items: int

    # AI-generated notes about what makes this output "good"
    quality_notes: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LearnedTemplate":
        return cls(**data)

    def save(self, directory: str = TEMPLATES_DIR):
        """Save template to JSON file"""
        os.makedirs(directory, exist_ok=True)
        filepath = os.path.join(directory, f"{self.name}.json")
        with open(filepath, "w") as f:
            json.dump(self.to_dict(), f, indent=2)
        logger.info(f"Template saved: {filepath}")
        return filepath

    @classmethod
    def load(cls, name: str, directory: str = TEMPLATES_DIR) -> "LearnedTemplate":
        """Load template from JSON file"""
        filepath = os.path.join(directory, f"{name}.json")
        with open(filepath, "r") as f:
            data = json.load(f)
        return cls.from_dict(data)


class TemplateLearner:
    """
    Learn templates from example files using AI analysis.
    """

    def __init__(self, anthropic_api_key: str):
        # H15: Use AsyncAnthropic for use in async functions
        try:
            from anthropic import AsyncAnthropic
            self.client = AsyncAnthropic(api_key=anthropic_api_key)
            self._async = True
        except ImportError:
            self.client = Anthropic(api_key=anthropic_api_key)
            self._async = False

    async def learn_from_file(
        self,
        file_path: str,
        template_name: str,
        description: str = "",
        additional_rules: Optional[List[str]] = None
    ) -> LearnedTemplate:
        """
        Learn a template from an example "good" output file.

        Args:
            file_path: Path to the example file (PPT or Excel)
            template_name: Name for the new template
            description: What this template is for
            additional_rules: Any extra rules you want to add

        Returns:
            LearnedTemplate that can be used for comparisons
        """
        logger.info(f"Learning template from: {file_path}")

        # Analyze the file
        file_lower = file_path.lower()
        if file_lower.endswith(".pptx"):
            analysis = analyze_pptx(file_path)
            file_type = "pptx"
        elif file_lower.endswith(".xlsx"):
            analysis = analyze_xlsx(file_path)
            file_type = "xlsx"
        else:
            raise ValueError(f"Unsupported file type: {file_path}")

        # Use AI to understand what makes this a "good" output
        quality_analysis = await self._analyze_quality(
            analysis.to_dict() if hasattr(analysis, 'to_dict') else analysis,
            file_type,
            description,
            additional_rules
        )

        # Create the template
        template = LearnedTemplate(
            name=template_name,
            file_type=file_type,
            created_at=datetime.now().isoformat(),
            source_file=os.path.basename(file_path),
            description=description or quality_analysis.get("description", ""),
            structure=quality_analysis.get("structure", {}),
            quality_rules=quality_analysis.get("quality_rules", []),
            required_fields=quality_analysis.get("required_fields", []),
            blocked_patterns=quality_analysis.get("blocked_patterns", []),
            min_items=quality_analysis.get("min_items", 10),
            max_items=quality_analysis.get("max_items", 100),
            quality_notes=quality_analysis.get("quality_notes", ""),
        )

        # Save it
        template.save()

        return template

    async def _analyze_quality(
        self,
        analysis: Dict[str, Any],
        file_type: str,
        description: str,
        additional_rules: Optional[List[str]]
    ) -> Dict[str, Any]:
        """Use AI to analyze what makes this output good"""

        prompt = f"""
You are creating a QUALITY TEMPLATE from an example of a "good" output file.
This template will be used to automatically validate future outputs.

FILE TYPE: {file_type.upper()}

FILE ANALYSIS:
```json
{json.dumps(analysis, indent=2, default=str)[:4000]}
```

CONTEXT: {description or "This is an example of high-quality output that future outputs should match."}

ADDITIONAL RULES TO ENFORCE:
{chr(10).join(f'- {rule}' for rule in (additional_rules or [])) or 'None specified'}

YOUR TASK: Extract the QUALITY RULES that make this output "good".

Analyze what makes this output high-quality:
- Completeness: what fields are always present and populated?
- Data quality: what patterns indicate real data vs placeholder/spam?
- Structure: how is it organized? Required sections/slides/sheets?
- Validation: what should be rejected (spam URLs, empty fields, generic text)?

Return ONLY JSON (no explanation):
```json
{{
    "description": "What this template validates and what service/use-case it's for",
    "structure": {{
        "expected_sections": ["section_name_1", "section_name_2"],
        "expected_columns": ["column_1", "column_2"],
        "expected_slide_types": ["title", "data", "summary"]
    }},
    "quality_rules": [
        {{
            "name": "rule_name",
            "check": "Specific validation logic (e.g., 'website field must contain a valid domain')",
            "severity": "critical|high|medium|low",
            "message": "Error message shown when this rule fails",
            "example_pass": "Example data that passes this rule",
            "example_fail": "Example data that fails this rule"
        }}
    ],
    "required_fields": ["field_1", "field_2"],
    "blocked_patterns": ["facebook.com", "linkedin.com", "wikipedia.org", "placeholder"],
    "min_items": 20,
    "max_items": 100,
    "quality_notes": "Human-readable summary of what makes this output 'good' — completeness, depth, structure, data accuracy, professional appearance"
}}
```

SEVERITY DEFINITIONS:
- critical: blocks success entirely (empty data, wrong format, missing required sections)
- high: major quality gap (missing important fields, spam data present)
- medium: noticeable issue (inconsistent formatting, minor data gaps)
- low: cosmetic (style inconsistencies, non-essential fields missing)

BE SPECIFIC — not "data fields present" but "company_name, website, description fields present and non-empty".
"""

        from config import CLAUDE_MODEL
        # H15: Use async or run_in_executor
        if self._async:
            response = await self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}]
            )
        else:
            import asyncio as _aio
            response = await _aio.get_event_loop().run_in_executor(
                None, lambda: self.client.messages.create(
                    model=CLAUDE_MODEL,
                    max_tokens=2048,
                    messages=[{"role": "user", "content": prompt}]
                )
            )

        # M10: Parse response using JSONDecoder instead of greedy regex
        text = response.content[0].text
        try:
            decoder = json.JSONDecoder()
            brace_idx = text.find('{')
            if brace_idx >= 0:
                obj, _ = decoder.raw_decode(text[brace_idx:])
                return obj
        except (json.JSONDecodeError, ValueError):
            pass

        # Fallback defaults
        return {
            "description": description,
            "structure": {},
            "quality_rules": [],
            "required_fields": ["name", "website"],
            "blocked_patterns": ["facebook.com", "linkedin.com"],
            "min_items": 10,
            "max_items": 100,
            "quality_notes": "Auto-generated template",
        }

    async def learn_from_comparison(
        self,
        good_file: str,
        bad_file: str,
        template_name: str
    ) -> LearnedTemplate:
        """
        Learn by comparing a good output vs a bad output.
        AI will identify what makes the good one better.
        """
        logger.info(f"Learning from comparison: {good_file} vs {bad_file}")

        # Analyze both
        if good_file.lower().endswith(".pptx"):
            file_type = "pptx"
        elif good_file.lower().endswith(".docx"):
            file_type = "docx"
        else:
            file_type = "xlsx"

        if file_type == "pptx":
            good_analysis = analyze_pptx(good_file)
            bad_analysis = analyze_pptx(bad_file)
        elif file_type == "docx":
            from file_readers.docx_reader import analyze_docx
            good_analysis = analyze_docx(good_file)
            bad_analysis = analyze_docx(bad_file)
        else:
            good_analysis = analyze_xlsx(good_file)
            bad_analysis = analyze_xlsx(bad_file)

        # Ask AI to find the differences
        prompt = f"""
COMPARATIVE QUALITY ANALYSIS: Good vs Bad {file_type.upper()} Output

GOOD OUTPUT (reference for high quality):
```json
{json.dumps(good_analysis.to_dict() if hasattr(good_analysis, 'to_dict') else good_analysis, indent=2, default=str)[:3000]}
```

BAD OUTPUT (what to avoid):
```json
{json.dumps(bad_analysis.to_dict() if hasattr(bad_analysis, 'to_dict') else bad_analysis, indent=2, default=str)[:3000]}
```

YOUR TASK: Identify EVERY difference that makes the GOOD output better.

Analyze:
1. What's present in GOOD but missing in BAD?
2. What's more complete/thorough in GOOD?
3. What data quality patterns differ (specific vs generic, real vs placeholder)?
4. What structural differences exist?
5. What's the key quality gap between them?

Return ONLY JSON (no explanation):
{{
    "quality_differences": [
        {{
            "aspect": "What dimension is different (completeness, accuracy, depth, structure, etc.)",
            "good_example": "What the good output does",
            "bad_example": "What the bad output does or lacks",
            "impact": "critical|high|medium|low",
            "rule_to_enforce": "Specific validation rule to catch bad outputs"
        }}
    ],
    "structure": {{
        "expected_sections": ["sections from good output"],
        "expected_columns": ["columns from good output"],
        "expected_slide_types": ["slide types from good output"]
    }},
    "quality_rules": [
        {{
            "name": "rule_name",
            "check": "How to validate this (specific logic)",
            "severity": "critical|high|medium|low",
            "message": "Error message when this rule fails",
            "would_catch_bad_output": true
        }}
    ],
    "required_fields": ["fields that good output has and bad output lacks"],
    "blocked_patterns": ["patterns found in bad output that should be rejected"],
    "min_items": 0,
    "max_items": 100,
    "quality_notes": "Summary: what makes good good, what makes bad bad, and minimum quality threshold"
}}
"""

        from config import CLAUDE_MODEL
        # H15: Use async or run_in_executor
        if self._async:
            response = await self.client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}]
            )
        else:
            import asyncio as _aio
            response = await _aio.get_event_loop().run_in_executor(
                None, lambda: self.client.messages.create(
                    model=CLAUDE_MODEL,
                    max_tokens=2048,
                    messages=[{"role": "user", "content": prompt}]
                )
            )

        # M10: Parse response using JSONDecoder instead of greedy regex
        text = response.content[0].text
        quality_analysis = {}
        try:
            decoder = json.JSONDecoder()
            brace_idx = text.find('{')
            if brace_idx >= 0:
                quality_analysis, _ = decoder.raw_decode(text[brace_idx:])
        except (json.JSONDecodeError, ValueError):
            pass

        template = LearnedTemplate(
            name=template_name,
            file_type=file_type,
            created_at=datetime.now().isoformat(),
            source_file=f"{os.path.basename(good_file)} vs {os.path.basename(bad_file)}",
            description=f"Learned from comparing good vs bad output",
            structure=quality_analysis.get("structure", {}),
            quality_rules=quality_analysis.get("quality_rules", []),
            required_fields=quality_analysis.get("required_fields", []),
            blocked_patterns=quality_analysis.get("blocked_patterns", []),
            min_items=quality_analysis.get("min_items", 10),
            max_items=quality_analysis.get("max_items", 100),
            quality_notes=quality_analysis.get("quality_notes", ""),
        )

        template.save()
        return template


# =============================================================================
# TEMPLATE MANAGER
# =============================================================================


class TemplateManager:
    """
    Manages all templates (both hardcoded and learned).
    """

    def __init__(self, templates_dir: str = TEMPLATES_DIR):
        self.templates_dir = templates_dir
        self._cache: Dict[str, LearnedTemplate] = {}

    def list_templates(self) -> List[str]:
        """List all available templates"""
        templates = []

        # Hardcoded templates from template_comparison.py
        from template_comparison import TEMPLATES
        templates.extend(TEMPLATES.keys())

        # Learned templates from files
        if os.path.exists(self.templates_dir):
            for filename in os.listdir(self.templates_dir):
                if filename.endswith(".json"):
                    templates.append(filename[:-5])

        return list(set(templates))

    def get_template(self, name: str) -> Optional[LearnedTemplate]:
        """Get a template by name"""
        # Check cache
        if name in self._cache:
            return self._cache[name]

        # Try to load from file
        filepath = os.path.join(self.templates_dir, f"{name}.json")
        if os.path.exists(filepath):
            template = LearnedTemplate.load(name, self.templates_dir)
            self._cache[name] = template
            return template

        return None

    def delete_template(self, name: str) -> bool:
        """Delete a learned template"""
        filepath = os.path.join(self.templates_dir, f"{name}.json")
        if os.path.exists(filepath):
            os.remove(filepath)
            if name in self._cache:
                del self._cache[name]
            return True
        return False


# =============================================================================
# COMPARISON WITH LEARNED TEMPLATES
# =============================================================================


def compare_with_learned_template(
    analysis: Dict[str, Any],
    template: LearnedTemplate
) -> Dict[str, Any]:
    """
    Compare file analysis against a learned template.

    Returns dict with:
        - passed: bool
        - issues: list of issues found
        - score: 0-100 quality score
    """
    issues = []
    checks_passed = 0
    total_checks = 0

    # Check min items
    total_checks += 1
    item_count = len(analysis.get("companies", analysis.get("sheets", [])))
    if item_count < template.min_items:
        issues.append({
            "severity": "critical",
            "category": "insufficient_items",
            "message": f"Only {item_count} items, need at least {template.min_items}",
        })
    else:
        checks_passed += 1

    # Check required fields
    for field in template.required_fields:
        total_checks += 1
        # Check if field exists in data
        found = False
        for company in analysis.get("companies", []):
            if company.get(field):
                found = True
                break
        if not found:
            issues.append({
                "severity": "high",
                "category": "missing_field",
                "message": f"Required field '{field}' is missing or empty",
            })
        else:
            checks_passed += 1

    # Check blocked patterns
    for pattern in template.blocked_patterns:
        total_checks += 1
        pattern_found = False
        for company in analysis.get("companies", []):
            website = company.get("website", "")
            if pattern.lower() in website.lower():
                pattern_found = True
                issues.append({
                    "severity": "high",
                    "category": "blocked_pattern",
                    "message": f"Found blocked pattern '{pattern}' in {company.get('name')}'s website",
                })
                break
        if not pattern_found:
            checks_passed += 1

    # Apply quality rules
    for rule in template.quality_rules:
        total_checks += 1
        # Quality rules are not yet evaluated — count as skipped, not passed
        logger.warning(f"Quality rule '{rule.get('name', 'unnamed')}' skipped (not yet implemented)")
        # Do NOT increment checks_passed — unevaluated rules should not inflate score

    # Calculate score
    score = (checks_passed / max(total_checks, 1)) * 100

    return {
        "passed": len([i for i in issues if i["severity"] == "critical"]) == 0,
        "issues": issues,
        "score": round(score, 1),
        "checks_passed": checks_passed,
        "total_checks": total_checks,
        "template_used": template.name,
    }


# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================


async def learn_template(
    api_key: str,
    file_path: str,
    template_name: str,
    description: str = ""
) -> LearnedTemplate:
    """
    Quick function to learn a template from a file.

    Example:
        template = await learn_template(
            api_key="sk-...",
            file_path="examples/good_target_search.pptx",
            template_name="target-search-v2",
            description="Target search with strict logo requirements"
        )
    """
    learner = TemplateLearner(api_key)
    return await learner.learn_from_file(file_path, template_name, description)


def get_all_templates() -> List[str]:
    """Get all available template names"""
    manager = TemplateManager()
    return manager.list_templates()
