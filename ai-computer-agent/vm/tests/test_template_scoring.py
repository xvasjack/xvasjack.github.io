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
