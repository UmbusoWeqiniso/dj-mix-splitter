"""Automatic track-boundary detection for continuous DJ mixes.

Method: Foote self-similarity novelty.
  1. Extract timbral + harmonic features (MFCC, chroma, spectral contrast).
  2. Aggregate onto an adaptive time grid so even hour-long mixes stay tractable.
  3. Build a cosine self-similarity matrix (SSM).
  4. Correlate a Gaussian-tapered checkerboard kernel along the SSM diagonal to
     get a "novelty" curve that spikes where the musical content changes.
  5. Peak-pick the novelty curve (respecting a musical minimum track length) to
     get track boundaries.
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable, List, Optional

import librosa
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

from config import (
    ANALYSIS_SAMPLE_RATE,
    MIN_TRACK_SECONDS,
    WAVEFORM_PEAKS,
)

ProgressCb = Optional[Callable[[float, str], None]]

KERNEL_SECONDS = 40.0   # half-width of the checkerboard kernel
MAX_GRID = 4000         # cap SSM size for tractability on long mixes
DEFAULT_SENSITIVITY = 5  # 1 (few, long tracks) .. 10 (many, short tracks)


def sensitivity_params(sensitivity: float) -> tuple[float, float]:
    """Map a 1..10 sensitivity dial to (min_track_seconds, prominence_threshold).

    Higher sensitivity => shorter allowed tracks and a lower novelty threshold,
    i.e. more boundaries. Calibrated against real mixes.
    """
    s = max(1.0, min(10.0, float(sensitivity)))
    frac = (s - 1.0) / 9.0
    min_track = 240.0 - frac * 180.0        # 240s @1  ->  60s @10
    prominence = 0.30 - frac * 0.24         # 0.30 @1 -> 0.06 @10
    return min_track, prominence


def _ping(cb: ProgressCb, frac: float, msg: str) -> None:
    if cb:
        cb(frac, msg)


def _extract_features(y: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Return (features [n_frames, n_dims], frames_per_second)."""
    hop = 512
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20, hop_length=hop)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    contrast = librosa.feature.spectral_contrast(y=y, sr=sr, hop_length=hop)
    feats = np.vstack([mfcc, chroma, contrast])  # [dims, frames]
    fps = sr / hop
    return feats.T, fps


def _aggregate_to_grid(feats: np.ndarray, fps: float, duration: float) -> tuple[np.ndarray, float]:
    """Median-aggregate frame features onto an adaptive time grid.

    Returns (grid_features [n_grid, dims], seconds_per_grid_cell).
    """
    n_cells = int(min(MAX_GRID, max(64, round(duration))))  # ~1s cells, capped
    resolution = duration / n_cells
    n_frames = feats.shape[0]
    edges = np.linspace(0, n_frames, n_cells + 1).astype(int)
    grid = np.empty((n_cells, feats.shape[1]), dtype=np.float64)
    for i in range(n_cells):
        a, b = edges[i], max(edges[i] + 1, edges[i + 1])
        grid[i] = np.median(feats[a:b], axis=0)
    # z-score each dimension so no single feature dominates the similarity
    mean = grid.mean(axis=0, keepdims=True)
    std = grid.std(axis=0, keepdims=True) + 1e-9
    grid = (grid - mean) / std
    return grid, resolution


def _self_similarity(grid: np.ndarray) -> np.ndarray:
    """Cosine self-similarity matrix in [0, 1]."""
    norm = grid / (np.linalg.norm(grid, axis=1, keepdims=True) + 1e-9)
    ssm = norm @ norm.T
    return (ssm + 1.0) / 2.0


def _checkerboard_kernel(half: int) -> np.ndarray:
    axis = np.arange(-half, half)
    g = np.exp(-0.5 * (axis / (half * 0.5)) ** 2)
    gauss = np.outer(g, g)
    s = np.where(axis < 0, -1.0, 1.0)
    sign = np.outer(s, s)
    return gauss * sign


def _foote_novelty(ssm: np.ndarray, half: int) -> np.ndarray:
    n = ssm.shape[0]
    kernel = _checkerboard_kernel(half)
    novelty = np.zeros(n)
    padded = np.pad(ssm, half, mode="edge")
    for i in range(n):
        window = padded[i:i + 2 * half, i:i + 2 * half]
        novelty[i] = np.sum(window * kernel)
    novelty = np.maximum(novelty, 0.0)
    if novelty.max() > 0:
        novelty /= novelty.max()
    return novelty


def _peaks_to_segments(
    peak_times: List[float], duration: float, min_track: float
) -> List[dict]:
    bounds = [0.0] + sorted(t for t in peak_times if 0 < t < duration) + [duration]
    segments: List[dict] = []
    for i in range(len(bounds) - 1):
        segments.append({"start": float(bounds[i]), "end": float(bounds[i + 1])})

    # merge any segment shorter than the musical minimum into its neighbour
    merged: List[dict] = []
    for seg in segments:
        if merged and (seg["end"] - seg["start"]) < min_track:
            merged[-1]["end"] = seg["end"]
        else:
            merged.append(dict(seg))
    # also fix a too-short first segment
    while len(merged) > 1 and (merged[0]["end"] - merged[0]["start"]) < min_track:
        merged[1]["start"] = merged[0]["start"]
        merged.pop(0)
    return merged


def segment_from_novelty(
    novelty: np.ndarray,
    resolution: float,
    duration: float,
    sensitivity: float = DEFAULT_SENSITIVITY,
) -> List[dict]:
    """Pick boundaries from a precomputed novelty curve. Cheap: re-runnable for
    the sensitivity slider without re-extracting features."""
    novelty = np.asarray(novelty, dtype=np.float64)
    min_track, prominence = sensitivity_params(sensitivity)
    min_distance = max(1, int(round(min_track / resolution)))
    peak_idx, _ = find_peaks(novelty, distance=min_distance, prominence=prominence)
    peak_times = [float(idx * resolution) for idx in peak_idx]
    segments = _peaks_to_segments(peak_times, duration, min_track)
    for i, seg in enumerate(segments, start=1):
        seg["index"] = i
    return segments


def estimate_bpm(path: Path, start: float, end: float) -> dict:
    """Estimate tempo (BPM) and the phase of the first beat for a track region.

    Returns {"bpm": float, "beat_offset": float} where beat_offset is the time
    (seconds, relative to `start`) of the first detected beat — used by the
    mixer to align a beat grid and to beat-match decks.
    """
    duration = max(0.0, float(end) - float(start))
    if duration < 4.0:
        raise RuntimeError("Track is too short to estimate a tempo.")
    # cap the analysis window: tempo is stable, no need to load a 10-min track
    win = min(duration, 90.0)
    y, sr = librosa.load(str(path), sr=ANALYSIS_SAMPLE_RATE, mono=True,
                         offset=float(start), duration=win)
    if y.size == 0:
        raise RuntimeError("No audio in that region.")
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    # Derive a precise, continuous BPM from the actual beat spacing rather than
    # librosa's quantized tempo estimate (which snaps many tracks to one value).
    bpm = float(np.atleast_1d(tempo)[0])
    if len(beats) >= 4:
        ibi = np.diff(beats)
        med = np.median(ibi)
        good = ibi[(ibi > med * 0.5) & (ibi < med * 1.5)]
        if good.size:
            bpm = 60.0 / float(np.mean(good))
    # fold into a DJ-friendly range (most dance music sits 70–180)
    while bpm and bpm < 70:
        bpm *= 2.0
    while bpm > 180:
        bpm /= 2.0
    beat_offset = float(beats[0]) if len(beats) else 0.0
    beat_offset = beat_offset % (60.0 / bpm) if bpm else 0.0
    return {"bpm": round(bpm, 2), "beat_offset": round(beat_offset, 4)}


def _waveform_peaks(y: np.ndarray) -> List[float]:
    n = WAVEFORM_PEAKS
    if len(y) < n:
        n = len(y)
    edges = np.linspace(0, len(y), n + 1).astype(int)
    peaks = []
    for i in range(n):
        a, b = edges[i], max(edges[i] + 1, edges[i + 1])
        peaks.append(float(np.max(np.abs(y[a:b]))))
    m = max(peaks) or 1.0
    return [round(p / m, 4) for p in peaks]


def analyze(path: Path, on_progress: ProgressCb = None) -> dict:
    """Run full segmentation. Returns dict with duration, segments, novelty, waveform."""
    _ping(on_progress, 0.05, "Loading audio…")
    y, sr = librosa.load(str(path), sr=ANALYSIS_SAMPLE_RATE, mono=True)
    duration = len(y) / sr
    if duration < MIN_TRACK_SECONDS:
        raise RuntimeError(
            f"Audio is only {duration:.0f}s long — too short to split into DJ tracks."
        )

    _ping(on_progress, 0.20, "Extracting audio features…")
    feats, fps = _extract_features(y, sr)

    _ping(on_progress, 0.45, "Building similarity matrix…")
    grid, resolution = _aggregate_to_grid(feats, fps, duration)
    ssm = _self_similarity(grid)

    _ping(on_progress, 0.65, "Detecting track transitions…")
    half = max(4, int(round(KERNEL_SECONDS / resolution)))
    half = min(half, grid.shape[0] // 2 - 1)
    novelty = _foote_novelty(ssm, half)
    novelty = gaussian_filter1d(novelty, sigma=1.0)
    if novelty.max() > 0:
        novelty /= novelty.max()

    segments = segment_from_novelty(novelty, resolution, duration, DEFAULT_SENSITIVITY)

    _ping(on_progress, 0.85, "Rendering waveform…")
    waveform = _waveform_peaks(y)
    novelty_ds = [round(float(v), 4) for v in np.interp(
        np.linspace(0, len(novelty) - 1, len(waveform)),
        np.arange(len(novelty)),
        novelty,
    )]

    return {
        "duration": float(duration),
        "segments": segments,
        "waveform": waveform,
        "novelty": novelty_ds,
        "novelty_full": [round(float(v), 5) for v in novelty],
        "resolution": float(resolution),
        "sensitivity": DEFAULT_SENSITIVITY,
    }
