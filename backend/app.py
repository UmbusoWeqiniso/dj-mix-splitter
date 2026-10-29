"""FastAPI application: pipeline API + static frontend."""
from __future__ import annotations

import urllib.parse
from pathlib import Path

import uuid

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import DATA_DIR, get_acrcloud_config, get_apple_music_config, get_spotify_config, require_ffmpeg
from identify import check_acrcloud_status
from jobs import manager
from stems import STEM_ORDER, stem_manager
from transcribe import transcribe_manager
from apple_music import catalog_search, catalog_song, developer_token, status as apple_music_status
import spotify as spotify_svc
from services import list_services, services_summary
from stitch import apply_edit, edit_state, export_to_mp3, revert_all, stitch_dir_name, write_preview
from storage import cleanup_regions, clear_stems, storage_summary

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"

app = FastAPI(title="DJ Mix Splitter")


class CreateJob(BaseModel):
    url: str


class TrackEdit(BaseModel):
    start: float
    end: float
    title: str = ""
    artist: str = ""


class ExportRequest(BaseModel):
    tracks: list[TrackEdit]


class TrackSave(BaseModel):
    index: int = 1
    start: float
    end: float
    title: str = ""
    artist: str = ""
    id_status: str = "unknown"
    id_message: str = ""
    score: float | None = None


class TracksUpdateRequest(BaseModel):
    tracks: list[TrackSave]


class RedetectRequest(BaseModel):
    sensitivity: float


class SingleTrack(BaseModel):
    start: float
    end: float
    title: str = ""
    artist: str = ""
    index: int = 1


class BpmRequest(BaseModel):
    start: float
    end: float


class StemRequest(BaseModel):
    track_index: int = 1
    start: float
    end: float
    title: str = ""
    quality: str = "balanced"  # "vocal", "fast", "balanced", "high"


class MixRequest(BaseModel):
    stems: list[str]
    title: str = ""
    artist: str = ""


class StitchRequest(BaseModel):
    start: float
    end: float
    quality: str = "balanced"
    muted: list[str] = []
    crossfade_ms: float = 25.0


class StorageClearStems(BaseModel):
    job_id: str


@app.get("/api/health")
def health() -> dict:
    cfg = get_acrcloud_config()
    ffmpeg_ok = True
    ffmpeg_msg = ""
    try:
        require_ffmpeg()
    except RuntimeError as exc:
        ffmpeg_ok = False
        ffmpeg_msg = str(exc)
    acr_status = check_acrcloud_status(cfg)
    return {
        "ffmpeg": ffmpeg_ok,
        "ffmpeg_message": ffmpeg_msg,
        "acrcloud_configured": cfg.configured,
        "acrcloud_status": acr_status.get("status", "unknown"),
        "acrcloud_code": acr_status.get("code"),
        "acrcloud_message": acr_status.get("message", ""),
        "apple_music_configured": get_apple_music_config().configured,
        "spotify_configured": get_spotify_config().configured,
        "spotify_connected": spotify_svc.connected() if get_spotify_config().configured else False,
    }


@app.get("/api/resources")
def resources() -> dict:
    try:
        import psutil
    except ImportError:
        return {"available": False}
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage(str(DATA_DIR))
    return {
        "available": True,
        "cpu_percent": psutil.cpu_percent(interval=0.05),
        "memory_mb": round(mem.used / (1024 * 1024)),
        "memory_percent": round(mem.percent, 1),
        "disk_used_gb": round(disk.used / (1024 ** 3), 1),
        "disk_total_gb": round(disk.total / (1024 ** 3), 1),
        "disk_percent": round(disk.percent, 1),
    }


@app.get("/api/services")
def get_services() -> dict:
    return services_summary()


@app.get("/api/services/spotify/login")
def spotify_login() -> dict:
    try:
        return spotify_svc.login_url()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/api/services/spotify/callback")
def spotify_callback(code: str = "", state: str = "", error: str = ""):
    if error:
        return RedirectResponse("/?services=spotify-error")
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing OAuth code or state.")
    try:
        spotify_svc.finish_login(code, state)
    except (ValueError, RuntimeError) as exc:
        return RedirectResponse(f"/?services=spotify-error&msg={urllib.parse.quote(str(exc))}")
    return RedirectResponse("/?services=spotify-connected")


@app.post("/api/services/spotify/disconnect")
def spotify_disconnect() -> dict:
    spotify_svc.disconnect()
    return {"ok": True}


@app.get("/api/services/spotify/search")
def spotify_search(q: str, limit: int = 20) -> dict:
    try:
        tracks = spotify_svc.search(q, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return {"tracks": tracks}


@app.get("/api/services/spotify/tracks/{track_id}")
def spotify_track(track_id: str) -> dict:
    try:
        track = spotify_svc.lookup_track(track_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not track:
        raise HTTPException(status_code=404, detail="Track not found.")
    return track


@app.get("/api/apple-music/status")
def apple_music_status_ep() -> dict:
    try:
        return apple_music_status()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/apple-music/token")
def apple_music_token() -> dict:
    try:
        return {"token": developer_token()}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/api/apple-music/search")
def apple_music_search(q: str, types: str = "songs", limit: int = 20) -> dict:
    try:
        return catalog_search(q, types=types, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/api/apple-music/songs/{song_id}")
def apple_music_song(song_id: str) -> dict:
    try:
        song = catalog_song(song_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    if not song:
        raise HTTPException(status_code=404, detail="Song not found in catalog.")
    return song


@app.post("/api/jobs")
def create_job(body: CreateJob) -> dict:
    url = body.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="A YouTube/audio URL is required.")
    job = manager.create(url)
    return job.snapshot()


@app.post("/api/jobs/upload")
async def upload_job(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    uploads = DATA_DIR / "_uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    safe = (file.filename or "audio").replace("/", "_").replace("..", "_")
    tmp = uploads / f"{uuid.uuid4().hex[:8]}_{safe}"
    tmp.write_bytes(data)
    job = manager.create_from_file(tmp, Path(safe).stem)
    return job.snapshot()


@app.get("/api/cached")
def list_cached() -> list:
    return manager.list_cached()


@app.post("/api/jobs/adopt")
def adopt_job(body: dict) -> dict:
    source_id = (body or {}).get("id", "")
    try:
        job = manager.adopt(source_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return job.snapshot()


def _get_job(job_id: str) -> Job:
    job = manager.get(job_id)
    if not job:
        try:
            job = manager.adopt(job_id)
        except Exception:
            pass
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return _get_job(job_id).snapshot()


@app.post("/api/jobs/{job_id}/redetect")
def redetect_job(job_id: str, body: RedetectRequest) -> dict:
    job = _get_job(job_id)
    if job.status in ("running", "exporting"):
        raise HTTPException(status_code=409, detail="Job is busy.")
    try:
        manager.ensure_novelty(job)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    manager.redetect(job, body.sensitivity)
    return job.snapshot()


@app.post("/api/jobs/{job_id}/reidentify")
def reidentify_job(job_id: str) -> dict:
    job = _get_job(job_id)
    if job.status in ("running", "exporting"):
        raise HTTPException(status_code=409, detail="Job is busy.")
    manager.reidentify(job)
    return job.snapshot()


@app.post("/api/jobs/{job_id}/tracks")
def update_tracks(job_id: str, body: TracksUpdateRequest) -> dict:
    job = _get_job(job_id)
    if job.status in ("running", "exporting"):
        raise HTTPException(status_code=409, detail="Job is busy.")
    if not body.tracks:
        raise HTTPException(status_code=400, detail="No tracks provided.")
    try:
        manager.update_tracks(job, [t.model_dump() for t in body.tracks])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return job.snapshot()


@app.delete("/api/jobs/{job_id}/tracks/{track_index}")
def delete_track(job_id: str, track_index: int) -> dict:
    job = _get_job(job_id)
    if job.status in ("running", "exporting"):
        raise HTTPException(status_code=409, detail="Job is busy.")
    try:
        manager.delete_track(job, track_index)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return job.snapshot()


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    if ".." in job_id or "/" in job_id or "\\" in job_id:
        raise HTTPException(status_code=400, detail="Invalid job id.")
    try:
        manager.delete_job(job_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"ok": True, "id": job_id}


@app.api_route("/api/jobs/{job_id}/audio", methods=["GET", "HEAD"])
def get_audio(job_id: str):
    job = _get_job(job_id)
    src = job.dir / "source.wav"
    if not src.exists():
        raise HTTPException(status_code=404, detail="Audio not ready")
    return FileResponse(src, media_type="audio/wav")


@app.post("/api/jobs/{job_id}/export")
def export_job(job_id: str, body: ExportRequest) -> dict:
    job = _get_job(job_id)
    if not body.tracks:
        raise HTTPException(status_code=400, detail="No tracks selected for export.")
    if job.status in ("running", "exporting"):
        raise HTTPException(status_code=409, detail="Job is busy.")
    tracks = [t.model_dump() for t in body.tracks]
    manager.export(job, tracks)
    return job.snapshot()


@app.post("/api/jobs/{job_id}/track")
def export_single_track(job_id: str, body: SingleTrack) -> dict:
    job = _get_job(job_id)
    try:
        info = manager.export_single(job, body.model_dump(), body.index)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return info


@app.get("/api/storage")
def get_storage() -> dict:
    return storage_summary()


@app.post("/api/storage/clear-stems")
def storage_clear_stems(body: StorageClearStems) -> dict:
    try:
        return clear_stems(body.job_id.strip())
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/storage/cleanup-regions")
def storage_cleanup_regions() -> dict:
    return cleanup_regions()


@app.api_route("/api/jobs/{job_id}/region", methods=["GET", "HEAD"])
def get_region(job_id: str, start: float, end: float):
    job = _get_job(job_id)
    try:
        path = manager.region_wav(job, start, end)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/jobs/{job_id}/bpm")
def track_bpm(job_id: str, body: BpmRequest) -> dict:
    job = _get_job(job_id)
    try:
        return manager.track_bpm(job, body.start, body.end)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/jobs/{job_id}/stems")
def create_stems(job_id: str, body: StemRequest) -> dict:
    job = _get_job(job_id)
    src = job.dir / "source.wav"
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source audio not available")
    sjob = stem_manager.create(src, job.dir, body.track_index, body.start, body.end, body.title, body.quality)
    return sjob.snapshot()


@app.get("/api/stems/{stem_id}")
def get_stems(stem_id: str) -> dict:
    sjob = stem_manager.get(stem_id)
    if not sjob:
        raise HTTPException(status_code=404, detail="Stem job not found")
    return sjob.snapshot()


@app.api_route("/api/stems/{stem_id}/audio/{stem}", methods=["GET", "HEAD"])
def get_stem_audio(stem_id: str, stem: str):
    sjob = stem_manager.get(stem_id)
    if not sjob or stem not in sjob.stems:
        raise HTTPException(status_code=404, detail="Stem not found")
    path = sjob.dir / sjob.stems[stem]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Stem file missing")
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/stems/{stem_id}/mix")
def mix_stems_ep(stem_id: str, body: MixRequest) -> dict:
    sjob = stem_manager.get(stem_id)
    if not sjob:
        raise HTTPException(status_code=404, detail="Stem job not found")
    chosen = [s for s in STEM_ORDER if s in body.stems and s in sjob.stems]
    if not chosen:
        raise HTTPException(status_code=400, detail="Select at least one stem.")
    files = [sjob.stems[s] for s in chosen]
    safe = "+".join(chosen)
    base = (body.title or f"track {sjob.track_index}").strip().replace("/", "_")
    filename = f"{base} [{safe}].mp3"
    from stems import mix_stems
    try:
        mix_stems(sjob.dir, files, sjob.dir / filename, title=body.title, artist=body.artist)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"filename": filename, "stems": chosen}


@app.post("/api/stems/{stem_id}/transcribe")
def transcribe_vocals(stem_id: str) -> dict:
    sjob = stem_manager.get(stem_id)
    if not sjob:
        raise HTTPException(status_code=404, detail="Stem job not found")
    if "vocals" not in sjob.stems:
        raise HTTPException(status_code=409, detail="Vocals stem not ready yet.")
    vocals = sjob.dir / sjob.stems["vocals"]
    cache = sjob.dir / "transcript.json"
    tjob = transcribe_manager.create(stem_id, vocals, cache)
    return tjob.snapshot()


@app.get("/api/stems/{stem_id}/transcript")
def get_transcript(stem_id: str) -> dict:
    tjob = transcribe_manager.get(stem_id)
    if not tjob:
        raise HTTPException(status_code=404, detail="No transcription started")
    return tjob.snapshot()


@app.api_route("/api/stems/{stem_id}/download/{filename}", methods=["GET", "HEAD"])
def download_stem_mix(stem_id: str, filename: str):
    sjob = stem_manager.get(stem_id)
    if not sjob:
        raise HTTPException(status_code=404, detail="Stem job not found")
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = sjob.dir / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="audio/mpeg", filename=filename)


@app.api_route("/api/jobs/{job_id}/download", methods=["GET", "HEAD"])
def download_zip(job_id: str):
    job = _get_job(job_id)
    if not job.export.get("zip"):
        raise HTTPException(status_code=404, detail="Nothing to download yet")
    path = job.dir / "tracks" / job.export["zip"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="Zip not found")
    title = (job.source.get("title") or "tracks").replace("/", "_")
    return FileResponse(path, media_type="application/zip", filename=f"{title}.zip")


@app.api_route("/api/jobs/{job_id}/download/{filename}", methods=["GET", "HEAD"])
def download_track(job_id: str, filename: str):
    job = _get_job(job_id)
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = job.dir / "tracks" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="audio/mpeg", filename=filename)


def _punch_stem_job(job, start: float, end: float, quality: str):
    src = job.dir / "source.wav"
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source audio not available")
    if end - start < 0.1:
        raise HTTPException(status_code=400, detail="OUT must be at least 0.1s after IN.")
    return stem_manager.create(
        src_wav=src, parent_dir=job.dir, track_index=0, start=start, end=end,
        title="Stem punch", quality=quality or "balanced",
        dir_name=stitch_dir_name(start, end, quality or "balanced"),
    )


def _muted_files(sjob, muted: list[str]) -> list[str]:
    return [sjob.stems[s] for s in muted if s in sjob.stems]


@app.get("/api/jobs/{job_id}/stitch")
def stitch_state(job_id: str) -> dict:
    return edit_state(_get_job(job_id))


@app.post("/api/jobs/{job_id}/stitch/separate")
def stitch_separate(job_id: str, body: StitchRequest) -> dict:
    job = _get_job(job_id)
    return _punch_stem_job(job, body.start, body.end, body.quality).snapshot()


def _ready_punch(job, body: StitchRequest):
    sjob = _punch_stem_job(job, body.start, body.end, body.quality)
    if sjob.status != "ready":
        raise HTTPException(status_code=409, detail="Stems for this exact range are not ready — separate first.")
    return sjob


@app.post("/api/jobs/{job_id}/stitch/preview")
def stitch_preview(job_id: str, body: StitchRequest) -> dict:
    job = _get_job(job_id)
    sjob = _ready_punch(job, body)
    try:
        info = write_preview(job, sjob.dir, _muted_files(sjob, body.muted),
                             body.start, body.end, body.crossfade_ms)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    import time
    info["url"] = f"/api/jobs/{job_id}/stitched-preview?t={int(time.time() * 1000)}"
    return info


@app.post("/api/jobs/{job_id}/stitch/apply")
def stitch_apply(job_id: str, body: StitchRequest) -> dict:
    job = _get_job(job_id)
    if not body.muted:
        raise HTTPException(status_code=400, detail="Mute at least one stem first.")
    sjob = _ready_punch(job, body)
    try:
        return apply_edit(job, sjob.dir, _muted_files(sjob, body.muted), body.muted,
                          body.start, body.end, body.crossfade_ms)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.api_route("/api/jobs/{job_id}/stitched-preview", methods=["GET", "HEAD"])
def get_stitched_preview(job_id: str):
    prev = _get_job(job_id).dir / "stitched_preview.wav"
    if not prev.exists():
        raise HTTPException(status_code=404, detail="Preview not found.")
    return FileResponse(prev, media_type="audio/wav")


@app.post("/api/jobs/{job_id}/stitch/revert")
def stitch_revert(job_id: str) -> dict:
    try:
        return revert_all(_get_job(job_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.api_route("/api/jobs/{job_id}/download-stitched", methods=["GET", "HEAD"])
def download_stitched(job_id: str):
    job = _get_job(job_id)
    src = job.dir / "source.wav"
    if not src.exists():
        raise HTTPException(status_code=404, detail="Audio file not found.")
    dst = job.dir / "stitched_export.mp3"
    title = (job.source.get("title") or "song") + " (Edit)"
    try:
        export_to_mp3(src, dst, title=title, artist=job.source.get("uploader") or "")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"MP3 export failed: {exc}")
    return FileResponse(dst, media_type="audio/mpeg", filename=f"{title.replace('/', '_')}.mp3")


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")
