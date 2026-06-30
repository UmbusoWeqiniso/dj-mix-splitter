"""Identify songs inside the mix using ACRCloud's identification API.

We cut a short representative clip from each detected segment and ask ACRCloud
what it is. No credentials => the step reports 'not configured' (it never invents
a result).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, List, Optional

import requests

from config import ACRCloudConfig, ID_SAMPLE_SECONDS, require_ffmpeg

ProgressCb = Optional[Callable[[float, str], None]]


def _cut_clip(src: Path, start: float, duration: float, dst: Path) -> None:
    ffmpeg = require_ffmpeg()
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}",
        "-i", str(src),
        "-ac", "1", "-ar", "8000", "-f", "wav", str(dst),
    ]
    subprocess.run(cmd, check=True)


def _sign(cfg: ACRCloudConfig, timestamp: str) -> str:
    string_to_sign = "\n".join(
        ["POST", "/v1/identify", cfg.access_key, "audio", "1", timestamp]
    )
    digest = hmac.new(
        cfg.access_secret.encode("ascii"),
        string_to_sign.encode("ascii"),
        digestmod=hashlib.sha1,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def _identify_clip(cfg: ACRCloudConfig, clip: Path) -> dict:
    timestamp = str(time.time())
    signature = _sign(cfg, timestamp)
    sample_bytes = clip.stat().st_size
    url = f"https://{cfg.host}/v1/identify"
    with clip.open("rb") as fh:
        files = {"sample": ("clip.wav", fh, "audio/wav")}
        data = {
            "access_key": cfg.access_key,
            "sample_bytes": str(sample_bytes),
            "timestamp": timestamp,
            "signature": signature,
            "data_type": "audio",
            "signature_version": "1",
        }
        resp = requests.post(url, files=files, data=data, timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    status = payload.get("status", {})
    code = status.get("code")

    if code == 0:
        meta = payload.get("metadata", {})
        # ACRCloud returns hits under "music" (fingerprint) and/or "humming"
        # (cover/melody). Take whichever candidate scores highest.
        candidates = (meta.get("music") or []) + (meta.get("humming") or [])
        if candidates:
            top = max(candidates, key=lambda m: m.get("score") or 0)
            artists = ", ".join(a.get("name", "") for a in top.get("artists", []) if a.get("name"))
            return {
                "status": "matched",
                "title": top.get("title", ""),
                "artist": artists,
                "album": (top.get("album") or {}).get("name", ""),
                "score": top.get("score"),
            }
        return {"status": "no_match"}
    if code == 1001:  # no result
        return {"status": "no_match"}
    return {"status": "error", "message": status.get("msg", f"ACRCloud code {code}")}


def identify_segments(
    cfg: ACRCloudConfig,
    src: Path,
    segments: List[dict],
    on_progress: ProgressCb = None,
) -> List[dict]:
    """Return identification info aligned 1:1 with `segments`."""
    if not cfg.configured:
        return [{"status": "not_configured"} for _ in segments]

    results: List[dict] = []
    total = len(segments)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for i, seg in enumerate(segments):
            seg_len = seg["end"] - seg["start"]
            clip_len = min(ID_SAMPLE_SECONDS, max(6.0, seg_len * 0.5))
            offset = seg["start"] + max(0.0, (seg_len - clip_len) / 2.0)
            clip = tmpdir / f"clip_{i}.wav"
            try:
                _cut_clip(src, offset, clip_len, clip)
                results.append(_identify_clip(cfg, clip))
            except requests.HTTPError as exc:
                results.append({"status": "error", "message": f"HTTP {exc.response.status_code}"})
            except Exception as exc:  # noqa: BLE001 - surface, don't fabricate
                results.append({"status": "error", "message": str(exc)})
            if on_progress:
                on_progress((i + 1) / total, f"Identifying tracks… {i + 1}/{total}")
    return results
