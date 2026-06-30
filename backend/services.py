"""Unified streaming / loader service registry for the Services panel."""
from __future__ import annotations

from typing import Any

import spotify as spotify_svc
from apple_music import status as apple_music_status
from config import get_acrcloud_config, get_spotify_config, require_ffmpeg


def _ffmpeg_ready() -> bool:
    try:
        require_ffmpeg()
        return True
    except RuntimeError:
        return False


def list_services() -> list[dict[str, Any]]:
    ffmpeg_ok = _ffmpeg_ready()
    acr = get_acrcloud_config()
    am = apple_music_status()
    sp = spotify_svc.status()

    loaders = [
        {
            "id": "youtube",
            "name": "YouTube",
            "group": "load",
            "configured": ffmpeg_ok,
            "connected": ffmpeg_ok,
            "can_split": ffmpeg_ok,
            "can_play": False,
            "note": "Paste a YouTube mix or track URL in Load.",
            "env": [],
        },
        {
            "id": "soundcloud",
            "name": "SoundCloud",
            "group": "load",
            "configured": ffmpeg_ok,
            "connected": ffmpeg_ok,
            "can_split": ffmpeg_ok,
            "can_play": False,
            "note": "Paste a SoundCloud URL in Load.",
            "env": [],
        },
        {
            "id": "bandcamp",
            "name": "Bandcamp",
            "group": "load",
            "configured": ffmpeg_ok,
            "connected": ffmpeg_ok,
            "can_split": ffmpeg_ok,
            "can_play": False,
            "note": "Paste a Bandcamp URL in Load.",
            "env": [],
        },
        {
            "id": "local",
            "name": "Local files",
            "group": "load",
            "configured": ffmpeg_ok,
            "connected": ffmpeg_ok,
            "can_split": ffmpeg_ok,
            "can_play": False,
            "note": "Browse an MP3 or WAV in Load.",
            "env": [],
        },
    ]

    streams = [
        {
            "id": "spotify",
            "name": "Spotify",
            "group": "stream",
            "configured": sp["configured"],
            "connected": sp["connected"],
            "can_split": False,
            "can_play": True,
            "note": "Playback & catalog links — split/stem needs YouTube or local files.",
            "env": ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REDIRECT_URI"],
            "account": sp.get("display_name") or "",
            "redirect_uri": sp.get("redirect_uri") or "",
        },
        {
            "id": "apple_music",
            "name": "Apple Music",
            "group": "stream",
            "configured": am["configured"],
            "connected": False,
            "can_split": False,
            "can_play": True,
            "note": "MusicKit playback — add Apple keys to .env, then Connect.",
            "env": [
                "APPLE_MUSIC_TEAM_ID",
                "APPLE_MUSIC_KEY_ID",
                "APPLE_MUSIC_PRIVATE_KEY_PATH",
                "APPLE_MUSIC_STOREFRONT",
            ],
            "storefront": am.get("storefront") or "us",
        },
    ]

    tools = [
        {
            "id": "acrcloud",
            "name": "ACRCloud",
            "group": "tool",
            "configured": acr.configured,
            "connected": acr.configured,
            "can_split": False,
            "can_play": False,
            "note": "Auto-names tracks during analysis.",
            "env": ["ACRCLOUD_HOST", "ACRCLOUD_ACCESS_KEY", "ACRCLOUD_ACCESS_SECRET"],
        },
    ]

    return loaders + streams + tools


def services_summary() -> dict[str, Any]:
    items = list_services()
    return {
        "services": items,
        "ffmpeg": _ffmpeg_ready(),
        "stream_connected": sum(1 for s in items if s["group"] == "stream" and s.get("connected")),
        "stream_configured": sum(1 for s in items if s["group"] == "stream" and s.get("configured")),
    }
