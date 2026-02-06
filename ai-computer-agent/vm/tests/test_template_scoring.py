import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from template_comparison import (
    _count_regulations, _count_data_points, _count_companies,
    _assign_slides_to_sections, _score_section, MARKET_RESEARCH_SECTIONS,
    _hex_color_distance, _check_element_style, _find_shape_for_element,
    _check_cross_slide_consistency, Severity,
)
from file_readers.pptx_reader import ShapeFormatting, SlideFormatting, FormattingProfile


class TestRegulationCounting:
    def test_keyword_then_year(self):
        assert _count_regulations("energy conservation act, 1992") >= 1

    def test_year_then_keyword(self):
        assert _count_regulations("the 2022 energy conservation act") >= 1

    def test_with_number(self):
        assert _count_regulations("ministerial regulation no. 18 of 2013") >= 1

    def test_plan(self):
        assert _count_regulations("power development plan 2024-2037") >= 1

    def test_no_match(self):
        assert _count_regulations("no legislation mentioned here") == 0

    def test_multiple(self):
        text = "energy conservation act 1992 and carbon tax act 2026"
        assert _count_regulations(text) >= 2


class TestDataPointCounting:
    def test_percent(self):
        assert _count_data_points("growth of 14% annually") >= 1

    def test_dollar_abbreviation(self):
        assert _count_data_points("market size $320M") >= 1

    def test_complex_number(self):
        assert _count_data_points("valued at 1,234.5 million USD") >= 1

    def test_currency_prefix(self):
        assert _count_data_points("$5.3 billion market") >= 1

    def test_power_units(self):
        assert _count_data_points("capacity of 45 GW installed") >= 1

    def test_no_match(self):
        assert _count_data_points("the market is growing") == 0

    def test_no_false_positive_on_plan_b(self):
        assert _count_data_points("Plan B is better") == 0

    def test_multiple_units(self):
        assert _count_data_points("45 GW capacity and $320M revenue and 14% growth") >= 3


class TestCompanyCounting:
    def test_suffixed(self):
        assert _count_companies("JERA Co., Ltd. and Tokyo Gas Co., Ltd.") >= 2

    def test_acronyms(self):
        assert _count_companies("EGAT operates plants alongside TEPCO") >= 2

    def test_mixed(self):
        assert _count_companies("PTT Group, JERA Co., and EGAT are major players") >= 3

    def test_no_match(self):
        assert _count_companies("the market has several participants") == 0

    def test_excludes_non_company(self):
        assert _count_companies("GDP grew 5% and USD strengthened") == 0

    def test_excludes_orgs(self):
        assert _count_companies("ASEAN and OECD published reports") == 0

    def test_no_double_counting(self):
        assert _count_companies("JERA Co., Ltd. is a major player") <= 1


class TestSectionAssignment:
    def test_basic_section_detection(self):
        slides = [
            {"number": 1, "title": "Thailand", "all_text": "Thailand Energy"},
            {"number": 2, "title": "Table of Contents", "all_text": ""},
            {"number": 3, "title": "Policy & Regulations", "all_text": "Section 1 of 5 Policy & Regulations"},
            {"number": 4, "title": "Foundational Acts", "all_text": "Energy Conservation Act 1992"},
            {"number": 5, "title": "National Energy Policy", "all_text": "Power Development Plan 2024"},
            {"number": 6, "title": "Market Overview", "all_text": "Section 2 Market Overview"},
            {"number": 7, "title": "TPES", "all_text": "45 GW capacity $320M"},
            {"number": 8, "title": "Competitive Landscape", "all_text": "Section 3 Competitive Landscape"},
            {"number": 9, "title": "Japanese Companies", "all_text": "JERA Co., Ltd."},
        ]
        sections = _assign_slides_to_sections(slides)
        assert len(sections["policy"]) == 2  # slides 4,5
        assert len(sections["market"]) == 1  # slide 7
        assert len(sections["competitive"]) == 1  # slide 9

    def test_no_dividers_all_preamble(self):
        slides = [
            {"number": 1, "title": "Title", "all_text": "stuff"},
            {"number": 2, "title": "Content", "all_text": "more stuff"},
        ]
        sections = _assign_slides_to_sections(slides)
        assert len(sections["preamble"]) == 2
        assert all(len(sections[k]) == 0 for k in MARKET_RESEARCH_SECTIONS)

    def test_divider_not_in_section_content(self):
        slides = [
            {"number": 1, "title": None, "all_text": "Section 1 Policy & Regulations"},
            {"number": 2, "title": "Acts", "all_text": "Act 2020"},
        ]
        sections = _assign_slides_to_sections(slides)
        assert len(sections["policy"]) == 1  # only slide 2, divider excluded


class TestSectionScoring:
    def test_policy_with_regulations(self):
        slides = [
            {"all_text": "Energy Conservation Act 1992 and Carbon Tax Act 2026 and Power Plan 2024"},
        ]
        score, max_score, failures, counts = _score_section(
            "policy", slides, MARKET_RESEARCH_SECTIONS["policy"]
        )
        assert score > 0
        assert counts.get("regulations", 0) >= 3

    def test_market_without_data_points(self):
        slides = [
            {"all_text": "The market is growing nicely"},
        ]
        score, max_score, failures, counts = _score_section(
            "market", slides, MARKET_RESEARCH_SECTIONS["market"]
        )
        assert score == 0
        assert any("data points" in f for f in failures)

    def test_competitive_with_companies(self):
        slides = [
            {"all_text": "JERA Co., Ltd. and Tokyo Gas Co., Ltd. and EGAT operate here"},
        ]
        score, max_score, failures, counts = _score_section(
            "competitive", slides, MARKET_RESEARCH_SECTIONS["competitive"]
        )
        assert score > 0
        assert counts.get("companies", 0) >= 3


class TestSectionAwareIntegration:
    def test_regulations_in_wrong_section_fails_policy(self):
        """Regulations only in Market slides should fail Policy check."""
        slides = [
            {"number": 1, "title": "Title", "all_text": ""},
            {"number": 2, "title": "Policy & Regulations", "all_text": "Section 1 Policy & Regulations"},
            {"number": 3, "title": "Content", "all_text": "No regulations here just text"},
            {"number": 4, "title": "Market Overview", "all_text": "Section 2 Market Overview"},
            {"number": 5, "title": "Energy", "all_text": "Energy Conservation Act 1992 and Power Plan 2024 and Investment Act 2019"},
        ]
        sections = _assign_slides_to_sections(slides)
        # Policy section has no regulations — they're in market
        score, _, failures, counts = _score_section(
            "policy", sections["policy"], MARKET_RESEARCH_SECTIONS["policy"]
        )
        assert counts.get("regulations", 0) == 0
        assert any("regulation" in f.lower() for f in failures)

    def test_companies_in_right_section_passes(self):
        slides = [
            {"number": 1, "title": "Competitive Landscape", "all_text": "Section 3 Competitive Landscape"},
            {"number": 2, "title": "Japanese", "all_text": "JERA Co., Ltd. and TEPCO and EGAT"},
        ]
        sections = _assign_slides_to_sections(slides)
        score, _, failures, counts = _score_section(
            "competitive", sections["competitive"], MARKET_RESEARCH_SECTIONS["competitive"]
        )
        assert counts.get("companies", 0) >= 3
        assert not any("companies" in f.lower() for f in failures)


# =============================================================================
# COLOR DISTANCE TESTS
# =============================================================================

class TestHexColorDistance:
    def test_identical(self):
        assert _hex_color_distance("1F497D", "1F497D") == 0

    def test_similar_colors_within_tolerance(self):
        # Very close colors — should be < 30
        dist = _hex_color_distance("1F497D", "1E4A7E")
        assert dist < 30

    def test_different_colors_above_tolerance(self):
        # Very different colors — should be > 100
        dist = _hex_color_distance("1F497D", "FF0000")
        assert dist > 100

    def test_handles_hash_prefix(self):
        assert _hex_color_distance("#1F497D", "1F497D") == 0

    def test_handles_none(self):
        assert _hex_color_distance(None, "1F497D") == 0.0
        assert _hex_color_distance("1F497D", None) == 0.0


# =============================================================================
# ELEMENT STYLE CHECK TESTS
# =============================================================================

def _make_shape(**kwargs):
    """Helper to create a ShapeFormatting with overrides."""
    defaults = dict(
        shape_type="text_box", left=0.4, top=1.3, width=6.0, height=2.0,
        font_size_pt=10, font_color_hex="333333", font_bold=False,
        text_length=50, text_content="Sample text",
    )
    defaults.update(kwargs)
    return ShapeFormatting(**defaults)


class TestElementStyleCheck:
    def test_font_size_within_tolerance_no_discrepancy(self):
        shape = _make_shape(font_size_pt=10.5)
        spec = {"fontSize": 10}
        discs = _check_element_style(shape, spec, "Slide 5", "bodyText")
        size_discs = [d for d in discs if d.category == "font_size_mismatch"]
        assert len(size_discs) == 0

    def test_font_color_mismatch_high_severity(self):
        shape = _make_shape(font_color_hex="FF0000")
        spec = {"color": "333333"}
        discs = _check_element_style(shape, spec, "Slide 5", "bodyText")
        color_discs = [d for d in discs if d.category == "font_color_mismatch"]
        assert len(color_discs) == 1
        assert color_discs[0].severity == Severity.HIGH

    def test_fill_color_mismatch_high_severity(self):
        shape = _make_shape(fill_color_hex="011AB7")
        spec = {"fill": "1F497D"}
        discs = _check_element_style(shape, spec, "Slide 12", "quadrant")
        fill_discs = [d for d in discs if d.category == "fill_color_mismatch"]
        assert len(fill_discs) == 1
        assert fill_discs[0].severity == Severity.HIGH

    def test_bold_mismatch_medium_severity(self):
        shape = _make_shape(font_bold=False)
        spec = {"bold": True}
        discs = _check_element_style(shape, spec, "Slide 3", "sectionHeader")
        bold_discs = [d for d in discs if d.category == "bold_mismatch"]
        assert len(bold_discs) == 1
        assert bold_discs[0].severity == Severity.MEDIUM


# =============================================================================
# CROSS-SLIDE CONSISTENCY TESTS
# =============================================================================

class TestCrossSlideConsistency:
    def test_mixed_fonts_flags_inconsistency(self):
        """When >20% body shapes use wrong font, should flag HIGH."""
        shapes_correct = [_make_shape(dominant_font_name="Century Gothic") for _ in range(4)]
        shapes_wrong = [_make_shape(dominant_font_name="Segoe UI", top=1.5) for _ in range(6)]
        slide = SlideFormatting(slide_number=2, shapes=shapes_correct + shapes_wrong)
        profile = FormattingProfile(source_file="test.pptx", slides=[slide])
        patterns_data = {"style": {"fonts": {"body": {"family": "Century Gothic", "size": 10}}}}
        discs = _check_cross_slide_consistency(profile, patterns_data)
        font_discs = [d for d in discs if d.category == "inconsistent_body_font"]
        assert len(font_discs) == 1
        assert font_discs[0].severity == Severity.HIGH

    def test_uniform_fonts_no_discrepancy(self):
        shapes = [_make_shape(dominant_font_name="Century Gothic", top=1.5) for _ in range(10)]
        slide = SlideFormatting(slide_number=2, shapes=shapes)
        profile = FormattingProfile(source_file="test.pptx", slides=[slide])
        patterns_data = {"style": {"fonts": {"body": {"family": "Century Gothic", "size": 10}}}}
        discs = _check_cross_slide_consistency(profile, patterns_data)
        font_discs = [d for d in discs if d.category == "inconsistent_body_font"]
        assert len(font_discs) == 0


# =============================================================================
# SHAPE-TO-ELEMENT MATCHING TESTS
# =============================================================================

class TestFindShapeForElement:
    def test_matches_by_position(self):
        slide = SlideFormatting(slide_number=5, shapes=[
            _make_shape(left=0.4, top=1.3, shape_type="text_box"),
            _make_shape(left=8.5, top=3.0, shape_type="text_box"),
        ])
        spec = {"x": 8.5, "y": 3.0}
        matched = _find_shape_for_element(slide, "insightPanel", spec)
        assert matched is not None
        assert matched.left == 8.5

    def test_type_filter_no_match_chart_to_text(self):
        slide = SlideFormatting(slide_number=5, shapes=[
            _make_shape(left=0.4, top=1.3, shape_type="chart"),
        ])
        spec = {"x": 0.4, "y": 1.3}
        matched = _find_shape_for_element(slide, "bodyText", spec)
        # Should not match chart to text element
        assert matched is None


# =============================================================================
# ARRAY ELEMENT TESTS
# =============================================================================

class TestArrayElementChecks:
    def test_quadrant_fill_mismatch(self):
        """Quadrant with wrong fill color should produce discrepancy."""
        from template_comparison import _compare_slide_to_pattern
        slide = SlideFormatting(slide_number=3, shapes=[
            _make_shape(left=0.4, top=0.15, font_size_pt=20, text_content="Strategy Matrix"),
            _make_shape(left=0.4, top=1.3, fill_color_hex="FF0000", shape_type="text_box"),
            _make_shape(left=6.6, top=1.3, fill_color_hex="F2F2F2", shape_type="text_box"),
            _make_shape(left=0.4, top=4.0, fill_color_hex="F2F2F2", shape_type="text_box"),
            _make_shape(left=6.6, top=4.0, fill_color_hex="D6E4F0", shape_type="text_box"),
        ])
        pattern_spec = {
            "elements": {
                "title": {"x": 0.4, "y": 0.15, "w": 12.5, "h": 0.55},
                "quadrants": [
                    {"x": 0.4, "y": 1.3, "w": 6.0, "h": 2.5, "label": "top-left", "fill": "D6E4F0"},
                    {"x": 6.6, "y": 1.3, "w": 6.3, "h": 2.5, "label": "top-right", "fill": "F2F2F2"},
                    {"x": 0.4, "y": 4.0, "w": 6.0, "h": 2.5, "label": "bottom-left", "fill": "F2F2F2"},
                    {"x": 6.6, "y": 4.0, "w": 6.3, "h": 2.5, "label": "bottom-right", "fill": "D6E4F0"},
                ],
            }
        }
        discs = _compare_slide_to_pattern(slide, "matrix_2x2", pattern_spec)
        fill_discs = [d for d in discs if d.category == "fill_color_mismatch"]
        assert len(fill_discs) >= 1  # top-left has FF0000 vs expected D6E4F0


# =============================================================================
# TABLE HEADER FILL TESTS
# =============================================================================

class TestTableHeaderFill:
    def test_table_header_fill_mismatch(self):
        from template_comparison import _compare_slide_to_pattern
        table_shape = _make_shape(
            shape_type="table", left=0.4, top=1.3, width=12.5,
            table_header_fill_hex="011AB7",
        )
        slide = SlideFormatting(slide_number=7, shapes=[
            _make_shape(left=0.4, top=0.15, font_size_pt=20, text_content="Regulation Table"),
            table_shape,
        ])
        pattern_spec = {
            "elements": {
                "title": {"x": 0.4, "y": 0.15, "w": 12.5, "h": 0.55},
                "table": {
                    "x": 0.4, "y": 1.3, "w": 12.5,
                    "headerFill": "1F497D",
                    "headerColor": "FFFFFF",
                },
            }
        }
        discs = _compare_slide_to_pattern(slide, "data_table_reference", pattern_spec)
        hdr_discs = [d for d in discs if d.category == "table_header_fill_mismatch"]
        assert len(hdr_discs) == 1
        assert hdr_discs[0].severity == Severity.HIGH


# =============================================================================
# ROUND 2: ITALIC, BORDER, FONT FAMILY, DEDUP TESTS
# =============================================================================

class TestItalicMismatch:
    def test_italic_mismatch_produces_discrepancy(self):
        shape = _make_shape(font_italic=False)
        spec = {"italic": True}
        discs = _check_element_style(shape, spec, "Slide 4", "subtitle")
        italic_discs = [d for d in discs if d.category == "italic_mismatch"]
        assert len(italic_discs) == 1
        assert italic_discs[0].severity == Severity.MEDIUM

    def test_italic_match_no_discrepancy(self):
        shape = _make_shape(font_italic=True)
        spec = {"italic": True}
        discs = _check_element_style(shape, spec, "Slide 4", "subtitle")
        italic_discs = [d for d in discs if d.category == "italic_mismatch"]
        assert len(italic_discs) == 0


class TestBorderColorMismatch:
    def test_border_color_mismatch_produces_discrepancy(self):
        shape = _make_shape(border_color_hex="FF0000")
        spec = {"border": "1F497D"}
        discs = _check_element_style(shape, spec, "Slide 6", "calloutBox")
        border_discs = [d for d in discs if d.category == "border_color_mismatch"]
        assert len(border_discs) == 1
        assert border_discs[0].severity == Severity.MEDIUM

    def test_border_color_match_no_discrepancy(self):
        shape = _make_shape(border_color_hex="1F497D")
        spec = {"border": "1F497D"}
        discs = _check_element_style(shape, spec, "Slide 6", "calloutBox")
        border_discs = [d for d in discs if d.category == "border_color_mismatch"]
        assert len(border_discs) == 0


class TestFontFamilyPerElement:
    def test_wrong_font_family_produces_discrepancy(self):
        shape = _make_shape(dominant_font_name="Segoe UI")
        spec = {"family": "Century Gothic"}
        discs = _check_element_style(shape, spec, "Slide 3", "bodyText")
        family_discs = [d for d in discs if d.category == "font_family_element_mismatch"]
        assert len(family_discs) == 1
        assert family_discs[0].severity == Severity.HIGH

    def test_correct_font_family_no_discrepancy(self):
        shape = _make_shape(dominant_font_name="Century Gothic")
        spec = {"family": "Century Gothic"}
        discs = _check_element_style(shape, spec, "Slide 3", "bodyText")
        family_discs = [d for d in discs if d.category == "font_family_element_mismatch"]
        assert len(family_discs) == 0


class TestDedupTitleDiscrepancies:
    def test_dedup_removes_aggregate_title_when_per_element_ran(self):
        """When per-element font_size_mismatch exists at Slide level,
        the aggregate title_font_size_mismatch at Presentation-wide should be removed."""
        from template_comparison import Discrepancy, Severity
        discrepancies = [
            Discrepancy(severity=Severity.HIGH, category="title_font_size_mismatch",
                        location="Presentation-wide", expected="24pt", actual="20pt",
                        suggestion="fix"),
            Discrepancy(severity=Severity.MEDIUM, category="font_size_mismatch",
                        location="Slide 3", expected="24pt", actual="20pt",
                        suggestion="fix"),
        ]
        per_element_categories = {d.category for d in discrepancies
                                  if d.location.startswith("Slide ")}
        dedup_categories = {"title_font_size_mismatch", "title_color_mismatch",
                           "title_bold_mismatch", "subtitle_font_size_mismatch",
                           "subtitle_color_mismatch"}
        if per_element_categories & {"font_size_mismatch", "font_color_mismatch", "bold_mismatch"}:
            discrepancies = [d for d in discrepancies
                            if d.category not in dedup_categories
                            or d.location != "Presentation-wide"]
        assert len(discrepancies) == 1
        assert discrepancies[0].location == "Slide 3"


# =============================================================================
# ROUND 3: CONTENT QUALITY TESTS
# =============================================================================

class TestContentQuality:
    def test_source_attribution_detection(self):
        """SOURCE_PATTERNS regex matches common citation formats."""
        import re
        SOURCE_PATTERNS = re.compile(
            r'(?:source\s*[:;]|according to|per\s+(?:[A-Z][\w]+)|'
            r'cited by|based on\s+(?:data|research|analysis|report|survey)|'
            r'(?:McKinsey|BCG|Bloomberg|IEA|World Bank|Statista|Euromonitor)\b)',
            re.IGNORECASE
        )
        assert len(SOURCE_PATTERNS.findall("Source: IEA, 2024")) >= 1
        assert len(SOURCE_PATTERNS.findall("According to Bloomberg")) >= 1
        assert len(SOURCE_PATTERNS.findall("Based on data from McKinsey")) >= 2
        assert len(SOURCE_PATTERNS.findall("The market is growing rapidly")) == 0

    def test_data_freshness_scoring(self):
        """Years closer to current year score as fresh."""
        import datetime
        current_year = datetime.datetime.now().year
        years = [2020, 2021, 2022, 2025, 2026]
        recent = [y for y in years if y >= current_year - 3]
        stale = [y for y in years if y < current_year - 4]
        assert len(recent) >= 2
        assert len(stale) >= 2

    def test_recommendation_specificity(self):
        """Rec text with entity + timeline + number = specific."""
        import re
        text = "Recommend partnering with Tesla Corp by Q2 2026 to capture $50M market opportunity"
        has_entity = bool(re.search(r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:Corp|Ltd|Inc|Group)', text))
        has_timeline = bool(re.search(r'(?:by|within|before|Q[1-4])\s+\d{4}', text, re.IGNORECASE))
        has_number = bool(re.search(r'\$[\d,]+|\d+\s*(?:million|billion|M|B)', text, re.IGNORECASE))
        assert has_entity
        assert has_timeline
        assert has_number

    def test_redundancy_jaccard(self):
        """Jaccard similarity catches near-duplicate sentences."""
        s1 = "The renewable energy market in Thailand is growing rapidly due to government incentives"
        s2 = "The renewable energy market in Thailand is expanding rapidly due to government incentives and subsidies"
        words1 = set(s1.lower().split())
        words2 = set(s2.lower().split())
        jaccard = len(words1 & words2) / len(words1 | words2)
        assert jaccard > 0.65

    def test_insight_chain_completeness(self):
        """Insight with data + implication + action = complete chain."""
        import re
        para = "Market growing at 15% CAGR suggests a 12-month window, companies should invest now"
        has_data = bool(re.search(r'\d+(?:\.\d+)?%', para))
        has_implication = bool(re.search(r'suggests?', para))
        has_action = bool(re.search(r'should', para))
        assert has_data and has_implication and has_action

    def test_incomplete_chain_detected(self):
        """Insight with only data but no implication or action = incomplete."""
        import re
        para = "The market size is $5.2 billion and growing at 8.3% annually"
        has_data = bool(re.search(r'\d+(?:\.\d+)?%|\$[\d,]+', para))
        has_implication = bool(re.search(r'(?:therefore|suggests?|implies?|indicates?|means)', para))
        has_action = bool(re.search(r'(?:should|must|recommend|consider|within|by\s+\d{4})', para))
        assert has_data
        assert not has_implication
        assert not has_action
        assert sum([has_data, has_implication, has_action]) < 2
