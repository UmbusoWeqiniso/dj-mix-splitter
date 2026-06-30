"""Export detected tracks as 320 kbps MP3 files (with ID3 tags) and a zip bundle."""
from __future__ import annotations

import re
import subprocess
import zipfile
from pathlib import Path
from typing import Callable, List, Optional

from config import require_ffmpeg

ProgressCb = Optional[Callable[[float, str], None]]


def _safe_name(name: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|]", "_", name).strip()
    name = re.sub(r"\s+", " ", name)
    return name[:120] or "track"


def _export_one(
    src: Path, start: float, end: float, dst: Path, title: str, artist: str, track_no: int
) -> None:
    ffmpeg = require_ffmpeg()
    duration = max(0.1, end - start)
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", str(src),
        "-c:a", "libmp3lame", "-b:a", "320k",
        "-metadata", f"title={title}",
        "-metadata", f"artist={artist}",
        "-metadata", f"track={track_no}",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def export_one(src: Path, out_dir: Path, track: dict, index: int) -> dict:
    """Export a single track to MP3. Returns {filename, title, artist}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    title = (track.get("title") or f"Track {index:02d}").strip()
    artist = (track.get("artist") or "").strip()
    label = f"{index:02d} - {artist + ' - ' if artist else ''}{title}"
    filename = f"{_safe_name(label)}.mp3"
    dst = out_dir / filename
    _export_one(src, float(track["start"]), float(track["end"]), dst, title, artist, index)
    return {"filename": filename, "title": title, "artist": artist}


def export_tracks(
    src: Path,
    out_dir: Path,
    tracks: List[dict],
    on_progress: ProgressCb = None,
) -> dict:
    """Export each track. `tracks` items: {start, end, title, artist}.

    Returns {files: [{filename, title, artist}], zip: <name>}.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    files: List[dict] = []
    total = len(tracks)

    for i, t in enumerate(tracks, start=1):
        title = (t.get("title") or f"Track {i:02d}").strip()
        artist = (t.get("artist") or "").strip()
        label = f"{i:02d} - {artist + ' - ' if artist else ''}{title}"
        filename = f"{_safe_name(label)}.mp3"
        dst = out_dir / filename
        _export_one(src, float(t["start"]), float(t["end"]), dst, title, artist, i)
        files.append({"filename": filename, "title": title, "artist": artist})
        if on_progress:
            on_progress(i / total, f"Exporting MP3s… {i}/{total}")

    zip_name = "tracks.zip"
    zip_path = out_dir / zip_name
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for f in files:
            zf.write(out_dir / f["filename"], arcname=f["filename"])

    return {"files": files, "zip": zip_name}
