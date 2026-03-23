from __future__ import annotations

import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import openpyxl
from openpyxl.workbook.workbook import Workbook
from openpyxl.worksheet.worksheet import Worksheet


@dataclass(frozen=True)
class CompanyRow:
    row_number: int
    speeda_id: str | None
    company_name: str
    country: str | None
    existing_director_info: str | None


class WorkbookAdapter:
    def __init__(
        self,
        source_workbook_path: Path,
        sheet_name: str,
        start_row: int,
        end_row: int,
        target_column: str,
    ) -> None:
        self.source_workbook_path = source_workbook_path
        self.sheet_name = sheet_name
        self.start_row = start_row
        self.end_row = end_row
        self.target_column = target_column.upper()
        self.working_workbook_path: Path | None = None
        self._workbook: Workbook | None = None
        self._sheet: Worksheet | None = None

    def prepare_working_copy(self, run_dir: Path, source_override: Path | None = None) -> Path:
        run_dir.mkdir(parents=True, exist_ok=True)
        src = source_override if source_override else self.source_workbook_path
        destination = run_dir / "working.xlsx"
        shutil.copy2(src, destination)
        self.working_workbook_path = destination
        return destination

    def load(self) -> None:
        if not self.working_workbook_path:
            raise RuntimeError("Working workbook path is not prepared.")
        self._workbook = openpyxl.load_workbook(self.working_workbook_path)
        if self.sheet_name not in self._workbook.sheetnames:
            raise ValueError(f"Sheet '{self.sheet_name}' not found in workbook.")
        self._sheet = self._workbook[self.sheet_name]

    @property
    def sheet(self) -> Worksheet:
        if not self._sheet:
            raise RuntimeError("Workbook is not loaded.")
        return self._sheet

    def iter_company_rows(self) -> Iterable[CompanyRow]:
        for row_num in range(self.start_row, self.end_row + 1):
            company_name = self.sheet[f"D{row_num}"].value
            if company_name is None:
                continue
            company_name = str(company_name).strip()
            if not company_name:
                continue

            speeda_id_raw = self.sheet[f"A{row_num}"].value
            country_raw = self.sheet[f"G{row_num}"].value
            director_raw = self.sheet[f"{self.target_column}{row_num}"].value

            speeda_id = str(speeda_id_raw).strip() if speeda_id_raw is not None else None
            country = str(country_raw).strip() if country_raw is not None else None
            director_info = str(director_raw).strip() if director_raw is not None else None

            yield CompanyRow(
                row_number=row_num,
                speeda_id=speeda_id if speeda_id else None,
                company_name=company_name,
                country=country if country else None,
                existing_director_info=director_info if director_info else None,
            )

    def write_director_info(self, row_number: int, value: str) -> None:
        self.sheet[f"{self.target_column}{row_number}"].value = value

    def save(self) -> None:
        if not self._workbook or not self.working_workbook_path:
            raise RuntimeError("Workbook is not loaded.")
        self._workbook.save(self.working_workbook_path)

    def sync_to_source(self) -> None:
        if not self.working_workbook_path:
            raise RuntimeError("Working workbook path is not prepared.")
        self.source_workbook_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.source_workbook_path.with_name(
            f"{self.source_workbook_path.stem}.codex_sync{self.source_workbook_path.suffix}"
        )
        last_error: Exception | None = None
        for _ in range(20):
            try:
                shutil.copy2(self.working_workbook_path, temp_path)
                temp_path.replace(self.source_workbook_path)
                return
            except PermissionError as exc:
                last_error = exc
                time.sleep(1.5)
        if last_error:
            raise PermissionError(
                f"Could not update the source workbook after repeated retries: {self.source_workbook_path}"
            ) from last_error

    def close(self) -> None:
        if self._workbook:
            self._workbook.close()
        self._workbook = None
        self._sheet = None

    def export(self, destination_path: Path) -> Path:
        if not self.working_workbook_path:
            raise RuntimeError("Working workbook path is not prepared.")
        destination_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.working_workbook_path, destination_path)
        return destination_path
