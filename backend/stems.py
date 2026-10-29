"""Stem separation using Demucs' 6-source model (htdemucs_6s):
vocals / drums / bass / guitar / piano / other.

The model is loaded once and reused. Separation runs on Apple-Silicon GPU (MPS)
when available, otherwise CPU. Stems are saved as WAV with soundfile (the new
torchaudio backend needs torchcodec, which we avoid).
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Callable, Dict, List, Optional

import certifi
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

from config import DATA_DIR, require_ffmpeg

# python.org Python ships without CA certs; point urllib/torch.hub at certifi so
# the model can be downloaded on first use.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except (TypeError, ValueError):
        return default


# Separation is extremely CPU/RAM heavy. To keep the host machine usable we:
#   1. run at most STEM_MAX_CONCURRENCY separations at once (serialized by default), and
#   2. cap the BLAS/torch thread pool so a single job can't saturate every core.
# Both are derived from the machine's core count and overridable via env vars.
_CPU_COUNT = os.cpu_count() or 4
# Leave headroom for the OS/UI: cap BLAS/torch threads so one job can't pin every core.
_THREAD_CAP = _env_int("STEM_TORCH_THREADS", max(1, _CPU_COUNT // 4))
STEM_MAX_CONCURRENCY = _env_int("STEM_MAX_CONCURRENCY", 1)

# These must be set before torch/numpy spin up their thread pools.
for _var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS",
             "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_var, str(_THREAD_CAP))

# Only one heavy separation may touch the (shared) model / device at a time.
_inference_gate = threading.Semaphore(STEM_MAX_CONCURRENCY)
_threads_configured = False

# Memory discipline: retain finished jobs only briefly, cap the registry, and
# unload the (large) model once the app has been idle so it runs silently at rest.
STEM_JOB_TTL = _env_int("STEM_JOB_TTL", 300)         # drop finished jobs after 5 min
STEM_JOB_MAX = _env_int("STEM_JOB_MAX", 16)          # hard cap on retained jobs
STEM_MODEL_IDLE = _env_int("STEM_MODEL_IDLE", 60)    # unload model after 1 min idle
_last_used = 0.0


def _configure_torch_threads() -> None:
    global _threads_configured
    if _threads_configured:
        return
    import torch
    try:
        torch.set_num_threads(_THREAD_CAP)
        torch.set_num_interop_threads(1)
    except Exception:  # noqa: BLE001 — interop threads can only be set once
        pass
    _threads_configured = True


ProgressCb = Optional[Callable[[float, str], None]]

# demucs htdemucs_6s sources are drums,bass,other,vocals,guitar,piano.
# We additionally (a) split the kick out of the drum stem and (b) split the
# catch-all "other" stem into tonal (synth) + percussive (perc) via HPSS — both
# are perfect-reconstruction, so the UI exposes 8 channels.
STEM_ORDER = ["vocals", "kick", "drums", "bass", "guitar", "piano", "synth", "perc"]
KICK_CUTOFF = 110.0  # Hz; below this is treated as kick within the drum stem

# Quality presets, ordered cheapest → heaviest. `kick`/`hpss` toggle the CPU-side
# post-processing (kick crossover, harmonic/percussive split); `mode` selects the
# channel layout. The default is "balanced" — "high" (shifts=2, overlap=0.5) is
# ~4x the compute for a marginal quality gain, so it stays explicit/opt-in.
DEFAULT_QUALITY = os.environ.get("STEM_DEFAULT_QUALITY", "balanced")
QUALITY_PRESETS = {
    # vocal/instrumental specialist: 4-source model, no kick split, no HPSS — fastest path
    "vocal":    {"model": "htdemucs",    "shifts": 1, "overlap": 0.25, "kick": False, "hpss": False, "mode": "vocal"},
    # quick full kit: 4-source model + kick split, skip the (heavy) HPSS synth/perc split
    "fast":     {"model": "htdemucs",    "shifts": 1, "overlap": 0.25, "kick": True,  "hpss": False, "mode": "full"},
    # default: 6-source model, single pass, full 8-channel layout
    "balanced": {"model": "htdemucs_6s", "shifts": 1, "overlap": 0.25, "kick": True,  "hpss": True,  "mode": "full"},
    # max quality: 6-source model run twice (shifts=2) with 50% overlap
    "high":     {"model": "htdemucs_6s", "shifts": 2, "overlap": 0.5,  "kick": True,  "hpss": True,  "mode": "full"},
}


def _preset(quality: str) -> dict:
    return QUALITY_PRESETS.get(quality, QUALITY_PRESETS[DEFAULT_QUALITY])

_model = None
_model_name = None
_model_lock = threading.Lock()


def _device() -> str:
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def _release_device_memory(device: str) -> None:
    """Hand freed tensors back to the allocator so RAM/VRAM doesn't creep up
    across successive separations."""
    import gc
    import torch
    gc.collect()
    try:
        if device == "mps" and hasattr(torch, "mps"):
            torch.mps.empty_cache()
        elif device == "cuda":
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def get_model(model_name: str = "htdemucs_6s"):
    global _model, _model_name, _last_used
    _configure_torch_threads()
    with _model_lock:
        if _model is None or _model_name != model_name:
            from demucs.pretrained import get_model as load_model
            m = load_model(model_name)
            m.to(_device())
            m.eval()
            _model = m
            _model_name = model_name
        _last_used = time.time()
        return _model


def unload_model() -> bool:
    """Drop the resident model and release device memory. Safe to call only when
    no separation is running (the caller holds the inference gate)."""
    global _model, _model_name
    with _model_lock:
        if _model is None:
            return False
        device = _device()
        _model = None
        _model_name = None
    _release_device_memory(device)
    return True


def _cut(src: Path, start: float, end: float, dst: Path) -> None:
    ffmpeg = require_ffmpeg()
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error",
         "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}",
         "-i", str(src), "-ar", "44100", "-ac", "2", str(dst)],
        check=True,
    )


def _split_kick(drums: np.ndarray, sr: int, cutoff: float = KICK_CUTOFF):
    """Split a drum stem into (kick, rest) with a zero-phase low-pass crossover.

    The low band carries the kick fundamental/sub; `rest = drums - kick` keeps
    snare/hats/cymbals. The split perfectly reconstructs (kick + rest == drums),
    so summing channels in the mixer stays exact.
    `drums` is [samples, channels]."""
    sos = butter(4, cutoff / (sr / 2.0), btype="low", output="sos")
    kick = sosfiltfilt(sos, drums, axis=0)
    rest = drums - kick
    return kick.astype(np.float32), rest.astype(np.float32)


def _split_other(other: np.ndarray):
    """Split the catch-all 'other' stem into tonal (synth) and percussive (perc)
    parts with harmonic/percussive source separation. margin=1.0 keeps the masks
    complementary so synth + perc reconstructs 'other'. `other` is [samples, ch]."""
    import librosa
    synth = np.zeros_like(other)
    perc = np.zeros_like(other)
    for c in range(other.shape[1]):
        h, p = librosa.effects.hpss(np.ascontiguousarray(other[:, c]), margin=1.0)
        synth[:, c] = h
        perc[:, c] = p
    return synth.astype(np.float32), perc.astype(np.float32)


def separate(src_wav: Path, start: float, end: float, out_dir: Path, quality: str = DEFAULT_QUALITY) -> dict:
    """Separate the [start,end] region of src_wav into stem WAVs in out_dir.
    Channel layout depends on the quality preset (see QUALITY_PRESETS).
    Returns {stems: {name: filename}, samplerate}."""
    import torch
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    preset = _preset(quality)
    model_name = preset["model"]
    shifts = preset["shifts"]
    overlap = preset["overlap"]
    do_kick = preset.get("kick", True)
    do_hpss = preset.get("hpss", True)
    mode = preset.get("mode", "full")

    out_dir.mkdir(parents=True, exist_ok=True)
    model = get_model(model_name)
    device = _device()
    sr = int(model.samplerate)

    with tempfile.TemporaryDirectory() as tmp:
        clip = Path(tmp) / "clip.wav"
        _cut(src_wav, start, end, clip)
        wav = AudioFile(clip).read(
            streams=0, samplerate=model.samplerate, channels=model.audio_channels
        )

    ref = wav.mean(0)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(
            model, wav[None], device=device,
            shifts=shifts, split=True, overlap=overlap, progress=False,
        )[0]
    sources = sources * ref.std() + ref.mean()

    arrays: Dict[str, np.ndarray] = {}
    for source, name in zip(sources, model.sources):
        arrays[name] = source.cpu().numpy().T  # [samples, channels]

    # Free the device tensors before the (CPU-bound) post-processing/writes.
    del sources, wav
    _release_device_memory(device)

    if mode == "vocal":
        # Specialist layout: vocals + everything-else summed into one instrumental
        # channel. Skips kick/HPSS entirely — the fastest, lightest output.
        vocals = arrays.get("vocals")
        if vocals is None:
            raise RuntimeError("Model did not produce a vocals source.")
        instrumental = None
        for name, arr in arrays.items():
            if name == "vocals":
                continue
            instrumental = arr.copy() if instrumental is None else instrumental + arr
        if instrumental is None:
            instrumental = np.zeros_like(vocals)
        ordered = [("vocals", vocals), ("instrumental", instrumental)]
    else:
        # carve the kick out of the drum kit onto its own channel
        if do_kick and "drums" in arrays:
            kick, rest = _split_kick(arrays["drums"], sr)
            arrays["kick"] = kick
            arrays["drums"] = rest

        # split the catch-all "other" into tonal (synth) + percussive (perc)
        if do_hpss and "other" in arrays:
            synth, perc = _split_other(arrays["other"])
            arrays["synth"] = synth
            arrays["perc"] = perc

        names = [n for n in STEM_ORDER if n in arrays]
        # keep any model sources not in the canonical order (e.g. "other" when HPSS is off)
        names += [n for n in arrays if n not in STEM_ORDER and n != "other"]
        if "other" in arrays and "other" not in names and not do_hpss:
            names.append("other")
        ordered = [(n, arrays[n]) for n in names]

    stems: Dict[str, str] = {}
    for name, arr in ordered:
        arr = np.clip(arr, -1.0, 1.0)
        path = out_dir / f"{name}.wav"
        sf.write(str(path), arr, sr)
        stems[name] = path.name

    return {"stems": stems, "samplerate": sr}


def mix_stems(stem_dir: Path, stem_files: List[str], dst_mp3: Path,
              title: str = "", artist: str = "") -> None:
    """Sum the selected stem WAVs (they reconstruct the chosen blend) and encode MP3."""
    if not stem_files:
        raise RuntimeError("No stems selected.")
    mixed = None
    sr = None
    for fn in stem_files:
        data, this_sr = sf.read(str(stem_dir / fn), always_2d=True)
        sr = this_sr if sr is None else sr
        mixed = data if mixed is None else mixed + data
    peak = float(np.max(np.abs(mixed))) if mixed is not None else 1.0
    if peak > 1.0:
        mixed = mixed / peak  # prevent clipping when summing stems

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "mix.wav"
        sf.write(str(wav), mixed, sr)
        ffmpeg = require_ffmpeg()
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(wav),
             "-c:a", "libmp3lame", "-b:a", "320k",
             "-metadata", f"title={title}", "-metadata", f"artist={artist}",
             str(dst_mp3)],
            check=True,
        )


# Display ordering: canonical 8 channels first, then the specialist extras.
DISPLAY_ORDER = STEM_ORDER + ["other", "instrumental"]


def _order_stems(names) -> List[str]:
    present = set(names)
    ordered = [n for n in DISPLAY_ORDER if n in present]
    ordered += [n for n in names if n not in DISPLAY_ORDER]
    return ordered


# --------------------------- async job management ---------------------------
def _expected_stems(quality: str) -> List[str]:
    """Channel names a finished job of this quality should contain (used only for
    cache matching on legacy dirs without a manifest)."""
    preset = _preset(quality)
    mode = preset.get("mode", "full")
    if mode == "vocal":
        return ["vocals", "instrumental"]
    if preset["model"] == "htdemucs_6s":
        return list(STEM_ORDER)
    if preset.get("hpss", True):
        return ["vocals", "kick", "drums", "bass", "synth", "perc"]
    return ["vocals", "kick", "drums", "bass", "other"]


def _stem_dir_candidates(parent_dir: Path, track_index: int, start: float, end: float, quality: str) -> List[Path]:
    base = f"t{track_index}_{int(start)}_{int(end)}"
    stems_root = parent_dir / "stems"
    dirs = [stems_root / f"{base}_{quality}", stems_root / base]
    seen: set[Path] = set()
    out: List[Path] = []
    for d in dirs:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


_CORE_STEMS = {"vocals", "drums", "bass"}


def _write_stem_manifest(out_dir: Path, quality: str, track_index: int,
                         start: float, end: float, stems: Dict[str, str]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "quality": quality,
        "track_index": track_index,
        "start": start,
        "end": end,
        "stems": stems,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))


def _load_cached_stems(out_dir: Path, expected: List[str]) -> Optional[Dict[str, str]]:
    if not out_dir.is_dir():
        return None
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        try:
            data = json.loads(manifest_path.read_text())
            stems = data.get("stems") or {}
            if stems and all((out_dir / fn).exists() for fn in stems.values()):
                return dict(stems)
        except (json.JSONDecodeError, OSError):
            pass
    if len(expected) == 4:
        found = {n: f"{n}.wav" for n in expected if (out_dir / f"{n}.wav").exists()}
        if len(found) == 4:
            return found
    found = {n: f"{n}.wav" for n in STEM_ORDER if (out_dir / f"{n}.wav").exists()}
    if not _CORE_STEMS.issubset(found.keys()) or len(found) < 4:
        return None
    return found


class StemJob:
    def __init__(self, id: str, track_index: int, title: str, out_dir: Path):
        self.id = id
        self.track_index = track_index
        self.title = title
        self.dir = out_dir
        self.status = "running"   # running | ready | error
        self.progress = 0.0
        self.message = "Preparing…"
        self.error: Optional[str] = None
        self.stems: Dict[str, str] = {}
        self.samplerate = 44100
        self.touched = time.time()
        self._lock = threading.Lock()

    def update(self, **kw):
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)
            self.touched = time.time()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "track_index": self.track_index,
                "title": self.title,
                "status": self.status,
                "progress": round(self.progress, 3),
                "message": self.message,
                "error": self.error,
                "stems": dict(self.stems),
                "samplerate": self.samplerate,
                "order": _order_stems(self.stems.keys()),
            }


class StemManager:
    def __init__(self):
        self._jobs: Dict[str, StemJob] = {}
        # Maps a track/region key -> active StemJob so duplicate requests reuse
        # the in-flight separation instead of starting a second Demucs run.
        self._inflight: Dict[str, str] = {}
        self._lock = threading.Lock()
        self._sweeper = threading.Thread(target=self._sweep_loop, daemon=True)
        self._sweeper.start()

    @staticmethod
    def _key(parent_dir: Path, track_index: int, start: float, end: float, quality: str) -> str:
        return f"{parent_dir}|{track_index}|{int(start)}|{int(end)}|{quality}"

    def get(self, sid: str) -> Optional[StemJob]:
        with self._lock:
            job = self._jobs.get(sid)
        if job is not None:
            job.touched = time.time()  # keep actively-polled jobs from eviction
        return job

    def _evict_jobs(self) -> None:
        """Drop finished jobs past their TTL and enforce a hard cap so the
        registry can't grow without bound (stems live on disk + dedup cache, so
        a 404 simply triggers a fast cache-backed re-resolve on the client)."""
        now = time.time()
        with self._lock:
            finished = [
                (sid, j) for sid, j in self._jobs.items()
                if j.status in ("ready", "error")
            ]
            for sid, j in finished:
                if now - j.touched > STEM_JOB_TTL:
                    self._jobs.pop(sid, None)
            if len(self._jobs) > STEM_JOB_MAX:
                done = sorted(
                    ((sid, j) for sid, j in self._jobs.items()
                     if j.status in ("ready", "error")),
                    key=lambda kv: kv[1].touched,
                )
                overflow = len(self._jobs) - STEM_JOB_MAX
                for sid, _ in done[:overflow]:
                    self._jobs.pop(sid, None)

    def _maybe_unload_model(self) -> None:
        """Free the resident model once idle — but only if no separation is
        running (non-blocking gate acquire guarantees we never unload mid-use)."""
        if time.time() - _last_used < STEM_MODEL_IDLE:
            return
        if not _inference_gate.acquire(blocking=False):
            return
        try:
            unload_model()
        finally:
            _inference_gate.release()

    def _sweep_loop(self) -> None:
        interval = max(15.0, min(STEM_MODEL_IDLE, STEM_JOB_TTL) / 4.0)
        while True:
            time.sleep(interval)
            try:
                self._evict_jobs()
                self._maybe_unload_model()
            except Exception:  # noqa: BLE001 — sweeper must never die
                traceback.print_exc()

    def create(self, src_wav: Path, parent_dir: Path, track_index: int,
               start: float, end: float, title: str, quality: str = DEFAULT_QUALITY,
               dir_name: Optional[str] = None) -> StemJob:
        """`dir_name` pins the output folder to an exact name (used by the stem
        punch/stitch editor so regions never collide with per-track deck stems)."""
        expected = _expected_stems(quality)
        if dir_name:
            out_dir = parent_dir / "stems" / dir_name
            candidates = [out_dir]
        else:
            out_dir = parent_dir / "stems" / f"t{track_index}_{int(start)}_{int(end)}_{quality}"
            candidates = _stem_dir_candidates(parent_dir, track_index, start, end, quality)
        cached = None
        for cand in candidates:
            cached = _load_cached_stems(cand, expected)
            if cached:
                out_dir = cand
                break

        key = f"{parent_dir}|{dir_name}" if dir_name else self._key(parent_dir, track_index, start, end, quality)
        sid = uuid.uuid4().hex[:12]
        job = StemJob(sid, track_index, title, out_dir)

        with self._lock:
            if cached:
                job.update(stems=cached, status="ready", progress=1.0,
                           message="Loaded cached stems.")
                self._jobs[sid] = job
                return job
            # Reuse an existing in-flight job for the same region if present.
            existing_id = self._inflight.get(key)
            if existing_id:
                existing = self._jobs.get(existing_id)
                if existing and existing.status == "running":
                    return existing
            self._jobs[sid] = job
            self._inflight[key] = sid

        # Status stays "running" on the wire (so the frontend treats it as
        # in-progress); the message reflects that it is waiting in the queue.
        job.update(status="running", progress=0.0,
                   message="Queued — waiting for the separator…")

        def run():
            time_factors = {"vocal": 0.3, "fast": 0.4, "balanced": 1.2, "high": 2.6}
            est = max(8.0, (end - start) * time_factors.get(quality, 1.2))
            stop = threading.Event()

            def ticker():
                t0 = time.time()
                messages = {
                    "vocal": "Vocal/instrumental split: 2 stems (vocals, instrumental)…",
                    "fast": "Fast separation: 5 stems (vocals, kick, drums, bass, other)…",
                    "balanced": "Balanced separation: 8 stems (vocals, kick, drums, bass, guitar, piano, synth, perc)…",
                    "high": "High-quality separation: 8 stems (vocals, kick, drums, bass, guitar, piano, synth, perc)…"
                }
                while not stop.is_set():
                    frac = min(0.95, 0.05 + (time.time() - t0) / est * 0.9)
                    job.update(progress=frac, message=messages.get(quality, messages["balanced"]))
                    stop.wait(0.5)

            # Block here (not inside separate) so queued jobs report "Queued…"
            # with no fake progress until the separator is actually free.
            with _inference_gate:
                th = threading.Thread(target=ticker, daemon=True)
                try:
                    out_dir.mkdir(parents=True, exist_ok=True)
                    th.start()
                    result = separate(src_wav, start, end, out_dir, quality)
                    stop.set()
                    _write_stem_manifest(out_dir, quality, track_index, start, end, result["stems"])
                    job.update(stems=result["stems"], samplerate=result["samplerate"],
                               status="ready", progress=1.0, message="Stems ready.")
                except Exception as exc:  # noqa: BLE001
                    stop.set()
                    traceback.print_exc()
                    job.update(status="error", error=str(exc), message=f"Separation failed: {exc}")
                finally:
                    stop.set()
                    queue_empty = False
                    with self._lock:
                        if self._inflight.get(key) == sid:
                            del self._inflight[key]
                        queue_empty = len(self._inflight) == 0
                    if queue_empty:
                        unload_model()
                    self._evict_jobs()

        threading.Thread(target=run, daemon=True).start()
        return job


stem_manager = StemManager()
