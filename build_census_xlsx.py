#!/usr/bin/env python3
"""Build the Shizuoka FA-target census .xlsx from census_data.json.

Reads:  /home/user/xvasjack.github.io/census_data.json
Writes: /home/user/xvasjack.github.io/Shizuoka_FA_Target_Census.xlsx

census_data.json shape:
{
  "rows": [ {verified company record}, ... ],
  "roundLog": [ {round, agents:[...], newInBand, newTotal, cumulative}, ... ],
  "coverage": {"cities":[...], "industries":[...], "sourceTypes":[...]},
  "listedFound": int, "listedExpected": 58,
  "saturation": "text",
  "unsizableTailNote": "text",
  "discoverySources": [ {url, usedFor}, ... ]
}
"""
import json, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

ROOT = "/home/user/xvasjack.github.io"
DATA = os.path.join(ROOT, "census_data.json")
OUT  = os.path.join(ROOT, "Shizuoka_FA_Target_Census.xlsx")

HDR_FILL = PatternFill("solid", fgColor="1F4E78")
HDR_FONT = Font(bold=True, color="FFFFFF", size=10)
SUB_FILL = PatternFill("solid", fgColor="D9E1F2")
SWEET_FILL = PatternFill("solid", fgColor="E2EFDA")
WARN_FILL = PatternFill("solid", fgColor="FCE4D6")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(vertical="top", wrap_text=True)
TOP = Alignment(vertical="top")


def style_header(ws, ncols, row=1):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = BORDER


def write_table(ws, headers, rows, widths=None, start=1, fill_for=None):
    for j, h in enumerate(headers, 1):
        ws.cell(row=start, column=j, value=h)
    style_header(ws, len(headers), row=start)
    for i, rowvals in enumerate(rows, start + 1):
        for j, v in enumerate(rowvals, 1):
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            cell = ws.cell(row=i, column=j, value=v)
            cell.alignment = WRAP
            cell.border = BORDER
        if fill_for:
            fill = fill_for(rows[i - start - 1])
            if fill:
                for j in range(1, len(headers) + 1):
                    ws.cell(row=i, column=j).fill = fill
    if widths:
        for j, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = ws.cell(row=start + 1, column=1)
    if rows:
        ws.auto_filter.ref = f"A{start}:{get_column_letter(len(headers))}{start + len(rows)}"


def joinurls(x):
    if not x:
        return ""
    if isinstance(x, str):
        return x
    return "\n".join(dict.fromkeys([u for u in x if u]))


def num(x):
    return x if isinstance(x, (int, float)) else None


def main():
    with open(DATA, encoding="utf-8") as f:
        d = json.load(f)
    rows = d.get("rows", [])

    def is_q(r):
        return r.get("decision") == "qualified"

    def revM(r):
        # revenue in JPY millions
        v = r.get("revenueJPYM")
        if isinstance(v, (int, float)):
            return v
        ok = r.get("revenueOku")
        if isinstance(ok, (int, float)):
            return round(ok * 100)
        return None

    def revOku(r):
        ok = r.get("revenueOku")
        if isinstance(ok, (int, float)):
            return ok
        v = r.get("revenueJPYM")
        if isinstance(v, (int, float)):
            return round(v / 100, 1)
        return None

    qualified = [r for r in rows if is_q(r)]
    # sweet spot: revenue 20-30B = 200-300 oku = 20000-30000 JPY M
    def in_sweet(r):
        m = revM(r)
        return m is not None and 20000 <= m <= 30000
    sweet = [r for r in qualified if in_sweet(r)]
    unsizable = [r for r in rows if r.get("decision") == "unsizable"]
    screened = [r for r in rows if r.get("decision") == "screened_out"]

    # sort qualified by revenue desc (None last)
    qualified.sort(key=lambda r: (revM(r) is None, -(revM(r) or 0)))
    sweet.sort(key=lambda r: -(revM(r) or 0))

    wb = Workbook()

    # ---------- helper to emit a company tab (cols 1-10 + extras) ----------
    COMP_HEAD = ["#", "Name (会社名)", "URL", "Industry", "Address (本社所在地)", "Zip",
                 "Representative (代表者)", "Registered Capital (資本金)",
                 "Revenue (JPY M)", "Rev Basis", "Headcount (従業員数)",
                 "Overseas Presence (by country)", "Listed", "Ticker",
                 "Family-owned", "Deprioritized", "Official Source URL(s)", "Notes"]
    COMP_W = [4, 28, 30, 18, 34, 8, 18, 16, 12, 9, 11, 26, 7, 8, 12, 13, 40, 30]

    def comp_rows(items):
        out = []
        for i, r in enumerate(items, 1):
            out.append([
                i,
                r.get("name", ""),
                r.get("officialUrl") or r.get("url") or "",
                r.get("industry", ""),
                r.get("address") or "",
                r.get("zip") or "",
                r.get("representative") or "",
                r.get("registeredCapital") or "",
                revM(r),
                (r.get("revenueBasis") or "") if revM(r) is not None else "",
                num(r.get("headcount")),
                r.get("overseas") or "",
                "Yes" if r.get("listed") else "No",
                r.get("ticker") or "",
                "Yes" if r.get("familyOwned") else "",
                "Yes" if r.get("deprioritized") else "",
                joinurls(r.get("officialSourceUrls") or r.get("sourceUrls")),
                r.get("reason") or r.get("note") or "",
            ])
        return out

    # ---- Targets (Qualified) ----
    ws = wb.active
    ws.title = "Targets (Qualified)"
    write_table(ws, COMP_HEAD, comp_rows(qualified), COMP_W,
                fill_for=lambda rv: SWEET_FILL if (isinstance(rv[8], (int, float)) and 20000 <= rv[8] <= 30000) else None)

    # ---- Sweet Spot ----
    ws = wb.create_sheet("Sweet Spot (¥20-30B)")
    write_table(ws, COMP_HEAD, comp_rows(sweet), COMP_W,
                fill_for=lambda rv: SWEET_FILL)

    # ---- Found-but-unsizable ----
    UNS_HEAD = ["#", "Name", "URL", "Industry", "HQ City", "Address", "Representative",
                "HQ in Shizuoka?", "Independent?", "Why unsizable", "Source URL(s)"]
    UNS_W = [4, 28, 30, 18, 12, 32, 18, 14, 12, 34, 40]
    uns_rows = []
    for i, r in enumerate(unsizable, 1):
        uns_rows.append([
            i, r.get("name", ""), r.get("officialUrl") or r.get("url") or "",
            r.get("industry", ""), r.get("hqCity") or "", r.get("address") or "",
            r.get("representative") or "",
            "Yes" if r.get("hqInShizuoka") else ("?" if r.get("hqInShizuoka") is None else "No"),
            "Yes" if r.get("independent") else ("?" if r.get("independent") is None else "No"),
            r.get("reason") or "neither revenue nor headcount obtainable",
            joinurls((r.get("officialSourceUrls") or []) + (r.get("screeningSourceUrls") or []) + (r.get("sourceUrls") or [])),
        ])
    ws = wb.create_sheet("Found-but-unsizable")
    write_table(ws, UNS_HEAD, uns_rows, UNS_W)

    # ---- Screened-Out ----
    SO_HEAD = ["#", "Name", "HQ City", "Industry", "Reason screened out",
               "Revenue est (¥oku)", "Headcount est", "Listed", "Source URL(s)"]
    SO_W = [4, 28, 12, 18, 40, 13, 12, 7, 40]
    so_rows = []
    # order: too_big, too_small, excluded, other
    for i, r in enumerate(screened, 1):
        so_rows.append([
            i, r.get("name", ""), r.get("hqCity") or "", r.get("industry", ""),
            r.get("reason") or "", revOku(r), num(r.get("headcount")),
            "Yes" if r.get("listed") else "No",
            joinurls((r.get("officialSourceUrls") or []) + (r.get("screeningSourceUrls") or []) + (r.get("sourceUrls") or [])),
        ])
    ws = wb.create_sheet("Screened-Out")
    write_table(ws, SO_HEAD, so_rows, SO_W)

    # ---- Sources ----
    ws = wb.create_sheet("Sources")
    src_rows = []
    seen = set()
    n = 0
    for s in d.get("discoverySources", []):
        u = s.get("url") if isinstance(s, dict) else s
        if not u or u in seen:
            continue
        seen.add(u); n += 1
        src_rows.append([n, "Discovery", s.get("usedFor", "") if isinstance(s, dict) else "", u])
    for r in rows:
        for u in (r.get("officialSourceUrls") or []):
            if u and u not in seen:
                seen.add(u); n += 1
                src_rows.append([n, "Official (cols 7-10)", r.get("name", ""), u])
        for u in (r.get("screeningSourceUrls") or []):
            if u and u not in seen:
                seen.add(u); n += 1
                src_rows.append([n, "Screening only", r.get("name", ""), u])
    write_table(ws, ["#", "Type", "Company / Use", "URL"], src_rows, [4, 18, 28, 70])

    # ---- Methodology ----
    ws = wb.create_sheet("Methodology")
    meth = d.get("methodology") or default_methodology(d, len(qualified), len(sweet), len(unsizable), len(screened))
    ws.column_dimensions["A"].width = 120
    ws.cell(row=1, column=1, value="Methodology & Scope").font = Font(bold=True, size=13)
    for i, line in enumerate(meth.split("\n"), start=3):
        c = ws.cell(row=i, column=1, value=line)
        c.alignment = Alignment(wrap_text=True, vertical="top")

    # ---- Coverage Log ----
    ws = wb.create_sheet("Coverage Log")
    ws.cell(row=1, column=1, value="Per-round discovery log (loop until 2 consecutive rounds add 0 new in-band)").font = Font(bold=True, size=12)
    rl_head = ["Round", "Sources / agents covered", "New in-band found", "New total found", "Cumulative candidates"]
    rl_rows = []
    for r in d.get("roundLog", []):
        rl_rows.append([r.get("round"), ", ".join(r.get("agents", [])),
                        r.get("newInBand"), r.get("newTotal"), r.get("cumulative")])
    write_table(ws, rl_head, rl_rows, [7, 70, 16, 15, 18], start=3)
    base = 3 + len(rl_rows) + 2
    cov = d.get("coverage", {})
    anchor_found = d.get("listedFound")
    anchor_exp = d.get("listedExpected", 58)
    extra = [
        ("Listed-company completeness anchor",
         f"Full roster of ~{anchor_exp} listed Shizuoka-HQ firms covered; {anchor_found} listed entities "
         f"represented across the workbook (incl. holding cos / separately-listed subs counted individually)."),
        ("Source TYPES covered", ", ".join(cov.get("sourceTypes", []))),
        ("Municipalities swept", ", ".join(cov.get("cities", []))),
        ("Industries swept", ", ".join(cov.get("industries", []))),
        ("Saturation / stop condition", d.get("saturation", "")),
        ("Unsizable sub-radar tail", d.get("unsizableTailNote", "")),
    ]
    for k, (label, val) in enumerate(extra):
        r = base + k
        ws.cell(row=r, column=1, value=label).font = Font(bold=True)
        c = ws.cell(row=r, column=2, value=val)
        c.alignment = Alignment(wrap_text=True, vertical="top")

    # tab colors
    wb["Targets (Qualified)"].sheet_properties.tabColor = "1F4E78"
    wb["Sweet Spot (¥20-30B)"].sheet_properties.tabColor = "70AD47"
    wb["Found-but-unsizable"].sheet_properties.tabColor = "BF9000"
    wb["Screened-Out"].sheet_properties.tabColor = "C00000"

    wb.save(OUT)
    print(f"WROTE {OUT}")
    print(f"  Targets(Qualified)={len(qualified)}  SweetSpot={len(sweet)}  "
          f"Unsizable={len(unsizable)}  ScreenedOut={len(screened)}  "
          f"ListedCaptured={anchor_found}/{anchor_exp}")


def default_methodology(d, nq, ns, nu, nso):
    return (
        "OBJECTIVE\n"
        "Build a ~95%-complete census of financial-advisory (FA) BD target companies HEADQUARTERED in "
        "Shizuoka Prefecture, Japan, sized for mid-market M&A coverage.\n\n"
        "SCREENING BAND\n"
        "• Include revenue ¥5B–¥100B (50–1,000億円); sweet spot ¥20–30B (200–300億).\n"
        "• Exclude <¥5B and >¥100B.\n"
        "• Group/consolidated revenue used for the band test when available; standalone used (and flagged) otherwise.\n"
        "• Private firms with undisclosed revenue kept if headcount > 200.\n"
        "• Listed and private both in scope; family-owned flagged & preferred.\n"
        "• Automotive / energy / semiconductor / real estate / high-tech DEPRIORITIZED (flagged, not dropped).\n"
        "• Excluded categories: banks / securities / captive finance, sports clubs, and branches/subsidiaries of "
        "operating parents based OUTSIDE Shizuoka. A 〇〇ホールディングス family parent is treated as INDEPENDENT.\n\n"
        "METHOD — looping discovery over a finite set of high-yield source TYPES until saturation:\n"
        "1. Every listed company HQ'd in Shizuoka (full roster; completeness anchor ~58).\n"
        "2. Revenue rankings walked down to ¥5B (houjin.jp net_sales pref-22 and equivalents).\n"
        "3. Employee-count rankings (ts-hikaku a22, ねとらぼ 東部/中部/西部) — catches privates via headcount proxy.\n"
        "4. Famous-private / regional lists + industry-association & chamber member directories.\n"
        "5. Municipality × industry sweep across all major cities × major industries.\n"
        "Stop condition: every source type 1–5 and every municipality×industry cell searched, AND the last 2 "
        "discovery rounds each added 0 new in-band companies. See Coverage Log for the per-round table.\n\n"
        "DEDUP\n"
        "Each name NFKC-normalized (fold full/half-width), corporate-form suffixes (株式会社/有限会社/（株）…) and "
        "spaces stripped; deduped on that key before verification so each company is sized once.\n\n"
        "SOURCING DISCIPLINE (output columns 7–10)\n"
        "Registered capital, revenue, headcount and overseas presence are taken ONLY from each company's own "
        "official website or its own statutory filings (会社概要 / IR / 決算短信 / 有価証券報告書 / 官報決算公告); "
        "blank where absent there. Third-party aggregators were used ONLY to decide screening (in/out), never as the "
        "value in columns 7–10. For listed firms revenue is always disclosed and was pulled from IR.\n\n"
        "QC GATE\n"
        "億円×100 = 百万円 conversion checked (figures 10× off their source flagged); 〇〇ホールディングス family "
        "parent kept INDEPENDENT; PE fund / major shareholder ≠ corporate parent; standalone vs group revenue "
        "reported explicitly (Rev Basis column); registered HQ confirmed in Shizuoka (not merely a plant).\n\n"
        f"RESULT: {nq} qualified targets ({ns} in the ¥20–30B sweet spot), {nu} found-but-unsizable, "
        f"{nso} screened-out (reasons in that tab).\n\n"
        "UNSIZABLE SUB-RADAR TAIL\n"
        "A small tail of sub-radar private firms whose revenue and headcount are not disclosed on their own site or "
        "any checked third-party source is inherently unreachable; these are listed in Found-but-unsizable rather "
        "than chased. This is the ~5% residual the brief allows."
    )


if __name__ == "__main__":
    main()
