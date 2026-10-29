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
    selectedIndex: 0,
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
    if (parts.length === 3) {
      const hms = parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (ED.duration && hms > ED.duration + 10 && (parts[0] * 60 + parts[1] <= ED.duration + 10)) {
        return parts[0] * 60 + parts[1] + (parts[2] < 100 ? parts[2] / 100 : parts[2] / 1000);
      }
      return hms;
    }
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
    if ($("#edit-reidentify")) $("#edit-reidentify").disabled = false;
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
    ED.selectedIndex = 0;
    updateSkipHints();
    ensureBpm();

    drawWave();
    renderBoundaries();
    renderRows();
    updateZoomLabel();
    initPunch();
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
    updatePunchVisual();
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
    if (!row || !ED.data?.tracks?.[i]) return;
    const t = ED.data.tracks[i];
    const timeCell = row.querySelector(".c-time");
    if (timeCell) timeCell.textContent = fmtEdit(t.start);
    const lenCell = row.querySelector(".c-len");
    if (lenCell) lenCell.innerHTML = seg7(fmtEdit(t.end - t.start), "pl-len");
    if (ED.selectedIndex === i) {
      const startInput = $("#inspect-start");
      if (startInput && document.activeElement !== startInput) startInput.value = fmtEdit(t.start);
      const lenInspect = $("#inspect-len");
      if (lenInspect) lenInspect.innerHTML = seg7(fmtEdit(t.end - t.start), "pl-len");
    }
  }

  function updateRowInfo(i) {
    const row = document.querySelector(`${ROW_SEL}[data-i="${i}"]`);
    if (!row || !ED.data?.tracks?.[i]) return;
    const t = ED.data.tracks[i];
    const titleEl = row.querySelector(".pl-title");
    if (titleEl) titleEl.textContent = t.title || `Track ${String(i + 1).padStart(2, "0")}`;
    const artistEl = row.querySelector(".pl-meta");
    if (artistEl) artistEl.textContent = t.artist || "";
  }

  function selectTrack(i, { seek = false } = {}) {
    if (!ED.data?.tracks || !ED.data.tracks[i]) return;
    ED.selectedIndex = i;
    const t = ED.data.tracks[i];

    document.querySelectorAll(ROW_SEL).forEach((el) => {
      if (Number(el.dataset.i) === i) el.classList.add("selected");
      else el.classList.remove("selected");
    });

    const noEl = $("#inspect-no");
    if (noEl) noEl.innerHTML = seg7(String(i + 1).padStart(2, "0"), "pl-no");

    const titleEl = $("#inspect-title");
    if (titleEl && document.activeElement !== titleEl) titleEl.value = t.title || "";

    const artistEl = $("#inspect-artist");
    if (artistEl && document.activeElement !== artistEl) artistEl.value = t.artist || "";

    const startEl = $("#inspect-start");
    if (startEl && document.activeElement !== startEl) startEl.value = fmtEdit(t.start);

    const lenEl = $("#inspect-len");
    if (lenEl) lenEl.innerHTML = seg7(fmtEdit(t.end - t.start), "pl-len");

    const mergeBtn = $("#inspect-merge-btn");
    if (mergeBtn) mergeBtn.disabled = i === 0;

    const delBtn = $("#inspect-delete-btn");
    if (delBtn) delBtn.disabled = ED.data.tracks.length <= 1;

    if (seek) seekTo(t.start);
    updateRowPlayback();
  }

  function toggleTrackPlay(i) {
    if (!ED.data?.tracks?.[i]) return;
    const t = ED.data.tracks[i];
    const ct = audio.currentTime;
    const isPlayingThis = ct >= t.start && ct < t.end && !audio.paused;
    if (isPlayingThis) {
      audio.pause();
    } else {
      seekTo(t.start);
      audio.play();
    }
    selectTrack(i);
  }

  function renderRows() {
    const list = $("#edit-track-rows");
    list.innerHTML = "";

    const hasQuotaNotice = (ED.data.tracks || []).some(
      (t) => t.id_status === "error" && (t.id_message || "").toLowerCase().includes("limit exceeded")
    );
    const noticeEl = $("#edit-quota-notice");
    if (noticeEl) {
      if (hasQuotaNotice) {
        noticeEl.classList.remove("hidden");
        noticeEl.innerHTML = `⚠️ <span><strong>ACRCloud Limit Reached (Code 3003):</strong> Free daily API request limit is exhausted. Metadata fallbacks used where available. Update credentials in <code>.env</code> and click <strong>🔍 ID</strong> to re-identify.</span>`;
      } else {
        noticeEl.classList.add("hidden");
      }
    }

    if (ED.selectedIndex >= ED.data.tracks.length) {
      ED.selectedIndex = Math.max(0, ED.data.tracks.length - 1);
    }

    ED.data.tracks.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "edit-track-row" + (i === ED.selectedIndex ? " selected" : "");
      row.dataset.i = i;
      row.innerHTML = `
        <span class="c-play"><button type="button" class="row-play-btn" title="Play / Pause track" aria-label="Play track">▶</button></span>
        <span class="c-no">${seg7(String(i + 1).padStart(2, "0"), "pl-no")}</span>
        <span class="c-time mono">${fmtEdit(t.start)}</span>
        <span class="c-len">${seg7(fmtEdit(t.end - t.start), "pl-len")}</span>
        <div class="c-info">
          <span class="pl-title">${escapeHtml(t.title || `Track ${String(i + 1).padStart(2, "0")}`)}</span>
          <span class="pl-meta">${escapeHtml(t.artist || "")}</span>
        </div>
        <span class="c-pads">
          <button type="button" class="deck-pad pad-download" title="Download track MP3" aria-label="Download track"><span class="deck-pad-glyph">⬇</span></button>
        </span>`;

      row.querySelector(".row-play-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTrackPlay(i);
      });

      const dlBtn = row.querySelector(".pad-download");
      dlBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadTrack(i, dlBtn);
      });

      setupRowScrub(row, i);
      list.appendChild(row);
    });

    selectTrack(ED.selectedIndex || 0);
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
    ED.selectedIndex = idx + 1;
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
    ED.selectedIndex = Math.max(0, i - 1);
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
    ED.selectedIndex = Math.max(0, Math.min(i, tracks.length - 1));
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
    const onControl = (el) => el.closest("button, a, label, input");
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
      selectTrack(i);
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
      const playBtn = el.querySelector(".row-play-btn");
      if (i === active) {
        const t = ED.data.tracks[i];
        const prog = Math.min(1, Math.max(0, (audio.currentTime - t.start) / Math.max(0.1, t.end - t.start)));
        el.classList.add("playing");
        el.style.setProperty("--prog", prog.toFixed(4));
        if (playBtn) playBtn.innerHTML = audio.paused ? "▶" : "⏸";
      } else {
        el.classList.remove("playing");
        el.style.removeProperty("--prog");
        if (playBtn) playBtn.innerHTML = "▶";
      }
    });

    const inspectPlay = $("#inspect-play-btn");
    if (inspectPlay) {
      const isSelectedPlaying = ED.selectedIndex === active && !audio.paused;
      const glyph = inspectPlay.querySelector(".deck-pad-glyph");
      const text = inspectPlay.querySelector(".inspect-btn-text");
      if (glyph) glyph.textContent = isSelectedPlaying ? "⏸" : "▶";
      if (text) text.textContent = isSelectedPlaying ? "PAUSE" : "PLAY";
      if (isSelectedPlaying) inspectPlay.classList.add("active");
      else inspectPlay.classList.remove("active");
    }
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
    return (ED.data?.tracks || []).map((t, i) => ({
      index: i + 1,
      start: t.start,
      end: t.end,
      title: (t.title || "").trim(),
      artist: (t.artist || "").trim(),
      id_status: t.id_status || "unknown",
      id_message: t.id_message || "",
      score: t.score ?? null,
    }));
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

  async function downloadTrack(i, btn) {
    const t = ED.data?.tracks?.[i];
    if (!t || !ED.jobId) return;
    const origHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.classList.add("exporting");
      btn.innerHTML = `<span class="deck-pad-glyph">⏳</span>`;
    }
    toast(`Exporting “${t.title || `Track ${i + 1}`}”…`);
    try {
      const res = await api(`/api/jobs/${ED.jobId}/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: t.start,
          end: t.end,
          title: t.title || "",
          artist: t.artist || "",
          index: i + 1,
        }),
      });
      if (res && res.filename) {
        const a = document.createElement("a");
        a.href = `/api/jobs/${ED.jobId}/download/${encodeURIComponent(res.filename)}`;
        a.download = res.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast(`Downloaded “${res.title || `Track ${i + 1}`}”`);
      } else {
        toast("Download failed: invalid server response.", true);
      }
    } catch (err) {
      toast(`Download failed: ${err.message || err}`, true);
    } finally {
      if (btn) {
        btn.classList.remove("exporting");
        btn.innerHTML = origHtml;
      }
    }
  }

  async function exportZip() {
    if (!ED.jobId || !ED.data?.tracks?.length) return;
    const tracks = collectTracks().map((t) => ({
      start: t.start,
      end: t.end,
      title: t.title || "",
      artist: t.artist || "",
    }));
    const btn = $("#edit-export-zip");
    if (btn) btn.disabled = true;
    toast("Exporting all tracks to ZIP…");
    try {
      await api(`/api/jobs/${ED.jobId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks }),
      });
      const interval = setInterval(async () => {
        try {
          const job = await api(`/api/jobs/${ED.jobId}`);
          if (job.status === "error") {
            clearInterval(interval);
            if (btn) btn.disabled = false;
            toast(job.error || "ZIP export failed", true);
            return;
          }
          if (job.export && job.export.zip) {
            clearInterval(interval);
            if (btn) btn.disabled = false;
            const a = document.createElement("a");
            a.href = `/api/jobs/${ED.jobId}/download`;
            a.download = `${(job.source?.title || "tracks").replace(/\//g, "_")}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            toast("ZIP download started!");
          }
        } catch (_) {
          clearInterval(interval);
          if (btn) btn.disabled = false;
        }
      }, 1000);
    } catch (e) {
      toast(`Export failed: ${e.message}`, true);
      if (btn) btn.disabled = false;
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
      if ($("#edit-reidentify")) $("#edit-reidentify").disabled = false;
      $("#edit-progress").classList.add("hidden");
      toast(job.error || "Operation failed", true);
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

  async function reidentify() {
    if (!ED.jobId || !ED.data) return;
    const btn = $("#edit-reidentify");
    if (btn) btn.disabled = true;
    $("#edit-redetect-status").textContent = "Re-identifying…";
    ED.awaitingResult = true;
    $("#edit-status").textContent = "IDENTIFYING";
    $("#edit-status").className = "lcd-status playing";
    try {
      await api(`/api/jobs/${ED.jobId}/reidentify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      startPolling();
    } catch (e) {
      toast(e.message, true);
      if (btn) btn.disabled = false;
      $("#edit-redetect-status").textContent = "";
      ED.awaitingResult = false;
    }
  }

  // ==================== STEM PUNCH & STITCH UNIT ====================
  const STEM_LABELS = {
    vocals: "VOC", kick: "KICK", drums: "DRM", bass: "BASS",
    guitar: "GTR", piano: "KEY", synth: "SYN", perc: "PERC", other: "OTHER",
    instrumental: "INST",
  };
  const STEM_LEDS = {
    vocals: "#ff5c7a", kick: "#ff4d2e", drums: "#f5a623", bass: "#29a3d3",
    guitar: "#3ddc84", piano: "#ff8a5c", synth: "#9b6bff", perc: "#2fd4c0",
    other: "#ff9f3e", instrumental: "#ff9f3e",
  };

  const PUNCH = {
    open: false,
    inTime: 0,
    outTime: 5,
    quality: "balanced",
    stemId: null,
    stems: {},
    order: [],
    muted: new Set(["vocals"]),
    splitRange: null,
    poll: null,
    previewAudio: new Audio(),
    isPlayingOrig: false,
    isPlayingEdit: false,
    stopTimer: null,
  };

  function updatePunchVisual() {
    const punch = $("#edit-punch-region");
    if (!punch || !ED.duration) return;
    if (!PUNCH.open && PUNCH.inTime === 0 && PUNCH.outTime === 0) {
      punch.classList.add("hidden");
      return;
    }
    const { span } = viewRange();
    if (!span) return;
    const inPct = timeToViewPct(PUNCH.inTime);
    const outPct = timeToViewPct(PUNCH.outTime);
    punch.classList.remove("hidden");
    punch.style.left = Math.max(0, inPct) + "%";
    punch.style.width = Math.max(0.4, outPct - inPct) + "%";

    const inFld = $("#punch-in");
    const outFld = $("#punch-out");
    const lenFld = $("#punch-len");
    if (inFld && document.activeElement !== inFld) inFld.value = fmtEdit(PUNCH.inTime);
    if (outFld && document.activeElement !== outFld) outFld.value = fmtEdit(PUNCH.outTime);
    if (lenFld) lenFld.textContent = fmtEdit(Math.max(0, PUNCH.outTime - PUNCH.inTime));
  }

  function setPunchIn(sec) {
    sec = Math.max(0, Math.min(ED.duration || 0, Math.round(sec * 100) / 100));
    PUNCH.inTime = sec;
    if (PUNCH.outTime <= PUNCH.inTime) {
      PUNCH.outTime = Math.min(ED.duration || (sec + 5), sec + 5);
    }
    onPunchRangeChanged();
    updatePunchVisual();
  }

  function setPunchOut(sec) {
    sec = Math.max(0, Math.min(ED.duration || 0, Math.round(sec * 100) / 100));
    PUNCH.outTime = sec;
    if (PUNCH.inTime >= PUNCH.outTime) {
      PUNCH.inTime = Math.max(0, sec - 5);
    }
    onPunchRangeChanged();
    updatePunchVisual();
  }

  function onPunchRangeChanged() {
    if (PUNCH.splitRange) {
      const [s, e, q] = PUNCH.splitRange;
      if (Math.abs(s - PUNCH.inTime) > 0.05 || Math.abs(e - PUNCH.outTime) > 0.05 || q !== PUNCH.quality) {
        PUNCH.splitRange = null;
        PUNCH.stemId = null;
        PUNCH.stems = {};
        renderPunchStems(false);
        setPunchState("SET RANGE", "paused");
        setPunchMsg("Range changed — press SPLIT to separate stems.", "");
        const editBtn = $("#punch-play-edit");
        const applyBtn = $("#punch-apply");
        if (editBtn) editBtn.disabled = true;
        if (applyBtn) applyBtn.disabled = true;
      }
    }
  }

  function setPunchState(text, cls = "paused") {
    const el = $("#punch-state");
    if (el) {
      el.textContent = text;
      el.className = `lcd-status ${cls}`;
    }
  }

  function setPunchMsg(text, cls = "") {
    const el = $("#punch-msg");
    if (el) {
      el.textContent = text;
      el.className = `punch-msg ${cls}`.trim();
    }
  }

  async function checkPunchEditState() {
    if (!ED.jobId) return;
    try {
      const state = await api(`/api/jobs/${ED.jobId}/stitch`);
      const revertBtn = $("#punch-revert");
      if (revertBtn) {
        if (state.has_backup) revertBtn.classList.remove("hidden");
        else revertBtn.classList.add("hidden");
      }
    } catch (_) {}
  }

  function initPunch() {
    PUNCH.inTime = 0;
    PUNCH.outTime = Math.min(ED.duration || 5, Math.max(5, ED.data?.tracks?.[0]?.end || 5));
    PUNCH.stemId = null;
    PUNCH.stems = {};
    PUNCH.order = [];
    PUNCH.muted = new Set(["vocals"]);
    PUNCH.splitRange = null;
    renderPunchStems(false);
    checkPunchEditState();
    updatePunchVisual();
  }

  function togglePunchModal(show) {
    PUNCH.open = typeof show === "boolean" ? show : !PUNCH.open;
    const modal = $("#punch-modal");
    const openBtn = $("#edit-punch-open");
    const region = $("#edit-punch-region");

    if (PUNCH.open) {
      modal?.classList.remove("hidden");
      openBtn?.classList.add("on");
      region?.classList.remove("hidden");
      if (PUNCH.inTime === 0 && PUNCH.outTime <= 5 && audio.currentTime > 0) {
        setPunchIn(audio.currentTime);
      }
      updatePunchVisual();
      checkPunchEditState();
    } else {
      modal?.classList.add("hidden");
      openBtn?.classList.remove("on");
      region?.classList.add("hidden");
      stopPunchAudition();
    }
  }

  function renderPunchStems(isReady = true) {
    const rack = $("#punch-stems");
    if (!rack) return;
    rack.innerHTML = "";
    if (!isReady || !PUNCH.order.length) {
      rack.classList.add("is-off");
      rack.innerHTML = `<p class="punch-hint">Set IN / OUT, then press <b>SPLIT</b>.</p>`;
      return;
    }
    rack.classList.remove("is-off");
    PUNCH.order.forEach((name) => {
      if (!PUNCH.stems[name]) return;
      const isMuted = PUNCH.muted.has(name);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mix-tbtn punch-stem ${isMuted ? "muted" : ""}`;
      btn.dataset.name = name;
      btn.title = isMuted ? `Unmute ${name}` : `Mute ${name}`;
      btn.innerHTML = `
        <span class="led" style="--c: ${STEM_LEDS[name] || "#ff9f3e"}"></span>
        <span class="name">${escapeHtml(STEM_LABELS[name] || name)}</span>
        <span class="st">${isMuted ? "OFF" : "ON"}</span>
      `;
      btn.addEventListener("click", () => {
        if (PUNCH.muted.has(name)) {
          PUNCH.muted.delete(name);
        } else {
          PUNCH.muted.add(name);
        }
        renderPunchStems(true);
        const editBtn = $("#punch-play-edit");
        const applyBtn = $("#punch-apply");
        const hasMuted = PUNCH.muted.size > 0;
        if (editBtn) editBtn.disabled = !hasMuted;
        if (applyBtn) applyBtn.disabled = !hasMuted;
        if (hasMuted) {
          const names = [...PUNCH.muted].map((s) => (STEM_LABELS[s] || s).toUpperCase()).join(", ");
          setPunchMsg(`Muting: ${names}. Click EDIT to audition or STITCH to save.`);
        } else {
          setPunchMsg("Nothing muted. Click a stem (e.g. VOC) to switch it off.");
        }
      });
      rack.appendChild(btn);
    });
  }

  async function separatePunchStems() {
    if (!ED.jobId) return;
    if (PUNCH.outTime - PUNCH.inTime < 0.1) {
      toast("OUT must be after IN.", true);
      return;
    }
    const btn = $("#punch-separate");
    const prog = $("#punch-progress");
    const bar = $("#punch-bar");

    if (btn) btn.disabled = true;
    prog?.classList.remove("hidden");
    if (bar) bar.style.width = "5%";
    setPunchState("SPLITTING", "working");
    setPunchMsg(`Splitting ${fmtEdit(PUNCH.inTime)} – ${fmtEdit(PUNCH.outTime)} (${PUNCH.quality})…`);

    try {
      const res = await api(`/api/jobs/${ED.jobId}/stitch/separate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: PUNCH.inTime,
          end: PUNCH.outTime,
          quality: PUNCH.quality,
        }),
      });

      if (res.status === "running") {
        pollPunchStems(res.id);
      } else if (res.status === "ready") {
        applyPunchStemsReady(res);
      }
    } catch (e) {
      toast(e.message, true);
      prog?.classList.add("hidden");
      if (btn) btn.disabled = false;
      setPunchState("ERROR", "error");
      setPunchMsg(e.message, "bad");
    }
  }

  function pollPunchStems(stemId) {
    clearInterval(PUNCH.poll);
    PUNCH.poll = setInterval(async () => {
      try {
        const job = await api(`/api/stems/${stemId}`);
        const bar = $("#punch-bar");
        if (bar) bar.style.width = `${Math.round((job.progress || 0) * 100)}%`;
        if (job.status === "ready") {
          clearInterval(PUNCH.poll);
          applyPunchStemsReady(job);
        } else if (job.status === "error") {
          clearInterval(PUNCH.poll);
          $("#punch-progress")?.classList.add("hidden");
          const sepBtn = $("#punch-separate");
          if (sepBtn) sepBtn.disabled = false;
          setPunchState("ERROR", "error");
          setPunchMsg(job.error || "Separation failed.", "bad");
          toast(job.error || "Separation failed", true);
        }
      } catch (_) {
        clearInterval(PUNCH.poll);
        $("#punch-progress")?.classList.add("hidden");
        const sepBtn = $("#punch-separate");
        if (sepBtn) sepBtn.disabled = false;
      }
    }, 600);
  }

  function applyPunchStemsReady(res) {
    PUNCH.stemId = res.id;
    PUNCH.stems = res.stems || {};
    PUNCH.order = res.order || Object.keys(PUNCH.stems);
    PUNCH.splitRange = [PUNCH.inTime, PUNCH.outTime, PUNCH.quality];
    if (PUNCH.stems.vocals && !PUNCH.muted.size) {
      PUNCH.muted.add("vocals");
    }

    $("#punch-progress")?.classList.add("hidden");
    const sepBtn = $("#punch-separate");
    if (sepBtn) sepBtn.disabled = false;
    const editBtn = $("#punch-play-edit");
    const applyBtn = $("#punch-apply");
    if (editBtn) editBtn.disabled = PUNCH.muted.size === 0;
    if (applyBtn) applyBtn.disabled = PUNCH.muted.size === 0;

    renderPunchStems(true);
    setPunchState("READY", "playing");
    setPunchMsg("Stems ready. Vocals muted by default — click EDIT to audition.", "ok");
    toast("Stems split for selected range!");
  }

  function stopPunchAudition() {
    clearTimeout(PUNCH.stopTimer);
    if (PUNCH.isPlayingOrig) {
      audio.pause();
      PUNCH.isPlayingOrig = false;
      const btn = $("#punch-play-orig");
      if (btn) btn.textContent = "▶ ORIG";
    }
    if (PUNCH.isPlayingEdit) {
      PUNCH.previewAudio.pause();
      PUNCH.isPlayingEdit = false;
      const btn = $("#punch-play-edit");
      if (btn) btn.textContent = "▶ EDIT";
    }
  }

  function playPunchOrig() {
    const btn = $("#punch-play-orig");
    if (PUNCH.isPlayingOrig) {
      stopPunchAudition();
      return;
    }
    stopPunchAudition();
    PUNCH.isPlayingOrig = true;
    if (btn) btn.textContent = "⏹ STOP";

    const lead = 4.0;
    const playStart = Math.max(0, PUNCH.inTime - lead);
    const playEnd = Math.min(ED.duration, PUNCH.outTime + lead);
    seekTo(playStart);
    audio.play();

    const checkStop = () => {
      if (!PUNCH.isPlayingOrig) return;
      if (audio.currentTime >= playEnd || audio.paused) {
        stopPunchAudition();
      } else {
        PUNCH.stopTimer = setTimeout(checkStop, 80);
      }
    };
    PUNCH.stopTimer = setTimeout(checkStop, 100);
  }

  async function playPunchEdit() {
    const btn = $("#punch-play-edit");
    if (PUNCH.isPlayingEdit) {
      stopPunchAudition();
      return;
    }
    if (!ED.jobId || !PUNCH.splitRange) {
      toast("Please split stems first.", true);
      return;
    }
    if (!PUNCH.muted.size) {
      toast("Click a stem (e.g. VOC) to mute first.", true);
      return;
    }
    stopPunchAudition();
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ …";
    }
    setPunchMsg("Rendering preview clip…");

    try {
      const res = await api(`/api/jobs/${ED.jobId}/stitch/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: PUNCH.inTime,
          end: PUNCH.outTime,
          quality: PUNCH.quality,
          muted: [...PUNCH.muted],
        }),
      });

      PUNCH.previewAudio.src = res.url;
      PUNCH.previewAudio.currentTime = 0;
      await PUNCH.previewAudio.play();
      PUNCH.isPlayingEdit = true;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "⏹ STOP";
      }
      setPunchMsg("Auditioning edit in context (4s lead-in / out)…", "ok");

      const onEnded = () => {
        stopPunchAudition();
        PUNCH.previewAudio.removeEventListener("ended", onEnded);
      };
      PUNCH.previewAudio.addEventListener("ended", onEnded, { once: true });
    } catch (e) {
      stopPunchAudition();
      toast(e.message, true);
      setPunchMsg(e.message, "bad");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "▶ EDIT";
      }
    }
  }

  async function applyPunchStitch() {
    if (!ED.jobId || !PUNCH.splitRange) {
      toast("Split stems first.", true);
      return;
    }
    if (!PUNCH.muted.size) {
      toast("Mute at least one stem first.", true);
      return;
    }
    const btn = $("#punch-apply");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ …";
    }
    stopPunchAudition();
    setPunchState("STITCHING", "working");
    setPunchMsg("Splicing edit seamlessly into song audio…");

    try {
      const res = await api(`/api/jobs/${ED.jobId}/stitch/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: PUNCH.inTime,
          end: PUNCH.outTime,
          quality: PUNCH.quality,
          muted: [...PUNCH.muted],
        }),
      });

      if (res.waveform) {
        ED.data.waveform = res.waveform;
        drawWave();
      }
      const ct = audio.currentTime;
      audio.src = `/api/jobs/${ED.jobId}/audio?t=${Date.now()}`;
      audio.addEventListener("canplay", () => { audio.currentTime = ct; }, { once: true });
      audio.load();

      $("#punch-revert")?.classList.remove("hidden");
      setPunchState("APPLIED", "playing");
      setPunchMsg(`Stitched! ${fmtEdit(PUNCH.inTime)}–${fmtEdit(PUNCH.outTime)} replaced with muted edit.`, "ok");
      toast("Song audio updated with seamless stitch!");
    } catch (e) {
      toast(e.message, true);
      setPunchState("ERROR", "error");
      setPunchMsg(e.message, "bad");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "STITCH";
      }
    }
  }

  async function revertPunchStitch() {
    if (!ED.jobId) return;
    const btn = $("#punch-revert");
    if (btn) btn.disabled = true;
    stopPunchAudition();
    setPunchMsg("Restoring original song audio…");

    try {
      const res = await api(`/api/jobs/${ED.jobId}/stitch/revert`, { method: "POST" });
      if (res.waveform) {
        ED.data.waveform = res.waveform;
        drawWave();
      }
      const ct = audio.currentTime;
      audio.src = `/api/jobs/${ED.jobId}/audio?t=${Date.now()}`;
      audio.addEventListener("canplay", () => { audio.currentTime = ct; }, { once: true });
      audio.load();

      $("#punch-revert")?.classList.add("hidden");
      setPunchState("REVERTED", "paused");
      setPunchMsg("Song restored to original.", "ok");
      toast("Restored original song audio.");
    } catch (e) {
      toast(e.message, true);
      setPunchMsg(e.message, "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function downloadPunchMp3() {
    if (!ED.jobId) return;
    toast("Preparing MP3 download…");
    const a = document.createElement("a");
    a.href = `/api/jobs/${ED.jobId}/download-stitched?t=${Date.now()}`;
    const name = ($("#edit-mix-title")?.textContent || "song").trim().replace(/[/\\?%*:|"<>]/g, "_");
    a.download = `${name} [Edit].mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
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
    stopPunchAudition();
    clearInterval(PUNCH.poll);
    togglePunchModal(false);
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
    if (e.key === "Escape" && !$("#edit-studio").classList.contains("hidden")) {
      if (PUNCH.open) togglePunchModal(false);
      else closeEditStudio();
    }
  });
  $("#edit-play").addEventListener("click", () => { audio.paused ? audio.play() : audio.pause(); });
  $("#edit-skip-back").addEventListener("click", () => skipBy(-skipStep()));
  $("#edit-skip-fwd").addEventListener("click", () => skipBy(skipStep()));
  $("#edit-split").addEventListener("click", () => splitAt(audio.currentTime || 0));
  $("#edit-save").addEventListener("click", saveTracks);
  $("#edit-export-zip")?.addEventListener("click", exportZip);
  $("#edit-redetect").addEventListener("click", redetect);
  $("#edit-reidentify")?.addEventListener("click", reidentify);
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

  // Track Inspector setup
  function setupInspector() {
    const titleInput = $("#inspect-title");
    titleInput?.addEventListener("input", (e) => {
      const i = ED.selectedIndex;
      if (i >= 0 && ED.data?.tracks?.[i]) {
        ED.data.tracks[i].title = e.target.value;
        updateRowInfo(i);
      }
    });

    const artistInput = $("#inspect-artist");
    artistInput?.addEventListener("input", (e) => {
      const i = ED.selectedIndex;
      if (i >= 0 && ED.data?.tracks?.[i]) {
        ED.data.tracks[i].artist = e.target.value;
        updateRowInfo(i);
      }
    });

    const startInput = $("#inspect-start");
    startInput?.addEventListener("change", (e) => {
      const i = ED.selectedIndex;
      if (i >= 0 && ED.data?.tracks?.[i]) {
        const secs = parseTime(e.target.value);
        if (secs === null) {
          toast("Use a time like 3:20", true);
          startInput.value = fmtEdit(ED.data.tracks[i].start);
          return;
        }
        setBoundary(i, secs);
        selectTrack(i);
      }
    });

    $("#inspect-snap-now")?.addEventListener("click", () => {
      const i = ED.selectedIndex;
      if (i >= 0 && ED.data?.tracks?.[i]) {
        const curTime = audio.currentTime || 0;
        setBoundary(i, curTime);
        selectTrack(i);
        toast(`Track ${String(i + 1).padStart(2, "0")} start set to ${fmtEdit(curTime)}.`);
      }
    });

    $("#inspect-play-btn")?.addEventListener("click", () => {
      toggleTrackPlay(ED.selectedIndex);
    });

    $("#inspect-download-btn")?.addEventListener("click", () => {
      const i = ED.selectedIndex;
      const btn = $("#inspect-download-btn");
      if (i >= 0) downloadTrack(i, btn);
    });

    $("#inspect-merge-btn")?.addEventListener("click", () => {
      const i = ED.selectedIndex;
      if (i > 0) mergeUp(i);
    });

    $("#inspect-delete-btn")?.addEventListener("click", () => {
      const i = ED.selectedIndex;
      if (i >= 0) deleteTrack(i);
    });
  }
  setupInspector();

  // Punch modal controls
  $("#edit-punch-open")?.addEventListener("click", () => togglePunchModal());
  $("#punch-close")?.addEventListener("click", () => togglePunchModal(false));
  $("#punch-set-in")?.addEventListener("click", () => setPunchIn(audio.currentTime || 0));
  $("#punch-set-out")?.addEventListener("click", () => setPunchOut(audio.currentTime || 0));
  $("#punch-track")?.addEventListener("click", () => {
    let idx = currentTrackIndex();
    if (idx < 0) idx = 0;
    const t = ED.data?.tracks?.[idx];
    if (t) {
      setPunchIn(t.start);
      setPunchOut(t.end);
      toast(`Selected Track ${idx + 1} (${fmtEdit(t.start)} – ${fmtEdit(t.end)})`);
    }
  });
  $("#punch-in")?.addEventListener("change", (e) => {
    const v = parseTime(e.target.value);
    if (v !== null) setPunchIn(v);
    else e.target.value = fmtEdit(PUNCH.inTime);
  });
  $("#punch-out")?.addEventListener("change", (e) => {
    const v = parseTime(e.target.value);
    if (v !== null) setPunchOut(v);
    else e.target.value = fmtEdit(PUNCH.outTime);
  });
  document.querySelectorAll(".punch-quality .seg").forEach((seg) => {
    seg.addEventListener("click", () => {
      document.querySelectorAll(".punch-quality .seg").forEach((b) => b.classList.toggle("on", b === seg));
      PUNCH.quality = seg.dataset.q;
      onPunchRangeChanged();
    });
  });
  $("#punch-separate")?.addEventListener("click", separatePunchStems);
  $("#punch-play-orig")?.addEventListener("click", playPunchOrig);
  $("#punch-play-edit")?.addEventListener("click", playPunchEdit);
  $("#punch-apply")?.addEventListener("click", applyPunchStitch);
  $("#punch-revert")?.addEventListener("click", revertPunchStitch);
  $("#punch-mp3")?.addEventListener("click", downloadPunchMp3);

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
