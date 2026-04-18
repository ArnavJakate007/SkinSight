from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import threading
from typing import Any
from uuid import uuid4

import cv2
import httpx
import numpy as np

from app.pipeline import analyze_image
from app.schemas import (
    LesionTypeSummary,
    RecoveryForecast,
    RoutineLogResponse,
    SkinMetrics,
    TrackerCompareResponse,
    TrackerComparison,
    TrackerImagePoint,
    TrackerInitResponse,
    TrackerMetricRow,
    TrackerOverviewResponse,
    TrackerRecord,
    TrackerReportResponse,
    TrackerUploadResponse,
)

DISCLAIMER_TEXT = "This is an AI-assisted skin assessment, not a medical diagnosis."
CLAUDE_MODEL_DEFAULT = "claude-3-5-haiku-latest"

_DB_LOCK = threading.Lock()
_DB_READY = False


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now_utc().isoformat()


def _tracker_db_path() -> Path:
    default_path = Path(__file__).resolve().parents[1] / "data" / "skinsight_tracker.sqlite3"
    configured = os.getenv("SKINSIGHT_TRACKER_DB_PATH", str(default_path))
    return Path(configured)


def tracker_asset_dir() -> Path:
    default_path = Path(__file__).resolve().parents[1] / "data" / "tracker_assets"
    configured = os.getenv("SKINSIGHT_TRACKER_ASSET_DIR", str(default_path))
    path = Path(configured)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _asset_path_from_url(url: str) -> Path:
    filename = Path(url).name
    return tracker_asset_dir() / filename


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_tracker_db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _ensure_db() -> None:
    global _DB_READY
    if _DB_READY:
        return

    db_path = _tracker_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with _DB_LOCK:
        if _DB_READY:
            return
        with _connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS trackers (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    start_date TEXT NOT NULL,
                    duration INTEGER NOT NULL,
                    concerns TEXT NOT NULL,
                    auto_delete_images INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS images (
                    id TEXT PRIMARY KEY,
                    tracker_id TEXT NOT NULL,
                    image_url TEXT NOT NULL,
                    lesion_overlay_url TEXT NOT NULL,
                    pigmentation_overlay_url TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    is_baseline INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY (tracker_id) REFERENCES trackers(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metrics (
                    image_id TEXT PRIMARY KEY,
                    acne_count INTEGER NOT NULL,
                    lesion_types TEXT NOT NULL,
                    pigmentation_score REAL NOT NULL,
                    redness_score REAL NOT NULL,
                    texture_score REAL NOT NULL,
                    oiliness_score REAL NOT NULL,
                    skin_health_score REAL NOT NULL,
                    raw_analysis_json TEXT NOT NULL,
                    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS routine_logs (
                    id TEXT PRIMARY KEY,
                    tracker_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    morning_routine TEXT NOT NULL,
                    night_routine TEXT NOT NULL,
                    adherence_score REAL NOT NULL,
                    FOREIGN KEY (tracker_id) REFERENCES trackers(id) ON DELETE CASCADE,
                    UNIQUE (tracker_id, date)
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_images_tracker_time
                ON images (tracker_id, timestamp)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_routine_tracker_date
                ON routine_logs (tracker_id, date)
                """
            )
            conn.commit()
        _DB_READY = True


def parse_concern_types(raw: str) -> list[str]:
    normalized = raw.strip()
    if not normalized:
        return []

    # Support JSON array and comma-separated formats to keep API ergonomic.
    json_candidates = [normalized, normalized.replace('\\"', '"')]
    if normalized.startswith('"') and normalized.endswith('"') and len(normalized) > 1:
        unquoted = normalized[1:-1]
        json_candidates.append(unquoted)
        json_candidates.append(unquoted.replace('\\"', '"'))

    for candidate in json_candidates:
        if not candidate.lstrip().startswith("["):
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            cleaned = [str(item).strip() for item in parsed if str(item).strip()]
            if cleaned:
                return list(dict.fromkeys(cleaned))

    cleaned = []
    for part in normalized.split(","):
        token = part.strip().strip('"').strip("'").strip("[]").strip()
        if token:
            cleaned.append(token)
    return list(dict.fromkeys(cleaned))


def _decode_image(image_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Unable to decode image")
    return image


def _jpeg_bytes_from_image(image_bgr: np.ndarray) -> bytes:
    ok, encoded = cv2.imencode(".jpg", image_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise ValueError("Failed to encode image")
    return encoded.tobytes()


def _coerce_to_jpeg_bytes(image_bytes: bytes) -> bytes:
    return _jpeg_bytes_from_image(_decode_image(image_bytes))


def _save_asset(file_stem: str, payload: bytes) -> str:
    filename = f"{file_stem}.jpg"
    path = tracker_asset_dir() / filename
    path.write_bytes(payload)
    return f"/tracker-assets/{filename}"


def _save_base64_asset(file_stem: str, encoded_b64: str) -> str:
    try:
        payload = base64.b64decode(encoded_b64)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid base64 payload for image asset") from exc
    return _save_asset(file_stem, payload)


def _clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def _lesion_types_from_analysis(acne_type_breakdown: dict[str, dict[str, int]]) -> LesionTypeSummary:
    totals = {
        "comedones": 0,
        "papules": 0,
        "pustules": 0,
        "nodules": 0,
    }
    for zone_types in acne_type_breakdown.values():
        totals["comedones"] += int(zone_types.get("comedone", 0))
        totals["papules"] += int(zone_types.get("papule", 0))
        totals["pustules"] += int(zone_types.get("pustule", 0))
        totals["nodules"] += int(zone_types.get("nodule_cyst", 0))
    return LesionTypeSummary(**totals)


def _build_pigmentation_overlay_base64(image_bytes: bytes) -> str:
    image = _decode_image(image_bytes)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]

    val_cut = float(np.percentile(val, 36))
    sat_cut = float(np.percentile(sat, 72))

    mask = np.logical_and(val < val_cut, sat < sat_cut).astype(np.uint8) * 255
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.GaussianBlur(mask, (7, 7), 0)

    heat = cv2.applyColorMap(mask, cv2.COLORMAP_TURBO)
    alpha = (mask.astype(np.float32) / 255.0)[:, :, None] * 0.45
    blended = image.astype(np.float32) * (1.0 - alpha) + heat.astype(np.float32) * alpha
    blended = np.clip(blended, 0, 255).astype(np.uint8)

    return base64.b64encode(_jpeg_bytes_from_image(blended)).decode("utf-8")


def _metrics_from_analysis(analysis_json: dict[str, Any]) -> SkinMetrics:
    acne_count = int(len(analysis_json.get("lesions", [])))
    lesion_types = _lesion_types_from_analysis(
        analysis_json.get("acne_type_breakdown", {}) or {}
    )
    pigmentation_score = float(
        (analysis_json.get("hyperpigmentation", {}) or {}).get("coverage_percent", 0.0)
    )

    inflammatory_load = (
        lesion_types.papules * 1.0
        + lesion_types.pustules * 1.35
        + lesion_types.nodules * 1.8
    )
    redness_score = _clamp(
        (inflammatory_load / max(1, acne_count)) * 55.0 + min(45.0, acne_count * 1.5),
        0.0,
        100.0,
    )

    oiliness_pressure = (
        lesion_types.comedones * 1.0
        + lesion_types.papules * 1.2
        + lesion_types.pustules * 1.4
        + lesion_types.nodules * 1.6
    )
    oiliness_score = _clamp(oiliness_pressure * 4.2, 0.0, 100.0)

    acne_score_0_1 = float(analysis_json.get("acne_score", 0.0))
    texture_score = _clamp(
        100.0 - (acne_score_0_1 * 58.0 + pigmentation_score * 0.24 + redness_score * 0.22),
        0.0,
        100.0,
    )

    overall_burden = (
        min(100.0, acne_count * 3.1) * 0.34
        + pigmentation_score * 0.22
        + redness_score * 0.18
        + (100.0 - texture_score) * 0.14
        + oiliness_score * 0.12
    )
    skin_health_score = _clamp(100.0 - overall_burden, 0.0, 100.0)

    return SkinMetrics(
        acne_count=acne_count,
        lesion_types=lesion_types,
        pigmentation_score=round(pigmentation_score, 2),
        redness_score=round(redness_score, 2),
        texture_score=round(texture_score, 2),
        oiliness_score=round(oiliness_score, 2),
        skin_health_score=round(skin_health_score, 2),
    )


def _skin_metrics_from_row(row: sqlite3.Row) -> SkinMetrics:
    parsed_lesion_types = json.loads(row["lesion_types"]) if row["lesion_types"] else {}
    return SkinMetrics(
        acne_count=int(row["acne_count"]),
        lesion_types=LesionTypeSummary(**parsed_lesion_types),
        pigmentation_score=float(row["pigmentation_score"]),
        redness_score=float(row["redness_score"]),
        texture_score=float(row["texture_score"]),
        oiliness_score=float(row["oiliness_score"]),
        skin_health_score=float(row["skin_health_score"]),
    )


def _pct_change(baseline: float, current: float, *, higher_is_better: bool) -> float:
    if abs(baseline) <= 1e-9:
        if higher_is_better:
            return 100.0 if current > baseline else 0.0
        return 100.0 if current <= baseline else -100.0

    if higher_is_better:
        value = ((current - baseline) / abs(baseline)) * 100.0
    else:
        value = ((baseline - current) / abs(baseline)) * 100.0
    return round(_clamp(value, -100.0, 100.0), 2)


def _build_comparison(
    baseline_image_id: str,
    current_image_id: str,
    baseline_metrics: SkinMetrics,
    current_metrics: SkinMetrics,
) -> TrackerComparison:
    return TrackerComparison(
        baseline_image_id=baseline_image_id,
        current_image_id=current_image_id,
        acne_reduction_percent=_pct_change(
            float(baseline_metrics.acne_count),
            float(current_metrics.acne_count),
            higher_is_better=False,
        ),
        pigmentation_improvement_percent=_pct_change(
            baseline_metrics.pigmentation_score,
            current_metrics.pigmentation_score,
            higher_is_better=False,
        ),
        redness_reduction_percent=_pct_change(
            baseline_metrics.redness_score,
            current_metrics.redness_score,
            higher_is_better=False,
        ),
        texture_improvement_percent=_pct_change(
            baseline_metrics.texture_score,
            current_metrics.texture_score,
            higher_is_better=True,
        ),
        skin_health_score_delta=round(
            current_metrics.skin_health_score - baseline_metrics.skin_health_score,
            2,
        ),
    )


def _recovery_percent(baseline_metrics: SkinMetrics, current_metrics: SkinMetrics) -> float:
    improvement_window = max(1.0, 100.0 - baseline_metrics.skin_health_score)
    progress = (
        (current_metrics.skin_health_score - baseline_metrics.skin_health_score)
        / improvement_window
    ) * 100.0
    return round(_clamp(progress, 0.0, 100.0), 2)


def _timeline_forecast(points: list[TrackerImagePoint]) -> RecoveryForecast:
    if len(points) < 2:
        return RecoveryForecast(
            estimated_days_to_mild_acne=None,
            estimated_days_to_target_health=None,
            narrative="Need at least two check-ins to estimate recovery timeline.",
        )

    first = points[0]
    last = points[-1]
    t0 = datetime.fromisoformat(first.timestamp)
    t1 = datetime.fromisoformat(last.timestamp)
    days = max(1.0, (t1 - t0).total_seconds() / 86400.0)

    acne_velocity = (first.metrics.acne_count - last.metrics.acne_count) / days
    health_velocity = (last.metrics.skin_health_score - first.metrics.skin_health_score) / days

    target_mild_acne_count = 5.0
    target_health = 85.0

    days_to_mild: int | None
    if acne_velocity > 1e-6 and last.metrics.acne_count > target_mild_acne_count:
        days_to_mild = int(
            np.ceil((last.metrics.acne_count - target_mild_acne_count) / acne_velocity)
        )
    elif last.metrics.acne_count <= target_mild_acne_count:
        days_to_mild = 0
    else:
        days_to_mild = None

    days_to_target_health: int | None
    if health_velocity > 1e-6 and last.metrics.skin_health_score < target_health:
        days_to_target_health = int(
            np.ceil((target_health - last.metrics.skin_health_score) / health_velocity)
        )
    elif last.metrics.skin_health_score >= target_health:
        days_to_target_health = 0
    else:
        days_to_target_health = None

    if days_to_mild is None and days_to_target_health is None:
        narrative = (
            "Improvement velocity is currently flat. Keep routine consistency for 10-14 days "
            "before recalculating projection."
        )
    else:
        parts: list[str] = []
        if days_to_mild is not None:
            parts.append(f"Estimated time to mild acne stage: ~{days_to_mild} days")
        if days_to_target_health is not None:
            parts.append(
                f"Estimated time to target skin health score: ~{days_to_target_health} days"
            )
        narrative = ". ".join(parts) + "."

    return RecoveryForecast(
        estimated_days_to_mild_acne=days_to_mild,
        estimated_days_to_target_health=days_to_target_health,
        narrative=narrative,
    )


def _comparison_insight(comparison: TrackerComparison) -> str:
    trend_label = "stable"
    if comparison.acne_reduction_percent >= 10:
        trend_label = "improving"
    elif comparison.acne_reduction_percent <= -10:
        trend_label = "worsening"

    return (
        f"Trend: {trend_label}. Acne reduction {comparison.acne_reduction_percent:.1f}%, "
        f"pigmentation improvement {comparison.pigmentation_improvement_percent:.1f}%, "
        f"redness reduction {comparison.redness_reduction_percent:.1f}% and "
        f"skin health delta {comparison.skin_health_score_delta:+.1f}."
    )

def _parse_iso_utc(raw_timestamp: str) -> datetime:
    candidate = raw_timestamp.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    parsed = datetime.fromisoformat(candidate)

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    else:
        parsed = parsed.astimezone(timezone.utc)
    return parsed




def _normalize_timestamp(raw_timestamp: str | None) -> str:
    if not raw_timestamp:
        return _iso_now()
    candidate = raw_timestamp.strip()
    if not candidate:
        return _iso_now()
    try:
        parsed = _parse_iso_utc(candidate)
    except ValueError as exc:
        raise ValueError("timestamp must be ISO-8601 format") from exc
    return parsed.isoformat()


def _row_to_tracker_record(row: sqlite3.Row) -> TrackerRecord:
    return TrackerRecord(
        id=str(row["id"]),
        user_id=str(row["user_id"]),
        start_date=str(row["start_date"]),
        duration_days=int(row["duration"]),
        concern_types=json.loads(row["concerns"]) if row["concerns"] else [],
        auto_delete_images=bool(row["auto_delete_images"]),
    )


def _baseline_point(points: list[TrackerImagePoint]) -> TrackerImagePoint:
    if not points:
        raise ValueError("No tracker images available")
    return next((point for point in points if point.is_baseline), points[0])


def _load_tracker(tracker_id: str) -> TrackerRecord:
    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM trackers WHERE id = ?",
                (tracker_id,),
            ).fetchone()
    if row is None:
        raise ValueError("tracker_id not found")
    return _row_to_tracker_record(row)


def _cleanup_old_assets_if_needed(tracker: TrackerRecord) -> None:
    if not tracker.auto_delete_images:
        return

    retention_days = int(os.getenv("SKINSIGHT_TRACKER_RETENTION_DAYS", "30"))
    cutoff_dt = _now_utc().timestamp() - retention_days * 86400

    _ensure_db()
    rows_to_remove: list[sqlite3.Row] = []
    with _DB_LOCK:
        with _connect() as conn:
            rows_to_remove = conn.execute(
                """
                SELECT id, image_url, lesion_overlay_url, pigmentation_overlay_url, timestamp
                FROM images
                WHERE tracker_id = ? AND is_baseline = 0
                """,
                (tracker.id,),
            ).fetchall()

            removable_ids: list[str] = []
            for row in rows_to_remove:
                try:
                    row_ts = datetime.fromisoformat(str(row["timestamp"]))
                except ValueError:
                    continue
                if row_ts.timestamp() < cutoff_dt:
                    removable_ids.append(str(row["id"]))

            for image_id in removable_ids:
                conn.execute("DELETE FROM images WHERE id = ?", (image_id,))
            conn.commit()

    for row in rows_to_remove:
        try:
            row_ts = datetime.fromisoformat(str(row["timestamp"]))
        except ValueError:
            continue
        if row_ts.timestamp() >= cutoff_dt:
            continue

        for url_key in ("image_url", "lesion_overlay_url", "pigmentation_overlay_url"):
            url = str(row[url_key])
            try:
                path = _asset_path_from_url(url)
                if path.exists():
                    path.unlink()
            except OSError:
                pass


def _store_tracker_image(
    *,
    tracker_id: str,
    image_bytes: bytes,
    timestamp: str,
    is_baseline: bool,
) -> tuple[str, SkinMetrics]:
    analysis = analyze_image(image_bytes)
    analysis_json = analysis.model_dump()
    metrics = _metrics_from_analysis(analysis_json)

    image_id = uuid4().hex

    original_url = _save_asset(f"{image_id}_original", _coerce_to_jpeg_bytes(image_bytes))
    lesion_overlay_url = _save_base64_asset(
        f"{image_id}_lesions",
        analysis_json["annotated_image_base64"],
    )

    pigmentation_overlay_b64 = _build_pigmentation_overlay_base64(image_bytes)
    pigmentation_overlay_url = _save_base64_asset(
        f"{image_id}_pigmentation",
        pigmentation_overlay_b64,
    )

    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO images (
                    id, tracker_id, image_url, lesion_overlay_url,
                    pigmentation_overlay_url, timestamp, is_baseline
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    image_id,
                    tracker_id,
                    original_url,
                    lesion_overlay_url,
                    pigmentation_overlay_url,
                    timestamp,
                    1 if is_baseline else 0,
                ),
            )
            conn.execute(
                """
                INSERT INTO metrics (
                    image_id, acne_count, lesion_types, pigmentation_score,
                    redness_score, texture_score, oiliness_score,
                    skin_health_score, raw_analysis_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    image_id,
                    metrics.acne_count,
                    json.dumps(metrics.lesion_types.model_dump(), separators=(",", ":")),
                    metrics.pigmentation_score,
                    metrics.redness_score,
                    metrics.texture_score,
                    metrics.oiliness_score,
                    metrics.skin_health_score,
                    json.dumps(analysis_json, separators=(",", ":")),
                ),
            )
            conn.commit()

    return image_id, metrics


def _timeline_points(tracker_id: str) -> list[TrackerImagePoint]:
    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            rows = conn.execute(
                """
                SELECT
                    i.id AS image_id,
                    i.timestamp AS image_timestamp,
                    i.is_baseline AS is_baseline,
                    i.image_url AS image_url,
                    i.lesion_overlay_url AS lesion_overlay_url,
                    i.pigmentation_overlay_url AS pigmentation_overlay_url,
                    m.acne_count AS acne_count,
                    m.lesion_types AS lesion_types,
                    m.pigmentation_score AS pigmentation_score,
                    m.redness_score AS redness_score,
                    m.texture_score AS texture_score,
                    m.oiliness_score AS oiliness_score,
                    m.skin_health_score AS skin_health_score,
                    m.raw_analysis_json AS raw_analysis_json
                FROM images i
                JOIN metrics m ON m.image_id = i.id
                WHERE i.tracker_id = ?
                ORDER BY i.is_baseline DESC, i.timestamp ASC, i.id ASC
                """,
                (tracker_id,),
            ).fetchall()

    if not rows:
        return []

    first_time = datetime.fromisoformat(str(rows[0]["image_timestamp"]))
    points: list[TrackerImagePoint] = []
    for row in rows:
        ts = datetime.fromisoformat(str(row["image_timestamp"]))
        day_index = max(0, int((ts - first_time).total_seconds() // 86400))

        parsed_lesion_types = (
            json.loads(str(row["lesion_types"])) if row["lesion_types"] else {}
        )
        metrics = SkinMetrics(
            acne_count=int(row["acne_count"]),
            lesion_types=LesionTypeSummary(**parsed_lesion_types),
            pigmentation_score=float(row["pigmentation_score"]),
            redness_score=float(row["redness_score"]),
            texture_score=float(row["texture_score"]),
            oiliness_score=float(row["oiliness_score"]),
            skin_health_score=float(row["skin_health_score"]),
        )
        points.append(
            TrackerImagePoint(
                image_id=str(row["image_id"]),
                timestamp=str(row["image_timestamp"]),
                day_index=day_index,
                is_baseline=bool(row["is_baseline"]),
                image_url=str(row["image_url"]),
                lesion_overlay_url=str(row["lesion_overlay_url"]),
                pigmentation_overlay_url=str(row["pigmentation_overlay_url"]),
                metrics=metrics,
            )
        )

    return points


def _fetch_metric_row_for_image(image_id: str) -> TrackerMetricRow:
    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM metrics WHERE image_id = ?",
                (image_id,),
            ).fetchone()
    if row is None:
        raise ValueError("image_id not found")

    return TrackerMetricRow(
        image_id=str(row["image_id"]),
        acne_count=int(row["acne_count"]),
        lesion_types=json.loads(row["lesion_types"]),
        pigmentation_score=float(row["pigmentation_score"]),
        redness_score=float(row["redness_score"]),
        texture_score=float(row["texture_score"]),
        oiliness_score=float(row["oiliness_score"]),
        skin_health_score=float(row["skin_health_score"]),
        raw_analysis_json=json.loads(row["raw_analysis_json"]),
    )


def _adherence_percent(tracker_id: str) -> float:
    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                """
                SELECT AVG(adherence_score) AS adherence
                FROM routine_logs
                WHERE tracker_id = ?
                """,
                (tracker_id,),
            ).fetchone()
    adherence = float(row["adherence"] or 0.0) if row is not None else 0.0
    return round(_clamp(adherence, 0.0, 100.0), 2)


def initialize_tracker(
    *,
    user_id: str,
    concern_types: list[str],
    duration_days: int,
    baseline_image_bytes: bytes,
    auto_delete_images: bool,
) -> TrackerInitResponse:
    _ensure_db()

    if duration_days <= 0:
        raise ValueError("duration_days must be greater than zero")
    if duration_days > 365:
        raise ValueError("duration_days must be <= 365")

    tracker_id = uuid4().hex
    start_date = _iso_now()

    with _DB_LOCK:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO trackers (id, user_id, start_date, duration, concerns, auto_delete_images)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    tracker_id,
                    user_id.strip(),
                    start_date,
                    duration_days,
                    json.dumps(concern_types, separators=(",", ":")),
                    1 if auto_delete_images else 0,
                ),
            )
            conn.commit()

    baseline_image_id, baseline_metrics = _store_tracker_image(
        tracker_id=tracker_id,
        image_bytes=baseline_image_bytes,
        timestamp=start_date,
        is_baseline=True,
    )

    return TrackerInitResponse(
        tracker_id=tracker_id,
        baseline_image_id=baseline_image_id,
        baseline_metrics=baseline_metrics,
        disclaimer=DISCLAIMER_TEXT,
    )


def upload_progress_image(
    *,
    tracker_id: str,
    image_bytes: bytes,
    timestamp: str | None,
) -> TrackerUploadResponse:
    tracker = _load_tracker(tracker_id)
    _cleanup_old_assets_if_needed(tracker)

    image_timestamp = _normalize_timestamp(timestamp)
    if _parse_iso_utc(image_timestamp) < _parse_iso_utc(tracker.start_date):
        raise ValueError("timestamp cannot be earlier than baseline capture time")

    current_image_id, updated_metrics = _store_tracker_image(
        tracker_id=tracker_id,
        image_bytes=image_bytes,
        timestamp=image_timestamp,
        is_baseline=False,
    )

    points = _timeline_points(tracker_id)
    if not points:
        raise ValueError("No tracker images available")

    baseline = _baseline_point(points)
    current = next((p for p in points if p.image_id == current_image_id), points[-1])
    comparison = _build_comparison(
        baseline.image_id,
        current.image_id,
        baseline.metrics,
        current.metrics,
    )
    prediction = _timeline_forecast(points)
    recovery_percent = _recovery_percent(baseline.metrics, current.metrics)

    return TrackerUploadResponse(
        tracker_id=tracker_id,
        image_id=current.image_id,
        updated_metrics=updated_metrics,
        comparison=comparison,
        prediction=prediction,
        recovery_percent=recovery_percent,
        latest_insights=_comparison_insight(comparison),
        disclaimer=DISCLAIMER_TEXT,
    )


def compare_tracker_progress(
    *,
    tracker_id: str,
    current_image_id: str | None,
) -> TrackerCompareResponse:
    tracker = _load_tracker(tracker_id)
    _cleanup_old_assets_if_needed(tracker)

    points = _timeline_points(tracker_id)
    if len(points) < 2:
        raise ValueError("At least one baseline and one progress image are required")

    baseline = _baseline_point(points)
    if current_image_id:
        current = next((item for item in points if item.image_id == current_image_id), None)
        if current is None:
            raise ValueError("current_image_id not found for this tracker")
    else:
        current = points[-1]

    comparison = _build_comparison(
        baseline.image_id,
        current.image_id,
        baseline.metrics,
        current.metrics,
    )
    prediction = _timeline_forecast(points)
    recovery_percent = _recovery_percent(baseline.metrics, current.metrics)

    return TrackerCompareResponse(
        tracker_id=tracker_id,
        baseline_metrics=baseline.metrics,
        current_metrics=current.metrics,
        comparison=comparison,
        prediction=prediction,
        recovery_percent=recovery_percent,
        disclaimer=DISCLAIMER_TEXT,
    )


def log_routine(
    *,
    tracker_id: str,
    date: str,
    morning_routine: dict[str, bool],
    night_routine: dict[str, bool],
    adherence_score: float | None,
) -> RoutineLogResponse:
    _load_tracker(tracker_id)

    day = date.strip()
    if not day:
        raise ValueError("date is required")

    if adherence_score is None:
        checks = list(morning_routine.values()) + list(night_routine.values())
        adherence_score = (
            (sum(1 for done in checks if done) / len(checks)) * 100.0 if checks else 0.0
        )

    adherence_score = round(_clamp(float(adherence_score), 0.0, 100.0), 2)

    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            existing = conn.execute(
                """
                SELECT id FROM routine_logs
                WHERE tracker_id = ? AND date = ?
                """,
                (tracker_id, day),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO routine_logs (
                        id, tracker_id, date, morning_routine, night_routine, adherence_score
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        uuid4().hex,
                        tracker_id,
                        day,
                        json.dumps(morning_routine, separators=(",", ":")),
                        json.dumps(night_routine, separators=(",", ":")),
                        adherence_score,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE routine_logs
                    SET morning_routine = ?, night_routine = ?, adherence_score = ?
                    WHERE tracker_id = ? AND date = ?
                    """,
                    (
                        json.dumps(morning_routine, separators=(",", ":")),
                        json.dumps(night_routine, separators=(",", ":")),
                        adherence_score,
                        tracker_id,
                        day,
                    ),
                )
            conn.commit()

    return RoutineLogResponse(
        tracker_id=tracker_id,
        date=day,
        adherence_score=adherence_score,
    )


def tracker_overview(tracker_id: str) -> TrackerOverviewResponse:
    tracker = _load_tracker(tracker_id)
    _cleanup_old_assets_if_needed(tracker)

    points = _timeline_points(tracker_id)
    if not points:
        raise ValueError("No images available for tracker")

    baseline = _baseline_point(points)
    latest = points[-1]
    comparison = _build_comparison(
        baseline.image_id,
        latest.image_id,
        baseline.metrics,
        latest.metrics,
    )
    prediction = _timeline_forecast(points)
    recovery_percent = _recovery_percent(baseline.metrics, latest.metrics)

    return TrackerOverviewResponse(
        tracker_id=tracker.id,
        user_id=tracker.user_id,
        start_date=tracker.start_date,
        duration_days=tracker.duration_days,
        concern_types=tracker.concern_types,
        adherence_percent=_adherence_percent(tracker.id),
        recovery_percent=recovery_percent,
        latest_metrics=latest.metrics,
        latest_insights=_comparison_insight(comparison),
        prediction=prediction,
        timeline=points,
        disclaimer=DISCLAIMER_TEXT,
    )


def _tracker_prompt(
    *,
    concerns: list[str],
    duration_days: int,
    comparison: TrackerComparison,
    current_metrics: SkinMetrics,
    prediction: RecoveryForecast,
) -> str:
    concerns_text = ", ".join(concerns) if concerns else "general skin recovery"

    return (
        "You are an evidence-oriented skincare assistant. "
        "Use non-diagnostic language and keep recommendations safe and practical.\n\n"
        f"Tracking concerns: {concerns_text}\n"
        f"Plan duration: {duration_days} days\n"
        f"Acne reduction: {comparison.acne_reduction_percent:.1f}%\n"
        f"Pigmentation improvement: {comparison.pigmentation_improvement_percent:.1f}%\n"
        f"Redness reduction: {comparison.redness_reduction_percent:.1f}%\n"
        f"Texture improvement: {comparison.texture_improvement_percent:.1f}%\n"
        f"Skin health score delta: {comparison.skin_health_score_delta:+.1f}\n"
        f"Current acne count: {current_metrics.acne_count}\n"
        f"Current pigmentation score: {current_metrics.pigmentation_score:.1f}\n"
        f"Current redness score: {current_metrics.redness_score:.1f}\n"
        f"Current texture score: {current_metrics.texture_score:.1f}\n"
        f"Current oiliness score: {current_metrics.oiliness_score:.1f}\n"
        f"Current skin health score: {current_metrics.skin_health_score:.1f}\n"
        f"Forecast: {prediction.narrative}\n\n"
        "Return exactly three sections with short headings:\n"
        "1) Improvement trend\n"
        "2) Concern-specific insights\n"
        "3) Actionable next steps for next 7 days\n"
        "Include one caution line about when to consult a dermatologist."
    )


def _claude_request(prompt: str) -> tuple[str, str, str]:
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    model = os.getenv("ANTHROPIC_MODEL", CLAUDE_MODEL_DEFAULT).strip() or CLAUDE_MODEL_DEFAULT

    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured")

    payload = {
        "model": model,
        "max_tokens": 700,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": prompt}],
    }

    with httpx.Client(timeout=httpx.Timeout(35.0, connect=5.0)) as client:
        response = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        data = response.json()

    blocks = data.get("content", []) if isinstance(data, dict) else []
    text_parts = [blk.get("text", "") for blk in blocks if blk.get("type") == "text"]
    text = "\n".join(part for part in text_parts if part).strip()
    if not text:
        raise RuntimeError("Claude returned empty response")

    return "claude", model, text


def _fallback_report_text(
    *,
    comparison: TrackerComparison,
    prediction: RecoveryForecast,
    current_metrics: SkinMetrics,
    reason: str,
) -> str:
    return (
        "Improvement trend\n"
        f"- Acne reduction: {comparison.acne_reduction_percent:.1f}%\n"
        f"- Pigmentation improvement: {comparison.pigmentation_improvement_percent:.1f}%\n"
        f"- Redness reduction: {comparison.redness_reduction_percent:.1f}%\n"
        f"- Skin health delta: {comparison.skin_health_score_delta:+.1f}\n\n"
        "Concern-specific insights\n"
        f"- Current acne count is {current_metrics.acne_count}.\n"
        f"- Skin health score is {current_metrics.skin_health_score:.1f}/100 with texture score {current_metrics.texture_score:.1f}.\n"
        f"- Forecast snapshot: {prediction.narrative}\n\n"
        "Actionable next steps for next 7 days\n"
        "- Keep cleansing and moisturizing routine consistent daily.\n"
        "- Use broad-spectrum sunscreen each morning to reduce pigmentation persistence.\n"
        "- Avoid introducing multiple strong actives at the same time.\n"
        "- If painful nodules, scarring, or persistent worsening continue, consult a dermatologist.\n\n"
        f"Local fallback note: Claude response unavailable ({reason})."
    )


def generate_tracker_report(
    *,
    tracker_id: str,
    current_image_id: str | None,
) -> TrackerReportResponse:
    tracker = _load_tracker(tracker_id)
    compare_payload = compare_tracker_progress(
        tracker_id=tracker.id,
        current_image_id=current_image_id,
    )

    prompt = _tracker_prompt(
        concerns=tracker.concern_types,
        duration_days=tracker.duration_days,
        comparison=compare_payload.comparison,
        current_metrics=compare_payload.current_metrics,
        prediction=compare_payload.prediction,
    )

    try:
        generated_by, model, summary = _claude_request(prompt)
    except Exception as exc:  # noqa: BLE001
        generated_by = "fallback"
        model = os.getenv("ANTHROPIC_MODEL", CLAUDE_MODEL_DEFAULT)
        summary = _fallback_report_text(
            comparison=compare_payload.comparison,
            prediction=compare_payload.prediction,
            current_metrics=compare_payload.current_metrics,
            reason=str(exc),
        )

    return TrackerReportResponse(
        generated_by=generated_by,
        model=model,
        summary=summary,
        created_at=_iso_now(),
        disclaimer=DISCLAIMER_TEXT,
    )
