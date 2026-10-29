"""Identify songs inside the mix using ACRCloud's identification API.

We cut a short representative clip from each detected segment and ask ACRCloud
what it is. No credentials => the step reports 'not configured' (it never invents
a result).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import struct
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from typing import Callable, Dict, List, Optional

import requests

from config import ACRCloudConfig, ID_SAMPLE_SECONDS, require_ffmpeg

ProgressCb = Optional[Callable[[float, str], None]]

_acrcloud_state: Dict = {
    "checked_at": 0.0,
    "status": "unknown",  # "ok", "quota_exceeded", "error", "not_configured"
    "code": None,
    "message": "",
}


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


def _record_status(code: Optional[int], msg: str) -> None:
    global _acrcloud_state
    _acrcloud_state["code"] = code
    _acrcloud_state["checked_at"] = time.time()
    if code == 3003:
        _acrcloud_state["status"] = "quota_exceeded"
        _acrcloud_state["message"] = msg or "ACRCloud requests limit exceeded (upgrade account or renew key)"
    elif code in (0, 1001):
        _acrcloud_state["status"] = "ok"
        _acrcloud_state["message"] = "ACRCloud active"
    else:
        _acrcloud_state["status"] = "error"
        _acrcloud_state["message"] = msg or f"ACRCloud error {code}"


def check_acrcloud_status(cfg: ACRCloudConfig, force: bool = False) -> dict:
    """Check ACRCloud API status and quota availability. Fast and cached for 5 minutes."""
    if not cfg.configured:
        return {
            "configured": False,
            "status": "not_configured",
            "code": None,
            "message": "ACRCloud credentials not configured in .env",
        }

    now = time.time()
    if not force and _acrcloud_state["status"] != "unknown" and (now - _acrcloud_state["checked_at"] < 300):
        return {"configured": True, **_acrcloud_state}

    # Lightweight ping with 1s of silent wave in memory
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(struct.pack("<8000h", *([0] * 8000)))
    sample_bytes = buf.tell()
    buf.seek(0)

    ts = str(now)
    sig = _sign(cfg, ts)
    url = f"https://{cfg.host}/v1/identify"
    data = {
        "access_key": cfg.access_key,
        "sample_bytes": str(sample_bytes),
        "timestamp": ts,
        "signature": sig,
        "data_type": "audio",
        "signature_version": "1",
    }
    try:
        resp = requests.post(url, files={"sample": ("ping.wav", buf, "audio/wav")}, data=data, timeout=6)
        resp.raise_for_status()
        payload = resp.json()
        status = payload.get("status", {})
        code = status.get("code")
        msg = status.get("msg", "")
        _record_status(code, msg)
    except Exception as exc:  # noqa: BLE001
        _record_status(-1, str(exc))

    return {"configured": True, **_acrcloud_state}


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
    msg = status.get("msg", f"ACRCloud code {code}")

    _record_status(code, msg)

    if code == 0:
        meta = payload.get("metadata", {})
        # ACRCloud returns hits under "music" (fingerprint) and/or "humming"
        candidates = (meta.get("music") or []) + (meta.get("humming") or [])
        if candidates:
            top = max(candidates, key=lambda m: m.get("score") or 0)
            artists = ", ".join(a.get("name", "") for a in top.get("artists", []) if a.get("name"))
            return {
                "status": "matched",
                "code": 0,
                "title": top.get("title", ""),
                "artist": artists,
                "album": (top.get("album") or {}).get("name", ""),
                "score": top.get("score"),
            }
        return {"status": "no_match", "code": 0}
    if code == 1001:  # no result
        return {"status": "no_match", "code": 1001}
    return {"status": "error", "code": code, "message": msg}


def identify_segments(
    cfg: ACRCloudConfig,
    src: Path,
    segments: List[dict],
    on_progress: ProgressCb = None,
) -> List[dict]:
    """Return identification info aligned 1:1 with `segments`."""
    if not cfg.configured:
        return [{"status": "not_configured", "code": None} for _ in segments]

    results: List[dict] = []
    total = len(segments)
    quota_exhausted = False

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for i, seg in enumerate(segments):
            if quota_exhausted:
                # Fast fail subsequent clips without wasting network requests
                results.append({
                    "status": "error",
                    "code": 3003,
                    "message": "requests limit exceeded, please upgrade your account",
                })
                if on_progress:
                    on_progress((i + 1) / total, f"Identifying tracks… {i + 1}/{total} (quota exceeded)")
                continue

            seg_len = seg["end"] - seg["start"]
            clip_len = min(ID_SAMPLE_SECONDS, max(6.0, seg_len * 0.5))
            offset = seg["start"] + max(0.0, (seg_len - clip_len) / 2.0)
            clip = tmpdir / f"clip_{i}.wav"
            try:
                _cut_clip(src, offset, clip_len, clip)
                res = _identify_clip(cfg, clip)
                results.append(res)
                if res.get("code") == 3003:
                    quota_exhausted = True
            except requests.HTTPError as exc:
                results.append({"status": "error", "code": exc.response.status_code, "message": f"HTTP {exc.response.status_code}"})
            except Exception as exc:  # noqa: BLE001 - surface, don't fabricate
                results.append({"status": "error", "code": -1, "message": str(exc)})

            if on_progress:
                on_progress((i + 1) / total, f"Identifying tracks… {i + 1}/{total}")

    return results
