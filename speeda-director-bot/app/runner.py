from __future__ import annotations

import json
import random
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .config import DEFAULT_AUTH_STATE_PATH, RUNS_DIR
from .extractors import ExtractResult, SpeedaExtractor, format_director_info, marker_for_status
from .models import DashboardStatus, RunConfig
from .storage import StateStore
from .workbook import CompanyRow, WorkbookAdapter


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class RuntimeCounters:
    total_rows: int = 0
    done_rows: int = 0
    success_rows: int = 0
    failed_rows: int = 0
    skipped_rows: int = 0
    warning_rows: int = 0
    current_row: int | None = None
    current_company: str | None = None


class SpeedaRunController:
    def __init__(self, store: StateStore) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pause_event = threading.Event()
        self._stop_event = threading.Event()
        self._status = "idle"
        self._message = ""
        self._started_at: datetime | None = None
        self._ended_at: datetime | None = None
        self._run_id: str | None = None
        self._source_workbook_path: str | None = None
        self._working_workbook_path: str | None = None
        self._run_dir: Path | None = None
        self._run_log_csv: Path | None = None
        self._config: RunConfig | None = None
        self._recent_errors: list[dict] = []
        self._counters = RuntimeCounters()
        self._current_step: str | None = None
        self._current_url: str | None = None

    def get_status(self) -> DashboardStatus:
        with self._lock:
            now = utc_now()
            elapsed = 0.0
            if self._started_at:
                elapsed = (now - self._started_at).total_seconds()
            eta = None
            if self._counters.done_rows > 0 and self._counters.total_rows > 0:
                rows_left = self._counters.total_rows - self._counters.done_rows
                speed = self._counters.done_rows / max(elapsed, 1)
                eta = rows_left / speed if speed > 0 else None
            return DashboardStatus(
                status=self._status,
                run_id=self._run_id,
                message=self._message,
                workbook_path=self._source_workbook_path,
                working_workbook_path=self._working_workbook_path,
                started_at=self._started_at,
                ended_at=self._ended_at,
                elapsed_seconds=elapsed,
                eta_seconds=eta,
                total_rows=self._counters.total_rows,
                done_rows=self._counters.done_rows,
                success_rows=self._counters.success_rows,
                failed_rows=self._counters.failed_rows,
                skipped_rows=self._counters.skipped_rows,
                warning_rows=self._counters.warning_rows,
                current_row=self._counters.current_row,
                current_company=self._counters.current_company,
                current_step=self._current_step,
                current_url=self._current_url,
                recent_errors=list(self._recent_errors),
            )

    def start_run(self, config: RunConfig) -> tuple[bool, str, str | None]:
        workbook_path = Path(config.workbook_path)
        if not workbook_path.exists():
            return False, f"Workbook not found: {workbook_path}", None
        if config.start_row > config.end_row:
            return False, "start_row cannot be greater than end_row.", None

        with self._lock:
            if self._status in ("running", "paused", "stopping"):
                return False, "A run is already active.", None
            self._reset_runtime_state()
            self._status = "running"
            self._message = "Starting run."
            self._current_step = "Preparing run"
            self._current_url = None
            self._started_at = utc_now()
            self._ended_at = None
            self._run_id = f"run_{utc_now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
            self._source_workbook_path = config.workbook_path
            self._config = config
            self._pause_event.set()
            self._stop_event.clear()
            run_id = self._run_id

        self._thread = threading.Thread(
            target=self._run_loop,
            kwargs={
                "run_id": run_id,
                "config": config,
                "row_filter": None,
                "source_override": None,
            },
            daemon=True,
        )
        self._thread.start()
        return True, "Run started.", run_id

    def retry_failed(self) -> tuple[bool, str, str | None]:
        with self._lock:
            if self._status in ("running", "paused", "stopping"):
                return False, "Cannot retry while a run is active.", None
            latest_id = self.store.get_latest_run_id()
            if not latest_id:
                return False, "No previous run found.", None
            latest_run = self.store.get_run(latest_id)
            if not latest_run:
                return False, "Could not load previous run details.", None
            failed_rows = self.store.get_failed_row_numbers(latest_id)
            if not failed_rows:
                return False, "No failed rows to retry.", None
            source_override = latest_run.get("working_workbook_path")
            if not source_override:
                return False, "Previous working workbook path is missing.", None
            config_dict = latest_run.get("config")
            if not isinstance(config_dict, dict):
                return False, "Previous run config is missing.", None
            config_dict["force_retry"] = True
            config = RunConfig.from_payload(config_dict)

            self._reset_runtime_state()
            self._status = "running"
            self._message = f"Retrying {len(failed_rows)} failed rows from {latest_id}."
            self._current_step = "Preparing retry run"
            self._current_url = None
            self._started_at = utc_now()
            self._ended_at = None
            self._run_id = f"retry_{utc_now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
            self._source_workbook_path = config.workbook_path
            self._config = config
            self._pause_event.set()
            self._stop_event.clear()
            run_id = self._run_id

        self._thread = threading.Thread(
            target=self._run_loop,
            kwargs={
                "run_id": run_id,
                "config": config,
                "row_filter": set(failed_rows),
                "source_override": Path(source_override),
            },
            daemon=True,
        )
        self._thread.start()
        return True, "Retry run started.", run_id

    def pause_run(self) -> tuple[bool, str]:
        with self._lock:
            if self._status != "running":
                return False, "Run is not active."
            self._status = "paused"
            self._message = "Run paused."
            self._pause_event.clear()
            run_id = self._run_id
        if run_id:
            self.store.update_run(run_id, status="paused", message="Run paused.")
        return True, "Run paused."

    def resume_run(self) -> tuple[bool, str]:
        with self._lock:
            if self._status != "paused":
                return False, "Run is not paused."
            self._status = "running"
            self._message = "Run resumed."
            self._pause_event.set()
            run_id = self._run_id
        if run_id:
            self.store.update_run(run_id, status="running", message="Run resumed.")
        return True, "Run resumed."

    def stop_run(self) -> tuple[bool, str]:
        with self._lock:
            if self._status not in ("running", "paused"):
                return False, "No active run to stop."
            self._status = "stopping"
            self._message = "Stopping run."
            self._stop_event.set()
            self._pause_event.set()
        return True, "Stop requested."

    def login_check(self, config: RunConfig) -> tuple[bool, str]:
        auth_path = DEFAULT_AUTH_STATE_PATH
        auth_path.parent.mkdir(parents=True, exist_ok=True)
        self._set_activity("Checking login", None)
        try:
            with SpeedaExtractor(
                base_url=config.base_url,
                storage_state_path=auth_path,
                headless=config.headless,
                pace_profile=config.pace_profile,
            ) as extractor:
                result = extractor.login_check()
            if result.status == "success":
                return True, "Login check passed. Session state saved."
            if result.status == "auth_required":
                return False, "Login is required in the opened browser session."
            if result.status == "blocked":
                return False, "Blocked/captcha page detected during login check."
            return False, result.error_reason or "Login check failed."
        except Exception as exc:
            return False, f"Login check failed: {exc}"

    def export_results(self, destination_path: str | None = None) -> tuple[bool, str]:
        with self._lock:
            run_id = self._run_id
            working = self._working_workbook_path
            run_dir = self._run_dir
            source_workbook_path = self._source_workbook_path
        if not run_id or not working:
            latest_run_id = self.store.get_latest_run_id()
            if latest_run_id:
                latest_run = self.store.get_run(latest_run_id)
            else:
                latest_run = None
            if latest_run:
                run_id = latest_run_id
                working = latest_run.get("working_workbook_path")
                source_workbook_path = latest_run.get("source_workbook_path")
                if working:
                    run_dir = Path(working).parent
        if not run_id or not working:
            return False, "No run output is available."
        working_path = Path(working)
        if not working_path.exists():
            return False, "Working workbook file does not exist."
        downloads_dir = Path.home() / "Downloads"
        if destination_path:
            dst = Path(destination_path)
            csv_path = (run_dir or working_path.parent) / "run_log.csv"
        else:
            source_name = Path(source_workbook_path or "result.xlsx").stem
            dst = downloads_dir / f"{source_name}_director_output.xlsx"
            csv_path = downloads_dir / f"{source_name}_director_output_log.csv"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(working_path, dst)

        self.store.export_run_csv(run_id, csv_path)
        return True, f"Exported workbook to {dst}. Run log: {csv_path}."

    def _run_loop(
        self,
        *,
        run_id: str,
        config: RunConfig,
        row_filter: set[int] | None,
        source_override: Path | None,
    ) -> None:
        adapter = WorkbookAdapter(
            source_workbook_path=Path(config.workbook_path),
            sheet_name=config.sheet_name,
            start_row=config.start_row,
            end_row=config.end_row,
            target_column=config.target_column,
        )
        run_dir = RUNS_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        working = adapter.prepare_working_copy(run_dir, source_override=source_override)

        with self._lock:
            self._working_workbook_path = str(working)
            self._run_dir = run_dir
            self._run_log_csv = run_dir / "run_log.csv"

        try:
            adapter.load()
        except Exception as exc:
            self._mark_run_failed(run_id, f"Workbook load failed: {exc}")
            return

        rows = [r for r in adapter.iter_company_rows() if row_filter is None or r.row_number in row_filter]
        with self._lock:
            self._counters.total_rows = len(rows)

        self.store.create_run(
            run_id,
            config=config.to_dict(),
            source_workbook_path=str(adapter.source_workbook_path),
            working_workbook_path=str(working),
            status="running",
            message=self._message,
        )

        auth_hits = 0
        blocked_hits = 0

        try:
            with SpeedaExtractor(
                base_url=config.base_url,
                storage_state_path=DEFAULT_AUTH_STATE_PATH,
                headless=config.headless,
                pace_profile=config.pace_profile,
            ) as extractor:
                login_result = extractor.login_check()
                if login_result.status == "auth_required":
                    self._mark_run_failed(run_id, "Login required. Click Login Check, sign in, then retry.")
                    return
                if login_result.status == "blocked":
                    self._mark_run_failed(run_id, "Blocked page detected during startup.")
                    return

                for row_index, company_row in enumerate(rows, start=1):
                    if self._stop_event.is_set():
                        self._mark_run_stopped(run_id, "Run stopped by user.")
                        break

                    self._pause_event.wait()
                    if self._stop_event.is_set():
                        self._mark_run_stopped(run_id, "Run stopped by user.")
                        break

                    self._set_current_row(company_row)

                    if company_row.existing_director_info and not config.force_retry:
                        self._set_activity("Skipping existing row", None, f"Skipping row {company_row.row_number}; value already exists.")
                        self._record_skip(run_id, company_row)
                        continue

                    self._set_activity(
                        "Extracting directors",
                        None,
                        f"Reading row {company_row.row_number}: {company_row.company_name}",
                    )
                    result, attempts_used = self._extract_with_retries(
                        extractor,
                        company_row,
                        config.max_retries,
                        config.pace_profile,
                    )
                    final_status = result.status
                    output_value: str | None = None
                    debug_path = self._write_debug_artifacts(run_dir, company_row.row_number, final_status, result)
                    error_reason = result.error_reason
                    if debug_path and error_reason:
                        error_reason = f"{error_reason} Debug: {debug_path}"
                    elif debug_path:
                        error_reason = f"Debug: {debug_path}"
                    if result.status == "success":
                        output_value = format_director_info(result.directors)
                        auth_hits = 0
                        blocked_hits = 0
                    else:
                        output_value = marker_for_status(result.status)
                        if result.status == "auth_required":
                            auth_hits += 1
                        if result.status == "blocked":
                            blocked_hits += 1

                    self._set_activity(
                        "Writing workbook",
                        result.source_url,
                        f"Saving row {company_row.row_number} with status {final_status}.",
                    )
                    adapter.write_director_info(company_row.row_number, output_value)
                    adapter.save()

                    self.store.upsert_row_result(
                        run_id,
                        row_number=company_row.row_number,
                        speeda_id=company_row.speeda_id,
                        company_name=company_row.company_name,
                        country=company_row.country,
                        status=final_status,
                        director_info=output_value,
                        source_url=result.source_url,
                        error_reason=error_reason,
                        attempt_count=attempts_used,
                    )

                    self._increment_counters(company_row, final_status)
                    self._persist_checkpoint(run_id, company_row.row_number)

                    if auth_hits >= 2:
                        self._mark_run_failed(run_id, "Repeated auth_required detected. Please login and resume with Retry Failed.")
                        break
                    if blocked_hits >= 3:
                        self._mark_run_failed(run_id, "Repeated blocked pages detected. Stopping for account safety.")
                        break
                    if row_index < len(rows):
                        self._pause_between_companies(config.pace_profile)
                else:
                    self._mark_run_completed(run_id, "Run completed.")
        except Exception as exc:
            self._mark_run_failed(run_id, f"Runtime failure: {exc}")
        finally:
            try:
                adapter.save()
            except Exception:
                pass
            adapter.close()
            if self._run_log_csv:
                self.store.export_run_csv(run_id, self._run_log_csv)

    def _extract_with_retries(
        self,
        extractor: SpeedaExtractor,
        row: CompanyRow,
        max_retries: int,
        pace_profile: str,
    ) -> tuple[ExtractResult, int]:
        attempts = max_retries + 1
        last_result: ExtractResult | None = None
        for attempt in range(1, attempts + 1):
            last_result = extractor.extract_company(
                company_name=row.company_name,
                speeda_id=row.speeda_id,
                country=row.country,
            )
            if last_result.status in ("success", "not_found", "ambiguous", "blocked", "auth_required"):
                return last_result, attempt
            # parse/network/ui_changed get retries.
            self._pause_for_retry(pace_profile, attempt)
        if last_result:
            return last_result, attempts
        return ExtractResult("parse_fail", [], None, "No extraction result returned."), attempts

    def _pause_between_companies(self, pace_profile: str) -> None:
        delays = {
            "stealth": (3.5, 7.0),
            "conservative": (1.8, 3.4),
            "normal": (0.4, 1.1),
        }
        low, high = delays.get(pace_profile, delays["stealth"])
        seconds = random.uniform(low, high)
        self._set_activity("Waiting a bit", None, f"Short safety pause for {seconds:.1f}s.")
        self._timed_pause(seconds)

    def _pause_for_retry(self, pace_profile: str, attempt: int) -> None:
        base = {
            "stealth": 2.4,
            "conservative": 1.2,
            "normal": 0.6,
        }.get(pace_profile, 2.4)
        seconds = base * min(attempt, 3)
        self._set_activity("Waiting before retry", None, f"Retry pause for {seconds:.1f}s.")
        self._timed_pause(seconds)

    def _timed_pause(self, seconds: float) -> None:
        deadline = time.monotonic() + max(seconds, 0.0)
        while time.monotonic() < deadline:
            if self._stop_event.is_set():
                return
            if not self._pause_event.is_set():
                self._pause_event.wait()
                if self._stop_event.is_set():
                    return
            remaining = deadline - time.monotonic()
            time.sleep(min(0.5, max(remaining, 0.05)))

    def _record_skip(self, run_id: str, row: CompanyRow) -> None:
        self.store.upsert_row_result(
            run_id,
            row_number=row.row_number,
            speeda_id=row.speeda_id,
            company_name=row.company_name,
            country=row.country,
            status="skipped_existing",
            director_info=row.existing_director_info,
            source_url=None,
            error_reason="Skipped because target cell already has value.",
            attempt_count=0,
        )
        with self._lock:
            self._counters.done_rows += 1
            self._counters.skipped_rows += 1
        self._persist_checkpoint(run_id, row.row_number)

    def _set_current_row(self, row: CompanyRow) -> None:
        with self._lock:
            self._counters.current_row = row.row_number
            self._counters.current_company = row.company_name

    def _increment_counters(self, row: CompanyRow, status: str) -> None:
        with self._lock:
            self._counters.done_rows += 1
            if status == "success":
                self._counters.success_rows += 1
            elif status == "skipped_existing":
                self._counters.skipped_rows += 1
            else:
                self._counters.failed_rows += 1
                self._counters.warning_rows += 1
                self._recent_errors.insert(
                    0,
                    {
                        "row_number": row.row_number,
                        "company_name": row.company_name,
                        "status": status,
                    },
                )
                self._recent_errors = self._recent_errors[:30]

    def _persist_checkpoint(self, run_id: str, row_number: int | None) -> None:
        with self._lock:
            counters = RuntimeCounters(
                total_rows=self._counters.total_rows,
                done_rows=self._counters.done_rows,
                success_rows=self._counters.success_rows,
                failed_rows=self._counters.failed_rows,
                skipped_rows=self._counters.skipped_rows,
                warning_rows=self._counters.warning_rows,
                current_row=self._counters.current_row,
                current_company=self._counters.current_company,
            )
        self.store.update_checkpoint(
            run_id,
            last_row=row_number,
            done_rows=counters.done_rows,
            success_rows=counters.success_rows,
            failed_rows=counters.failed_rows,
            skipped_rows=counters.skipped_rows,
            warning_rows=counters.warning_rows,
        )

    def _write_debug_artifacts(
        self,
        run_dir: Path,
        row_number: int,
        status: str,
        result: ExtractResult,
    ) -> str | None:
        if not result.debug_text and not result.debug_html:
            return None
        debug_dir = run_dir / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        base_name = f"row_{row_number}_{status}"
        if result.debug_text:
            text_path = debug_dir / f"{base_name}.txt"
            text_path.write_text(result.debug_text, encoding="utf-8")
        else:
            text_path = None
        if result.debug_html:
            html_path = debug_dir / f"{base_name}.html"
            html_path.write_text(result.debug_html, encoding="utf-8")
        if text_path:
            return str(text_path)
        return str(debug_dir / f"{base_name}.html")

    def _set_activity(self, step: str, url: str | None, message: str | None = None) -> None:
        with self._lock:
            self._current_step = step
            if url:
                self._current_url = url
            if message:
                self._message = message

    def _mark_run_completed(self, run_id: str, message: str) -> None:
        with self._lock:
            self._status = "completed"
            self._message = message
            self._current_step = "Completed"
            self._ended_at = utc_now()
        self.store.update_run(run_id, status="completed", message=message, ended=True)

    def _mark_run_failed(self, run_id: str, message: str) -> None:
        with self._lock:
            self._status = "failed"
            self._message = message
            self._current_step = "Failed"
            self._ended_at = utc_now()
        self.store.update_run(run_id, status="failed", message=message, ended=True)

    def _mark_run_stopped(self, run_id: str, message: str) -> None:
        with self._lock:
            self._status = "stopped"
            self._message = message
            self._current_step = "Stopped"
            self._ended_at = utc_now()
        self.store.update_run(run_id, status="stopped", message=message, ended=True)

    def _reset_runtime_state(self) -> None:
        self._pause_event.set()
        self._stop_event.clear()
        self._run_id = None
        self._source_workbook_path = None
        self._working_workbook_path = None
        self._run_dir = None
        self._run_log_csv = None
        self._recent_errors = []
        self._counters = RuntimeCounters()
        self._current_step = None
        self._current_url = None
        self._started_at = None
        self._ended_at = None
        self._message = ""
        self._status = "idle"
