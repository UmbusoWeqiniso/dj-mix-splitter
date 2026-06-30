"""Spotify Web API — OAuth PKCE, token storage, catalog search."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
import urllib.parse
from typing import Any

import requests

from config import DATA_DIR, get_spotify_config

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPES = "user-read-private user-read-email streaming user-read-playback-state user-modify-playback-state"
TOKEN_PATH = DATA_DIR / "_services" / "spotify.json"
_pending_lock = threading.Lock()
_pending: dict[str, dict[str, Any]] = {}


def _services_dir() -> None:
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)


def configured() -> bool:
    return get_spotify_config().configured


def connected() -> bool:
    tokens = _load_tokens()
    return bool(tokens.get("refresh_token") or tokens.get("access_token"))


def status() -> dict[str, Any]:
    cfg = get_spotify_config()
    tokens = _load_tokens()
    return {
        "configured": cfg.configured,
        "connected": connected(),
        "redirect_uri": cfg.redirect_uri if cfg.configured else "",
        "display_name": tokens.get("display_name", ""),
    }


def _load_tokens() -> dict[str, Any]:
    if not TOKEN_PATH.exists():
        return {}
    try:
        return json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_tokens(data: dict[str, Any]) -> None:
    _services_dir()
    TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def disconnect() -> None:
    if TOKEN_PATH.exists():
        TOKEN_PATH.unlink()


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def login_url() -> dict[str, str]:
    cfg = get_spotify_config()
    if not cfg.configured:
        raise RuntimeError(
            "Spotify is not configured. Set SPOTIFY_CLIENT_ID in .env "
            "(and SPOTIFY_CLIENT_SECRET for some app types). See .env.example."
        )
    state = secrets.token_urlsafe(24)
    verifier, challenge = _pkce_pair()
    with _pending_lock:
        _pending[state] = {"verifier": verifier, "ts": time.time()}
        stale = [k for k, v in _pending.items() if time.time() - v.get("ts", 0) > 900]
        for k in stale:
            _pending.pop(k, None)
    params = {
        "client_id": cfg.client_id,
        "response_type": "code",
        "redirect_uri": cfg.redirect_uri,
        "state": state,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "scope": SCOPES,
    }
    return {"url": f"{AUTH_URL}?{urllib.parse.urlencode(params)}", "state": state}


def finish_login(code: str, state: str) -> None:
    cfg = get_spotify_config()
    with _pending_lock:
        pending = _pending.pop(state, None)
    if not pending:
        raise ValueError("OAuth state expired or invalid — try connecting again.")
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": cfg.redirect_uri,
        "client_id": cfg.client_id,
        "code_verifier": pending["verifier"],
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if cfg.client_secret:
        basic = base64.b64encode(f"{cfg.client_id}:{cfg.client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    res = requests.post(TOKEN_URL, data=data, headers=headers, timeout=20)
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Spotify token exchange failed ({res.status_code}): {detail}")
    payload = res.json()
    expires_at = int(time.time()) + int(payload.get("expires_in", 3600))
    stored = {
        "access_token": payload["access_token"],
        "refresh_token": payload.get("refresh_token", ""),
        "expires_at": expires_at,
        "scope": payload.get("scope", ""),
    }
    profile = _profile_with_token(stored["access_token"])
    if profile.get("display_name"):
        stored["display_name"] = profile["display_name"]
    _save_tokens(stored)


def _profile_with_token(access_token: str) -> dict[str, Any]:
    res = requests.get(
        f"{API_BASE}/me",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=20,
    )
    if not res.ok:
        return {}
    return res.json()


def _refresh_access_token(refresh_token: str) -> dict[str, Any]:
    cfg = get_spotify_config()
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": cfg.client_id,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if cfg.client_secret:
        basic = base64.b64encode(f"{cfg.client_id}:{cfg.client_secret}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    res = requests.post(TOKEN_URL, data=data, headers=headers, timeout=20)
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Spotify refresh failed ({res.status_code}): {detail}")
    payload = res.json()
    tokens = _load_tokens()
    tokens["access_token"] = payload["access_token"]
    tokens["expires_at"] = int(time.time()) + int(payload.get("expires_in", 3600))
    if payload.get("refresh_token"):
        tokens["refresh_token"] = payload["refresh_token"]
    _save_tokens(tokens)
    return tokens


def access_token() -> str:
    if not configured():
        raise RuntimeError("Spotify is not configured.")
    tokens = _load_tokens()
    if not tokens.get("refresh_token") and not tokens.get("access_token"):
        raise RuntimeError("Spotify is not connected.")
    if tokens.get("access_token") and int(tokens.get("expires_at", 0)) > time.time() + 60:
        return tokens["access_token"]
    if tokens.get("refresh_token"):
        refreshed = _refresh_access_token(tokens["refresh_token"])
        return refreshed["access_token"]
    raise RuntimeError("Spotify session expired — connect again in Services.")


def _client_credentials_token() -> str:
    cfg = get_spotify_config()
    if not cfg.client_secret:
        raise RuntimeError("Spotify client credentials require SPOTIFY_CLIENT_SECRET.")
    basic = base64.b64encode(f"{cfg.client_id}:{cfg.client_secret}".encode()).decode()
    res = requests.post(
        TOKEN_URL,
        data={"grant_type": "client_credentials"},
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=20,
    )
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Spotify auth failed ({res.status_code}): {detail}")
    return res.json()["access_token"]


def _api_token() -> str:
    if connected():
        return access_token()
    return _client_credentials_token()


def _track_attrs(item: dict[str, Any]) -> dict[str, Any]:
    album = item.get("album") or {}
    images = album.get("images") or []
    artwork = images[-1]["url"] if images else ""
    return {
        "id": item["id"],
        "title": item.get("name") or "Unknown",
        "artist": ", ".join(a["name"] for a in item.get("artists") or []),
        "album": album.get("name") or "",
        "duration": (item.get("duration_ms") or 0) / 1000,
        "url": (item.get("external_urls") or {}).get("spotify") or "",
        "artworkUrl": artwork,
    }


def search(term: str, *, limit: int = 20) -> list[dict[str, Any]]:
    q = term.strip()
    if not q:
        raise ValueError("Search term is required.")
    if not configured():
        raise RuntimeError("Spotify is not configured.")
    token = _api_token()
    res = requests.get(
        f"{API_BASE}/search",
        params={"q": q, "type": "track", "limit": min(max(limit, 1), 25)},
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Spotify search failed ({res.status_code}): {detail}")
    tracks = (((res.json() or {}).get("tracks") or {}).get("items")) or []
    return [_track_attrs(t) for t in tracks]


def lookup_track(track_id: str) -> dict[str, Any] | None:
    tid = track_id.strip()
    if not tid:
        raise ValueError("Track id is required.")
    if not configured():
        raise RuntimeError("Spotify is not configured.")
    token = _api_token()
    res = requests.get(
        f"{API_BASE}/tracks/{tid}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=20,
    )
    if res.status_code == 404:
        return None
    if not res.ok:
        detail = res.text.strip() or res.reason
        raise RuntimeError(f"Spotify lookup failed ({res.status_code}): {detail}")
    return _track_attrs(res.json())
