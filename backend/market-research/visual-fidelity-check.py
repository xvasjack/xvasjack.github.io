#!/usr/bin/env python3
"""
Visual fidelity checker for PPTX output against the Escort template.

Focus: checks that correlate with visible formatting quality.
- Theme fonts and palette
- Slide layout/master/media structure
- Typography/layout profile drift
- Overflow/overlap and content-safe top margins
"""

import argparse
import json
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Dict, List, Tuple, Any


THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parent.parent
DEFAULT_TEMPLATE = REPO_ROOT / "251219_Escort_Phase 1 Market Selection_V3.pptx"
PPTX_READER_PATH = REPO_ROOT / "ai-computer-agent" / "vm" / "file_readers"

if str(PPTX_READER_PATH) not in sys.path:
    sys.path.insert(0, str(PPTX_READER_PATH))

try:
    import pptx_reader  # type: ignore
except Exception as exc:  # pragma: no cover
    print(
        json.dumps(
            {
                "valid": False,
                "error": f"Could not import pptx_reader: {exc}",
                "summary": {"passed": 0, "failed": 1, "warnings": 0},
                "checks": [],
            }
        )
    )
    sys.exit(2)


THEME_KEYS = [
    "dk1",
    "lt1",
    "dk2",
    "lt2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
]

SEVERITY_WEIGHT = {"high": 15, "medium": 8, "low": 4}


def _read_zip_text(zf: zipfile.ZipFile, name: str) -> str:
    return zf.read(name).decode("utf-8", errors="ignore")


def _parse_theme_xml(xml: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"major_font": None, "minor_font": None, "colors": {}}
    major = re.search(r"<a:majorFont>.*?<a:latin typeface=\"([^\"]+)\"", xml, re.S)
    minor = re.search(r"<a:minorFont>.*?<a:latin typeface=\"([^\"]+)\"", xml, re.S)
    out["major_font"] = major.group(1) if major else None
    out["minor_font"] = minor.group(1) if minor else None

    for key in THEME_KEYS:
        pattern = rf"<a:{key}[^>]*>.*?<a:(?:srgbClr|sysClr) [^>]*(?:val|lastClr)=\"([0-9A-Fa-f]+)\""
        m = re.search(pattern, xml, re.S)
        out["colors"][key] = m.group(1).upper() if m else None
    return out


def _extract_package_stats(pptx_path: Path) -> Dict[str, Any]:
    with zipfile.ZipFile(pptx_path) as zf:
        names = zf.namelist()
        slide_layouts = [
            n for n in names if n.startswith("ppt/slideLayouts/") and n.endswith(".xml")
        ]
        slide_masters = [
            n for n in names if n.startswith("ppt/slideMasters/") and n.endswith(".xml")
        ]
        media = [n for n in names if n.startswith("ppt/media/") and n != "ppt/media/"]
        slide_xmls = [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)]

        layout_links = 0
        for rel_name in names:
            if not re.match(r"^ppt/slideMasters/_rels/slideMaster\d+\.xml\.rels$", rel_name):
                continue
            rel_xml = _read_zip_text(zf, rel_name)
            layout_links += len(re.findall(r'Type="[^"]+/slideLayout"', rel_xml))

        theme_files = [n for n in names if n.startswith("ppt/theme/theme") and n.endswith(".xml")]
        theme = {"major_font": None, "minor_font": None, "colors": {k: None for k in THEME_KEYS}}
        if theme_files:
            theme = _parse_theme_xml(_read_zip_text(zf, theme_files[0]))

    return {
        "slide_count": len(slide_xmls),
        "slide_layout_count": len(slide_layouts),
        "slide_master_count": len(slide_masters),
        "layout_links_from_master": layout_links,
        "media_count": len(media),
        "theme": theme,
    }


def _round_float(value: Any) -> float:
    try:
        return round(float(value), 3)
    except Exception:
        return 0.0


def _median_or_zero(vals: List[float]) -> float:
    if not vals:
        return 0.0
    vals = sorted(vals)
    n = len(vals)
    mid = n // 2
    if n % 2:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) / 2.0


def _is_probable_title_band_shape(shape: Dict[str, Any]) -> bool:
    """
    Ignore likely title/subtitle text when checking content-body top margin.
    This avoids false positives because title shapes intentionally live above 1.2in.
    """
    top = _round_float(shape.get("top", 0))
    height = _round_float(shape.get("height", 0))
    width = _round_float(shape.get("width", 0))
    text_len = int(shape.get("text_length", 0) or 0)

    # Typical title/subtitle strip on Escort-like layouts.
    if top <= 1.15 and height <= 0.95 and width >= 4.0 and text_len <= 280:
        return True
    if top <= 0.95 and text_len <= 420:
        return True
    return False


def _content_top_violations(profile_dict: Dict[str, Any], min_top: float = 1.2) -> int:
    violations = 0
    for slide in profile_dict.get("slides", []):
        number = int(slide.get("slide_number", 0) or 0)
        if number <= 1:
            continue
        tops: List[float] = []
        for shape in slide.get("shapes", []):
            shape_type = shape.get("shape_type")
            if shape_type not in {"text_box", "table", "placeholder", "chart"}:
                continue
            if _is_probable_title_band_shape(shape):
                continue
            if shape_type in {"text_box", "placeholder"} and int(shape.get("text_length", 0) or 0) == 0:
                continue
            top = _round_float(shape.get("top", 0))
            if top > 0:
                tops.append(top)
        if not tops:
            continue
        content_top = min(tops)
        if content_top < min_top:
            violations += 1
    return violations


def _check(
    checks: List[Dict[str, Any]],
    name: str,
    passed: bool,
    expected: Any,
    actual: Any,
    severity: str = "medium",
) -> None:
    checks.append(
        {
            "name": name,
            "passed": bool(passed),
            "expected": expected,
            "actual": actual,
            "severity": severity,
        }
    )


def compare_fidelity(generated_path: Path, template_path: Path) -> Dict[str, Any]:
    gen_pkg = _extract_package_stats(generated_path)
    tpl_pkg = _extract_package_stats(template_path)

    gen_profile = pptx_reader.extract_formatting_profile(str(generated_path))
    tpl_profile = pptx_reader.extract_formatting_profile(str(template_path))
    if gen_profile is None or tpl_profile is None:
        raise RuntimeError("Could not extract formatting profile from one or both PPTX files")

    gen = gen_profile.to_dict()
    tpl = tpl_profile.to_dict()

    checks: List[Dict[str, Any]] = []

    # Theme fidelity
    _check(
        checks,
        "Theme major font",
        gen_pkg["theme"]["major_font"] == tpl_pkg["theme"]["major_font"],
        tpl_pkg["theme"]["major_font"],
        gen_pkg["theme"]["major_font"],
        "high",
    )
    _check(
        checks,
        "Theme minor font",
        gen_pkg["theme"]["minor_font"] == tpl_pkg["theme"]["minor_font"],
        tpl_pkg["theme"]["minor_font"],
        gen_pkg["theme"]["minor_font"],
        "high",
    )
    palette_matches = 0
    for k in THEME_KEYS:
        if gen_pkg["theme"]["colors"].get(k) == tpl_pkg["theme"]["colors"].get(k):
            palette_matches += 1
    palette_ratio = palette_matches / max(1, len(THEME_KEYS))
    _check(
        checks,
        "Theme palette match ratio",
        palette_ratio >= 0.9,
        ">= 0.90",
        round(palette_ratio, 2),
        "high",
    )

    # Layout/master/media fidelity
    _check(
        checks,
        "Slide layout count",
        gen_pkg["slide_layout_count"] >= max(1, tpl_pkg["slide_layout_count"] - 1),
        f">= {max(1, tpl_pkg['slide_layout_count'] - 1)}",
        gen_pkg["slide_layout_count"],
        "low",
    )
    _check(
        checks,
        "Master layout link count",
        gen_pkg["layout_links_from_master"] >= max(1, tpl_pkg["layout_links_from_master"] - 1),
        f">= {max(1, tpl_pkg['layout_links_from_master'] - 1)}",
        gen_pkg["layout_links_from_master"],
        "low",
    )
    media_ratio = gen_pkg["media_count"] / max(1, tpl_pkg["media_count"])
    _check(
        checks,
        "Media asset ratio",
        media_ratio >= 0.25,
        ">= 0.25",
        round(media_ratio, 2),
        "medium",
    )

    # Typography/layout profile drift
    title_size_delta = abs(
        _round_float(gen.get("title_font_size_pt", 0)) - _round_float(tpl.get("title_font_size_pt", 0))
    )
    _check(
        checks,
        "Title font size delta",
        title_size_delta <= 1.5,
        "<= 1.5pt",
        round(title_size_delta, 2),
        "high",
    )

    title_y_delta = abs(_round_float(gen.get("title_y", 0)) - _round_float(tpl.get("title_y", 0)))
    _check(
        checks,
        "Title Y-position delta",
        title_y_delta <= 0.6,
        "<= 0.60in",
        round(title_y_delta, 3),
        "medium",
    )

    content_start_delta = abs(
        _round_float(gen.get("content_start_y", 0)) - _round_float(tpl.get("content_start_y", 0))
    )
    _check(
        checks,
        "Content start Y delta",
        content_start_delta <= 1.6,
        "<= 1.60in",
        round(content_start_delta, 3),
        "medium",
    )

    _check(
        checks,
        "Header line count mode",
        int(gen.get("header_line_count_mode", 0) or 0) == int(tpl.get("header_line_count_mode", 0) or 0),
        int(tpl.get("header_line_count_mode", 0) or 0),
        int(gen.get("header_line_count_mode", 0) or 0),
        "medium",
    )

    gen_header_y = _median_or_zero([_round_float(x) for x in gen.get("header_line_y_positions", [])])
    tpl_header_y = _median_or_zero([_round_float(x) for x in tpl.get("header_line_y_positions", [])])
    header_y_delta = abs(gen_header_y - tpl_header_y) if tpl_header_y > 0 else 0.0
    _check(
        checks,
        "Header line Y delta",
        header_y_delta <= 0.1,
        "<= 0.10in",
        round(header_y_delta, 3),
        "medium",
    )

    # Readability/visual breakage proxies
    overflow_count = len(gen.get("overflow_shapes", []))
    overlap_count = len(gen.get("overlap_pairs", []))
    tpl_overflow_count = len(tpl.get("overflow_shapes", []))
    tpl_overlap_count = len(tpl.get("overlap_pairs", []))
    overflow_limit = max(int(round(tpl_overflow_count * 1.25)), tpl_overflow_count + 6, 10)
    overlap_limit = max(
        int(round(tpl_overlap_count * 1.5)),
        tpl_overlap_count + int(gen_pkg.get("slide_count", 0)),
        10,
    )
    _check(
        checks,
        "Overflow count vs template",
        overflow_count <= overflow_limit,
        f"<= {overflow_limit} (template={tpl_overflow_count})",
        overflow_count,
        "low",
    )
    _check(
        checks,
        "Overlap count vs template",
        overlap_count <= overlap_limit,
        f"<= {overlap_limit} (template={tpl_overlap_count})",
        overlap_count,
        "low",
    )

    top_violations = _content_top_violations(gen, min_top=1.2)
    _check(
        checks,
        "Content top-margin violations",
        top_violations == 0,
        0,
        top_violations,
        "medium",
    )

    # Score
    score = 100
    failed = [c for c in checks if not c["passed"]]
    for c in failed:
        score -= SEVERITY_WEIGHT.get(c["severity"], 6)
    score = max(0, score)

    high_failures = [c for c in failed if c["severity"] == "high"]
    valid = len(high_failures) == 0 and score >= 85

    return {
        "valid": valid,
        "score": score,
        "summary": {
            "passed": len([c for c in checks if c["passed"]]),
            "failed": len(failed),
            "warnings": 0,
            "highFailures": len(high_failures),
        },
        "checks": checks,
        "generated": {
            "file": str(generated_path),
            "package": gen_pkg,
            "profile": {
                "slide_count": gen.get("slide_count"),
                "title_font_name": gen.get("title_font_name"),
                "title_font_size_pt": gen.get("title_font_size_pt"),
                "font_family": gen.get("font_family"),
                "title_y": gen.get("title_y"),
                "content_start_y": gen.get("content_start_y"),
                "header_line_count_mode": gen.get("header_line_count_mode"),
            },
        },
        "template": {
            "file": str(template_path),
            "package": tpl_pkg,
            "profile": {
                "slide_count": tpl.get("slide_count"),
                "title_font_name": tpl.get("title_font_name"),
                "title_font_size_pt": tpl.get("title_font_size_pt"),
                "font_family": tpl.get("font_family"),
                "title_y": tpl.get("title_y"),
                "content_start_y": tpl.get("content_start_y"),
                "header_line_count_mode": tpl.get("header_line_count_mode"),
            },
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Visual fidelity validator for PPTX")
    parser.add_argument("--generated", required=True, help="Generated PPTX path")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="Template PPTX path")
    parser.add_argument("--json", action="store_true", help="Print JSON output only")
    args = parser.parse_args()

    generated_path = Path(args.generated).resolve()
    template_path = Path(args.template).resolve()

    if not generated_path.exists():
        print(json.dumps({"valid": False, "error": f"Generated file not found: {generated_path}"}))
        return 2
    if not template_path.exists():
        print(json.dumps({"valid": False, "error": f"Template file not found: {template_path}"}))
        return 2

    try:
        result = compare_fidelity(generated_path, template_path)
    except Exception as exc:
        print(json.dumps({"valid": False, "error": str(exc), "summary": {"passed": 0, "failed": 1, "warnings": 0}}))
        return 2

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Visual fidelity: {'PASS' if result['valid'] else 'FAIL'} | score={result['score']}")
        for check in result["checks"]:
            status = "PASS" if check["passed"] else "FAIL"
            print(
                f"  [{status}] {check['name']} ({check['severity']}): expected {check['expected']}, actual {check['actual']}"
            )

    return 0 if result.get("valid") else 1


if __name__ == "__main__":
    raise SystemExit(main())
