import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from template_comparison import (
    _count_regulations, _count_data_points, _count_companies,
    _assign_slides_to_sections, _score_section, MARKET_RESEARCH_SECTIONS,
)


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
