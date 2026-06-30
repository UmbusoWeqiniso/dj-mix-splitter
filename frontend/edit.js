// Mix split editor — adjust track boundaries, re-detect, save back to library.
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (s) => {
    s = Math.max(0, Math.round(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const fmtEdit = (s) => {
    s = Math.max(0, Math.round(s * 100) / 100);
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    const whole = Math.floor(sec);
    const tenth = Math.round((sec - whole) * 10);
    if (tenth) return `${m}:${String(whole).padStart(2, "0")}.${tenth}`;
    return `${m}:${String(whole).padStart(2, "0")}`;
  };
  const scopeMinPad = () => ((ED.duration || 0) >= 600 ? 2 : 1);
  const fmtScopeTime = (s) => {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(scopeMinPad(), "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const seg7 = (value, extraClass = "") => {
    const v = String(value);
    const mask = v.replace(/[0-9]/g, "8");
    return `<span class="seg7 ${extraClass}" data-mask="${escapeHtml(mask)}"><span class="seg7-v">${escapeHtml(v)}</span></span>`;
  };

  const ED = {
    jobId: null, data: null, duration: 0, poll: null,
    audioReady: false, awaitingResult: false,
    dragBoundary: -1,
    viewStart: 0,
    viewEnd: 0,
    bpm: 0,
    barLen: 0,
  };
  const MIN_TRACK = 0.05;
  const MIN_VIEW_SPAN = 1.5;
  const ZOOM_STEP = 1.45;
  const audio = $("#edit-audio");

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let d = res.statusText;
      try { d = (await res.json()).detail || d; } catch (_) {}
      throw new Error(d);
    }
    return res.json();
  }

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "toast" + (bad ? " bad" : "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function parseTime(s) {
    s = String(s).trim();
    if (!s) return null;
    const parts = s.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function reindexTracks() {
    ED.data.tracks.forEach((t, i) => { t.index = i + 1; });
  }

  window.openEditStudio = async function (jobId) {
    closeEditStudio(false);
    ED.jobId = jobId;
    $("#edit-studio").classList.remove("hidden");
    $("#edit-progress").classList.add("hidden");
    $("#edit-redetect-status").textContent = "Loading mix…";
    $("#edit-status").textContent = "LOADING";
    $("#edit-status").className = "lcd-status paused";
    try {
      const job = await api("/api/jobs/adopt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId }),
      });
      if (job.status !== "ready" && job.status !== "done") {
        ED.awaitingResult = true;
        startPolling();
        return;
      }
      applyResult(job);
    } catch (e) {
      toast(e.message, true);
      closeEditStudio(false);
    }
  };

  function applyResult(job) {
    ED.data = JSON.parse(JSON.stringify(job.result));
    ED.duration = job.result.duration;
    ED.viewStart = 0;
    ED.viewEnd = ED.duration;
    ED.awaitingResult = false;
    $("#edit-progress").classList.add("hidden");
    $("#edit-redetect").disabled = false;
    $("#edit-redetect-status").textContent = "";

    const src = job.source || {};
    $("#edit-mix-title").textContent = src.title || "Mix";
    $("#edit-mix-meta").textContent =
      `${src.uploader ? src.uploader + " · " : ""}${fmt(ED.duration)} · ${ED.data.tracks.length} tracks`;
    $("#edit-tracks-count").textContent = `${ED.data.tracks.length} tracks`;
    $("#edit-status").textContent = "READY";
    $("#edit-status").className = "lcd-status paused";

    const sens = ED.data.sensitivity ?? (window.getDefaultSensitivity ? window.getDefaultSensitivity() : 5);
    $("#edit-sensitivity").value = sens;
    $("#edit-sens-val").textContent = sens;

    const wantSrc = `/api/jobs/${ED.jobId}/audio`;
    if (!audio.src || !audio.src.includes(wantSrc)) {
      audio.src = wantSrc;
      ED.audioReady = false;
      audio.addEventListener("loadedmetadata", () => { ED.audioReady = true; }, { once: true });
    }

    ED.bpm = 0;
    ED.barLen = 0;
    updateSkipHints();
    ensureBpm();

    drawWave();
    renderBoundaries();
    renderRows();
    updateZoomLabel();
  }

  function viewRange() {
    const end = ED.viewEnd || ED.duration || 0;
    const start = Math.max(0, Math.min(ED.viewStart || 0, end));
    const span = Math.max(MIN_VIEW_SPAN, end - start);
    return { start, end: start + span, span };
  }

  function resetView() {
    if (!ED.duration) return;
    ED.viewStart = 0;
    ED.viewEnd = ED.duration;
    refreshView();
  }

  function zoomAt(factor, anchorTime) {
    if (!ED.duration) return;
    const { start, end, span } = viewRange();
    const newSpan = Math.min(ED.duration, span / factor);
    if (newSpan >= ED.duration - 0.01) {
      resetView();
      return;
    }
    const clampedSpan = Math.max(MIN_VIEW_SPAN, newSpan);
    const anchor = Math.max(0, Math.min(ED.duration, anchorTime));
    const anchorFrac = span ? (anchor - start) / span : 0.5;
    let newStart = anchor - anchorFrac * clampedSpan;
    if (newStart < 0) newStart = 0;
    if (newStart + clampedSpan > ED.duration) newStart = ED.duration - clampedSpan;
    ED.viewStart = newStart;
    ED.viewEnd = newStart + clampedSpan;
    refreshView();
  }

  function panBy(deltaTime) {
    if (!ED.duration) return;
    const { start, span } = viewRange();
    if (span >= ED.duration - 0.01) return;
    let newStart = start + deltaTime;
    if (newStart < 0) newStart = 0;
    if (newStart + span > ED.duration) newStart = ED.duration - span;
    ED.viewStart = newStart;
    ED.viewEnd = newStart + span;
    refreshView();
  }

  function refreshView() {
    drawWave();
    updateBoundaryVisuals();
    updatePlayhead();
    updateZoomLabel();
  }

  function updateZoomLabel() {
    const el = $("#edit-view-range");
    if (!el || !ED.duration) return;
    const { start, end, span } = viewRange();
    if (span >= ED.duration - 0.01) {
      el.classList.add("hidden");
      $("#edit-wave-wrap")?.classList.remove("zoomed");
      return;
    }
    el.classList.remove("hidden");
    el.textContent = `${fmtEdit(start)} – ${fmtEdit(end)}`;
    $("#edit-wave-wrap")?.classList.add("zoomed");
  }

  function waveInnerWidth() {
    return $("#edit-wave-wrap").clientWidth - 16;
  }

  function timeToViewPct(time) {
    const { start, span } = viewRange();
    if (!span) return 0;
    return ((time - start) / span) * 100;
  }

  function clientXToTime(clientX) {
    const wrap = $("#edit-wave-wrap");
    const rect = wrap.getBoundingClientRect();
    const w = waveInnerWidth();
    let x = clientX - rect.left - 8;
    x = Math.max(0, Math.min(w, x));
    const { start, span } = viewRange();
    return start + (x / w) * span;
  }

  function wfAt(wf, n, duration, t) {
    t = Math.max(0, Math.min(duration, t));
    if (n <= 1) return wf[0] || 0;
    const fi = (t / duration) * (n - 1);
    const i = Math.floor(fi);
    const f = fi - i;
    const a = wf[i] ?? 0;
    const b = wf[Math.min(n - 1, i + 1)] ?? 0;
    return a + (b - a) * f;
  }

  function peakInRange(wf, n, duration, t0, t1) {
    const span = t1 - t0;
    if (span <= 0) return wfAt(wf, n, duration, t0);
    const binDur = duration / Math.max(1, n);
    const steps = Math.max(2, Math.min(80, Math.ceil(span / (binDur * 0.2))));
    let peak = 0;
    for (let s = 0; s < steps; s++) {
      const t = t0 + ((s + 0.5) / steps) * span;
      peak = Math.max(peak, wfAt(wf, n, duration, t));
    }
    return peak;
  }

  function drawWave() {
    if (!ED.data) return;
    const canvas = $("#edit-wave");
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth - 16;
    const cssH = 160;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const wf = ED.data.waveform || [];
    const mid = cssH / 2;
    ctx.fillStyle = "rgba(255, 159, 62, 0.42)";
    const n = wf.length;
    if (!n || !ED.duration) return;

    const { start, span } = viewRange();
    const cols = Math.max(1, Math.floor(cssW));
    for (let px = 0; px < cols; px++) {
      const t0 = start + (px / cols) * span;
      const t1 = start + ((px + 1) / cols) * span;
      const peak = peakInRange(wf, n, ED.duration, t0, t1);
      const h = peak * (cssH * 0.42);
      ctx.fillRect(px, mid - h, 1, h * 2);
    }
  }

  function updateBoundaryVisuals() {
    if (!ED.data) return;
    ED.data.tracks.forEach((t, i) => {
      const pct = timeToViewPct(t.start) + "%";
      const region = document.querySelector(`#edit-regions .edit-region[data-i="${i}"]`);
      if (region) {
        region.style.left = pct;
        region.style.width = (timeToViewPct(t.end) - timeToViewPct(t.start)) + "%";
        region.classList.toggle("active", ED.dragBoundary === i || ED.dragBoundary === i - 1);
      }
      const line = document.querySelector(`#edit-boundaries .edit-boundary[data-i="${i}"]`);
      if (line) {
        line.style.left = pct;
        line.classList.toggle("dragging", ED.dragBoundary === i);
      }
      const grip = document.querySelector(`#edit-grips .edit-split-grip[data-i="${i}"]`);
      if (grip) {
        grip.style.left = pct;
        grip.classList.toggle("dragging", ED.dragBoundary === i);
        grip.title = `Track ${String(i + 1).padStart(2, "0")} · ${fmtEdit(t.start)}`;
      }
    });
  }

  function renderBoundaries() {
    if (!ED.data) return;
    const regions = $("#edit-regions");
    const boundaries = $("#edit-boundaries");
    const grips = $("#edit-grips");
    regions.innerHTML = "";
    boundaries.innerHTML = "";
    grips.innerHTML = "";

    ED.data.tracks.forEach((t, i) => {
      const region = document.createElement("div");
      region.className = "edit-region" + (i % 2 ? " alt" : "");
      if (ED.dragBoundary === i || ED.dragBoundary === i - 1) region.classList.add("active");
      region.dataset.i = i;
      region.style.left = timeToViewPct(t.start) + "%";
      region.style.width = (timeToViewPct(t.end) - timeToViewPct(t.start)) + "%";
      const tag = document.createElement("span");
      tag.className = "edit-region-tag";
      tag.textContent = String(i + 1).padStart(2, "0");
      region.appendChild(tag);
      regions.appendChild(region);

      if (i === 0 && t.start < MIN_TRACK) return;

      const line = document.createElement("div");
      line.className = "edit-boundary" + (ED.dragBoundary === i ? " dragging" : "");
      line.dataset.i = i;
      line.style.left = timeToViewPct(t.start) + "%";
      boundaries.appendChild(line);

      const grip = document.createElement("button");
      grip.type = "button";
      grip.className = "edit-split-grip" + (ED.dragBoundary === i ? " dragging" : "");
      grip.dataset.i = i;
      grip.style.left = timeToViewPct(t.start) + "%";
      grip.title = `Track ${String(i + 1).padStart(2, "0")} · ${fmtEdit(t.start)}`;
      grip.setAttribute("aria-label", `Drag track ${String(i + 1).padStart(2, "0")} start`);
      setupBoundaryDrag(grip, i, line);
      grips.appendChild(grip);
    });
  }

  function setupBoundaryDrag(grip, i, line) {
    if (!grip) return;
    let dragging = false;
    const move = (clientX) => {
      setBoundary(i, clientXToTime(clientX), { live: true });
    };
    const setDragging = (on) => {
      line.classList.toggle("dragging", on);
      grip.classList.toggle("dragging", on);
    };
    const onMove = (e) => { if (dragging) move(e.clientX); };
    const onEnd = (e) => {
      if (!dragging) return;
      dragging = false;
      ED.dragBoundary = -1;
      setDragging(false);
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onEnd);
      grip.removeEventListener("pointercancel", onEnd);
      try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
      document.querySelectorAll(`${ROW_SEL}.boundary-hot`).forEach((el) => {
        el.classList.remove("boundary-hot");
      });
      move(e.clientX);
      seekTo(ED.data.tracks[i].start);
      renderRows();
      refreshView();
    };
    grip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true;
      ED.dragBoundary = i;
      setDragging(true);
      document.querySelectorAll(ROW_SEL).forEach((el) => {
        const idx = Number(el.dataset.i);
        el.classList.toggle("boundary-hot", idx === i || idx === i - 1);
      });
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onEnd);
      grip.addEventListener("pointercancel", onEnd);
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      move(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  const ROW_SEL = "#edit-track-rows .edit-track-row";

  function updateRowCells(i) {
    const row = document.querySelector(`${ROW_SEL}[data-i="${i}"]`);
    if (!row || !ED.data.tracks[i]) return;
    const t = ED.data.tracks[i];
    const startInput = row.querySelector(".start");
    if (startInput) startInput.value = fmtEdit(t.start);
    const lenCell = row.querySelector(".c-len");
    if (lenCell) lenCell.innerHTML = seg7(fmtEdit(t.end - t.start), "pl-len");
  }

  function renderRows() {
    const list = $("#edit-track-rows");
    list.innerHTML = "";
    ED.data.tracks.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "edit-track-row";
      row.dataset.i = i;
      row.innerHTML = `
        <span class="c-no">${seg7(String(i + 1).padStart(2, "0"), "pl-no")}</span>
        <span class="c-time"><input class="start mono lcd-field" value="${fmtEdit(t.start)}" title="Track start time" /></span>
        <span class="c-len">${seg7(fmtEdit(t.end - t.start), "pl-len")}</span>
        <span class="c-title"><input class="title lcd-field" value="${escapeHtml(t.title || "")}" /></span>
        <span class="c-artist"><input class="artist lcd-field" value="${escapeHtml(t.artist || "")}" /></span>
        <span class="c-pads">
          ${i > 0 ? `<button type="button" class="deck-pad pad-merge" title="Merge with previous"><span class="deck-pad-glyph">⬆</span></button>` : ""}
          ${ED.data.tracks.length > 1 ? `<button type="button" class="deck-pad pad-delete" title="Delete track"><span class="deck-pad-glyph">✕</span></button>` : ""}
        </span>`;
      row.querySelector(".title").addEventListener("input", (e) => { t.title = e.target.value; });
      row.querySelector(".artist").addEventListener("input", (e) => { t.artist = e.target.value; });
      const startInput = row.querySelector(".start");
      if (startInput) {
        startInput.addEventListener("change", (e) => {
          const secs = parseTime(e.target.value);
          if (secs === null) { toast("Use a time like 3:20", true); renderRows(); return; }
          setBoundary(i, secs);
        });
      }
      row.querySelector(".pad-merge")?.addEventListener("click", () => mergeUp(i));
      row.querySelector(".pad-delete")?.addEventListener("click", () => deleteTrack(i));
      setupRowScrub(row, i);
      list.appendChild(row);
    });
    updateRowPlayback();
  }

  function setBoundary(i, start, { live = false } = {}) {
    const tracks = ED.data.tracks;
    const t = tracks[i];
    const minStart = i > 0 ? tracks[i - 1].start + MIN_TRACK : 0;
    const maxStart = t.end - MIN_TRACK;
    start = Math.round(Math.max(minStart, Math.min(maxStart, start)) * 100) / 100;
    t.start = start;
    if (i > 0) tracks[i - 1].end = start;
    if (live) {
      updateRowCells(i);
      if (i > 0) updateRowCells(i - 1);
      updateBoundaryVisuals();
      return;
    }
    renderRows();
    refreshView();
  }

  function zoomToTrack(i) {
    if (!ED.data?.tracks[i] || !ED.duration) return;
    const t = ED.data.tracks[i];
    const pad = Math.max(4, (t.end - t.start) * 0.35);
    let start = Math.max(0, t.start - pad);
    let end = Math.min(ED.duration, t.end + pad);
    let span = end - start;
    if (span < MIN_VIEW_SPAN) {
      const mid = (t.start + t.end) / 2;
      start = Math.max(0, mid - MIN_VIEW_SPAN / 2);
      end = Math.min(ED.duration, start + MIN_VIEW_SPAN);
      start = Math.max(0, end - MIN_VIEW_SPAN);
      span = end - start;
    }
    ED.viewStart = start;
    ED.viewEnd = end;
    refreshView();
  }

  function splitAt(time) {
    const tracks = ED.data.tracks;
    let idx = -1;
    for (let i = 0; i < tracks.length; i++) {
      if (time >= tracks[i].start && time < tracks[i].end - 0.5) { idx = i; break; }
    }
    if (idx < 0) { toast("Move the playhead inside a track to split.", true); return; }
    const t = tracks[idx];
    const left = { ...t, end: time };
    const right = {
      ...t, start: time, title: `${t.title || "Track"} (2)`,
      id_status: "unknown", id_message: "", score: null,
    };
    tracks.splice(idx, 1, left, right);
    reindexTracks();
    renderRows();
    refreshView();
  }

  function mergeUp(i) {
    if (i <= 0) return;
    const tracks = ED.data.tracks;
    tracks[i - 1].end = tracks[i].end;
    if (!tracks[i - 1].title && tracks[i].title) tracks[i - 1].title = tracks[i].title;
    tracks.splice(i, 1);
    reindexTracks();
    renderRows();
    refreshView();
  }

  function deleteTrack(i) {
    const tracks = ED.data.tracks;
    if (tracks.length <= 1) {
      toast("Can't delete the only track in the mix.", true);
      return;
    }
    const t = tracks[i];
    if (i > 0) tracks[i - 1].end = t.end;
    else if (i < tracks.length - 1) tracks[i + 1].start = t.start;
    tracks.splice(i, 1);
    reindexTracks();
    renderRows();
    refreshView();
  }

  function currentTrackIndex() {
    const ct = audio.currentTime;
    for (let i = 0; i < ED.data.tracks.length; i++) {
      if (ct >= ED.data.tracks[i].start && ct < ED.data.tracks[i].end) return i;
    }
    return -1;
  }

  function setupRowScrub(tr, i) {
    const onControl = (el) => el.closest("input, button, a, label");
    let scrubbing = false;
    const seekFrac = (clientX) => {
      const t = ED.data.tracks[i];
      const rect = tr.getBoundingClientRect();
      let f = (clientX - rect.left) / rect.width;
      f = Math.max(0, Math.min(1, f));
      seekTo(t.start + f * (t.end - t.start));
    };
    tr.addEventListener("pointerdown", (e) => {
      if (onControl(e.target)) return;
      scrubbing = true;
      tr.classList.add("scrubbing");
      try { tr.setPointerCapture(e.pointerId); } catch (_) {}
      seekFrac(e.clientX);
      e.preventDefault();
    });
    tr.addEventListener("pointermove", (e) => { if (scrubbing) seekFrac(e.clientX); });
    const end = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      tr.classList.remove("scrubbing");
      try { tr.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    tr.addEventListener("pointerup", end);
    tr.addEventListener("pointercancel", end);
    tr.addEventListener("dblclick", (e) => {
      if (onControl(e.target)) return;
      zoomToTrack(i);
      seekTo(ED.data.tracks[i].start);
    });
  }

  function updateRowPlayback() {
    if (!ED.data) return;
    const active = currentTrackIndex();
    document.querySelectorAll(ROW_SEL).forEach((el) => {
      const i = Number(el.dataset.i);
      if (i === active) {
        const t = ED.data.tracks[i];
        const prog = Math.min(1, Math.max(0, (audio.currentTime - t.start) / Math.max(0.1, t.end - t.start)));
        el.classList.add("playing");
        el.style.setProperty("--prog", prog.toFixed(4));
      } else {
        el.classList.remove("playing");
        el.style.removeProperty("--prog");
      }
    });
  }

  function seekTo(t) {
    if (!ED.audioReady) {
      audio.addEventListener("canplay", () => { audio.currentTime = t; }, { once: true });
      audio.load();
    } else {
      audio.currentTime = t;
    }
    updatePlayhead();
  }

  async function ensureBpm() {
    if (ED.bpm || !ED.jobId || !ED.data?.tracks?.length) return;
    let start = 0;
    let end = ED.duration;
    const idx = currentTrackIndex();
    if (idx >= 0) {
      const t = ED.data.tracks[idx];
      start = t.start;
      end = t.end;
    } else {
      const t = ED.data.tracks[0];
      start = t.start;
      end = t.end;
    }
    try {
      const r = await api(`/api/jobs/${ED.jobId}/bpm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end }),
      });
      ED.bpm = r.bpm || 0;
      ED.barLen = ED.bpm ? (4 * 60) / ED.bpm : 0;
    } catch (_) { /* keep 10 sec skips if BPM unknown */ }
    updateSkipHints();
  }

  function skipStep() {
    return ED.barLen || 10;
  }

  function updateSkipHints() {
    const label = ED.barLen ? "1 bar" : "10 sec";
    const back = $("#edit-skip-back");
    const fwd = $("#edit-skip-fwd");
    if (back) {
      back.title = `Skip back ${label}`;
      back.setAttribute("aria-label", `Skip back ${label}`);
    }
    if (fwd) {
      fwd.title = `Skip forward ${label}`;
      fwd.setAttribute("aria-label", `Skip forward ${label}`);
    }
  }

  function skipBy(delta) {
    if (!ED.duration) return;
    seekTo(Math.max(0, Math.min(ED.duration, audio.currentTime + delta)));
  }

  function updatePlayhead() {
    if (!ED.duration) return;
    const ph = $("#edit-playhead");
    const { start, span } = viewRange();
    const w = waveInnerWidth();
    const frac = (audio.currentTime - start) / span;
    if (frac < 0 || frac > 1) {
      ph.classList.add("hidden");
    } else {
      ph.classList.remove("hidden");
      ph.style.left = (8 + frac * w) + "px";
    }
    $("#edit-time").textContent = `${fmtScopeTime(audio.currentTime)} / ${fmtScopeTime(ED.duration)}`;
  }

  function collectTracks() {
    const rows = [...document.querySelectorAll(ROW_SEL)];
    return rows.map((tr, i) => {
      const t = ED.data.tracks[i];
      return {
        index: t.index,
        start: t.start,
        end: t.end,
        title: tr.querySelector(".title").value.trim(),
        artist: tr.querySelector(".artist").value.trim(),
        id_status: t.id_status || "unknown",
        id_message: t.id_message || "",
        score: t.score ?? null,
      };
    });
  }

  async function saveTracks() {
    const tracks = collectTracks();
    $("#edit-save").disabled = true;
    try {
      const job = await api(`/api/jobs/${ED.jobId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks }),
      });
      applyResult(job);
      if (window.syncLibraryFromJob) window.syncLibraryFromJob(job);
      toast(`Saved ${tracks.length} tracks to library.`);
    } catch (e) {
      toast(e.message, true);
    } finally {
      $("#edit-save").disabled = false;
    }
  }

  function startPolling() {
    clearInterval(ED.poll);
    ED.poll = setInterval(pollOnce, 900);
    pollOnce();
  }

  async function pollOnce() {
    if (!ED.jobId) return;
    let job;
    try { job = await api(`/api/jobs/${ED.jobId}`); } catch (_) { return; }
    if (job.status === "error") {
      clearInterval(ED.poll);
      $("#edit-redetect").disabled = false;
      $("#edit-progress").classList.add("hidden");
      toast(job.error || "Re-split failed", true);
      return;
    }
    if (job.status === "running") {
      $("#edit-progress").classList.remove("hidden");
      $("#edit-bar").style.width = Math.round((job.progress || 0) * 100) + "%";
      $("#edit-progress-msg").textContent = job.message || "Re-splitting…";
      $("#edit-status").textContent = "SPLITTING";
      $("#edit-status").className = "lcd-status playing";
    }
    if (job.status === "ready" && ED.awaitingResult) {
      applyResult(job);
      ED.awaitingResult = false;
      clearInterval(ED.poll);
    }
  }

  async function redetect() {
    if (!ED.jobId || !ED.data) return;
    const sensitivity = Number($("#edit-sensitivity").value);
    $("#edit-redetect").disabled = true;
    $("#edit-redetect-status").textContent = "Re-splitting…";
    ED.awaitingResult = true;
    $("#edit-status").textContent = "SPLITTING";
    $("#edit-status").className = "lcd-status playing";
    try {
      await api(`/api/jobs/${ED.jobId}/redetect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sensitivity }),
      });
      startPolling();
    } catch (e) {
      toast(e.message, true);
      $("#edit-redetect").disabled = false;
      $("#edit-redetect-status").textContent = "";
      ED.awaitingResult = false;
    }
  }

  function setupWaveView() {
    const wrap = $("#edit-wave-wrap");
    if (!wrap || wrap.dataset.viewReady) return;
    wrap.dataset.viewReady = "1";
    const TAP_SLOP = 12;

    wrap.addEventListener("wheel", (e) => {
      if (!ED.data || $("#edit-studio").classList.contains("hidden")) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, clientXToTime(e.clientX));
    }, { passive: false });

    let panning = false;
    let panOriginX = 0;
    let panOriginStart = 0;

    const applyPan = (clientX) => {
      const w = waveInnerWidth();
      const span = ED.viewEnd - ED.viewStart;
      if (!w || !span) return;
      const dt = -((clientX - panOriginX) / w) * span;
      let newStart = panOriginStart + dt;
      if (newStart < 0) newStart = 0;
      if (newStart + span > ED.duration) newStart = ED.duration - span;
      ED.viewStart = newStart;
      ED.viewEnd = newStart + span;
      refreshView();
    };

    const stopPan = () => {
      panning = false;
      wrap.classList.remove("panning");
    };

    const startPanAt = (clientX) => {
      panning = true;
      panOriginX = clientX;
      panOriginStart = ED.viewStart;
      wrap.classList.add("panning");
    };

    wrap.addEventListener("pointerdown", (e) => {
      if (!ED.data || $("#edit-studio").classList.contains("hidden")) return;
      if (ED.dragBoundary >= 0) return;
      if (!e.target.closest("#edit-wave")) return;

      const { span } = viewRange();
      const zoomed = span < ED.duration - 0.01;
      const touchLike = e.pointerType === "touch" || e.pointerType === "pen";
      const downX = e.clientX;
      const downY = e.clientY;
      let moved = false;

      if (e.shiftKey && zoomed) {
        startPanAt(downX);
        const onMove = (ev) => { if (panning) applyPan(ev.clientX); };
        const onEnd = () => {
          stopPan();
          wrap.removeEventListener("pointermove", onMove);
          wrap.removeEventListener("pointerup", onEnd);
          wrap.removeEventListener("pointercancel", onEnd);
        };
        wrap.addEventListener("pointermove", onMove);
        wrap.addEventListener("pointerup", onEnd);
        wrap.addEventListener("pointercancel", onEnd);
        e.preventDefault();
        return;
      }

      const onMove = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - downX;
        const dy = ev.clientY - downY;
        if (moved) {
          if (panning) applyPan(ev.clientX);
          return;
        }
        if (Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) return;
        moved = true;
        if (touchLike && zoomed) startPanAt(downX);
        if (panning) applyPan(ev.clientX);
      };

      const onEnd = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        wrap.removeEventListener("pointermove", onMove);
        wrap.removeEventListener("pointerup", onEnd);
        wrap.removeEventListener("pointercancel", onEnd);
        if (panning) {
          stopPan();
        } else if (!moved) {
          seekTo(clientXToTime(downX));
        }
      };

      wrap.addEventListener("pointermove", onMove);
      wrap.addEventListener("pointerup", onEnd);
      wrap.addEventListener("pointercancel", onEnd);
      if (touchLike) e.preventDefault();
    });
  }

  function closeEditStudio(reset = true) {
    clearInterval(ED.poll);
    if (reset) {
      audio.pause();
      audio.removeAttribute("src");
      ED.jobId = null;
      ED.data = null;
      ED.viewStart = 0;
      ED.viewEnd = 0;
      ED.bpm = 0;
      ED.barLen = 0;
    }
    $("#edit-studio").classList.add("hidden");
  }

  $("#edit-close").addEventListener("click", () => closeEditStudio());
  $("#edit-studio").addEventListener("click", (e) => {
    if (e.target.id === "edit-studio") closeEditStudio();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#edit-studio").classList.contains("hidden")) closeEditStudio();
  });
  $("#edit-play").addEventListener("click", () => { audio.paused ? audio.play() : audio.pause(); });
  $("#edit-skip-back").addEventListener("click", () => skipBy(-skipStep()));
  $("#edit-skip-fwd").addEventListener("click", () => skipBy(skipStep()));
  $("#edit-split").addEventListener("click", () => splitAt(audio.currentTime || 0));
  $("#edit-save").addEventListener("click", saveTracks);
  $("#edit-redetect").addEventListener("click", redetect);
  $("#edit-zoom-in").addEventListener("click", () => {
    zoomAt(ZOOM_STEP, audio.currentTime || viewRange().start);
  });
  $("#edit-zoom-out").addEventListener("click", () => {
    zoomAt(1 / ZOOM_STEP, audio.currentTime || viewRange().start);
  });
  $("#edit-zoom-fit").addEventListener("click", resetView);
  $("#edit-sensitivity").addEventListener("input", (e) => {
    $("#edit-sens-val").textContent = e.target.value;
  });
  audio.addEventListener("play", () => {
    $("#edit-play").textContent = "⏸";
    $("#edit-status").textContent = "PLAYING";
    $("#edit-status").className = "lcd-status playing";
    updateRowPlayback();
  });
  audio.addEventListener("pause", () => {
    $("#edit-play").textContent = "▶";
    if (!ED.awaitingResult) {
      $("#edit-status").textContent = "READY";
      $("#edit-status").className = "lcd-status paused";
    }
    updateRowPlayback();
  });
  audio.addEventListener("timeupdate", () => { updatePlayhead(); updateRowPlayback(); });
  window.addEventListener("resize", () => {
    if (ED.data) refreshView();
  });
  setupWaveView();
})();
