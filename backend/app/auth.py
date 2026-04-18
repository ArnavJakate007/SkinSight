from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from uuid import uuid4

from app.schemas import AuthUserResponse

_DB_LOCK = threading.Lock()
_DB_READY = False
_TOKEN_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60
_DEV_SECRET_FALLBACK = "skinsight-local-dev-secret"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _auth_db_path() -> Path:
    default_path = Path(__file__).resolve().parents[1] / "data" / "skinsight_auth.sqlite3"
    configured = os.getenv("SKINSIGHT_AUTH_DB_PATH", str(default_path))
    return Path(configured)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_auth_db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_db() -> None:
    global _DB_READY
    if _DB_READY:
        return

    db_path = _auth_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    with _DB_LOCK:
        if _DB_READY:
            return
        with _connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_users_email
                ON users (email)
                """
            )
            conn.commit()
        _DB_READY = True


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _validate_email(email: str) -> str:
    normalized = _normalize_email(email)
    if not normalized or "@" not in normalized:
        raise ValueError("A valid email is required")
    local, _, domain = normalized.partition("@")
    if not local or "." not in domain:
        raise ValueError("A valid email is required")
    return normalized


def _validate_password(password: str) -> None:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters")


def _password_hash(password: str, salt_hex: str) -> str:
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        310000,
    )
    return digest.hex()


def _token_secret() -> bytes:
    configured = os.getenv("SKINSIGHT_AUTH_SECRET", "").strip()
    if configured:
        return configured.encode("utf-8")
    return _DEV_SECRET_FALLBACK.encode("utf-8")


def _token_ttl_seconds() -> int:
    configured = os.getenv("SKINSIGHT_AUTH_TOKEN_TTL_SECONDS", "").strip()
    if not configured:
        return _TOKEN_TTL_SECONDS_DEFAULT
    try:
        ttl = int(configured)
    except ValueError as exc:
        raise ValueError("SKINSIGHT_AUTH_TOKEN_TTL_SECONDS must be an integer") from exc
    return max(60, ttl)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    padded = raw + "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _sign(message: str) -> str:
    digest = hmac.new(_token_secret(), message.encode("ascii"), hashlib.sha256).digest()
    return _b64url_encode(digest)


def _user_from_row(row: sqlite3.Row) -> AuthUserResponse:
    return AuthUserResponse(
        id=str(row["id"]),
        name=str(row["name"]),
        email=str(row["email"]),
        created_at=str(row["created_at"]),
    )


def issue_access_token(user_id: str) -> str:
    payload = {
        "uid": user_id,
        "exp": int(time.time()) + _token_ttl_seconds(),
    }
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded_payload = _b64url_encode(payload_json)
    return f"{encoded_payload}.{_sign(encoded_payload)}"


def verify_access_token(token: str) -> str:
    token = token.strip()
    if not token or "." not in token:
        raise ValueError("Invalid authentication token")

    encoded_payload, signature = token.split(".", 1)
    expected_signature = _sign(encoded_payload)
    if not hmac.compare_digest(signature, expected_signature):
        raise ValueError("Invalid authentication token")

    try:
        payload = json.loads(_b64url_decode(encoded_payload).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid authentication token") from exc

    user_id = str(payload.get("uid", "")).strip()
    if not user_id:
        raise ValueError("Invalid authentication token")

    try:
        exp = int(payload.get("exp", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid authentication token") from exc

    if exp <= int(time.time()):
        raise ValueError("Session expired. Please log in again")

    return user_id


def register_user(*, name: str, email: str, password: str) -> tuple[AuthUserResponse, str]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Name is required")

    clean_email = _validate_email(email)
    _validate_password(password)

    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            existing = conn.execute(
                "SELECT id FROM users WHERE email = ?",
                (clean_email,),
            ).fetchone()
            if existing is not None:
                raise ValueError("An account with this email already exists")

            user_id = f"usr_{uuid4().hex[:24]}"
            salt_hex = secrets.token_hex(16)
            created_at = _now_iso()
            conn.execute(
                """
                INSERT INTO users (id, name, email, password_hash, password_salt, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    clean_name,
                    clean_email,
                    _password_hash(password, salt_hex),
                    salt_hex,
                    created_at,
                ),
            )
            conn.commit()

            user_row = conn.execute(
                "SELECT id, name, email, created_at FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()

    if user_row is None:
        raise RuntimeError("Failed to create account")

    user = _user_from_row(user_row)
    return user, issue_access_token(user.id)


def authenticate_user(*, email: str, password: str) -> tuple[AuthUserResponse, str]:
    clean_email = _validate_email(email)
    if not password:
        raise ValueError("Password is required")

    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, email, created_at, password_hash, password_salt
                FROM users
                WHERE email = ?
                """,
                (clean_email,),
            ).fetchone()

    if row is None:
        raise ValueError("Invalid email or password")

    expected_hash = str(row["password_hash"])
    computed_hash = _password_hash(password, str(row["password_salt"]))
    if not hmac.compare_digest(expected_hash, computed_hash):
        raise ValueError("Invalid email or password")

    user = AuthUserResponse(
        id=str(row["id"]),
        name=str(row["name"]),
        email=str(row["email"]),
        created_at=str(row["created_at"]),
    )
    return user, issue_access_token(user.id)


def get_user_by_id(user_id: str) -> AuthUserResponse | None:
    clean_user_id = user_id.strip()
    if not clean_user_id:
        return None

    _ensure_db()
    with _DB_LOCK:
        with _connect() as conn:
            row = conn.execute(
                "SELECT id, name, email, created_at FROM users WHERE id = ?",
                (clean_user_id,),
            ).fetchone()

    if row is None:
        return None
    return _user_from_row(row)
