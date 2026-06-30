# DJ Mix Splitter

Turn a long YouTube DJ mix into individual, tagged MP3 tracks.

Paste a mix URL → the app downloads the audio, **automatically detects where each
track starts** (using self-similarity novelty analysis), optionally **identifies
the songs** via ACRCloud, then lets you review/rename and **export clean 320 kbps
MP3s**.

![flow](docs/flow.png)

## How it works

1. **Download** — `yt-dlp` grabs the best audio and `ffmpeg` makes a WAV.
2. **Analyze** — `librosa` extracts MFCC + chroma + spectral-contrast features,
   builds a cosine self-similarity matrix, and runs a Foote checkerboard-kernel
   *novelty* detector. Novelty peaks = points where the music changes = track
   boundaries. Boundaries closer than the minimum track length are merged.
3. **Identify** *(optional)* — a short clip from each segment is sent to ACRCloud
   for recognition. No keys → tracks stay numbered (nothing is invented).
4. **Export** — each track is cut with `ffmpeg` to a 320 kbps MP3 with ID3 tags,
   plus a `.zip` of everything.
5. **Stem Studio** *(per track)* — click the 🎛 button on any track to open it in
   its own player. The track is separated into **vocals / drums / bass / other**
   with [Demucs](https://github.com/facebookresearch/demucs) (`htdemucs`, runs on
   Apple-Silicon GPU when available). Play all stems in sync, **solo/mute** each,
   adjust volumes, and **download any blend** as a 320 kbps MP3 — untick *Vocals*
   for an instrumental, keep only *Vocals* for an acapella, etc. The first run
   downloads the ~80 MB model; separation then takes roughly 1–3 min per track and
   results are cached on disk.
6. **Vocals / Lyrics** *(in the Stem Studio)* — click **Transcribe vocals** to run
   [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the isolated vocal
   stem and get **scrollable, timestamped lyrics**. Click any line to jump there; the
   current line highlights and auto-scrolls as the track plays. Model size is set with
   `WHISPER_MODEL` (default `base`; use `small`/`medium` for higher accuracy). Results
   are cached to disk.

## Requirements

- macOS/Linux, Python 3.10+
- `ffmpeg` (`brew install ffmpeg`)
- (Optional) free ACRCloud account for song names

## Setup

```bash
cd dj-mix-splitter
cp .env.example .env        # add ACRCloud keys (optional)
./run.sh                    # first run installs deps, then serves the app
```

Open http://127.0.0.1:8000

## ACRCloud (song identification)

1. Sign up at https://console.acrcloud.com
2. Create an **Audio & Video Recognition** project.
3. Copy the **Host**, **Access Key**, **Access Secret** into `.env`.

## Notes / limits

- Auto-detection is great for mixes with distinct tracks; heavily blended/beatmatched
  transitions are harder — review and nudge selections before exporting.
- Tunables live in `backend/config.py` (`MIN_TRACK_SECONDS`, kernel size, etc.).
- This is a local tool for personal use. Respect copyright and each platform's terms.

## Project layout

```
backend/
  app.py        FastAPI API + serves the frontend
  download.py   yt-dlp wrapper
  analysis.py   Foote-novelty track segmentation
  identify.py   ACRCloud recognition
  export.py     ffmpeg MP3 export + zip
  jobs.py       background job pipeline
frontend/
  index.html / styles.css / app.js   web UI (waveform + track table)
```
