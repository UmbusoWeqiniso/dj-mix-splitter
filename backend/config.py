"""Central configuration. Values come from the environment / .env file.

Per project policy there are no hardcoded secrets and no silent fallbacks:
identification requires real ACRCloud credentials, and the app fails loudly
if a required external tool (ffmpeg) is missing.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.getenv("DATA_DIR", ROOT / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class ACRCloudConfig:
    host: str
    access_key: str
    access_secret: str

    @property
    def configured(self) -> bool:
        return bool(self.host and self.access_key and self.access_secret)


@dataclass(frozen=True)
class AppleMusicConfig:
    team_id: str
    key_id: str
    private_key: str
    storefront: str

    @property
    def configured(self) -> bool:
        return bool(self.team_id and self.key_id and self.private_key)

    def private_key_pem(self) -> str:
        if not self.private_key:
            raise RuntimeError("Apple Music private key is missing.")
        return self.private_key


def get_apple_music_config() -> AppleMusicConfig:
    key_inline = os.getenv("APPLE_MUSIC_PRIVATE_KEY", "").strip()
    key_path = os.getenv("APPLE_MUSIC_PRIVATE_KEY_PATH", "").strip()
    private_key = key_inline
    if not private_key and key_path:
        path = Path(key_path).expanduser()
        if not path.is_file():
            raise RuntimeError(
                f"APPLE_MUSIC_PRIVATE_KEY_PATH does not exist: {path}. "
                "Download your .p8 key from Apple Developer → Certificates, Identifiers & Profiles."
            )
        private_key = path.read_text(encoding="utf-8").strip()
    storefront = os.getenv("APPLE_MUSIC_STOREFRONT", "us").strip().lower() or "us"
    return AppleMusicConfig(
        team_id=os.getenv("APPLE_MUSIC_TEAM_ID", "").strip(),
        key_id=os.getenv("APPLE_MUSIC_KEY_ID", "").strip(),
        private_key=private_key,
        storefront=storefront,
    )


def get_acrcloud_config() -> ACRCloudConfig:
    return ACRCloudConfig(
        host=os.getenv("ACRCLOUD_HOST", "").strip(),
        access_key=os.getenv("ACRCLOUD_ACCESS_KEY", "").strip(),
        access_secret=os.getenv("ACRCLOUD_ACCESS_SECRET", "").strip(),
    )


@dataclass(frozen=True)
class SpotifyConfig:
    client_id: str
    client_secret: str
    redirect_uri: str

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.redirect_uri)


def get_spotify_config() -> SpotifyConfig:
    port = os.getenv("PORT", "8000").strip() or "8000"
    default_redirect = f"http://127.0.0.1:{port}/api/services/spotify/callback"
    redirect = os.getenv("SPOTIFY_REDIRECT_URI", "").strip() or default_redirect
    return SpotifyConfig(
        client_id=os.getenv("SPOTIFY_CLIENT_ID", "").strip(),
        client_secret=os.getenv("SPOTIFY_CLIENT_SECRET", "").strip(),
        redirect_uri=redirect,
    )


def require_ffmpeg() -> str:
    """Return the ffmpeg executable path or raise a clear error."""
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(
            "ffmpeg is not installed or not on PATH. "
            "macOS: `brew install ffmpeg` · Windows: https://ffmpeg.org/download.html · "
            "Linux: `apt install ffmpeg`. Then restart the server."
        )
    return exe


# --- Tunable analysis parameters (sane musical defaults, not fallbacks) ---
ANALYSIS_SAMPLE_RATE = 22050          # downsample for segmentation features
MIN_TRACK_SECONDS = 75.0              # tracks shorter than this get merged into neighbours
ID_SAMPLE_SECONDS = 18.0             # length of clip sent to ACRCloud per track
WAVEFORM_PEAKS = 1600                 # number of peaks rendered in the UI waveform
