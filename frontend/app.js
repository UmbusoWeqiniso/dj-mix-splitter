// Mix Station engine: load mixes/tracks (URL or local MP3), run the analysis
// pipeline, and feed every track into the Stem Studio playlist.
const $ = (sel) => document.querySelector(sel);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

// DL = downloaded/analyzed mixes (their tracks). PL = curated, ready-to-play list.
const DL = {
  items: [],            // { key, jobId, index, start, end, title, artist, mix }
  seen: new Set(),
  open: new Set(),      // jobIds whose folder is expanded
};
const PL = {
  items: [],
  seen: new Set(),
  activeKey: null,
  deckKeys: {},           // deckId -> playlist item key
  poll: null,
  preview: null,        // { key, audio }
};

function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// render a number as a seven-segment readout with faint ghost segments behind
function seg7(value, extraClass = "") {
  const v = String(value);
  const mask = v.replace(/[0-9]/g, "8");
  return `<span class="seg7 ${extraClass}" data-mask="${escapeHtml(mask)}"><span class="seg7-v">${escapeHtml(v)}</span></span>`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

// ---------- health ----------
let healthData = null;

function renderHealth() {
  const h = healthData;
  const el = $("#health");
  if (!h || !el) return;
  const ff = `<span class="pill svc-ffmpeg ${h.ffmpeg ? "ok" : "bad"}">ffmpeg ${h.ffmpeg ? "ready" : "missing"}</span>`;
  const ac = `<span class="pill svc-acr ${h.acrcloud_configured ? "ok" : ""}">ACRCloud ${h.acrcloud_configured ? "on" : "off"}</span>`;
  el.innerHTML = ff + ac;
}

async function checkHealth() {
  try {
    healthData = await api("/api/health");
    renderHealth();
  } catch (e) {
    $("#health").innerHTML = `<span class="pill bad">server error</span>`;
  }
}
window.refreshHealth = renderHealth;

// ---------- system resources (CPU / RAM / disk) ----------
const RESOURCES_POLL_MS = 4000;

function renderResources(data) {
  const el = $("#resources");
  if (!el) return;
  if (data && data.fetchError) {
    el.innerHTML = `<span class="pill stat stat-cpu muted" title="Could not reach /api/resources (server may need restart)">CPU —</span>`;
    return;
  }
  if (!data || data.available === false) {
    el.innerHTML = `<span class="pill stat stat-cpu muted" title="CPU stats unavailable (psutil not installed on server)">CPU —</span>`;
    return;
  }
  const cpu = Math.round(data.cpu_percent || 0);
  el.innerHTML = `<span class="pill stat stat-cpu" title="CPU usage">CPU <span class="cpu-val">${cpu}%</span></span>`;
}

async function pollResources() {
  try {
    renderResources(await api("/api/resources"));
  } catch (_) {
    renderResources({ fetchError: true });
  }
}
window.refreshResources = pollResources;

// ---------- load menu ----------
function toggleLoadMenu(force) {
  const m = $("#load-menu");
  const show = force !== undefined ? force : m.classList.contains("hidden");
  m.classList.toggle("hidden", !show);
  if (show) setTimeout(() => $("#url").focus(), 30);
}
$("#studio-load").addEventListener("click", () => toggleLoadMenu());
$("#load-close").addEventListener("click", () => toggleLoadMenu(false));
$("#load-menu").addEventListener("click", (e) => {
  if (e.target.id === "load-menu") toggleLoadMenu(false);   // click backdrop to close
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  toggleLoadMenu(false);
});

$("#go").addEventListener("click", loadFromUrl);
$("#url").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromUrl(); });
$("#file").addEventListener("change", loadFromFile);

// ---------- progress display (playlist main screen) ----------
const PLAYLIST_DOT_CELLS = 40;

function initPlaylistDotLoader() {
  const bar = $("#playlist-dot-loader");
  if (!bar || bar.dataset.ready) return;
  bar.innerHTML = "";
  for (let i = 0; i < PLAYLIST_DOT_CELLS; i++) {
    const cell = document.createElement("span");
    cell.className = "dot-cell";
    bar.appendChild(cell);
  }
  bar.dataset.ready = "1";
}

function setPlaylistDotPct(pct) {
  const el = $("#playlist-progress-pct");
  if (!el) return;
  const n = Math.max(0, Math.min(100, Math.round(pct)));
  const digits = String(n);
  const v = `${digits}%`;
  el.dataset.mask = digits.replace(/[0-9]/g, "8") + "%";
  const inner = el.querySelector(".seg7-v");
  if (inner) inner.textContent = v;
}

function setPlaylistDotProgress(frac) {
  initPlaylistDotLoader();
  const bar = $("#playlist-dot-loader");
  if (!bar) return;
  const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
  bar.setAttribute("aria-valuenow", String(pct));
  const cells = bar.querySelectorAll(".dot-cell");
  const lit = Math.round((pct / 100) * cells.length);
  cells.forEach((cell, i) => cell.classList.toggle("on", i < lit));
  setPlaylistDotPct(pct);
}

window.setStudioDotProgress = setPlaylistDotProgress;

function setPlaylistBusyLed(on) {
  $("#playlist-busy-led")?.classList.toggle("on", !!on);
}
window.setStudioBusyLed = setPlaylistBusyLed;

function showLoading(msg) {
  $("#playlist-progress")?.classList.remove("hidden");
  $("#playlist-list")?.closest(".playlist-viewport")?.classList.add("hidden");
  setPlaylistDotProgress(0);
  $("#playlist-msg").textContent = msg || "Working…";
  $("#playlist-msg").classList.remove("lcd-err");
  const st = $("#playlist-load-status");
  if (st) { st.textContent = "WORKING"; st.className = "lcd-status working"; }
  setPlaylistBusyLed(true);
}
function setLoading(frac, msg) {
  setPlaylistDotProgress(frac);
  if (msg) $("#playlist-msg").textContent = msg;
}
function hideLoading() {
  $("#playlist-progress")?.classList.add("hidden");
  $("#playlist-list")?.closest(".playlist-viewport")?.classList.remove("hidden");
  setPlaylistBusyLed(false);
  const st = $("#playlist-load-status");
  if (st) { st.textContent = "READY"; st.className = "lcd-status paused"; }
}

// ---------- load flows ----------
async function loadFromUrl() {
  const url = $("#url").value.trim();
  if (!url) { toast("Paste a mix or track URL first.", true); return; }
  if (window.AppleMusic && AppleMusic.parseUrl(url)) {
    toggleLoadMenu(false);
    if (!AppleMusic.configured()) {
      toast("Apple Music is not configured — open Settings ⚙ to set up.", true);
      return;
    }
    const handled = await AppleMusic.openUrl(url);
    if (handled) $("#url").value = "";
    return;
  }
  if (window.Spotify && Spotify.parseUrl(url)) {
    toggleLoadMenu(false);
    if (!Spotify.configured()) {
      toast("Spotify is not configured — open Settings ⚙ to set up.", true);
      return;
    }
    const handled = await Spotify.openUrl(url);
    if (handled) $("#url").value = "";
    return;
  }
  toggleLoadMenu(false);
  showLoading("Starting download…");
  try {
    const job = await api("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    $("#url").value = "";
    pollJob(job.id);
  } catch (e) { toast(e.message, true); hideLoading(); }
}

async function loadFromFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  toggleLoadMenu(false);
  showLoading(`Importing ${f.name}…`);
  try {
    const fd = new FormData();
    fd.append("file", f);
    const job = await api("/api/jobs/upload", { method: "POST", body: fd });
    pollJob(job.id);
  } catch (err) { toast(err.message, true); hideLoading(); }
  finally { e.target.value = ""; }
}

function pollJob(jobId) {
  clearInterval(PL.poll);
  const labels = { download: "Downloading", analyze: "Analyzing", identify: "Identifying", ready: "Ready" };
  PL.poll = setInterval(async () => {
    let job;
    try { job = await api(`/api/jobs/${jobId}`); } catch (_) { return; }
    if (job.status === "error") {
      clearInterval(PL.poll); hideLoading();
      toast(job.error || "Load failed", true);
      return;
    }
    setLoading(job.progress, `${labels[job.stage] || "Working"} — ${job.message || ""}`);
    if (job.status === "ready" || job.status === "done") {
      clearInterval(PL.poll); hideLoading();
      addMixToDownloads(job);
    }
  }, 900);
}

// ---------- downloads (analyzed mixes) ----------
function addMixToDownloads(job, { silent = false } = {}) {
  const tracks = (job.result && job.result.tracks) || [];
  const mix = (job.source && job.source.title) || "Mix";
  let added = 0;
  tracks.forEach((t) => {
    const key = `${job.id}:${t.index}`;
    if (DL.seen.has(key)) return;
    DL.seen.add(key);
    DL.items.push({
      key, jobId: job.id, index: t.index, start: t.start, end: t.end,
      title: t.title || `Track ${t.index}`, artist: t.artist || "", mix,
    });
    added++;
  });
  if (!silent && added) DL.open.add(job.id);   // auto-expand a freshly loaded mix
  renderDownloads();
  if (!silent && added) toast(`Downloaded ${added} track${added > 1 ? "s" : ""} from “${mix}”.`);
}

/** Replace library + playlist entries for a job after the edit studio saves. */
window.syncLibraryFromJob = function (job) {
  const mix = (job.source && job.source.title) || "Mix";
  DL.items = DL.items.filter((it) => it.jobId !== job.id);
  (job.result.tracks || []).forEach((t) => {
    DL.items.push({
      key: `${job.id}:${t.index}`,
      jobId: job.id, index: t.index, start: t.start, end: t.end,
      title: t.title || `Track ${t.index}`, artist: t.artist || "", mix,
    });
  });
  DL.seen = new Set(DL.items.map((it) => it.key));
  PL.items.forEach((it) => {
    if (it.jobId === job.id) window.stopPlaylistStemSplit?.(it.key);
  });
  PL.items = PL.items.filter((it) => it.jobId !== job.id);
  PL.seen = new Set(PL.items.map((it) => it.key));
  if (PL.activeKey && PL.activeKey.startsWith(`${job.id}:`)) PL.activeKey = null;
  renderDownloads();
  renderPlaylist();
};

function renderDownloads() {
  const list = $("#downloads-list");
  $("#downloads-count").textContent = `${DL.items.length} track${DL.items.length === 1 ? "" : "s"}`;
  if (!DL.items.length) {
    list.innerHTML = `<div class="playlist-empty muted small">Library empty — load a URL or MP3 above.</div>`;
    return;
  }
  // group tracks into one folder per mix (jobId), preserving insertion order
  const groups = new Map();
  DL.items.forEach((it) => {
    if (!groups.has(it.jobId)) groups.set(it.jobId, { mix: it.mix, items: [] });
    groups.get(it.jobId).items.push(it);
  });
  list.innerHTML = "";
  groups.forEach((g, jobId) => {
    const open = DL.open.has(jobId);
    const group = document.createElement("div");
    group.className = "dl-group" + (open ? " open" : "");

    const allInPl = g.items.every((it) => PL.seen.has(it.key));
    const folder = document.createElement("button");
    folder.className = "dl-folder" + (open ? " open" : "");
    folder.innerHTML = `
      <span class="dl-caret" aria-hidden="true">${open ? "▼" : "▶"}</span>
      <span class="dl-folder-name">${escapeHtml(g.mix)}</span>
      <span class="dl-folder-count">${seg7(g.items.length)}</span>
      <span class="dl-folder-actions">
        <button type="button" class="dl-add-all ghost iconbtn${allInPl ? " on" : ""}" title="${allInPl ? "All tracks in playlist" : "Add all tracks to playlist"}" aria-label="Add all tracks to playlist">${allInPl ? "✓" : "＋"}</button>
        <button type="button" class="dl-edit ghost iconbtn" title="Edit track splits" aria-label="Edit track splits">✎</button>
      </span>`;
    folder.title = open ? "Collapse" : "Expand";
    folder.addEventListener("click", () => {
      if (DL.open.has(jobId)) DL.open.delete(jobId); else DL.open.add(jobId);
      renderDownloads();
    });
    folder.querySelector(".dl-add-all").addEventListener("click", (e) => {
      e.stopPropagation();
      addMixToPlaylist(g.items, g.mix);
    });
    folder.querySelector(".dl-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLoadMenu(false);
      window.openEditStudio(jobId);
    });
    group.appendChild(folder);

    if (open) {
      const tracks = document.createElement("div");
      tracks.className = "dl-tracks";
      g.items.forEach((it, i) => {
        const inPl = PL.seen.has(it.key);
        const row = document.createElement("button");
        row.className = "pl-row dl-track";
        row.innerHTML = `
          <span class="pl-prev" data-key="${escapeHtml(it.key)}" title="Preview">▶</span>
          ${seg7(String(i + 1).padStart(2, "0"), "pl-no")}
          <span class="pl-title">${escapeHtml(it.title)}</span>
          <span class="pl-meta">${escapeHtml(it.artist || "")}</span>
          ${seg7(fmt(it.end - it.start), "pl-len")}
          <span class="pl-act ${inPl ? "added" : "add"}">${inPl ? "✓" : "＋"}</span>
          <span class="pl-act delete" title="Delete track">🗑</span>`;
        row.title = inPl ? "Already in playlist" : "Add to playlist";
        row.addEventListener("click", (e) => {
          if (e.target.closest(".pl-prev")) { togglePreview(it); return; }
          if (e.target.closest(".pl-act.delete")) { deleteFromLibrary(it); return; }
          if (e.target.closest(".pl-act.add, .pl-act.added")) { addToPlaylist(it); return; }
          if (isScrubbing(it)) return;
          togglePreview(it);   // row click previews; ＋ adds to playlist
        });
        setupPreviewScrub(row, it);
        tracks.appendChild(row);
      });
      group.appendChild(tracks);
    }
    list.appendChild(group);
  });
  updatePreviewButtons();
}

// ---------- playlist (ready to play) ----------
function getFocusedDeckKey() {
  const fid = window.getStudioFocusedDeckId?.();
  if (fid != null && PL.deckKeys[fid]) return PL.deckKeys[fid];
  return PL.activeKey;
}

function findEmptyDeckId() {
  const ids = window.getStudioDeckIds?.() || [1, 2];
  for (const id of ids) {
    if (!PL.deckKeys[id]) return id;
  }
  return window.getStudioFocusedDeckId?.() || 1;
}

function resolveLoadDeckId(deckId) {
  const ids = window.getStudioDeckIds?.() || [1, 2];
  if (deckId != null && ids.includes(deckId)) return deckId;
  return window.getStudioFocusedDeckId?.() || 1;
}

let suppressPlaylistScroll = false;

/** Map playlist rows to deck slots: index 0 → deck 1, index 1 → deck 2, etc. */
async function autoFillPlaylistToDecks() {
  const deckIds = window.getStudioDeckIds?.() || [1, 2];
  if (!deckIds.length || !PL.items.length) return;
  suppressPlaylistScroll = true;
  try {
    for (let i = 0; i < Math.min(PL.items.length, deckIds.length); i++) {
      const it = PL.items[i];
      const deckId = deckIds[i];
      if (PL.deckKeys[deckId] === it.key) continue;
      if (PL.deckKeys[deckId] != null) continue;
      await loadTrackToDeck(it, deckId);
    }
  } finally {
    suppressPlaylistScroll = false;
  }
}
window.autoFillPlaylistToDecks = autoFillPlaylistToDecks;

window.onStudioFocusDeck = (id) => {
  if (PL.deckKeys[id]) PL.activeKey = PL.deckKeys[id];
  renderPlaylist();
  updateNextTrackDisplay();
};

window.onStudioRemoveDeck = (id) => {
  delete PL.deckKeys[id];
  renderPlaylist();
};

function isSplittableTrack(it) {
  if (window.Spotify && Spotify.isItem(it)) return false;
  if (window.AppleMusic && AppleMusic.isItem(it)) return false;
  return !!(it && it.jobId != null);
}

function createPlaylistStemState() {
  return { status: "idle", progress: 0, message: "", stemId: null, error: null };
}

function queuePlaylistStemSplit(it) {
  if (!isSplittableTrack(it)) return;
  if (!it.stem) it.stem = createPlaylistStemState();
  window.startPlaylistStemSplit?.(it);
}

function applyPlaylistStemRowUI(row, it) {
  if (!row || !it) return;
  const stem = it.stem;
  if (!stem || !isSplittableTrack(it)) {
    row.classList.remove("stem-splitting", "stem-ready", "stem-error");
    row.style.removeProperty("--stem-prog");
    row.querySelector(".pl-stem-status")?.remove();
    return;
  }
  row.classList.toggle("stem-splitting", stem.status === "starting" || stem.status === "running");
  row.classList.toggle("stem-ready", stem.status === "ready");
  row.classList.toggle("stem-error", stem.status === "error");
  if (stem.status === "starting" || stem.status === "running") {
    row.style.setProperty("--stem-prog", (stem.progress || 0).toFixed(4));
  } else {
    row.style.removeProperty("--stem-prog");
  }
  const label = window.plStemStatusLabel?.(stem) || "";
  let statusEl = row.querySelector(".pl-stem-status");
  const slot = row.querySelector(".pl-stem-slot");
  const statusParent = slot || row;
  if (!label) {
    statusEl?.remove();
    return;
  }
  if (!statusEl) {
    statusEl = document.createElement("span");
    statusEl.className = "pl-stem-status muted small";
    statusEl.setAttribute("aria-live", "polite");
    statusParent.appendChild(statusEl);
  } else if (slot && statusEl.parentElement !== slot) {
    slot.appendChild(statusEl);
  }
  statusEl.textContent = label;
  statusEl.classList.toggle("lcd-err", stem.status === "error");
}

window.updatePlaylistStemRow = function updatePlaylistStemRow(key) {
  const it = PL.items.find((x) => x.key === key);
  const row = $("#playlist-list")?.querySelector(`.pl-row[data-key="${CSS.escape(key)}"]`);
  if (it && row) applyPlaylistStemRowUI(row, it);
};

function addToPlaylist(it) {
  if (PL.seen.has(it.key)) { toast("Already in the playlist."); return; }
  PL.seen.add(it.key);
  PL.items.push({ ...it, stem: createPlaylistStemState() });
  renderPlaylist();
  renderDownloads();
  toast(`Added “${it.title}” to the playlist.`);
  queuePlaylistStemSplit(PL.items[PL.items.length - 1]);
  autoFillPlaylistToDecks();
}

function addMixToPlaylist(items, mixName) {
  let added = 0;
  items.forEach((it) => {
    if (PL.seen.has(it.key)) return;
    PL.seen.add(it.key);
    const entry = { ...it, stem: createPlaylistStemState() };
    PL.items.push(entry);
    queuePlaylistStemSplit(entry);
    added++;
  });
  if (!added) {
    toast(`All tracks from “${mixName}” are already in the playlist.`);
    return;
  }
  renderPlaylist();
  renderDownloads();
  toast(`Added ${added} track${added > 1 ? "s" : ""} from “${mixName}”.`);
  autoFillPlaylistToDecks();
}
window.addToPlaylist = addToPlaylist;
window.PL = PL;

function removeFromPlaylist(key) {
  window.stopPlaylistStemSplit?.(key);
  PL.items = PL.items.filter((x) => x.key !== key);
  PL.seen.delete(key);
  if (PL.activeKey === key) PL.activeKey = null;
  Object.keys(PL.deckKeys).forEach((id) => {
    if (PL.deckKeys[id] === key) delete PL.deckKeys[id];
  });
  renderPlaylist();
  renderDownloads();
}

function getNextTrackForDeck(deckId) {
  if (!PL.items.length) return null;
  const key = PL.deckKeys[deckId];
  const idx = key != null
    ? PL.items.findIndex((x) => x.key === key)
    : -1;
  if (idx >= 0 && idx < PL.items.length - 1) return PL.items[idx + 1];
  if (idx < 0) return PL.items[0];
  return null;
}

function updateNextTrackDisplay() {
  const deckIds = window.getStudioDeckIds?.() || [];
  deckIds.forEach((deckId) => {
    const el = document.querySelector(`.deck[data-deck-id="${deckId}"] .deck-next`);
    if (!el) return;
    const next = getNextTrackForDeck(deckId);
    if (!next) {
      el.textContent = "NEXT: —";
      el.title = "";
      return;
    }
    const title = next.title || "Untitled";
    el.textContent = `NEXT: ${title}`;
    el.title = title;
  });
}
window.updateNextTrackDisplay = updateNextTrackDisplay;

async function deleteFromLibrary(it) {
  if (it.source === "apple-music") {
    removeFromPlaylist(it.key);
    DL.items = DL.items.filter((x) => x.key !== it.key);
    DL.seen.delete(it.key);
    renderDownloads();
    toast(`Removed “${it.title}”.`);
    return;
  }
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(it.jobId)}/tracks/${it.index}`, {
      method: "DELETE",
    });
    if (PL.preview && PL.preview.key === it.key) stopPreview();
    if (window.syncLibraryFromJob) window.syncLibraryFromJob(job);
    toast(`Deleted “${it.title}”.`);
  } catch (e) {
    toast(e.message, true);
  }
}

function syncPlaylistSnap() {
  const list = $("#playlist-list");
  const viewport = list?.closest(".playlist-viewport");
  if (!list?.closest(".playlist-lcd")) return;
  const h = list.clientHeight;
  if (h < 8) return;
  const rowH = 34;
  list.style.setProperty("--pl-snap-h", `${rowH}px`);
  viewport?.style.setProperty("--pl-peek", `${Math.max(0, h - rowH)}px`);
}

function playlistRowStep(list) {
  return parseFloat(getComputedStyle(list).getPropertyValue("--pl-snap-h")) || 34;
}

function updatePlaylistScrollHints() {
  const list = $("#playlist-list");
  const viewport = list?.closest(".playlist-viewport");
  const lcd = $("#playlist-lcd");
  if (!list || !viewport) return;
  const canUp = list.scrollTop > 2;
  const canDown = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
  viewport.classList.toggle("pl-can-up", canUp);
  viewport.classList.toggle("pl-can-down", canDown);
  lcd?.classList.toggle("pl-has-more", list.querySelectorAll(".pl-row").length > 1);
}

function wirePlMarquee(cell) {
  if (!cell || cell.dataset.marqueeReady) return;
  const text = cell.textContent.trim();
  if (!text) return;
  cell.dataset.marqueeReady = "1";
  cell.classList.remove("pl-marquee");
  cell.textContent = text;
  requestAnimationFrame(() => {
    if (cell.scrollWidth <= cell.clientWidth + 1) return;
    cell.classList.add("pl-marquee");
    cell.innerHTML = `<span class="pl-scroll">${escapeHtml(text)}</span>`;
    requestAnimationFrame(() => {
      const inner = cell.querySelector(".pl-scroll");
      if (!inner) return;
      const shift = inner.scrollWidth - cell.clientWidth;
      if (shift <= 1) {
        cell.classList.remove("pl-marquee");
        cell.textContent = text;
        return;
      }
      inner.style.setProperty("--pl-marquee-shift", `${shift}px`);
      inner.style.setProperty("--pl-marquee-dur", `${Math.min(16, Math.max(5, shift / 10))}s`);
    });
  });
}

function wirePlaylistMarquees(list = $("#playlist-list")) {
  if (!list?.closest(".playlist-lcd")) return;
  list.querySelectorAll(".pl-row .pl-title").forEach((cell) => {
    delete cell.dataset.marqueeReady;
    wirePlMarquee(cell);
  });
}

function playlistSnapStep(list, dir) {
  const slot = playlistRowStep(list);
  const max = Math.max(0, list.scrollHeight - list.clientHeight);
  const next = Math.max(0, Math.min(max, list.scrollTop + dir * slot));
  list.scrollTo({ top: next, behavior: "smooth" });
}

function playlistWheelStep(list, deltaY) {
  const slot = playlistRowStep(list);
  const threshold = Math.max(48, slot * 1.35);
  if (!list._plWheelAcc) list._plWheelAcc = 0;
  if ((list._plWheelAcc > 0 && deltaY < 0) || (list._plWheelAcc < 0 && deltaY > 0)) {
    list._plWheelAcc = 0;
  }
  list._plWheelAcc += deltaY;
  if (Math.abs(list._plWheelAcc) < threshold) return false;
  const dir = list._plWheelAcc > 0 ? 1 : -1;
  list._plWheelAcc = 0;
  playlistSnapStep(list, dir);
  return true;
}

function finishPlaylistLayout(list = $("#playlist-list")) {
  syncPlaylistSnap();
  wirePlaylistMarquees(list);
  updatePlaylistScrollIndex();
  updatePlaylistScrollHints();
}

function updatePlaylistScrollIndex() {
  const list = $("#playlist-list");
  const countEl = $("#playlist-count");
  if (!list || !countEl) return;
  const rows = list.querySelectorAll(".pl-row");
  if (!rows.length) {
    countEl.textContent = `${PL.items.length} track${PL.items.length === 1 ? "" : "s"}`;
    return;
  }
  const slot = playlistRowStep(list);
  const idx = Math.min(rows.length - 1, Math.max(0, Math.round(list.scrollTop / slot)));
  countEl.textContent = `${String(idx + 1).padStart(2, "0")} / ${String(rows.length).padStart(2, "0")}`;
}

function scrollPlaylistToKey(key) {
  const list = $("#playlist-list");
  if (!list || !key) return;
  const row = list.querySelector(`.pl-row[data-key="${CSS.escape(key)}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderPlaylist() {
  const list = $("#playlist-list");
  if (!PL.items.length) {
    $("#playlist-count").textContent = "0 tracks";
    list.innerHTML = `<div class="playlist-empty muted small">Empty — ＋ Add tracks from Library. Click a row to preview.</div>`;
    updateNextTrackDisplay();
    requestAnimationFrame(() => { finishPlaylistLayout(list); });
    return;
  }
  list.innerHTML = "";
  PL.items.forEach((it, i) => {
    const row = document.createElement("button");
    const isAm = window.AppleMusic && AppleMusic.isItem(it);
    const isSp = window.Spotify && Spotify.isItem(it);
    row.className = "pl-row" + (Object.values(PL.deckKeys).includes(it.key) ? " active" : "") + (isAm ? " am-source" : "") + (isSp ? " sp-source" : "");
    row.dataset.key = it.key;
    row.innerHTML = `
      <span class="pl-act load-deck" title="Load to deck" aria-label="Load to deck">＋</span>
      ${seg7(String(i + 1).padStart(2, "0"), "pl-no")}
      <span class="pl-track">
        <span class="pl-title">${escapeHtml(it.title)}</span>
        <span class="pl-meta">${escapeHtml(it.artist || it.mix)}</span>
      </span>
      <span class="pl-stem-slot" aria-hidden="true"></span>
      ${seg7(fmt(it.end - it.start), "pl-len")}
      <span class="pl-act remove" title="Remove from playlist" aria-label="Remove from playlist">✕</span>`;
    row.title = isAm
      ? `${it.title} — click to preview · ＋ load to deck`
      : isSp
        ? `${it.title} — opens in Spotify (no stem split)`
        : `${it.title} — click to preview · ＋ load to deck`;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".load-deck")) { loadTrackToDeck(it); return; }
      if (e.target.closest(".remove")) { removeFromPlaylist(it.key); return; }
      if (isScrubbing(it)) return;
      togglePreview(it);
    });
    setupPreviewScrub(row, it);
    list.appendChild(row);
    applyPlaylistStemRowUI(row, it);
  });
  updatePreviewButtons();
  updateNextTrackDisplay();
  requestAnimationFrame(() => {
    finishPlaylistLayout(list);
    if (!suppressPlaylistScroll) {
      const activeKey = Object.values(PL.deckKeys).find((k) => PL.items.some((it) => it.key === k));
      if (activeKey) scrollPlaylistToKey(activeKey);
      else if (PL.preview?.key) scrollPlaylistToKey(PL.preview.key);
    }
    updatePlaylistScrollIndex();
  });
}

// ---------- quick preview (no separation) ----------
function stopPreview() {
  if (PL.preview) {
    try { PL.preview.audio.pause(); } catch (_) {}
    PL.preview.audio.src = "";
    PL.preview = null;
  }
  if (window.AppleMusic) AppleMusic.stop();
  document.querySelectorAll(".pl-row.previewing").forEach((r) => {
    r.classList.remove("previewing", "hovering");
    r.style.removeProperty("--prog");
    r.style.removeProperty("--hover");
  });
}

function updatePreviewButtons() {
  document.querySelectorAll(".pl-prev").forEach((b) => {
    const key = b.dataset.key;
    let active = false;
    if (window.AppleMusic && AppleMusic.isPlayingKey(key)) active = true;
    else if (PL.preview && PL.preview.key === key && !PL.preview.audio.paused) active = true;
    b.textContent = active ? "⏸" : "▶";
    b.classList.toggle("on", !!active);
  });
  setPreviewProgress();
}
window.updatePreviewButtons = updatePreviewButtons;

// paint the previewing row(s) as a progress bar
function setPreviewProgress() {
  const p = PL.preview;
  document.querySelectorAll(".pl-row").forEach((row) => {
    const active = p && row.dataset.key === p.key;
    row.classList.toggle("previewing", !!active);
    if (active) {
      const d = p.audio.duration || 0;
      row.style.setProperty("--prog", (d ? p.audio.currentTime / d : 0).toFixed(4));
    } else {
      row.style.removeProperty("--prog");
    }
  });
}

// drag along a row (while it's previewing) to scrub; hovering shows a ghost
// line at the spot the track will skip to.
function setupPreviewScrub(row, it) {
  let scrubbing = false;
  const isLive = () => PL.preview && PL.preview.key === it.key && PL.preview.audio.duration;
  const fracAt = (clientX) => {
    const rect = row.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };
  const seekFrac = (clientX) => {
    if (!isLive()) return;
    const a = PL.preview.audio;
    a.currentTime = fracAt(clientX) * a.duration;
    setPreviewProgress();
  };
  const showHover = (clientX, target) => {
    if (!isLive() || (target && target.closest && target.closest(".pl-act"))) {
      row.classList.remove("hovering");
      return;
    }
    row.style.setProperty("--hover", fracAt(clientX).toFixed(4));
    row.classList.add("hovering");
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pl-act")) return;
    if (!isLive()) return;
    scrubbing = true;
    row.classList.add("scrubbing");
    try { row.setPointerCapture(e.pointerId); } catch (_) {}
    seekFrac(e.clientX);
    e.preventDefault();
  });
  row.addEventListener("pointermove", (e) => {
    if (scrubbing) { seekFrac(e.clientX); showHover(e.clientX, e.target); }
    else showHover(e.clientX, e.target);
  });
  row.addEventListener("pointerleave", () => row.classList.remove("hovering"));
  const end = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    row.classList.remove("scrubbing");
    try { row.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
}

function isScrubbing(it) {
  return PL.preview && PL.preview.key === it.key && !PL.preview.audio.paused;
}

function togglePreview(it) {
  if (window.Spotify && Spotify.isItem(it)) {
    stopPreview();
    Spotify.toggleItem(it);
    return;
  }
  if (window.AppleMusic && AppleMusic.isItem(it)) {
    stopPreview();
    AppleMusic.toggleItem(it).then(updatePreviewButtons).catch((e) => toast(e.message, true));
    return;
  }
  if (PL.preview && PL.preview.key === it.key) {
    const a = PL.preview.audio;
    if (a.paused) a.play().catch(() => {}); else a.pause();
    updatePreviewButtons();
    return;
  }
  stopPreview();
  const a = new Audio(`/api/jobs/${encodeURIComponent(it.jobId)}/region?start=${it.start}&end=${it.end}`);
  PL.preview = { key: it.key, audio: a };
  a.addEventListener("play", updatePreviewButtons);
  a.addEventListener("pause", updatePreviewButtons);
  a.addEventListener("timeupdate", setPreviewProgress);
  a.addEventListener("loadedmetadata", setPreviewProgress);
  a.addEventListener("ended", () => { stopPreview(); updatePreviewButtons(); });
  a.play().catch((e) => toast("Preview failed: " + e.message, true));
  updatePreviewButtons();
}

async function loadTrackToDeck(it, deckId) {
  if (window.Spotify && Spotify.isItem(it)) {
    stopPreview();
    PL.activeKey = it.key;
    renderPlaylist();
    Spotify.playItem(it);
    return;
  }
  if (window.AppleMusic && AppleMusic.isItem(it)) {
    stopPreview();
    PL.activeKey = it.key;
    renderPlaylist();
    AppleMusic.playItem(it).then(updatePreviewButtons).catch((e) => toast(e.message, true));
    toast("Apple Music playback only — load a YouTube mix or local file to split and stem.", false);
    return;
  }
  stopPreview();
  const targetDeck = resolveLoadDeckId(deckId ?? findEmptyDeckId());
  if (PL.deckKeys[targetDeck] === it.key) {
    renderPlaylist();
    return;
  }
  PL.activeKey = it.key;
  PL.deckKeys[targetDeck] = it.key;
  renderPlaylist();
  if (it.jobId) {
    try {
      await api("/api/jobs/adopt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.jobId }),
      });
    } catch (_) { /* job may already be loaded */ }
  }
  window.openStudio(it.jobId, {
    index: it.index, start: it.start, end: it.end, title: it.title,
  }, targetDeck);
}
window.loadTrackToDeck = loadTrackToDeck;

function openTrack(it) {
  loadTrackToDeck(it);
}

// ---------- startup: restore library from analyzed mixes on disk ----------
async function loadLibrary() {
  let items = [];
  try {
    items = await api("/api/cached");
  } catch (e) {
    toast("Could not load library — is the server running?", true);
    renderDownloads();
    return;
  }
  const analyzed = items.filter((it) => it.analyzed || (it.track_list && it.track_list.length));
  let restored = 0;
  for (const it of analyzed) {
    if (it.track_list && it.track_list.length) {
      addMixToDownloads({
        id: it.id,
        source: { title: it.title || "Mix" },
        result: { tracks: it.track_list },
        status: "ready",
      }, { silent: true });
      restored++;
      continue;
    }
    try {
      const job = await api("/api/jobs/adopt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id }),
      });
      if (job.status === "ready" || job.status === "done") {
        addMixToDownloads(job, { silent: true });
        restored++;
      }
    } catch (_) { /* skip broken entry */ }
  }
  if (!restored && analyzed.length) {
    toast("Library mixes found on disk but could not be loaded.", true);
  }
  renderDownloads();
}

// clicking anywhere outside the currently-previewing row stops the preview
document.addEventListener("pointerdown", (e) => {
  if (!PL.preview) return;
  if (e.target.closest(".pl-row.previewing")) return;
  if (e.target.closest("#playlist-list .pl-row")) return;
  stopPreview();
  updatePreviewButtons();
});

checkHealth();
pollResources();
setInterval(pollResources, RESOURCES_POLL_MS);
loadLibrary();
updateNextTrackDisplay();

(function initPlaylistSnap() {
  const list = $("#playlist-list");
  const lcd = $("#playlist-lcd");
  if (!list) return;
  list.addEventListener("scroll", () => {
    updatePlaylistScrollIndex();
    updatePlaylistScrollHints();
  }, { passive: true });
  list.addEventListener("wheel", (e) => {
    if (!list.closest(".playlist-lcd") || !list.querySelector(".pl-row")) return;
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    const stepped = playlistWheelStep(list, e.deltaY);
    if (stepped) e.preventDefault();
  }, { passive: false });
  const onResize = () => finishPlaylistLayout(list);
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(onResize);
    ro.observe(list);
    if (lcd) ro.observe(lcd);
  } else {
    window.addEventListener("resize", onResize);
  }
  requestAnimationFrame(() => requestAnimationFrame(onResize));
})();
