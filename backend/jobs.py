"""In-memory job manager that runs the download -> analyze -> identify pipeline
on background threads and exposes progress for polling."""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

CACHE_VERSION = 1

from dotenv import load_dotenv

from analysis import analyze, estimate_bpm, segment_from_novelty
from config import DATA_DIR, ROOT, get_acrcloud_config, require_ffmpeg
from download import download_audio
from export import export_one, export_tracks
from identify import identify_segments
from metadata_fallback import match_segment_to_metadata, split_artist_title


@dataclass
class Job:
    id: str
    url: str
    status: str = "queued"          # queued|running|ready|exporting|done|error
    stage: str = "queued"           # download|analyze|identify|export
    progress: float = 0.0           # 0..1 within the current stage
    message: str = "Queued"
    error: Optional[str] = None
    source: Dict = field(default_factory=dict)
    result: Dict = field(default_factory=dict)   # duration, segments, waveform, novelty, tracks
    export: Dict = field(default_factory=dict)
    # cached analysis internals for cheap re-detection (not sent to the client)
    novelty_full: list = field(default_factory=list, repr=False)
    resolution: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def dir(self) -> Path:
        return DATA_DIR / self.id

    def update(self, **kwargs) -> None:
        with self._lock:
            for k, v in kwargs.items():
                setattr(self, k, v)

    def snapshot(self) -> Dict:
        with self._lock:
            return {
                "id": self.id,
                "url": self.url,
                "status": self.status,
                "stage": self.stage,
                "progress": round(self.progress, 4),
                "message": self.message,
                "error": self.error,
                "source": self.source,
                "result": self.result,
                "export": self.export,
            }


def normalize_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    try:
        from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
        parsed = urlparse(url)
        if not parsed.netloc:
            return url
        # Handle youtu.be / youtube.com video ID
        if "youtu.be" in parsed.netloc:
            video_id = parsed.path.strip("/")
            return f"https://www.youtube.com/watch?v={video_id}"
        if "youtube.com" in parsed.netloc:
            qs = parse_qs(parsed.query)
            if "v" in qs:
                video_id = qs["v"][0]
                return f"https://www.youtube.com/watch?v={video_id}"
        clean_path = parsed.path.rstrip("/")
        clean_query = urlencode(sorted([(k, v) for k, vs in parse_qs(parsed.query).items() if k not in ("t", "si", "feature", "fbclid", "utm_source", "utm_medium", "utm_campaign") for v in vs]))
        return urlunparse((parsed.scheme, parsed.netloc.lower(), clean_path, "", clean_query, ""))
    except Exception:
        return url.rstrip("/")


class JobManager:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def create(self, url: str) -> Job:
        url = url.strip()
        # If we've already downloaded + analyzed this exact URL, reuse it instantly
        # instead of running the whole download -> analyze -> identify pipeline again.
        cached_id = self._find_cached_by_url(url)
        if cached_id:
            existing = self.get(cached_id)
            if existing and existing.status in ("ready", "done"):
                return existing
            return self.adopt(cached_id)

        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, url=url)
        job.dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._jobs[job_id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def create_from_file(self, src_path: Path, title: str = "") -> Job:
        """Import a local audio file: check for cached duplicates, otherwise transcode and analyze."""
        file_title = title or src_path.stem
        cached_id = self._find_cached_by_file(file_title)
        if cached_id:
            try:
                src_path.unlink(missing_ok=True)
            except Exception:
                pass
            existing = self.get(cached_id)
            if existing and existing.status in ("ready", "done"):
                return existing
            return self.adopt(cached_id)

        job_id = uuid.uuid4().hex[:12]
        job = Job(id=job_id, url=f"file:{file_title}")
        job.dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._jobs[job_id] = job

        def run():
            try:
                job.update(status="running", stage="download", progress=0.3, message="Importing file…")
                ffmpeg = require_ffmpeg()
                dst = job.dir / "source.wav"
                subprocess.run(
                    [ffmpeg, "-y", "-loglevel", "error", "-i", str(src_path),
                     "-ac", "2", "-ar", "44100", str(dst)],
                    check=True,
                )
                artist, clean_title = split_artist_title(file_title)
                job.update(source={
                    "title": file_title,
                    "clean_title": clean_title or file_title,
                    "artist": artist,
                    "uploader": "",
                    "webpage_url": "",
                })
                self._analyze_and_identify(job, dst)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Failed: {exc}")
            finally:
                try:
                    src_path.unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass

        threading.Thread(target=run, daemon=True).start()
        return job

    # ---------- result cache (survives restarts) ----------
    @staticmethod
    def _cache_path(job_dir: Path) -> Path:
        return job_dir / "result.json"

    def _save_cache(self, job: Job) -> None:
        try:
            payload = {
                "version": CACHE_VERSION,
                "url": job.url,
                "source": job.source,
                "result": job.result,
                "novelty_full": job.novelty_full,
                "resolution": job.resolution,
            }
            tmp = self._cache_path(job.dir).with_suffix(".tmp")
            tmp.write_text(json.dumps(payload))
            tmp.replace(self._cache_path(job.dir))
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    def _load_cache(self, job_dir: Path) -> Optional[dict]:
        path = self._cache_path(job_dir)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
            if data.get("version") != CACHE_VERSION or not data.get("result"):
                return None
            return data
        except Exception:  # noqa: BLE001
            return None

    def _find_cached_by_url(self, url: str) -> Optional[str]:
        if not url or url.startswith("cached:"):
            return None
        if not DATA_DIR.exists():
            return None
        norm_target = normalize_url(url)
        for d in DATA_DIR.iterdir():
            if not d.is_dir():
                continue
            data = self._load_cache(d)
            if data and (d / "source.wav").exists():
                cached_url = data.get("url", "").strip()
                if cached_url == url or (norm_target and normalize_url(cached_url) == norm_target):
                    return d.name
        return None

    def _find_cached_by_file(self, filename: str) -> Optional[str]:
        if not filename or not DATA_DIR.exists():
            return None
        name = filename.strip().lower()
        for d in DATA_DIR.iterdir():
            if not d.is_dir():
                continue
            data = self._load_cache(d)
            if data and (d / "source.wav").exists():
                cached_url = data.get("url", "").strip().lower()
                cached_title = (data.get("source") or {}).get("title", "").strip().lower()
                if cached_url == f"file:{name}" or cached_title == name:
                    return d.name
        return None

    def list_cached(self) -> list:
        """Mixes already downloaded to disk (survive server restarts)."""
        items = []
        for d in DATA_DIR.iterdir():
            src = d / "source.wav"
            if d.is_dir() and src.exists():
                st = src.stat()
                cache = self._load_cache(d)
                title = ""
                track_count = None
                analyzed = False
                track_list: list = []
                if cache:
                    analyzed = True
                    title = (cache.get("source") or {}).get("title") or ""
                    raw_tracks = (cache.get("result") or {}).get("tracks") or []
                    track_count = len(raw_tracks)
                    track_list = [
                        {
                            "index": t["index"],
                            "start": t["start"],
                            "end": t["end"],
                            "title": t.get("title") or f"Track {t['index']:02d}",
                            "artist": t.get("artist") or "",
                        }
                        for t in raw_tracks
                    ]
                items.append({
                    "id": d.name,
                    "size_mb": round(st.st_size / 1e6),
                    "mtime": st.st_mtime,
                    "title": title,
                    "tracks": track_count,
                    "analyzed": analyzed,
                    "track_list": track_list,
                })
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items

    def adopt(self, source_id: str) -> Job:
        """Open an already-downloaded mix. If we have a cached result, load it
        instantly; otherwise analyze the existing audio without re-downloading."""
        src_dir = DATA_DIR / source_id
        src = src_dir / "source.wav"
        if ".." in source_id or "/" in source_id or not src.exists():
            raise FileNotFoundError("That cached mix was not found.")

        # already loaded in memory and ready — reuse as-is
        existing = self.get(source_id)
        if existing and existing.status in ("ready", "done"):
            return existing

        job = Job(id=source_id, url=f"cached:{source_id}")
        with self._lock:
            self._jobs[source_id] = job

        cached = self._load_cache(src_dir)
        if cached:
            # instant: no analysis, no identification, no network
            job.url = cached.get("url") or job.url
            job.resolution = cached.get("resolution") or 0.0
            job.update(
                source=cached.get("source") or {"title": f"Imported mix ({source_id})"},
                result=cached["result"],
                status="ready",
                stage="ready",
                progress=1.0,
                message=f"Loaded {len(cached['result'].get('tracks', []))} cached tracks.",
            )
            return job

        job.update(source={"title": f"Imported mix ({source_id})", "uploader": "", "webpage_url": ""})

        def run():
            try:
                job.update(status="running", message="Loading cached audio…")
                self._analyze_and_identify(job, src)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Failed: {exc}")

        threading.Thread(target=run, daemon=True).start()
        return job

    def _run(self, job: Job) -> None:
        try:
            job.update(status="running", stage="download", progress=0.0, message="Starting download…")

            def dl_progress(frac, msg):
                job.update(progress=frac, message=msg)

            info = download_audio(job.url, job.dir, on_progress=dl_progress)
            src: Path = info["path"]
            job.update(
                source={
                    "title": info["title"],
                    "duration": info["duration"],
                    "uploader": info["uploader"],
                    "webpage_url": info["webpage_url"],
                    "description": info.get("description", ""),
                    "chapters": info.get("chapters", []),
                    "artist": info.get("artist", ""),
                    "track": info.get("track", ""),
                },
            )

            self._analyze_and_identify(job, src)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="error", error=str(exc), message=f"Failed: {exc}")

    def _analyze_and_identify(self, job: Job, src: Path) -> None:
        job.update(stage="analyze", progress=0.0, message="Analyzing audio…")

        def an_progress(frac, msg):
            job.update(progress=frac, message=msg)

        analysis = analyze(src, on_progress=an_progress)
        job.novelty_full = analysis["novelty_full"]
        job.resolution = analysis["resolution"]

        job.update(stage="identify", progress=0.0, message="Identifying tracks…")
        cfg = get_acrcloud_config()
        tracks = self._identify_to_tracks(job, src, analysis["segments"], cfg)

        has_quota_err = any(
            t.get("id_status") == "error" and ("limit exceeded" in (t.get("id_message") or "").lower())
            for t in tracks
        )
        matched_n = sum(1 for t in tracks if t.get("id_status") in ("matched", "fallback_chapter", "fallback_tracklist", "fallback_source_title", "fallback_source_meta"))
        if has_quota_err:
            fin_msg = f"Found {len(tracks)} tracks ({matched_n} labelled). Note: ACRCloud quota exceeded — see status bar."
        else:
            fin_msg = f"Found {len(tracks)} tracks ({matched_n} labelled). Review and export."

        job.update(
            result={
                "duration": analysis["duration"],
                "waveform": analysis["waveform"],
                "novelty": analysis["novelty"],
                "tracks": tracks,
                "acrcloud_configured": cfg.configured,
                "sensitivity": analysis["sensitivity"],
            },
            status="ready",
            stage="ready",
            progress=1.0,
            message=fin_msg,
        )
        self._save_cache(job)
        job.novelty_full = []

    def ensure_novelty(self, job: Job) -> None:
        """Load cached novelty curve on demand (keeps RAM low at rest)."""
        if job.novelty_full:
            return
        cached = self._load_cache(job.dir)
        if not cached:
            raise RuntimeError("Analysis data not available for re-detection.")
        job.novelty_full = cached.get("novelty_full") or []
        job.resolution = cached.get("resolution") or job.resolution
        if not job.novelty_full:
            raise RuntimeError("Analysis data not available for re-detection.")

    def _identify_to_tracks(self, job: Job, src: Path, segments: List[Dict], cfg) -> List[Dict]:
        def id_progress(frac, msg):
            job.update(progress=frac, message=msg)

        ids = identify_segments(cfg, src, segments, on_progress=id_progress)
        tracks: List[Dict] = []
        total_dur = (job.result or {}).get("duration") or 0.0
        seg_count = len(segments)

        for seg, ident in zip(segments, ids):
            status = ident.get("status")
            title = ident.get("title") if status == "matched" else ""
            artist = ident.get("artist") if status == "matched" else ""
            id_msg = ident.get("message", "")

            # If ACRCloud did not find a match or errored (e.g. quota limit exceeded)
            if not title:
                fb_title, fb_artist, fb_method = match_segment_to_metadata(
                    seg, total_dur, job.source or {}, seg_count
                )
                if fb_title:
                    title = fb_title
                    artist = fb_artist
                    status = f"fallback_{fb_method}"
                    id_msg = f"Detected from {fb_method}"

            tracks.append({
                "index": seg["index"],
                "start": seg["start"],
                "end": seg["end"],
                "title": title or f"Track {seg['index']:02d}",
                "artist": artist or "",
                "id_status": status,
                "id_message": id_msg,
                "score": ident.get("score"),
            })
        return tracks

    def redetect(self, job: Job, sensitivity: float) -> None:
        """Re-split using the cached novelty curve and a new sensitivity. Fast."""
        def run():
            try:
                self.ensure_novelty(job)
                job.update(status="running", stage="identify", progress=0.0, message="Re-splitting…")
                src = job.dir / "source.wav"
                segments = segment_from_novelty(
                    job.novelty_full, job.resolution, job.result["duration"], sensitivity
                )
                cfg = get_acrcloud_config()
                tracks = self._identify_to_tracks(job, src, segments, cfg)
                new_result = dict(job.result)
                new_result["tracks"] = tracks
                new_result["sensitivity"] = sensitivity

                has_quota_err = any(
                    t.get("id_status") == "error" and ("limit exceeded" in (t.get("id_message") or "").lower())
                    for t in tracks
                )
                matched_n = sum(1 for t in tracks if t.get("id_status") in ("matched", "fallback_chapter", "fallback_tracklist", "fallback_source_title", "fallback_source_meta"))
                if has_quota_err:
                    fin_msg = f"Found {len(tracks)} tracks ({matched_n} labelled). Note: ACRCloud quota exceeded."
                else:
                    fin_msg = f"Found {len(tracks)} tracks ({matched_n} labelled). Review and export."

                job.update(
                    result=new_result,
                    status="ready",
                    stage="ready",
                    progress=1.0,
                    message=fin_msg,
                )
                self._save_cache(job)
                job.novelty_full = []
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Re-detect failed: {exc}")

        threading.Thread(target=run, daemon=True).start()

    def reidentify(self, job: Job) -> None:
        """Re-run track identification using latest credentials and audio clips."""
        def run():
            try:
                job.update(status="running", stage="identify", progress=0.0, message="Re-identifying tracks…")
                src = job.dir / "source.wav"
                if not src.exists():
                    raise RuntimeError("Audio file source.wav not found.")

                load_dotenv(ROOT / ".env", override=True)
                cfg = get_acrcloud_config()

                current_tracks = (job.result or {}).get("tracks") or []
                segments = [{"index": t["index"], "start": t["start"], "end": t["end"]} for t in current_tracks]

                tracks = self._identify_to_tracks(job, src, segments, cfg)

                new_result = dict(job.result)
                new_result["tracks"] = tracks
                new_result["acrcloud_configured"] = cfg.configured

                has_quota_err = any(
                    t.get("id_status") == "error" and ("limit exceeded" in (t.get("id_message") or "").lower())
                    for t in tracks
                )
                matched_n = sum(1 for t in tracks if t.get("id_status") in ("matched", "fallback_chapter", "fallback_tracklist", "fallback_source_title", "fallback_source_meta"))
                if has_quota_err:
                    fin_msg = f"Re-identified {len(tracks)} tracks ({matched_n} labelled). Note: ACRCloud quota exceeded."
                else:
                    fin_msg = f"Re-identified {len(tracks)} tracks ({matched_n} labelled)."

                job.update(
                    result=new_result,
                    status="ready",
                    stage="ready",
                    progress=1.0,
                    message=fin_msg,
                )
                self._save_cache(job)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Re-identify failed: {exc}")

        threading.Thread(target=run, daemon=True).start()

    def update_tracks(self, job: Job, tracks: List[Dict]) -> None:
        """Persist manually edited track boundaries/names into the cached result."""
        if not job.result:
            raise RuntimeError("No analysis result to update.")
        cleaned: List[Dict] = []
        for i, t in enumerate(tracks, start=1):
            cleaned.append({
                "index": int(t.get("index") or i),
                "start": float(t["start"]),
                "end": float(t["end"]),
                "title": (t.get("title") or f"Track {i:02d}").strip(),
                "artist": (t.get("artist") or "").strip(),
                "id_status": t.get("id_status") or "unknown",
                "id_message": t.get("id_message") or "",
                "score": t.get("score"),
            })
        new_result = dict(job.result)
        new_result["tracks"] = cleaned
        job.update(
            result=new_result,
            status="ready",
            stage="ready",
            progress=1.0,
            message=f"Saved {len(cleaned)} tracks.",
        )
        self._save_cache(job)

    def delete_track(self, job: Job, track_index: int) -> None:
        """Remove one track from a mix, extending the neighbour boundary."""
        if not job.result:
            raise RuntimeError("No analysis result to update.")
        tracks: List[Dict] = list(job.result.get("tracks") or [])
        if len(tracks) <= 1:
            raise ValueError("Cannot delete the only remaining track.")
        idx = int(track_index) - 1
        if idx < 0 or idx >= len(tracks):
            raise ValueError("Track not found.")
        removed = tracks[idx]
        _remove_region_file(job.dir, removed["start"], removed["end"])
        _remove_stem_dir(job.dir, int(track_index), removed["start"], removed["end"])
        _remove_bpm_entry(job.dir, removed["start"], removed["end"])
        if idx > 0:
            tracks[idx - 1]["end"] = removed["end"]
        elif idx < len(tracks) - 1:
            tracks[idx + 1]["start"] = removed["start"]
        tracks.pop(idx)
        cleaned: List[Dict] = []
        for i, t in enumerate(tracks, start=1):
            cleaned.append({
                "index": i,
                "start": float(t["start"]),
                "end": float(t["end"]),
                "title": (t.get("title") or f"Track {i:02d}").strip(),
                "artist": (t.get("artist") or "").strip(),
                "id_status": t.get("id_status") or "unknown",
                "id_message": t.get("id_message") or "",
                "score": t.get("score"),
            })
        new_result = dict(job.result)
        new_result["tracks"] = cleaned
        job.update(
            result=new_result,
            status="ready",
            stage="ready",
            progress=1.0,
            message=f"Saved {len(cleaned)} tracks.",
        )
        _cleanup_orphaned_regions(job.dir, cleaned)
        self._save_cache(job)

    def delete_job(self, job_id: str) -> None:
        """Completely delete a mix/job from memory and disk."""
        if ".." in job_id or "/" in job_id or "\\" in job_id:
            raise ValueError("Invalid job id.")
        with self._lock:
            if job_id in self._jobs:
                del self._jobs[job_id]
        job_dir = DATA_DIR / job_id
        if job_dir.exists() and job_dir.is_dir():
            shutil.rmtree(job_dir, ignore_errors=True)

    def region_wav(self, job: Job, start: float, end: float) -> Path:
        """Cut [start, end] from source into a temp WAV for browser preview."""
        src = job.dir / "source.wav"
        if not src.exists():
            raise RuntimeError("Source audio not available.")
        tmp_dir = job.dir / ".tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        dst = tmp_dir / f"{region_key(start, end)}.wav"
        if dst.exists() and dst.stat().st_size > 0:
            return dst
        ffmpeg = require_ffmpeg()
        duration = max(0.1, float(end) - float(start))
        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-ss", f"{float(start):.3f}", "-t", f"{duration:.3f}",
            "-i", str(src),
            "-ac", "2", "-ar", "44100",
            str(dst),
        ]
        subprocess.run(cmd, check=True)
        return dst

    def track_bpm(self, job: Job, start: float, end: float) -> Dict:
        """Estimate (and cache) BPM + beat offset for a track region."""
        src = job.dir / "source.wav"
        if not src.exists():
            raise RuntimeError("Source audio not available.")
        key = region_key(start, end)
        cache_path = job.dir / "bpm.json"
        cache: Dict[str, Dict] = {}
        if cache_path.exists():
            try:
                cache = json.loads(cache_path.read_text())
            except Exception:  # noqa: BLE001
                cache = {}
        if key in cache:
            return cache[key]
        result = estimate_bpm(src, start, end)
        cache[key] = result
        try:
            cache_path.write_text(json.dumps(cache))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        return result

    def export_single(self, job: Job, track: Dict, index: int) -> Dict:
        """Export one track synchronously (fast) and return its file info."""
        src = job.dir / "source.wav"
        if not src.exists():
            raise RuntimeError("Source audio not available.")
        return export_one(src, job.dir / "tracks", track, index)

    def export(self, job: Job, tracks: List[Dict]) -> None:
        def run():
            try:
                job.update(status="exporting", stage="export", progress=0.0, message="Exporting MP3s…")
                src = job.dir / "source.wav"

                def ex_progress(frac, msg):
                    job.update(progress=frac, message=msg)

                out_dir = job.dir / "tracks"
                result = export_tracks(src, out_dir, tracks, on_progress=ex_progress)
                job.update(
                    export=result,
                    status="done",
                    stage="done",
                    progress=1.0,
                    message=f"Exported {len(result['files'])} MP3s.",
                )
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                job.update(status="error", error=str(exc), message=f"Export failed: {exc}")

        threading.Thread(target=run, daemon=True).start()


def region_key(start: float, end: float) -> str:
    return f"{round(start, 2)}_{round(end, 2)}"


def _region_wav_path(job_dir: Path, start: float, end: float) -> Path:
    return job_dir / "regions" / f"{region_key(start, end)}.wav"


def _stem_dir_path(job_dir: Path, track_index: int, start: float, end: float) -> Path:
    return job_dir / "stems" / f"t{track_index}_{int(start)}_{int(end)}"


def _remove_region_file(job_dir: Path, start: float, end: float) -> None:
    path = _region_wav_path(job_dir, start, end)
    if path.is_file():
        path.unlink()


def _remove_stem_dir(job_dir: Path, track_index: int, start: float, end: float) -> None:
    path = _stem_dir_path(job_dir, track_index, start, end)
    if path.is_dir():
        shutil.rmtree(path)


def _remove_bpm_entry(job_dir: Path, start: float, end: float) -> None:
    key = region_key(start, end)
    cache_path = job_dir / "bpm.json"
    if not cache_path.is_file():
        return
    try:
        cache = json.loads(cache_path.read_text())
    except Exception:  # noqa: BLE001
        return
    if key not in cache:
        return
    del cache[key]
    if cache:
        cache_path.write_text(json.dumps(cache))
    else:
        cache_path.unlink()


def _cleanup_orphaned_regions(job_dir: Path, tracks: List[Dict]) -> None:
    regions_dir = job_dir / "regions"
    if not regions_dir.is_dir():
        return
    valid = {region_key(t["start"], t["end"]) for t in tracks}
    for path in regions_dir.glob("*.wav"):
        if path.stem not in valid:
            path.unlink()


manager = JobManager()
