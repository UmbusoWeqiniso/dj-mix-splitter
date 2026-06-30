"""Disk usage introspection and cleanup helpers."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from config import DATA_DIR


def _dir_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def _mix_title(job_dir: Path) -> str:
    cache = job_dir / "result.json"
    if cache.exists():
        try:
            data = json.loads(cache.read_text())
            return (data.get("source") or {}).get("title") or job_dir.name
        except Exception:  # noqa: BLE001
            pass
    return job_dir.name


def storage_summary() -> dict:
    breakdown = {"source": 0, "stems": 0, "regions": 0, "tracks": 0, "other": 0}
    per_mix: list = []
    mix_count = 0

    if not DATA_DIR.exists():
        return {"total_bytes": 0, "mix_count": 0, "breakdown": breakdown, "per_mix": []}

    for d in sorted(DATA_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        src = d / "source.wav"
        if not src.exists():
            continue
        mix_count += 1

        source_b = src.stat().st_size
        stems_b = _dir_bytes(d / "stems")
        regions_b = _dir_bytes(d / "regions")
        tracks_b = _dir_bytes(d / "tracks")
        total_b = _dir_bytes(d)

        breakdown["source"] += source_b
        breakdown["stems"] += stems_b
        breakdown["regions"] += regions_b
        breakdown["tracks"] += tracks_b
        other_b = total_b - source_b - stems_b - regions_b - tracks_b
        breakdown["other"] += max(0, other_b)

        per_mix.append({
            "id": d.name,
            "title": _mix_title(d),
            "bytes": total_b,
            "stem_bytes": stems_b,
            "region_bytes": regions_b,
        })

    per_mix.sort(key=lambda x: x["bytes"], reverse=True)
    return {
        "total_bytes": sum(breakdown.values()),
        "mix_count": mix_count,
        "breakdown": breakdown,
        "per_mix": per_mix,
    }


def clear_stems(job_id: str) -> dict:
    if not job_id or ".." in job_id or "/" in job_id:
        raise ValueError("Invalid job id.")
    job_dir = DATA_DIR / job_id
    if not (job_dir / "source.wav").exists():
        raise FileNotFoundError("Mix not found.")
    stems_dir = job_dir / "stems"
    if not stems_dir.is_dir():
        return {"job_id": job_id, "cleared_bytes": 0}
    cleared = _dir_bytes(stems_dir)
    shutil.rmtree(stems_dir)
    return {"job_id": job_id, "cleared_bytes": cleared}


def cleanup_regions() -> dict:
    cleared = 0
    count = 0
    if not DATA_DIR.exists():
        return {"cleared_bytes": 0, "mix_count": 0}
    for d in DATA_DIR.iterdir():
        if not d.is_dir():
            continue
        regions = d / "regions"
        if regions.is_dir():
            cleared += _dir_bytes(regions)
            shutil.rmtree(regions)
            count += 1
    return {"cleared_bytes": cleared, "mix_count": count}
