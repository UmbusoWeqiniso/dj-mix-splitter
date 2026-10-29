"""Intelligent metadata fallback for track identification.

When ACRCloud fails (e.g. rate limit / quota exceeded code 3003, or no fingerprint match),
this module extracts track titles and artists from:
1. YouTube chapters (from yt-dlp info["chapters"])
2. YouTube description timestamp tracklists (e.g. "00:00 Artist - Title")
3. Source mix title / file name (for single songs or single-track uploads)
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple


CLEAN_PATTERNS = [
    r"(?:[\(\[\{]|\s*[\|\/\-]\s*)(?:official\s*(?:music\s*)?video|official\s*audio|visualizer|lyric\s*video|lyrics|hd|hq|4k|remastered|audio)[^\)\]\}]*(?:[\)\]\}]|$)",
    r"[\(\[\{]\s*(?:feat\.|ft\.)[^\)\]\}]+[\)\]\}]",  # we keep main title clean
    r"^\s*\d+[\.\)]\s*",  # leading numbers like "01. " or "1) "
]


def clean_title_string(text: str) -> str:
    """Strip common promotional or video fluff from a song title."""
    s = text
    for pat in CLEAN_PATTERNS:
        s = re.sub(pat, "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s.strip("\"' -–—:")


def split_artist_title(raw: str) -> Tuple[str, str]:
    """Split a string like 'Artist - Title' into (artist, title).

    If no delimiter is found, returns ('', cleaned_raw).
    """
    cleaned = clean_title_string(raw)
    # Common delimiters: " - ", " — ", " – ", " : "
    parts = re.split(r"\s+[-–—]\s+", cleaned, maxsplit=1)
    if len(parts) == 2 and parts[0] and parts[1]:
        return parts[0].strip("\"' "), parts[1].strip("\"' ")
    return "", cleaned


def parse_timestamp_seconds(ts: str) -> float:
    """Parse 'MM:SS' or 'HH:MM:SS' to seconds."""
    try:
        parts = [float(p) for p in ts.strip().split(":")]
        if len(parts) == 2:
            return parts[0] * 60 + parts[1]
        if len(parts) == 3:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
    except Exception:
        pass
    return 0.0


def parse_tracklist_from_description(text: str) -> List[Dict]:
    """Extract a list of {'start': float, 'title': str, 'artist': str} from description text."""
    if not text:
        return []

    entries: List[Dict] = []

    # Pattern 1: timestamp at start: "03:45 Artist - Title" or "[03:45] Artist - Title"
    p1 = re.finditer(
        r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?(?:\[|\()?\b(\d{1,2}:\d{2}(?::\d{2})?)\b(?:\]|\))?\s*[-–—:]*\s*(.+)",
        text,
    )
    for m in p1:
        ts = parse_timestamp_seconds(m.group(1))
        name = m.group(2).strip()
        # Clean trailing brackets like (03:45)
        name = re.sub(r"\s*[\(\[]\d{1,2}:\d{2}(?::\d{2})?[\)\]]\s*$", "", name).strip()
        if name and not name.lower().startswith("tracklist") and not name.lower().startswith("chapter"):
            artist, title = split_artist_title(name)
            entries.append({"start": ts, "title": title or name, "artist": artist, "raw": name})

    if not entries:
        # Pattern 2: timestamp at end: "Artist - Title 03:45"
        p2 = re.finditer(
            r"(?:^|\n)\s*(?:\d+[\.\)]\s*)?(.+?)\s*[-–—:]*\s*(?:\[|\()?\b(\d{1,2}:\d{2}(?::\d{2})?)\b(?:\]|\))?\s*$",
            text,
        )
        for m in p2:
            name = m.group(1).strip()
            ts = parse_timestamp_seconds(m.group(2))
            if name and not name.lower().startswith("tracklist"):
                artist, title = split_artist_title(name)
                entries.append({"start": ts, "title": title or name, "artist": artist, "raw": name})

    entries.sort(key=lambda x: x["start"])
    return entries


def match_segment_to_metadata(
    seg: Dict,
    total_duration: float,
    source: Dict,
    segment_count: int,
) -> Tuple[str, str, str]:
    """Attempt to resolve (title, artist, method) from source chapters, tracklist, or title.

    Returns ('', '', '') if no confident match is found.
    """
    start = float(seg.get("start", 0.0))
    end = float(seg.get("end", 0.0))
    seg_len = max(0.0, end - start)

    # 1. Check YouTube Chapters
    chapters = source.get("chapters") or []
    if chapters:
        # Find chapter that overlaps or starts closest to segment start
        best_ch = None
        best_diff = 99999.0
        for ch in chapters:
            ch_start = float(ch.get("start_time", 0.0))
            ch_end = float(ch.get("end_time", 0.0))
            # If segment start is inside chapter boundaries
            if ch_start <= start + 15.0 and (ch_end >= start - 15.0 or ch_end == 0.0):
                best_ch = ch
                break
            diff = abs(ch_start - start)
            if diff < best_diff and diff <= 45.0:
                best_diff = diff
                best_ch = ch

        if best_ch and best_ch.get("title"):
            artist, title = split_artist_title(best_ch["title"])
            return title or best_ch["title"], artist, "chapter"

    # 2. Check YouTube Description Tracklist
    desc = source.get("description") or ""
    if desc:
        tracklist = parse_tracklist_from_description(desc)
        if tracklist:
            # Find the tracklist item that starts closest to seg['start']
            best_entry = None
            best_diff = 99999.0
            for item in tracklist:
                diff = abs(item["start"] - start)
                # Either very close in time, or the last item before seg start
                if diff < best_diff and (diff <= 45.0 or (item["start"] <= start + 10.0 and (start - item["start"]) <= 60.0)):
                    best_diff = diff
                    best_entry = item

            if best_entry:
                return best_entry["title"], best_entry["artist"], "tracklist"

    # 3. Check Single Track Import (or if 1 segment covers >= 75% of mix)
    if segment_count == 1 or (total_duration > 0 and (seg_len / total_duration) >= 0.75):
        # We can look at source track/artist metadata from yt-dlp first
        src_artist = source.get("artist") or ""
        src_track = source.get("track") or ""
        if src_track:
            return src_track, src_artist, "source_meta"

        src_title = source.get("clean_title") or source.get("title") or ""
        if src_title and src_title.lower() not in ("unknown mix", "mix", "untitled"):
            artist, title = split_artist_title(src_title)
            if not artist and source.get("uploader"):
                # Sometimes uploader is the artist
                uploader = source["uploader"].strip()
                if not re.search(r"records|topic|vevo|official|music|channel", uploader, re.IGNORECASE):
                    artist = uploader
            return title or src_title, artist, "source_title"

    return "", "", ""
