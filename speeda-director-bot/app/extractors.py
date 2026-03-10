from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

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
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(DirectorEntry(name=name, age=age))

    return candidates


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
        self._browser = self._playwright.chromium.launch(headless=self.headless)
        if self.storage_state_path.exists():
            self._context = self._browser.new_context(storage_state=str(self.storage_state_path))
        else:
            self._context = self._browser.new_context()
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
            self._pace_wait(0.8)
            if self._is_blocked_page():
                return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
            if self._is_auth_page():
                return ExtractResult("auth_required", [], self.page.url, "Login is required.")
            self._context.storage_state(path=str(self.storage_state_path))
            return ExtractResult("success", [], self.page.url, None)
        except PlaywrightTimeoutError:
            return ExtractResult("network_fail", [], None, "Timeout during login check.")
        except Exception as exc:
            return ExtractResult("network_fail", [], None, f"Login check failed: {exc}")

    def extract_company(
        self,
        *,
        company_name: str,
        speeda_id: str | None,
        country: str | None,
    ) -> ExtractResult:
        try:
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
        if speeda_id:
            direct_urls = [
                f"{self.base_url}company/companyinformation/cid/{speeda_id}",
                f"{self.base_url}company/companyinformation/cid/{speeda_id}?8",
            ]
            for url in direct_urls:
                try:
                    self.page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    self._pace_wait()
                    if self._is_auth_page():
                        return ExtractResult("auth_required", [], self.page.url, "Login is required.")
                    if self._is_blocked_page():
                        return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
                    if self._looks_like_company_page():
                        return None
                except PlaywrightTimeoutError:
                    continue

        # Fallback to search.
        self.page.goto(self.base_url, wait_until="domcontentloaded", timeout=40000)
        if self._is_auth_page():
            return ExtractResult("auth_required", [], self.page.url, "Login is required.")
        if self._is_blocked_page():
            return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")

        search_input = self._find_search_input()
        if search_input is None:
            return ExtractResult("ui_changed", [], self.page.url, "Search box not found.")
        search_input.click()
        search_input.fill(company_name)
        search_input.press("Enter")
        self._pace_wait(1.2)

        if self._is_blocked_page():
            return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
        if self._is_auth_page():
            return ExtractResult("auth_required", [], self.page.url, "Session expired during search.")

        links = self._find_company_links()
        if not links:
            return ExtractResult("not_found", [], self.page.url, "No company result links found.")

        picked = None
        if country:
            lowered = country.lower()
            for link in links:
                card_text = link.inner_text(timeout=2000).lower()
                if lowered in card_text:
                    picked = link
                    break
        if picked is None:
            if len(links) > 1:
                # We still click first but return ambiguous if page title mismatch later.
                picked = links[0]
            else:
                picked = links[0]
        picked.click()
        self._pace_wait(1.0)

        if self._is_auth_page():
            return ExtractResult("auth_required", [], self.page.url, "Session expired after opening result.")
        if self._is_blocked_page():
            return ExtractResult("blocked", [], self.page.url, "Blocked or anti-bot page detected.")
        if not self._looks_like_company_page():
            return ExtractResult("ambiguous", [], self.page.url, "Could not confirm selected result is company profile.")
        return None

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

    def _find_company_links(self):
        selectors = [
            "a[href*='/company/companyinformation/cid/']",
            "a[href*='/company/']",
            "a:has-text('Company')",
        ]
        links = []
        for selector in selectors:
            locator = self.page.locator(selector)
            count = min(locator.count(), 5)
            for idx in range(count):
                candidate = locator.nth(idx)
                if candidate.is_visible():
                    links.append(candidate)
            if links:
                break
        return links

    def _looks_like_company_page(self) -> bool:
        try:
            url = self.page.url.lower()
            if "company" in url and ("cid" in url or "companyinformation" in url):
                return True
            title = self.page.title().lower()
            return "company" in title or "speeda" in title
        except Exception:
            return False

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

