"""Transcribe an isolated vocal stem into timestamped lines (lyrics) using
faster-whisper.

We transcribe the separated *vocals* stem (not the full mix) so the model hears
clean singing. VAD + anti-hallucination guards stop Whisper from inventing
repeated text over the instrumental residue that bleeds into the stem.
"""
from __future__ import annotations

import json
import os
import threading
import traceback
from pathlib import Path
from typing import Dict, Optional

import certifi

# python.org Python ships without CA certs; let the model download verify TLS.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

# Model size is configurable; "base" is fast and decent, "small"/"medium" are
# more accurate for lyrics (bigger download, slower).
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base").strip() or "base"
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "").strip()  # "" => auto-detect

_model = None
_model_lock = threading.Lock()


def get_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        return _model


def _transcribe(path: Path, on_segment=None) -> dict:
    model = get_model()
    segments, info = model.transcribe(
        str(path),
        language=WHISPER_LANGUAGE or None,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=600, threshold=0.35),
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.2,
        log_prob_threshold=-1.0,
    )
    total = float(getattr(info, "duration", 0.0)) or 1.0
    lines = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        lines.append({"start": round(float(seg.start), 2),
                      "end": round(float(seg.end), 2),
                      "text": text})
        if on_segment:
            on_segment(min(0.99, float(seg.end) / total))
    return {"language": getattr(info, "language", ""), "segments": lines}


class TranscribeJob:
    def __init__(self, id: str, cache_path: Path):
        self.id = id
        self.cache_path = cache_path
        self.status = "running"   # running | ready | error
        self.progress = 0.0
        self.message = "Transcribing vocals…"
        self.error: Optional[str] = None
        self.language = ""
        self.segments = []
        self._lock = threading.Lock()

    def update(self, **kw):
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "status": self.status,
                "progress": round(self.progress, 3),
                "message": self.message,
                "error": self.error,
                "language": self.language,
                "segments": list(self.segments),
            }


class TranscribeManager:
    def __init__(self):
        self._jobs: Dict[str, TranscribeJob] = {}
        self._lock = threading.Lock()

    def get(self, tid: str) -> Optional[TranscribeJob]:
        with self._lock:
            return self._jobs.get(tid)

    def create(self, tid: str, vocals_path: Path, cache_path: Path) -> TranscribeJob:
        job = TranscribeJob(tid, cache_path)
        with self._lock:
            self._jobs[tid] = job

        def run():
            try:
                if cache_path.exists():
                    data = json.loads(cache_path.read_text())
                    job.update(language=data.get("language", ""),
                               segments=data.get("segments", []),
                               status="ready", progress=1.0,
                               message="Loaded cached lyrics.")
                    return
                if not vocals_path.exists():
                    raise RuntimeError("Vocal stem not found. Separate stems first.")
                job.update(message=f"Transcribing vocals with Whisper ({WHISPER_MODEL})…")
                result = _transcribe(vocals_path, on_segment=lambda p: job.update(progress=p))
                cache_path.write_text(json.dumps(result))
                msg = ("No clear vocals detected in this track."
                       if not result["segments"] else "Lyrics ready.")
                job.update(language=result["language"], segments=result["segments"],
                           status="ready", progress=1.0, message=msg)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Transcription failed: {exc}")

        threading.Thread(target=run, daemon=True).start()
        return job


transcribe_manager = TranscribeManager()
