#!/usr/bin/env python3
"""
Slide-by-slide formatting audit against template geometry/style baselines.

Use this when deck-level checks are too coarse; it reports per-slide drift.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


THIS_DIR = Path(__file__).resolve().parent
REPO_ROOT = THIS_DIR.parent.parent
DEFAULT_TEMPLATE = REPO_ROOT / "251219_Escort_Phase 1 Market Selection_V3.pptx"
PPTX_READER_PATH = REPO_ROOT / "ai-computer-agent" / "vm" / "file_readers"

if str(PPTX_READER_PATH) not in sys.path:
    sys.path.insert(0, str(PPTX_READER_PATH))

try:
    import pptx_reader  # type: ignore
except Exception as exc:  # pragma: no cover
    print(json.dumps({"error": f"Could not import pptx_reader: {exc}"}))
    raise SystemExit(2)


def _to_float(v: Any) -> float:
    try:
        return float(v)
    except Exception:
        return 0.0


def _is_textual_shape(shape: Dict[str, Any]) -> bool:
    st = shape.get("shape_type")
    return st in {"text_box", "placeholder", "table", "chart"}


def _text_len(shape: Dict[str, Any]) -> int:
    try:
        return int(shape.get("text_length", 0) or 0)
    except Exception:
        return 0


def _is_probable_title(shape: Dict[str, Any]) -> bool:
    top = _to_float(shape.get("top", 0))
    width = _to_float(shape.get("width", 0))
    height = _to_float(shape.get("height", 0))
    font_size = _to_float(shape.get("font_size_pt", 0))
    text_len = _text_len(shape)
    if text_len == 0:
        return False
    if top <= 1.2 and width >= 4.0 and height <= 1.0 and (font_size >= 14 or font_size <= 0):
        return True
    if top <= 0.95 and (font_size >= 16 or font_size <= 0):
        return True
    return False


def _pick_title_shape(shapes: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    candidates = [s for s in shapes if _is_probable_title(s)]
    if not candidates:
        return None
    candidates.sort(
        key=lambda s: (
            _to_float(s.get("font_size_pt", 0)),
            -_to_float(s.get("top", 99)),
            _text_len(s),
        ),
        reverse=True,
    )
    return candidates[0]


def _normalize_layout_name(name: Any) -> str:
    s = str(name or "").strip().lower()
    if s in {"main", "ycp_main"}:
        return "main"
    if s in {"no bar", "no_bar"}:
        return "no_bar"
    if "divider" in s:
        return "divider"
    return s


def _slide_metrics(slide: Dict[str, Any]) -> Dict[str, Any]:
    shapes = slide.get("shapes", []) or []
    title_shape = _pick_title_shape(shapes)

    content_tops: List[float] = []
    footer_intrusions = 0
    tiny_text_shapes = 0
    long_text_shapes = 0

    for s in shapes:
        if not _is_textual_shape(s):
            continue
        if title_shape is not None and s is title_shape:
            continue
        if s.get("shape_type") in {"text_box", "placeholder"} and _text_len(s) == 0:
            continue

        top = _to_float(s.get("top", 0))
        height = _to_float(s.get("height", 0))
        bottom = top + height
        if top > 0:
            content_tops.append(top)
        txt = str(s.get("text_content") or "").strip().lower()
        is_source_footer = txt.startswith("source:") or txt.startswith("sources:")
        # Keep a conservative footer buffer but avoid false positives from
        # template-aligned source/table rows that naturally sit near the footer.
        if bottom > 7.30 and not (is_source_footer and top >= 6.3):
            footer_intrusions += 1

        font_size = _to_float(s.get("font_size_pt", 0))
        if font_size > 0 and font_size < 8 and _text_len(s) >= 24:
            tiny_text_shapes += 1
        if _text_len(s) >= 850:
            long_text_shapes += 1

    return {
        "slide": int(slide.get("slide_number", 0) or 0),
        "layout": slide.get("layout_name"),
        "shapeCount": len(shapes),
        "titleY": _to_float(title_shape.get("top", 0)) if title_shape else None,
        "titleFontPt": _to_float(title_shape.get("font_size_pt", 0)) if title_shape else None,
        "contentTop": min(content_tops) if content_tops else None,
        "footerIntrusions": footer_intrusions,
        "tinyTextShapes": tiny_text_shapes,
        "longTextShapes": long_text_shapes,
    }


def _compare_slide(gen_m: Dict[str, Any], tpl_m: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    slide_no = gen_m.get("slide")
    gen_layout_n = _normalize_layout_name(gen_m.get("layout"))
    tpl_layout_n = _normalize_layout_name(tpl_m.get("layout")) if tpl_m else ""
    is_divider_like = gen_layout_n in {"divider", "no_bar"}

    if gen_m.get("titleY") is None and slide_no > 1 and not is_divider_like:
        issues.append({"severity": "high", "code": "missing_title", "message": "No detectable title shape"})

    if gen_m.get("footerIntrusions", 0) > 0:
        issues.append(
            {
                "severity": "medium",
                "code": "footer_intrusion",
                "message": f"{gen_m.get('footerIntrusions')} shape(s) overlap footer zone",
            }
        )

    if gen_m.get("tinyTextShapes", 0) >= 2:
        issues.append(
            {
                "severity": "medium",
                "code": "tiny_text_density",
                "message": f"{gen_m.get('tinyTextShapes')} tiny text shape(s) (<8pt)",
            }
        )

    if gen_m.get("longTextShapes", 0) >= 2:
        issues.append(
            {
                "severity": "medium",
                "code": "long_text_density",
                "message": f"{gen_m.get('longTextShapes')} very long text shape(s) (>=850 chars)",
            }
        )

    if tpl_m is None:
        return issues

    if gen_layout_n != tpl_layout_n and gen_layout_n == "default":
        issues.append(
            {
                "severity": "high",
                "code": "default_layout_fallback",
                "message": f"Using DEFAULT layout while template ref slide uses '{tpl_m.get('layout')}'",
            }
        )

    if (
        gen_layout_n == "main"
        and tpl_layout_n == "main"
        and gen_m.get("titleY") is not None
        and tpl_m.get("titleY") is not None
    ):
        dy = abs(_to_float(gen_m["titleY"]) - _to_float(tpl_m["titleY"]))
        if dy > 0.6:
            issues.append(
                {
                    "severity": "high",
                    "code": "title_y_drift",
                    "message": f"Title Y drift {dy:.3f}in vs template slide",
                }
            )
        elif dy > 0.25:
            issues.append(
                {
                    "severity": "medium",
                    "code": "title_y_drift",
                    "message": f"Title Y drift {dy:.3f}in vs template slide",
                }
            )

    if (
        gen_layout_n == "main"
        and tpl_layout_n == "main"
        and gen_m.get("contentTop") is not None
        and tpl_m.get("contentTop") is not None
    ):
        dy = abs(_to_float(gen_m["contentTop"]) - _to_float(tpl_m["contentTop"]))
        if dy > 1.6:
            issues.append(
                {
                    "severity": "high",
                    "code": "content_top_drift",
                    "message": f"Content-top drift {dy:.3f}in vs template slide",
                }
            )
        elif dy > 0.7:
            issues.append(
                {
                    "severity": "medium",
                    "code": "content_top_drift",
                    "message": f"Content-top drift {dy:.3f}in vs template slide",
                }
            )

    return issues


def audit_slides(generated: Path, template: Path) -> Dict[str, Any]:
    gen_p = pptx_reader.extract_formatting_profile(str(generated))
    tpl_p = pptx_reader.extract_formatting_profile(str(template))
    if gen_p is None or tpl_p is None:
        raise RuntimeError("Could not extract formatting profile for generated/template")

    gen_slides = (gen_p.to_dict().get("slides") or [])
    tpl_slides = (tpl_p.to_dict().get("slides") or [])

    tpl_metrics = [_slide_metrics(s) for s in tpl_slides]
    out_slides: List[Dict[str, Any]] = []
    severity_counts = {"high": 0, "medium": 0, "low": 0}

    for idx, slide in enumerate(gen_slides):
        gm = _slide_metrics(slide)
        tm = tpl_metrics[idx] if idx < len(tpl_metrics) else None
        issues = _compare_slide(gm, tm)
        for it in issues:
            sev = str(it.get("severity") or "low").lower()
            if sev not in severity_counts:
                sev = "low"
            severity_counts[sev] += 1
        out_slides.append(
            {
                "slide": gm["slide"],
                "layout": gm["layout"],
                "templateRefLayout": tm["layout"] if tm else None,
                "metrics": gm,
                "templateRefMetrics": tm,
                "issueCount": len(issues),
                "issues": issues,
            }
        )

    issue_slides = [s["slide"] for s in out_slides if s["issueCount"] > 0]
    return {
        "generatedFile": str(generated),
        "templateFile": str(template),
        "summary": {
            "slides": len(out_slides),
            "slidesWithIssues": len(issue_slides),
            "high": severity_counts["high"],
            "medium": severity_counts["medium"],
            "low": severity_counts["low"],
            "issueSlides": issue_slides[:40],
        },
        "slides": out_slides,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Slide-by-slide formatting audit")
    parser.add_argument("--generated", required=True, help="Generated PPTX path")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="Template PPTX path")
    parser.add_argument("--json", action="store_true", help="Print full JSON")
    parser.add_argument("--top", type=int, default=15, help="Show top N issue slides in text mode")
    args = parser.parse_args()

    gen = Path(args.generated).resolve()
    tpl = Path(args.template).resolve()
    if not gen.exists():
        print(json.dumps({"error": f"Generated file not found: {gen}"}))
        return 2
    if not tpl.exists():
        print(json.dumps({"error": f"Template file not found: {tpl}"}))
        return 2

    report = audit_slides(gen, tpl)
    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(
        f"Slide-by-slide audit: slides={report['summary']['slides']} | "
        f"withIssues={report['summary']['slidesWithIssues']} | "
        f"high={report['summary']['high']} medium={report['summary']['medium']}"
    )
    ranked = sorted(report["slides"], key=lambda s: s["issueCount"], reverse=True)
    shown = 0
    for item in ranked:
        if item["issueCount"] <= 0:
            continue
        shown += 1
        if shown > max(1, args.top):
            break
        print(
            f"  Slide {item['slide']:>2}: issues={item['issueCount']} | "
            f"layout={item['layout']} | tpl={item['templateRefLayout']}"
        )
        for issue in item["issues"][:5]:
            print(f"    - [{issue['severity']}] {issue['code']}: {issue['message']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
