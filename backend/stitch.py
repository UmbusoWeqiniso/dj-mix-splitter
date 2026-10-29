"""Stem punch & stitch: mute stems (e.g. vocals) inside an exact time range of a
song and splice the result back seamlessly.

Approach (highest fidelity): instead of rebuilding the section from the summed
*active* stems, we keep the ORIGINAL audio and subtract only the *muted* stems:

    out = original - g(t) * sum(muted_stems)

`g(t)` ramps 0→1 at the IN point and 1→0 at the OUT point (equal-power curve), so
the edit fades in/out without clicks and everything you didn't mute stays
bit-identical to the source. Stems are aligned using the region start recorded in
the stem manifest, so they can never be spliced into the wrong part of the song.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Dict, List, Tuple

import librosa
import numpy as np
import soundfile as sf

from analysis import _waveform_peaks
from config import require_ffmpeg

PREVIEW_CONTEXT_SEC = 4.0
EDITS_FILE = "stitches.json"


def stitch_dir_name(start: float, end: float, quality: str) -> str:
    """Exact (millisecond) folder name for a punch region's stems."""
    return f"stitch_{int(round(start * 1000))}_{int(round(end * 1000))}_{quality}"


def _stem_region(stem_dir: Path) -> Tuple[float, float]:
    data = json.loads((stem_dir / "manifest.json").read_text())
    return float(data["start"]), float(data["end"])


def _muted_sum(stem_dir: Path, muted_files: List[str], sr: int, channels: int,
               start: float, frames: int) -> np.ndarray:
    """Sum the muted stems for exactly [start, start+frames/sr], resampled to `sr`."""
    out = np.zeros((frames, channels), dtype=np.float64)
    if not muted_files:
        return out
    region_start, region_end = _stem_region(stem_dir)
    if start < region_start - 0.01 or start + frames / sr > region_end + 0.05:
        raise ValueError(
            f"Stems cover {region_start:.2f}s–{region_end:.2f}s but the edit is "
            f"{start:.2f}s–{start + frames / sr:.2f}s. Re-separate this range."
        )
    acc = None
    stem_sr = None
    for fn in muted_files:
        p = stem_dir / fn
        if not p.exists():
            continue
        data, this_sr = sf.read(str(p), always_2d=True, dtype="float64")
        stem_sr = this_sr
        acc = data if acc is None else acc[: len(data)] + data[: len(acc)]
    if acc is None:
        return out
    if stem_sr != sr:
        acc = librosa.resample(acc.T, orig_sr=stem_sr, target_sr=sr).T
    if acc.shape[1] != channels:
        acc = acc.mean(axis=1, keepdims=True)
        if channels > 1:
            acc = np.repeat(acc, channels, axis=1)
    offset = int(round((start - region_start) * sr))
    seg = acc[max(0, offset): max(0, offset) + frames]
    out[: len(seg)] = seg
    return out


def _gain_curve(frames: int, sr: int, fade_frames_req: int) -> np.ndarray:
    g = np.ones(frames, dtype=np.float64)
    f = max(1, min(fade_frames_req, frames // 2))
    ramp = np.sin(np.linspace(0, np.pi / 2, f, endpoint=True))
    g[:f] = ramp
    g[frames - f:] = ramp[::-1]
    return g[:, None]


def render_edit(source_wav: Path, stem_dir: Path, muted_files: List[str],
                start: float, end: float, crossfade_ms: float = 25.0,
                context: float = 0.0) -> Tuple[np.ndarray, int, int, int, int]:
    """Return (window_audio, sr, window_start_frame, edit_start_frame, edit_end_frame).
    The window spans [start-context, end+context]; only [start,end] is modified."""
    with sf.SoundFile(str(source_wav)) as f:
        sr, channels, total = f.samplerate, f.channels, f.frames
        s = max(0, int(round(start * sr)))
        e = min(total, int(round(end * sr)))
        if e - s <= 0:
            raise ValueError("Invalid range: OUT must be after IN.")
        ws = max(0, s - int(round(context * sr)))
        we = min(total, e + int(round(context * sr)))
        f.seek(ws)
        window = f.read(we - ws, always_2d=True, dtype="float64")

    frames = e - s
    muted = _muted_sum(stem_dir, muted_files, sr, channels, s / sr, frames)
    gain = _gain_curve(frames, sr, int(round(crossfade_ms / 1000.0 * sr)))
    a, b = s - ws, e - ws
    window[a:b] = window[a:b] - gain * muted
    np.clip(window, -1.0, 1.0, out=window)
    return window, sr, ws, s, e


def write_preview(job, stem_dir: Path, muted_files: List[str], start: float, end: float,
                  crossfade_ms: float = 25.0) -> dict:
    """Render a short clip (edit + context on both sides) for auditioning."""
    window, sr, ws, s, e = render_edit(job.dir / "source.wav", stem_dir, muted_files,
                                       start, end, crossfade_ms, PREVIEW_CONTEXT_SEC)
    dst = job.dir / "stitched_preview.wav"
    sf.write(str(dst), window, sr, subtype="PCM_16")
    return {
        "clip_start": ws / sr,
        "edit_in": (s - ws) / sr,
        "edit_out": (e - ws) / sr,
        "clip_len": len(window) / sr,
    }


def _load_edits(job) -> List[Dict]:
    p = job.dir / EDITS_FILE
    try:
        return json.loads(p.read_text()) if p.exists() else []
    except Exception:  # noqa: BLE001
        return []


def _save_edits(job, edits: List[Dict]) -> None:
    p = job.dir / EDITS_FILE
    if edits:
        p.write_text(json.dumps(edits, indent=2))
    elif p.exists():
        p.unlink()


def _overlaps(a0: float, a1: float, b0: float, b1: float) -> bool:
    return a0 < b1 and b0 < a1


def invalidate_caches(job, ranges: List[Tuple[float, float]]) -> None:
    """Drop every derived cache that was built from the old audio in `ranges`:
    deck stems, punch stems, preview regions and the stitched preview."""
    stems_root = job.dir / "stems"
    if stems_root.is_dir():
        for d in stems_root.iterdir():
            if not d.is_dir():
                continue
            try:
                r0, r1 = _stem_region(d)
            except Exception:  # noqa: BLE001 — legacy dir without manifest: parse name
                parts = d.name.split("_")
                try:
                    r0, r1 = float(parts[1]), float(parts[2]) + 1
                except (IndexError, ValueError):
                    continue
            if any(_overlaps(r0, r1, a, b) for a, b in ranges):
                shutil.rmtree(d, ignore_errors=True)
    for sub in (".tmp", "regions"):
        p = job.dir / sub
        if p.is_dir():
            for f in p.glob("*.wav"):
                f.unlink(missing_ok=True)
    (job.dir / "stitched_preview.wav").unlink(missing_ok=True)


def _refresh_waveform(job, window: Optional[np.ndarray] = None, start: float = 0.0, end: float = 0.0, is_revert: bool = False) -> List[float]:
    new_result = dict(job.result)
    old_wf = list(new_result.get("waveform") or [])
    dur = float(new_result.get("duration") or 0.0)

    if is_revert:
        orig = new_result.get("waveform_orig")
        if orig:
            new_result["waveform"] = list(orig)
            job.update(result=new_result)
            from jobs import manager
            manager._save_cache(job)
            return new_result["waveform"]

    if window is not None and old_wf and dur > 0 and end > start:
        if "waveform_orig" not in new_result:
            new_result["waveform_orig"] = list(old_wf)

        n_peaks = len(old_wf)
        i_start = max(0, min(n_peaks - 1, int((start / dur) * n_peaks)))
        i_end = max(i_start + 1, min(n_peaks, int(np.ceil((end / dur) * n_peaks))))
        k = i_end - i_start

        window_mono = np.max(np.abs(window), axis=1) if window.ndim == 2 else np.abs(window)
        edges = np.linspace(0, len(window_mono), k + 1).astype(int)
        sub_peaks = []
        for i in range(k):
            a, b = edges[i], max(edges[i] + 1, edges[i + 1])
            sub_peaks.append(round(float(np.max(window_mono[a:b])), 4))

        new_wf = list(old_wf)
        new_wf[i_start:i_end] = sub_peaks
        new_result["waveform"] = new_wf
        job.update(result=new_result)
        from jobs import manager
        manager._save_cache(job)
        return new_wf

    # Memory-safe streaming peaks calculation from file
    src_file = job.dir / "source.wav"
    with sf.SoundFile(str(src_file)) as f:
        total_frames = f.frames
        n_peaks = 1600
        peaks = np.zeros(n_peaks, dtype=np.float32)
        cur = 0
        chunk_size = 65536
        while cur < total_frames:
            buf = f.read(chunk_size, dtype="float32", always_2d=True)
            if len(buf) == 0:
                break
            mono = np.max(np.abs(buf), axis=1)
            p_start = cur * n_peaks // total_frames
            p_end = min(n_peaks, (cur + len(buf)) * n_peaks // total_frames + 1)
            for pi in range(p_start, p_end):
                fa = max(0, pi * total_frames // n_peaks - cur)
                fb = min(len(mono), (pi + 1) * total_frames // n_peaks - cur)
                if fb > fa:
                    m = float(np.max(mono[fa:fb]))
                    if m > peaks[pi]:
                        peaks[pi] = m
            cur += len(buf)
        m = float(np.max(peaks)) or 1.0
        wf = [round(float(p / m), 4) for p in peaks]

    new_result["waveform"] = wf
    job.update(result=new_result)
    from jobs import manager
    manager._save_cache(job)
    return wf


def _write_edited_window(src: Path, s: int, e: int, window: np.ndarray) -> None:
    """Safely replace frames [s:e] in src with window.
    Tries fast in-place write first (works on clean WAVs); falls back to a clean
    stream-rewrite if the WAV has metadata headers that prevent in-place modification."""
    try:
        with sf.SoundFile(str(src), mode="r+") as f:
            f.seek(s)
            f.write(window)
            return
    except sf.LibsndfileError:
        pass

    tmp = src.with_name(f"{src.stem}.tmp{src.suffix}")
    chunk_size = 131072
    with sf.SoundFile(str(src), mode="r") as r:
        with sf.SoundFile(
            str(tmp),
            mode="w",
            samplerate=r.samplerate,
            channels=r.channels,
            format=r.format,
            subtype=r.subtype,
        ) as w:
            cur = 0
            while cur < s:
                to_read = min(chunk_size, s - cur)
                buf = r.read(to_read, dtype="float32", always_2d=True)
                if len(buf) == 0:
                    break
                w.write(buf)
                cur += len(buf)

            w.write(window)

            r.seek(e)
            while True:
                buf = r.read(chunk_size, dtype="float32", always_2d=True)
                if len(buf) == 0:
                    break
                w.write(buf)

    tmp.replace(src)


def apply_edit(job, stem_dir: Path, muted_files: List[str], muted_names: List[str],
               start: float, end: float, crossfade_ms: float = 25.0) -> dict:
    """Write the edit into source.wav in place (only the edited frames are touched).
    The untouched original is kept as source.wav.bak for one-click revert."""
    src = job.dir / "source.wav"
    bak = job.dir / "source.wav.bak"
    if not src.exists():
        raise FileNotFoundError("Song audio not found.")
    if not bak.exists():
        shutil.copy2(src, bak)

    window, sr, ws, s, e = render_edit(src, stem_dir, muted_files, start, end, crossfade_ms, 0.0)
    _write_edited_window(src, s, e, window)

    edits = _load_edits(job)
    edits.append({"start": start, "end": end, "muted": muted_names})
    _save_edits(job, edits)
    invalidate_caches(job, [(start, end)])
    wf = _refresh_waveform(job, window=window, start=start, end=end)
    return {"waveform": wf, "edits": edits, "has_backup": True}


def revert_all(job) -> dict:
    src = job.dir / "source.wav"
    bak = job.dir / "source.wav.bak"
    if not bak.exists():
        raise FileNotFoundError("Nothing to revert — the song is unedited.")
    edits = _load_edits(job)
    shutil.copy2(bak, src)
    bak.unlink(missing_ok=True)
    _save_edits(job, [])
    invalidate_caches(job, [(e["start"], e["end"]) for e in edits] or [(0, 1e9)])
    wf = _refresh_waveform(job, is_revert=True)
    return {"waveform": wf, "edits": [], "has_backup": False}


def edit_state(job) -> dict:
    return {"has_backup": (job.dir / "source.wav.bak").exists(), "edits": _load_edits(job)}


def export_to_mp3(wav_path: Path, dst_mp3: Path, title: str = "", artist: str = "") -> None:
    ffmpeg = require_ffmpeg()
    dst_mp3.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", str(wav_path),
           "-c:a", "libmp3lame", "-b:a", "320k"]
    if title:
        cmd += ["-metadata", f"title={title}"]
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(dst_mp3))
    subprocess.run(cmd, check=True)
