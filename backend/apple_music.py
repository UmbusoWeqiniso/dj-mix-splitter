"""Apple Music API helpers — developer token + catalog search proxy."""
from __future__ import annotations

import time
from typing import Any

import jwt
import requests

from config import get_apple_music_config

CATALOG_BASE = "https://api.music.apple.com/v1/catalog"
TOKEN_TTL_SECONDS = 3600 * 12  # refresh well before Apple's 6-month max


def _private_key_pem() -> str:
    cfg = get_apple_music_config()
    if not cfg.configured:
        raise RuntimeError(
            "Apple Music is not configured. Set APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, "
            "and APPLE_MUSIC_PRIVATE_KEY (or APPLE_MUSIC_PRIVATE_KEY_PATH) in .env — "
            "see .env.example."
        )
    return cfg.private_key_pem()


def developer_token() -> str:
    """Return a signed MusicKit developer token (ES256 JWT)."""
    cfg = get_apple_music_config()
    now = int(time.time())
    payload = {
        "iss": cfg.team_id,
        "iat": now,
        "exp": now + TOKEN_TTL_SECONDS,
    }
    headers = {"kid": cfg.key_id, "alg": "ES256"}
    return jwt.encode(payload, _private_key_pem(), algorithm="ES256", headers=headers)


def status() -> dict[str, Any]:
    cfg = get_apple_music_config()
    return {
        "configured": cfg.configured,
        "storefront": cfg.storefront,
    }


def catalog_search(term: str, *, types: str = "songs", limit: int = 20) -> dict[str, Any]:
    """Search the Apple Music catalog (developer token only — no user login)."""
    q = term.strip()
    if not q:
        raise ValueError("Search term is required.")
    cfg = get_apple_music_config()
    if not cfg.configured:
        raise RuntimeError("Apple Music is not configured.")

    url = f"{CATALOG_BASE}/{cfg.storefront}/search"
    params = {
        "term": q,
        "types": types,
        "limit": min(max(limit, 1), 25),
    }
    res = requests.get(
        url,
        params=params,
        headers={"Authorization": f"Bearer {developer_token()}"},
        timeout=20,
    )
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Apple Music search failed ({res.status_code}): {detail}")
    return res.json()


def catalog_song(song_id: str) -> dict[str, Any] | None:
    """Fetch a single catalog song by ID."""
    sid = song_id.strip()
    if not sid:
        raise ValueError("Song id is required.")
    cfg = get_apple_music_config()
    if not cfg.configured:
        raise RuntimeError("Apple Music is not configured.")

    url = f"{CATALOG_BASE}/{cfg.storefront}/songs/{sid}"
    res = requests.get(
        url,
        headers={"Authorization": f"Bearer {developer_token()}"},
        timeout=20,
    )
    if res.status_code == 404:
        return None
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Apple Music lookup failed ({res.status_code}): {detail}")
    data = res.json()
    songs = data.get("data") or []
    return songs[0] if songs else None
