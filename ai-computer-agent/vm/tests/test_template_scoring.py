import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from template_comparison import _count_regulations, _count_data_points, _count_companies


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
