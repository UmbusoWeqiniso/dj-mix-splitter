"""Download the audio of a YouTube (or other yt-dlp supported) URL as WAV."""
from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

import yt_dlp

ProgressCb = Optional[Callable[[float, str], None]]


def download_audio(url: str, out_dir: Path, on_progress: ProgressCb = None) -> dict:
    """Download bestaudio and transcode to a single WAV file.

    Returns a dict with keys: path, title, duration, uploader, webpage_url.
    Raises on failure (no silent fallback).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(out_dir / "source.%(ext)s")

    def _hook(d: dict) -> None:
        if on_progress is None:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            frac = (done / total) if total else 0.0
            on_progress(frac, f"Downloading audio… {int(frac * 100)}%")
        elif d.get("status") == "finished":
            on_progress(1.0, "Download finished, transcoding…")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": out_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [_hook],
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
            }
        ],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    wav_path = out_dir / "source.wav"
    if not wav_path.exists():
        raise RuntimeError(
            "Audio download/transcode did not produce a WAV file. "
            "Check that the URL is valid and ffmpeg is installed."
        )

    return {
        "path": wav_path,
        "title": info.get("title") or "Unknown mix",
        "duration": float(info.get("duration") or 0.0),
        "uploader": info.get("uploader") or "",
        "webpage_url": info.get("webpage_url") or url,
        "description": info.get("description") or "",
    }
