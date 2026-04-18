from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import threading

from app.schemas import AnalysisResult, ProgressReport

_DB_LOCK = threading.Lock()
_DB_READY = False


def _db_path() -> Path:
    default_path = Path(__file__).resolve().parents[1] / "data" / "skinsight_backup.sqlite3"
    configured = os.getenv("SKINSIGHT_SQLITE_PATH", str(default_path))
    return Path(configured)


def _ensure_db() -> Path:
    global _DB_READY
    db_path = _db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if _DB_READY:
        return db_path

    with _DB_LOCK:
        if _DB_READY:
            return db_path
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS analyze_backup (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    source_filename TEXT,
                    source_content_type TEXT,
                    source_image BLOB NOT NULL,
                    response_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS track_backup (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    baseline_filename TEXT,
                    baseline_content_type TEXT,
                    baseline_image BLOB NOT NULL,
                    followup_filename TEXT,
                    followup_content_type TEXT,
                    followup_image BLOB NOT NULL,
                    response_json TEXT NOT NULL
                )
                """
            )
            conn.commit()
        _DB_READY = True
    return db_path


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def store_analyze_backup(
    *,
    source_filename: str,
    source_content_type: str | None,
    image_bytes: bytes,
    result: AnalysisResult,
) -> None:
    db_path = _ensure_db()
    payload_json = json.dumps(result.model_dump(), separators=(",", ":"))
    with _DB_LOCK:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO analyze_backup (
                    created_at,
                    source_filename,
                    source_content_type,
                    source_image,
                    response_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    _utc_now(),
                    source_filename,
                    source_content_type,
                    image_bytes,
                    payload_json,
                ),
            )
            conn.commit()


def store_track_backup(
    *,
    baseline_filename: str,
    baseline_content_type: str | None,
    baseline_image_bytes: bytes,
    followup_filename: str,
    followup_content_type: str | None,
    followup_image_bytes: bytes,
    result: ProgressReport,
) -> None:
    db_path = _ensure_db()
    payload_json = json.dumps(result.model_dump(), separators=(",", ":"))
    with _DB_LOCK:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO track_backup (
                    created_at,
                    baseline_filename,
                    baseline_content_type,
                    baseline_image,
                    followup_filename,
                    followup_content_type,
                    followup_image,
                    response_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    _utc_now(),
                    baseline_filename,
                    baseline_content_type,
                    baseline_image_bytes,
                    followup_filename,
                    followup_content_type,
                    followup_image_bytes,
                    payload_json,
                ),
            )
            conn.commit()
