from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .config import (
    DEFAULT_BASE_URL,
    DEFAULT_END_ROW,
    DEFAULT_SHEET_NAME,
    DEFAULT_START_ROW,
    DEFAULT_TARGET_COLUMN,
    DEFAULT_WORKBOOK_PATH,
)


def _bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on")
    return default


def _int(value: Any, default: int, min_value: int | None = None, max_value: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    if min_value is not None and parsed < min_value:
        parsed = min_value
    if max_value is not None and parsed > max_value:
        parsed = max_value
    return parsed


@dataclass
class RunConfig:
    workbook_path: str = str(DEFAULT_WORKBOOK_PATH)
    sheet_name: str = DEFAULT_SHEET_NAME
    start_row: int = DEFAULT_START_ROW
    end_row: int = DEFAULT_END_ROW
    target_column: str = DEFAULT_TARGET_COLUMN
    force_retry: bool = False
    max_retries: int = 2
    pace_profile: str = "conservative"
    base_url: str = DEFAULT_BASE_URL
    headless: bool = False

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "RunConfig":
        payload = payload or {}
        pace = str(payload.get("pace_profile", "conservative")).strip().lower()
        if pace not in ("conservative", "normal"):
            pace = "conservative"
        target_col = str(payload.get("target_column", DEFAULT_TARGET_COLUMN)).strip().upper()
        if not target_col:
            target_col = DEFAULT_TARGET_COLUMN
        return cls(
            workbook_path=str(payload.get("workbook_path", DEFAULT_WORKBOOK_PATH)),
            sheet_name=str(payload.get("sheet_name", DEFAULT_SHEET_NAME)),
            start_row=_int(payload.get("start_row"), DEFAULT_START_ROW, min_value=1),
            end_row=_int(payload.get("end_row"), DEFAULT_END_ROW, min_value=1),
            target_column=target_col,
            force_retry=_bool(payload.get("force_retry"), False),
            max_retries=_int(payload.get("max_retries"), 2, min_value=0, max_value=5),
            pace_profile=pace,
            base_url=str(payload.get("base_url", DEFAULT_BASE_URL)),
            headless=_bool(payload.get("headless"), False),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "workbook_path": self.workbook_path,
            "sheet_name": self.sheet_name,
            "start_row": self.start_row,
            "end_row": self.end_row,
            "target_column": self.target_column,
            "force_retry": self.force_retry,
            "max_retries": self.max_retries,
            "pace_profile": self.pace_profile,
            "base_url": self.base_url,
            "headless": self.headless,
        }


@dataclass
class ApiResult:
    ok: bool
    message: str = ""
    run_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "message": self.message, "run_id": self.run_id}


@dataclass
class DashboardStatus:
    status: str
    run_id: str | None
    message: str
    workbook_path: str | None
    working_workbook_path: str | None
    started_at: datetime | None
    ended_at: datetime | None
    elapsed_seconds: float
    eta_seconds: float | None
    total_rows: int
    done_rows: int
    success_rows: int
    failed_rows: int
    skipped_rows: int
    warning_rows: int
    current_row: int | None
    current_company: str | None
    recent_errors: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "run_id": self.run_id,
            "message": self.message,
            "workbook_path": self.workbook_path,
            "working_workbook_path": self.working_workbook_path,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "elapsed_seconds": self.elapsed_seconds,
            "eta_seconds": self.eta_seconds,
            "total_rows": self.total_rows,
            "done_rows": self.done_rows,
            "success_rows": self.success_rows,
            "failed_rows": self.failed_rows,
            "skipped_rows": self.skipped_rows,
            "warning_rows": self.warning_rows,
            "current_row": self.current_row,
            "current_company": self.current_company,
            "recent_errors": self.recent_errors,
        }

