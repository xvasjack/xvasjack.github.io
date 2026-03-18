from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin

from playwright.sync_api import Browser, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


STATUS_MARKERS = {
    "not_found": "[NOT_FOUND]",
    "ambiguous": "[AMBIGUOUS]",
    "blocked": "[BLOCKED]",
    "auth_required": "[AUTH_REQUIRED]",
    "parse_fail": "[PARSE_FAIL]",
    "network_fail": "[NETWORK_FAIL]",
    "ui_changed": "[UI_CHANGED]",
}

FORBIDDEN_URL_TERMS = (
    "billing",
    "subscription",
    "upgrade",
    "pricing",
    "payment",
    "checkout",
    "invoice",
    "credit-card",
    "creditcard",
    "plan",
    "plans",
)

FORBIDDEN_TEXT_TERMS = (
    "upgrade your plan",
    "subscription",
    "billing",
    "payment method",
    "credit card",
    "buy now",
    "start trial",
    "free trial",
    "\u8ab2\u91d1",  # 課金
    "\u8acb\u6c42",  # 請求
    "\u652f\u6255\u3044",  # 支払い
    "\u30d7\u30e9\u30f3",  # プラン
)

ALLOWED_COMPANY_PATH_TERMS = (
    "/company/companyinformation/cid/",
    "/company/companyinformation/",
)


@dataclass(frozen=True)
class DirectorEntry:
    name: str
    age: int | None


@dataclass(frozen=True)
class ExtractResult:
    status: str
    directors: list[DirectorEntry]
    source_url: str | None
    error_reason: str | None


@dataclass(frozen=True)
class CompanySearchHit:
    href: str
    card_text: str


def format_director_info(directors: Iterable[DirectorEntry]) -> str:
    chunks = []
    for d in directors:
        if d.age is None:
            chunks.append(f"{d.name} (Age NA)")
        else:
            chunks.append(f"{d.name} (Age {d.age})")
    return "; ".join(chunks)


def marker_for_status(status: str) -> str:
    return STATUS_MARKERS.get(status, "[PARSE_FAIL]")


def parse_directors_from_text(raw_text: str) -> list[DirectorEntry]:
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    candidates: list[DirectorEntry] = []
    seen = set()

    for line in lines:
        if len(line) < 3:
            continue
        lower = line.lower()
        if not re.search(r"(director|executive|officer|board|chief|役員|取締役)", lower):
            # Keep lines with age patterns if they look like "Name (52)".
            if not re.search(r"[\( ]([2-9]\d)(?:\)|\s*(?:yrs|years|yo|歳))", line, flags=re.IGNORECASE):
                continue

        age = _extract_age(line)
        name = _extract_name(line)
        if not name:
            continue
        if len(name) < 2:
            continue
        if not _looks_like_person_name(name):
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(DirectorEntry(name=name, age=age))

    return candidates


def normalize_company_name(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def _looks_like_person_name(name: str) -> bool:
    lowered = name.lower().strip()
    if not lowered:
        return False
    blocked_phrases = (
        "executive",
        "director",
        "directors",
        "officer",
        "officers",
        "board",
        "chart",
        "organization",
        "key",
        "leadership",
        "profile",
        "information",
        "info",
        "charge",
        "management",
        "shareholder",
        "company",
    )
    if any(term in lowered for term in blocked_phrases):
        return False
    if any(char in name for char in ("&", "/", ":", "|", "[", "]")):
        return False
    if re.search(r"[\u3040-\u30ff\u3400-\u9fff]", name):
        return len(name) <= 40
    words = re.findall(r"[A-Za-z][A-Za-z'.-]*", name)
    if len(words) < 2 or len(words) > 8:
        return False
    return True


def _extract_age(line: str) -> int | None:
    patterns = [
        r"(?i)\bage[:\s]*([2-9]\d)\b",
        r"\(([2-9]\d)\)",
        r"\b([2-9]\d)\s*(?:years? old|yrs|yo|歳)\b",
    ]
    for p in patterns:
        m = re.search(p, line)
        if m:
            try:
                age = int(m.group(1))
                if 18 <= age <= 99:
                    return age
            except ValueError:
                return None
    return None


def _extract_name(line: str) -> str:
    cleaned = line
    cleaned = re.sub(
        r"(?i)\b(chairman|director|executive|officer|board member|chief executive officer|ceo|cfo|coo|cto|役員|取締役)\b",
        " ",
        cleaned,
    )
    cleaned = re.sub(r"\b[2-9]\d\s*(?:years? old|yrs|yo|歳)\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\([2-9]\d\)", " ", cleaned)
    cleaned = re.sub(r"(?i)\bage[:\s]*[2-9]\d\b", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -:|/")
    return cleaned.strip()


class SpeedaExtractor:
    def __init__(
        self,
        *,
        base_url: str,
        storage_state_path: Path,
        headless: bool,
        pace_profile: str,
    ) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.storage_state_path = storage_state_path
        self.headless = headless
        self.pace_profile = pace_profile
        self._playwright = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    def __enter__(self) -> "SpeedaExtractor":
        self._playwright = sync_playwright().start()
        launch_args = ["--start-maximized"] if not self.headless else None
        self._browser = self._playwright.chromium.launch(headless=self.headless, args=launch_args)
        if self.storage_state_path.exists():
            self._context = self._browser.new_context(
                storage_state=str(self.storage_state_path),
                viewport={"width": 1440, "height": 900},
            )
        else:
            self._context = self._browser.new_context(viewport={"width": 1440, "height": 900})
        self._page = self._context.new_page()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._context:
                self._context.storage_state(path=str(self.storage_state_path))
        except Exception:
            pass
        if self._context:
            self._context.close()
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()

    @property
    def page(self) -> Page:
        if not self._page:
            raise RuntimeError("Extractor is not initialized.")
        return self._page

    def login_check(self) -> ExtractResult:
        try:
            self.page.goto(self.base_url, wait_until="domcontentloaded", timeout=45000)
            if not self.headless:
                self.page.bring_to_front()
            self._pace_wait(0.8)
            safety_violation = self._get_safety_violation()
            if safety_violation:
                return ExtractResult("blocked", [], self.page.url, safety_violation)
            if self._is_blocked_page():
                return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
            if self._is_auth_page():
                if self.headless:
                    return ExtractResult("auth_required", [], self.page.url, "Login is required.")
                return self._wait_for_manual_login(timeout_seconds=300)
            self._context.storage_state(path=str(self.storage_state_path))
            return ExtractResult("success", [], self.page.url, None)
        except PlaywrightTimeoutError:
            return ExtractResult("network_fail", [], None, "Timeout during login check.")
        except Exception as exc:
            return ExtractResult("network_fail", [], None, f"Login check failed: {exc}")

    def _wait_for_manual_login(self, timeout_seconds: int) -> ExtractResult:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            try:
                self.page.bring_to_front()
            except Exception:
                pass
            time.sleep(2.0)
            safety_violation = self._get_safety_violation()
            if safety_violation:
                return ExtractResult("blocked", [], self.page.url, safety_violation)
            if self._is_blocked_page():
                return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
            if self._is_auth_page():
                continue
            self._context.storage_state(path=str(self.storage_state_path))
            return ExtractResult("success", [], self.page.url, None)
        return ExtractResult(
            "auth_required",
            [],
            self.page.url,
            "Login window stayed open, but sign-in was not completed within 5 minutes.",
        )

    def extract_company(
        self,
        *,
        company_name: str,
        speeda_id: str | None,
        country: str | None,
    ) -> ExtractResult:
        try:
            safety_violation = self._get_safety_violation()
            if safety_violation:
                return ExtractResult("blocked", [], self.page.url, safety_violation)
            if self._is_auth_page():
                return ExtractResult("auth_required", [], self.page.url, "Session is not authenticated.")

            open_result = self._open_company_page(company_name=company_name, speeda_id=speeda_id, country=country)
            if open_result is not None:
                return open_result

            section_text = self._collect_executive_text()
            if not section_text:
                return ExtractResult("ui_changed", [], self.page.url, "Could not find executive section text.")
            directors = parse_directors_from_text(section_text)
            if not directors:
                return ExtractResult("parse_fail", [], self.page.url, "Executive section found but no parseable director data.")
            return ExtractResult("success", directors, self.page.url, None)
        except PlaywrightTimeoutError:
            return ExtractResult("network_fail", [], self.page.url if self._page else None, "Page timeout during extraction.")
        except Exception as exc:
            return ExtractResult("parse_fail", [], self.page.url if self._page else None, f"Unhandled extraction error: {exc}")

    def _open_company_page(
        self,
        *,
        company_name: str,
        speeda_id: str | None,
        country: str | None,
    ) -> ExtractResult | None:
        expected_name = normalize_company_name(company_name)
        if speeda_id:
            direct_urls = [
                f"{self.base_url}company/companyinformation/cid/{speeda_id}",
                f"{self.base_url}company/companyinformation/cid/{speeda_id}?8",
            ]
            for url in direct_urls:
                try:
                    self.page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    self._pace_wait()
                    safety_violation = self._get_safety_violation()
                    if safety_violation:
                        return ExtractResult("blocked", [], self.page.url, safety_violation)
                    if self._is_auth_page():
                        return ExtractResult("auth_required", [], self.page.url, "Login is required.")
                    if self._is_blocked_page():
                        return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
                    if self._looks_like_company_page() and self._page_matches_company(expected_name):
                        return None
                except PlaywrightTimeoutError:
                    continue

            return ExtractResult("ambiguous", [], self.page.url, "Direct company page did not match the expected company.")

        # Safe mode: do not guess through search when the Speeda ID is missing.
        return ExtractResult("ambiguous", [], self.page.url, "Speeda ID is missing for this row. Safe auto-search is disabled.")

    def _find_search_input(self):
        selectors = [
            "input[type='search']",
            "input[placeholder*='Search' i]",
            "input[placeholder*='Company' i]",
            "input[placeholder*='会社' i]",
            "input[aria-label*='search' i]",
            "input[name*='search' i]",
        ]
        for selector in selectors:
            locator = self.page.locator(selector).first
            if locator.count() > 0 and locator.is_visible():
                return locator
        return None

    def _find_company_links(self) -> list[CompanySearchHit]:
        selectors = [
            "a[href*='/company/companyinformation/cid/']",
            "a[href*='/company/companyinformation/']",
        ]
        links: list[CompanySearchHit] = []
        seen_hrefs: set[str] = set()
        for selector in selectors:
            locator = self.page.locator(selector)
            count = min(locator.count(), 5)
            for idx in range(count):
                candidate = locator.nth(idx)
                if not candidate.is_visible():
                    continue
                href = candidate.get_attribute("href")
                if not href:
                    continue
                href = href.strip()
                href_lower = href.lower()
                if not self._is_safe_company_href(href_lower):
                    continue
                absolute_href = self.page.url if href.startswith("#") else urljoin(self.page.url, href)
                absolute_lower = absolute_href.lower()
                if not self._is_safe_company_href(absolute_lower):
                    continue
                if absolute_lower in seen_hrefs:
                    continue
                seen_hrefs.add(absolute_lower)
                try:
                    card_text = candidate.inner_text(timeout=1500).strip()
                except Exception:
                    card_text = ""
                links.append(CompanySearchHit(href=absolute_href, card_text=card_text))
            if links:
                break
        return links

    def _is_safe_company_href(self, href_lower: str) -> bool:
        if any(term in href_lower for term in FORBIDDEN_URL_TERMS):
            return False
        return any(path_term in href_lower for path_term in ALLOWED_COMPANY_PATH_TERMS)

    def _looks_like_company_page(self) -> bool:
        try:
            url = self.page.url.lower()
            if "company" in url and ("cid" in url or "companyinformation" in url):
                return True
            title = self.page.title().lower()
            return "company" in title or "speeda" in title
        except Exception:
            return False

    def _page_matches_company(self, expected_name: str) -> bool:
        try:
            body = self.page.locator("body").inner_text(timeout=1500)
        except Exception:
            return False
        normalized_body = normalize_company_name(body[:4000])
        return expected_name in normalized_body

    def _get_safety_violation(self) -> str | None:
        try:
            url_lower = (self.page.url or "").lower()
            if any(term in url_lower for term in FORBIDDEN_URL_TERMS):
                return f"Safety stop: suspicious billing/plan URL detected ({self.page.url})."
            body = self.page.locator("body").inner_text(timeout=1200).lower()
            body_preview = body[:3000]
            if any(term in body_preview for term in FORBIDDEN_TEXT_TERMS):
                return "Safety stop: suspicious billing/subscription text detected on page."
            return None
        except Exception:
            return None

    def _collect_executive_text(self) -> str:
        section_selectors = [
            "section:has-text('Executive in Charge')",
            "section:has-text('Executive')",
            "section:has-text('Director')",
            "div:has-text('Executive in Charge')",
            "div:has-text('Directors')",
            "div:has-text('役員')",
        ]
        for selector in section_selectors:
            section = self.page.locator(selector).first
            if section.count() > 0 and section.is_visible():
                text = section.inner_text(timeout=2000).strip()
                if len(text) > 10:
                    return text

        # Try opening tab by label then re-check.
        tab_labels = [
            "Executive in Charge",
            "Executive",
            "Directors",
            "Board of Directors",
            "役員",
            "Officer",
        ]
        for label in tab_labels:
            tab = self.page.get_by_text(label, exact=False).first
            if tab.count() > 0 and tab.is_visible():
                try:
                    tab.click(timeout=2000)
                    self._pace_wait(0.6)
                except Exception:
                    continue
                body_text = self.page.locator("body").inner_text(timeout=3000)
                if label.lower() in body_text.lower() or "役員" in body_text:
                    return body_text

        # Last fallback: scan whole page text.
        return self.page.locator("body").inner_text(timeout=4000)

    def _is_auth_page(self) -> bool:
        try:
            body = self.page.locator("body").inner_text(timeout=1500).lower()
            auth_terms = [
                "log in",
                "login",
                "sign in",
                "password",
                "email address",
                "メールアドレス",
                "ログイン",
            ]
            return any(term in body for term in auth_terms)
        except Exception:
            return False

    def _is_blocked_page(self) -> bool:
        try:
            body = self.page.locator("body").inner_text(timeout=1500).lower()
            blocked_terms = [
                "captcha",
                "verify you are human",
                "access denied",
                "temporarily blocked",
                "unusual traffic",
                "are you a robot",
            ]
            return any(term in body for term in blocked_terms)
        except Exception:
            return False

    def _pace_wait(self, multiplier: float = 1.0) -> None:
        base = 0.8 if self.pace_profile == "conservative" else 0.35
        time.sleep(base * multiplier)
