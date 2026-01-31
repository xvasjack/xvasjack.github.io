"""
Loop State Persistence

Saves and restores feedback loop state for crash recovery.
Uses atomic writes (write to .tmp, then rename) to prevent corruption.
"""

import json
import os
import time
import uuid
import logging
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, field, asdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("loop_state")

DEFAULT_LOOP_STATE_PATH = os.environ.get(
    "LOOP_STATE_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "loop_state.json"),
)

# Issue 86/32 fix: State schema version for migration support
STATE_SCHEMA_VERSION = 2


@dataclass
class PersistedLoopState:
    service_name: str
    iteration: int
    state: str
    prs_merged: int
    issue_tracker: Dict[str, int] = field(default_factory=dict)
    iterations_data: List[Dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    last_saved_at: float = 0.0
    # Issue 86/32 fix: Add schema version field
    schema_version: int = STATE_SCHEMA_VERSION

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["schema_version"] = STATE_SCHEMA_VERSION
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PersistedLoopState":
        # Issue 91 fix: Validate schema version and migrate if needed
        saved_version = data.get("schema_version", 1)
        if saved_version > STATE_SCHEMA_VERSION:
            raise ValueError(
                f"State file version {saved_version} is newer than supported version {STATE_SCHEMA_VERSION}. "
                f"Please update the agent."
            )

        # Migrate from older versions if needed
        if saved_version < STATE_SCHEMA_VERSION:
            data = cls._migrate_state(data, saved_version)

        return cls(
            service_name=data.get("service_name", ""),
            iteration=data.get("iteration", 0),
            state=data.get("state", "idle"),
            prs_merged=data.get("prs_merged", 0),
            issue_tracker=data.get("issue_tracker", {}),
            iterations_data=data.get("iterations_data", []),
            started_at=data.get("started_at", 0.0),
            last_saved_at=data.get("last_saved_at", 0.0),
            schema_version=STATE_SCHEMA_VERSION,
        )

    @classmethod
    def _migrate_state(cls, data: Dict[str, Any], from_version: int) -> Dict[str, Any]:
        """Issue 86 fix: Migrate state from older versions."""
        logger.info(f"Migrating state from version {from_version} to {STATE_SCHEMA_VERSION}")

        # v1 -> v2: Add issue_tracker if missing
        if from_version < 2:
            if "issue_tracker" not in data:
                data["issue_tracker"] = {}

        return data


def save_loop_state(
    state: PersistedLoopState,
    path: str = DEFAULT_LOOP_STATE_PATH,
) -> None:
    """Save loop state atomically (write .tmp then rename)."""
    state.last_saved_at = time.time()
    data = state.to_dict()

    # Issue 47/87 fix: Use UUID for temp file uniqueness to prevent collisions
    tmp_path = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
        logger.debug(f"Loop state saved: iteration={state.iteration}, state={state.state}")
    except Exception as e:
        logger.error(f"Failed to save loop state: {e}")
        # Clean up tmp file
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _cleanup_orphan_tmp_files(path: str):
    """RL-4: Clean up orphaned .tmp files from failed concurrent saves."""
    try:
        directory = os.path.dirname(path) or "."
        basename = os.path.basename(path)
        for filename in os.listdir(directory):
            # Match pattern: basename.UUID.tmp
            if filename.startswith(basename + ".") and filename.endswith(".tmp"):
                tmp_path = os.path.join(directory, filename)
                # Only clean up files older than 5 minutes
                try:
                    if time.time() - os.path.getmtime(tmp_path) > 300:
                        os.remove(tmp_path)
                        logger.debug(f"Cleaned up orphaned tmp file: {tmp_path}")
                except OSError:
                    pass
    except Exception as e:
        logger.debug(f"Orphan cleanup failed (non-critical): {e}")


def load_loop_state(
    path: str = DEFAULT_LOOP_STATE_PATH,
) -> Optional[PersistedLoopState]:
    """Load loop state from file. Returns None if not found or invalid."""
    # RL-4: Clean up orphaned temp files from failed concurrent saves
    _cleanup_orphan_tmp_files(path)

    if not os.path.exists(path):
        return None

    try:
        with open(path, "r") as f:
            content = f.read()

        # Issue 90 fix: Detect partial/corrupt JSON
        if not content.strip():
            logger.warning("State file is empty, ignoring")
            return None

        data = json.loads(content)

        # Issue 90 fix: Basic validation of data structure
        if not isinstance(data, dict):
            logger.warning(f"State file contains non-dict type: {type(data)}, ignoring")
            return None

        state = PersistedLoopState.from_dict(data)
        logger.info(
            f"Loaded loop state: service={state.service_name}, "
            f"iteration={state.iteration}, state={state.state}"
        )
        return state
    except json.JSONDecodeError as e:
        # Issue 90 fix: Handle corrupt JSON gracefully
        logger.error(f"State file contains invalid JSON: {e}")
        logger.warning("Ignoring corrupt state file - will start fresh")
        return None
    except ValueError as e:
        # Issue 91 fix: Handle schema version mismatch
        logger.error(f"State file validation error: {e}")
        return None
    except Exception as e:
        logger.error(f"Failed to load loop state: {e}")
        return None


def clear_loop_state(
    path: str = DEFAULT_LOOP_STATE_PATH,
) -> None:
    """Delete loop state file on successful completion."""
    if os.path.exists(path):
        try:
            os.remove(path)
            logger.info("Loop state cleared")
        except Exception as e:
            logger.error(f"Failed to clear loop state: {e}")
