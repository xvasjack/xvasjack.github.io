from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = PROJECT_ROOT / "web"
DATA_DIR = PROJECT_ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
AUTH_DIR = DATA_DIR / "auth"
DEFAULT_AUTH_STATE_PATH = AUTH_DIR / "storage_state.json"
STATE_DB_PATH = DATA_DIR / "state.db"

DEFAULT_WORKBOOK_PATH = Path(r"C:\Users\User\OneDrive - YCP Holdings\potential seller.xlsx")
DEFAULT_SHEET_NAME = "Company List"
DEFAULT_START_ROW = 11
DEFAULT_END_ROW = 8673
DEFAULT_TARGET_COLUMN = "V"
DEFAULT_BASE_URL = "https://www.ub-speeda.com/"

DEFAULT_SERVER_HOST = "127.0.0.1"
DEFAULT_SERVER_PORT = 8787


def ensure_directories() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    AUTH_DIR.mkdir(parents=True, exist_ok=True)

