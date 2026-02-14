#!/usr/bin/env python3
"""
PPTX XML package integrity audit.
Parses every .xml and .rels part to catch malformed XML that can trigger
"PowerPoint found unreadable content" repair dialogs.
"""

import argparse
import json
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List
from xml.etree import ElementTree


CTRL_RE = re.compile(rb"[\x00-\x08\x0B\x0C\x0E-\x1F]")


def audit_pptx(pptx_path: Path) -> Dict[str, Any]:
    issues: List[Dict[str, Any]] = []
    total_parts = 0
    parsed_parts = 0

    with zipfile.ZipFile(pptx_path) as zf:
        part_names = [n for n in zf.namelist() if n.endswith('.xml') or n.endswith('.rels')]
        total_parts = len(part_names)

        for name in part_names:
            raw = zf.read(name)

            if CTRL_RE.search(raw):
                issues.append(
                    {
                        "part": name,
                        "code": "xml_control_chars",
                        "message": "contains XML-invalid control characters",
                    }
                )
                continue

            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError as exc:
                issues.append(
                    {
                        "part": name,
                        "code": "utf8_decode_error",
                        "message": str(exc),
                    }
                )
                continue

            try:
                ElementTree.fromstring(text)
            except ElementTree.ParseError as exc:
                issues.append(
                    {
                        "part": name,
                        "code": "xml_parse_error",
                        "message": str(exc),
                    }
                )
                continue

            parsed_parts += 1

    return {
        "valid": len(issues) == 0,
        "summary": {
            "totalParts": total_parts,
            "parsedParts": parsed_parts,
            "issueCount": len(issues),
        },
        "issues": issues,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Audit XML integrity in a PPTX package')
    parser.add_argument('--pptx', required=True, help='Path to .pptx file')
    parser.add_argument('--json', action='store_true', help='Output JSON report')
    args = parser.parse_args()

    report = audit_pptx(Path(args.pptx).resolve())

    if args.json:
        print(json.dumps(report))
        raise SystemExit(0 if report.get('valid') else 1)

    if report.get('valid'):
        print(
            f"XML package audit PASS: {report['summary']['parsedParts']}/{report['summary']['totalParts']} parts parsed"
        )
        raise SystemExit(0)

    print(
        f"XML package audit FAIL: {report['summary']['issueCount']} issue(s) in {report['summary']['totalParts']} parts"
    )
    for issue in report.get('issues', [])[:20]:
        print(f" - {issue['part']}: {issue['code']} ({issue['message']})")
    raise SystemExit(1)


if __name__ == '__main__':
    main()
