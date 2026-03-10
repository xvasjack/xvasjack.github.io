from __future__ import annotations

import csv
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class StateStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    source_workbook_path TEXT NOT NULL,
                    working_workbook_path TEXT,
                    started_at TEXT NOT NULL,
                    ended_at TEXT
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS checkpoints (
                    run_id TEXT PRIMARY KEY,
                    last_row INTEGER,
                    done_rows INTEGER NOT NULL,
                    success_rows INTEGER NOT NULL,
                    failed_rows INTEGER NOT NULL,
                    skipped_rows INTEGER NOT NULL,
                    warning_rows INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS row_results (
                    run_id TEXT NOT NULL,
                    row_number INTEGER NOT NULL,
                    speeda_id TEXT,
                    company_name TEXT NOT NULL,
                    country TEXT,
                    status TEXT NOT NULL,
                    director_info TEXT,
                    source_url TEXT,
                    error_reason TEXT,
                    attempt_count INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, row_number)
                )
                """
            )

    def create_run(
        self,
        run_id: str,
        config: dict[str, Any],
        source_workbook_path: str,
        working_workbook_path: str,
        status: str = "running",
        message: str = "",
    ) -> None:
        now = utc_now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO runs (
                    run_id, status, message, config_json, source_workbook_path,
                    working_workbook_path, started_at, ended_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    run_id,
                    status,
                    message,
                    json.dumps(config, ensure_ascii=True),
                    source_workbook_path,
                    working_workbook_path,
                    now,
                ),
            )
            self._conn.execute(
                """
                INSERT INTO checkpoints (
                    run_id, last_row, done_rows, success_rows, failed_rows,
                    skipped_rows, warning_rows, updated_at
                ) VALUES (?, NULL, 0, 0, 0, 0, 0, ?)
                """,
                (run_id, now),
            )

    def update_run(
        self,
        run_id: str,
        *,
        status: str | None = None,
        message: str | None = None,
        ended: bool = False,
    ) -> None:
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT status, message FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                return
            new_status = status if status is not None else row["status"]
            new_message = message if message is not None else row["message"]
            ended_at = utc_now_iso() if ended else None
            self._conn.execute(
                """
                UPDATE runs
                SET status = ?,
                    message = ?,
                    ended_at = CASE WHEN ? IS NULL THEN ended_at ELSE ? END
                WHERE run_id = ?
                """,
                (new_status, new_message, ended_at, ended_at, run_id),
            )

    def upsert_row_result(
        self,
        run_id: str,
        *,
        row_number: int,
        speeda_id: str | None,
        company_name: str,
        country: str | None,
        status: str,
        director_info: str | None,
        source_url: str | None,
        error_reason: str | None,
        attempt_count: int,
    ) -> None:
        now = utc_now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO row_results (
                    run_id, row_number, speeda_id, company_name, country, status,
                    director_info, source_url, error_reason, attempt_count, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, row_number) DO UPDATE SET
                    speeda_id = excluded.speeda_id,
                    company_name = excluded.company_name,
                    country = excluded.country,
                    status = excluded.status,
                    director_info = excluded.director_info,
                    source_url = excluded.source_url,
                    error_reason = excluded.error_reason,
                    attempt_count = excluded.attempt_count,
                    updated_at = excluded.updated_at
                """,
                (
                    run_id,
                    row_number,
                    speeda_id,
                    company_name,
                    country,
                    status,
                    director_info,
                    source_url,
                    error_reason,
                    attempt_count,
                    now,
                ),
            )

    def update_checkpoint(
        self,
        run_id: str,
        *,
        last_row: int | None,
        done_rows: int,
        success_rows: int,
        failed_rows: int,
        skipped_rows: int,
        warning_rows: int,
    ) -> None:
        now = utc_now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE checkpoints
                SET last_row = ?,
                    done_rows = ?,
                    success_rows = ?,
                    failed_rows = ?,
                    skipped_rows = ?,
                    warning_rows = ?,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (
                    last_row,
                    done_rows,
                    success_rows,
                    failed_rows,
                    skipped_rows,
                    warning_rows,
                    now,
                    run_id,
                ),
            )

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run_row = self._conn.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,)).fetchone()
            if run_row is None:
                return None
            checkpoint_row = self._conn.execute(
                "SELECT * FROM checkpoints WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            data = dict(run_row)
            data["config"] = json.loads(data.pop("config_json"))
            if checkpoint_row:
                data["checkpoint"] = dict(checkpoint_row)
            else:
                data["checkpoint"] = None
            return data

    def get_latest_run_id(self) -> str | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT run_id
                FROM runs
                ORDER BY started_at DESC
                LIMIT 1
                """
            ).fetchone()
            return row["run_id"] if row else None

    def get_recent_errors(self, run_id: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT row_number, company_name, status, error_reason, updated_at
                FROM row_results
                WHERE run_id = ? AND status != 'success' AND status != 'skipped_existing'
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (run_id, limit),
            ).fetchall()
            return [dict(r) for r in rows]

    def get_failed_row_numbers(self, run_id: str) -> list[int]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT row_number
                FROM row_results
                WHERE run_id = ?
                  AND status NOT IN ('success', 'skipped_existing')
                ORDER BY row_number ASC
                """,
                (run_id,),
            ).fetchall()
            return [int(r["row_number"]) for r in rows]

    def export_run_csv(self, run_id: str, destination_csv_path: Path) -> Path:
        destination_csv_path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT row_number, speeda_id, company_name, country, status,
                       director_info, source_url, error_reason, attempt_count, updated_at
                FROM row_results
                WHERE run_id = ?
                ORDER BY row_number ASC
                """,
                (run_id,),
            ).fetchall()
        with destination_csv_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
                    "row_number",
                    "speeda_id",
                    "company_name",
                    "country",
                    "status",
                    "director_info",
                    "source_url",
                    "error_reason",
                    "attempt_count",
                    "updated_at",
                ]
            )
            for row in rows:
                writer.writerow(
                    [
                        row["row_number"],
                        row["speeda_id"],
                        row["company_name"],
                        row["country"],
                        row["status"],
                        row["director_info"],
                        row["source_url"],
                        row["error_reason"],
                        row["attempt_count"],
                        row["updated_at"],
                    ]
                )
        return destination_csv_path

