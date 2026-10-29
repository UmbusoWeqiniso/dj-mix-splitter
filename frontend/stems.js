// Stem Studio: separate a track into vocals/drums/bass/other, then play them
// together in sync with per-stem mute/solo/volume, and download any blend.
(function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const mod = (x, m) => ((x % m) + m) % m;
  const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
  const WAVE_PPS = 80;
  const WAVE_WINDOW_SEC = 8;
  // Beat-sync phase tolerance (fraction of one beat). Hysteresis avoids LED flicker.
  const SYNC_PHASE_IN = 0.06;   // enter "in sync" when within ~60 ms @ 100 BPM
  const SYNC_PHASE_OUT = 0.11;  // leave "in sync" only when drift exceeds this
  const SYNC_TEMPO_MIN = 0.8;   // ±20% pitch range (matches tempo slider)
  const SYNC_TEMPO_MAX = 1.2;
  const TEMPO_RESET_MS = 1500;  // smooth pitch return to +0.0% (ease-out)
  const deckTempoFadeRafs = new Map(); // deckId → rAF id (per-deck tempo reset fades)
  const deckTempoUiSilent = new Set(); // suppress range input echo during programmatic UI writes
  const COLORS = {
    vocals: "vocals", kick: "kick", drums: "drums", bass: "bass",
    guitar: "guitar", piano: "piano", synth: "synth", perc: "perc", other: "other",
    instrumental: "other",
    low: "low", mid: "mid", high: "high",
  };
  const STEM_LABELS = {
    vocals: "VOC", kick: "KICK", drums: "DRM", bass: "BASS",
    guitar: "GTR", piano: "KEY", synth: "SYN", perc: "PERC", other: "OTHER",
    instrumental: "INST",
    low: "LO", mid: "MID", high: "HI",
  };

  const XLOW = 250, XHIGH = 3000;
  const MAX_DECKS = 4;
  const MIN_DECKS = 1;

  // --- Stem AudioBuffer cache sizing (strict memory discipline) ---
  // Decoded stem AudioBuffers are huge: a 5-min stereo stem is ~100 MB
  // (300 s × 44.1 kHz × 2 ch × 4 bytes/sample ≈ 106 MB) and a track can carry up
  // to ~8 stems, so ONE cached track pins ≈800 MB of RAM. Left unbounded, the
  // cache grew by ≈800 MB for every distinct track ever loaded → runaway browser
  // RAM. The cap below is derived, not magic:
  //   • We can NEVER evict a track whose buffers are still wired into a loaded
  //     deck, so the unavoidable floor is the number of decks we support
  //     (MAX_DECKS).
  //   • On top of that we retain a few recently-used-but-unloaded tracks so
  //     re-loading a track you just played is instant (no re-fetch/re-decode).
  // Anything past the cap is evicted; a later re-load simply re-decodes it.
  const STEM_CACHE_RECENT = 2;                          // recent unloaded tracks to keep hot
  const STEM_CACHE_MAX = MAX_DECKS + STEM_CACHE_RECENT; // hard cap (worst case ≈ 6 × 800 MB)

  function createDeckState(id) {
    return {
      id,
      jobId: null, track: null, stemId: null,
      duration: 0, stems: {}, order: [],
      playing: false, startCtxTime: 0, offset: 0, playStartedAt: null,
      poll: null, sepStarting: false,
      mode: "stems", timeMode: "elapsed",
      subSuffix: "",
      sets: { stems: null, simple: null },
      fullBuffer: null, sharedInput: null, sharedSource: null, simpleStemSources: null,
      bpm: 0, beatOffset: 0, barLen: 0, loopBars: 4,
      rate: 1, tempoPct: 0, peaks: null,
      loops: {},
      cuePos: 0,
      mainVol: 1, loopVol: 1, mainMuted: false, loopMuted: false, cross: 0.5,
      deckVol: 1, deckMuted: false,
      mainBus: null, loopBus: null, outBus: null,
      stemVisible: {},
      studioErr: null,
      rowsBuilt: { stems: false, simple: false },
      stemsOpen: false,
    };
  }

  const DECK_COLORS = ["", "var(--accent-2)", "var(--magenta)", "var(--accent)", "var(--ok)"];
  const STEM_LEDS = {
    vocals: "#ff5c7a", kick: "#ff4d2e", drums: "#f5a623", bass: "#29a3d3",
    guitar: "#3ddc84", piano: "#ff8a5c", synth: "#9b6bff", perc: "#2fd4c0",
    other: "#ff9f3e", instrumental: "#ff9f3e",
    low: "#ff5a2e", mid: "#ffba2e", high: "#29b6ff",
  };

  const Studio = {
    focusedId: 1,
    nextId: 2,
    deckOrder: [1],
    decks: {},
    ctx: null, master: null,
    masterVol: 1, masterMuted: false,
    fxLoopVol: 1, fxLoopMuted: false,
    raf: null,
    stemCache: new Map(),
    scratch: { deckId: null, lastX: 0, lastT: 0, baseRate: 1 },
    syncAdjustUntil: 0, // performance.now() — follower LEDs show "adjusting" briefly after sync
    syncInFlight: false, // guard: SYNC button is one-shot, never re-entrant
  };

  function stemCacheKey(jobId, track) {
    const quality = window.currentQuality || "high";
    const start = Math.floor(Number(track.start));
    const end = Math.floor(Number(track.end));
    return `${jobId}:${track.index}:${start}:${end}:${quality}`;
  }

  // ---------- LRU discipline for Studio.stemCache ----------
  // The cache is a Map used as an LRU: reads re-insert the entry at the tail
  // (most-recently-used), so Map iteration order runs least→most recent. Writes
  // evict from the head until we are at/under STEM_CACHE_MAX, but a track whose
  // buffers are live on a deck is pinned and skipped.

  /** Keys whose decoded buffers are currently wired into a loaded deck — never evict. */
  function stemCacheKeysInUse() {
    const inUse = new Set();
    Studio.deckOrder.forEach((id) => {
      const d = Studio.decks[id];
      if (d?.track && d.jobId != null) inUse.add(stemCacheKey(d.jobId, d.track));
    });
    return inUse;
  }

  /** Drop an evicted entry's heavy references so its AudioBuffers can be GC'd. */
  function releaseStemCacheEntry(entry) {
    if (!entry?.buffers) return;
    for (const name of Object.keys(entry.buffers)) {
      if (entry.buffers[name]) entry.buffers[name].buffer = null;
    }
    entry.buffers = null;
  }

  /** Evict least-recently-used entries down to the cap, skipping in-use tracks. */
  function evictStemCache() {
    if (Studio.stemCache.size <= STEM_CACHE_MAX) return;
    const inUse = stemCacheKeysInUse();
    for (const key of Studio.stemCache.keys()) {
      if (Studio.stemCache.size <= STEM_CACHE_MAX) break;
      if (inUse.has(key)) continue; // pinned: buffers belong to a loaded deck
      releaseStemCacheEntry(Studio.stemCache.get(key));
      Studio.stemCache.delete(key);
    }
  }

  /** LRU read: fetch an entry and mark it most-recently-used. */
  function stemCacheGet(key) {
    const entry = Studio.stemCache.get(key);
    if (entry === undefined) return undefined;
    Studio.stemCache.delete(key);
    Studio.stemCache.set(key, entry); // move to MRU tail
    return entry;
  }

  /** LRU write: insert at the MRU tail, then evict back down to the cap. */
  function stemCacheSet(key, entry) {
    Studio.stemCache.delete(key);
    Studio.stemCache.set(key, entry);
    evictStemCache();
  }

  function saveStemCache(deckId) {
    const d = getDeck(deckId);
    if (!d.track || d.jobId == null || !d.sets.stems || !d.order.length) return;
    const buffers = {};
    for (const name of d.order) {
      const st = d.stems[name];
      if (!st?.buffer) continue;
      buffers[name] = {
        buffer: st.buffer,
        mute: st.mute,
        solo: st.solo,
        volume: st.volume,
        include: st.include,
      };
    }
    stemCacheSet(stemCacheKey(d.jobId, d.track), {
      buffers,
      order: [...d.order],
      stemId: d.stemId,
      duration: d.duration,
      stemVisible: { ...d.stemVisible },
      bpm: d.bpm || 0,
      beatOffset: d.beatOffset || 0,
    });
  }

  function restoreFromStemCache(deckId, cached, track) {
    const d = getDeck(deckId);
    ensureDeckAudio(deckId);
    d.stemId = cached.stemId;
    d.stemVisible = { ...cached.stemVisible };
    const stems = {};
    for (const name of cached.order) {
      const src = cached.buffers[name];
      if (!src?.buffer) continue;
      const gain = Studio.ctx.createGain();
      gain.connect(d.mainBus);
      stems[name] = {
        buffer: src.buffer,
        gain,
        input: gain,
        source: null,
        mute: src.mute ?? false,
        solo: src.solo ?? false,
        volume: src.volume ?? 1,
        include: src.include ?? true,
      };
    }
    const order = cached.order.filter((n) => stems[n]);
    d.stems = stems;
    d.order = order;
    d.duration = cached.duration;
    d.sets.stems = { stems, order, duration: d.duration };
    d.bpm = cached.bpm || 0;
    d.beatOffset = cached.beatOffset || 0;
    d.barLen = d.bpm ? (4 * 60) / d.bpm : 0;
    d.mode = "stems";
    updateDeckTitle(deckId);
    clearDeckErr(deckId);
    setDeckProgressMsg("", false, deckId);
    hideDeckJobProgress(deckId);
    if (deckId === Studio.focusedId) {
      activateSet("stems");
    } else {
      buildRowPane("stems", deckId);
      syncDeckStemRackUI(deckId);
      updateStemRowsPlaceholder(deckId);
      updateStudioPanels();
    }
    syncDeckTrackProgress(deckId);
    if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
    prefetchSimpleBands(deckId);
    buildDeckPeaks(deckId);
    refreshPlaylistWaveLanes();
    updateLoopBpm(deckId);
    ensureBpm(deckId);
  }

  Studio.decks[1] = createDeckState(1);
  let S = Studio.decks[1];

  function getDeck(id) {
    return Studio.decks[id ?? Studio.focusedId];
  }

  function deckEl(id) {
    return document.querySelector(`.deck[data-deck-id="${id}"]`);
  }

  function $d(sel, id) {
    return deckEl(id)?.querySelector(sel);
  }

  function deckIdFrom(el) {
    return parseInt(el?.closest(".deck")?.dataset.deckId, 10);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let d = res.statusText;
      try { d = (await res.json()).detail || d; } catch (_) {}
      throw new Error(d);
    }
    return res.json();
  }

  async function ensureJobAdopted(jobId) {
    if (!jobId) return;
    try {
      await api("/api/jobs/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId }),
      });
    } catch (_) { /* already in memory or missing on disk */ }
  }

  // ---------- playlist background stem separation ----------
  const playlistStemPolls = new Map();
  const playlistStemWaiters = new Map();

  function findPlaylistItem(key) {
    return window.PL?.items?.find((it) => it.key === key);
  }

  function findPlaylistItemForTrack(jobId, track) {
    const key = `${jobId}:${track.index}`;
    return findPlaylistItem(key);
  }

  function initPlStem(it) {
    if (!it.stem) {
      it.stem = { status: "idle", progress: 0, message: "", stemId: null, error: null };
    }
    return it.stem;
  }

  function isSplittablePlItem(it) {
    if (!it || it.jobId == null) return false;
    if (window.Spotify?.isItem?.(it)) return false;
    if (window.AppleMusic?.isItem?.(it)) return false;
    return true;
  }

  function playlistItemForDeck(deckId) {
    const d = getDeck(deckId);
    if (!d?.track || d.jobId == null) return null;
    const it = findPlaylistItemForTrack(d.jobId, d.track);
    return it && isSplittablePlItem(it) ? it : null;
  }

  /** True while this deck is waiting on stems — show progress on deck LCD (not playlist-only). */
  function deckSepShowsOnDeck(deckId) {
    const d = getDeck(deckId);
    if (d.studioErr) return false;
    if (d.poll) return true;
    const plItem = playlistItemForDeck(deckId);
    if (plItem?.stem) {
      const st = plItem.stem.status;
      if (st === "starting" || st === "running") return true;
    }
    if (d.sepStarting) return true;
    return false;
  }

  function syncDeckSepProgress(deckId) {
    const d = getDeck(deckId);
    if (typeof d.lastSepFrac === "number") {
      applyDeckSepProgress(deckId, d.lastSepFrac, d.lastSepMsg || "Separating…");
      return;
    }
    if (d.poll) return;
    const plItem = playlistItemForDeck(deckId);
    if (!plItem?.stem) return;
    const st = plItem.stem.status;
    if (st !== "starting" && st !== "running") return;
    applyDeckSepProgress(deckId, plItem.stem.progress || 0,
      plItem.stem.message || plStemStatusLabel(plItem.stem) || "Separating…");
  }

  function updateDeckSepInlinePct(deckId, frac) {
    const el = $d(".deck-sep-pct", deckId);
    if (!el) return;
    const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
    const digits = String(pct);
    el.dataset.mask = digits.replace(/[0-9]/g, "8") + "%";
    const inner = el.querySelector(".seg7-v");
    if (inner) inner.textContent = `${digits}%`;
  }

  function applyDeckSepProgress(deckId, frac, msg) {
    const d = getDeck(deckId);
    d.lastSepFrac = frac ?? 0;
    if (msg) d.lastSepMsg = msg;
    initDeckDotLoader(deckId);
    $d(".deck-progress", deckId)?.classList.remove("hidden");
    $d(".deck-sep-pct", deckId)?.classList.remove("hidden");
    setDeckDotProgress(deckId, d.lastSepFrac);
    updateDeckSepInlinePct(deckId, d.lastSepFrac);
    setDeckProgressMsg(d.lastSepMsg || "Separating…", false);
  }

  function clearDeckSepProgress(deckId) {
    const d = getDeck(deckId);
    d.lastSepFrac = null;
    d.lastSepMsg = null;
    $d(".deck-progress", deckId)?.classList.add("hidden");
    $d(".deck-sep-pct", deckId)?.classList.add("hidden");
  }

  function syncDeckSepFromPlItem(it) {
    if (!it?.stem) return;
    let touched = false;
    Studio.deckOrder.forEach((deckId) => {
      const d = getDeck(deckId);
      if (!d?.track || d.jobId !== it.jobId) return;
      if (Number(d.track.index) !== Number(it.index)) return;
      if (d.sets.stems || d.sets.simple) return;
      const st = it.stem.status;
      if (st !== "starting" && st !== "running") return;
      applyDeckSepProgress(deckId, it.stem.progress || 0,
        it.stem.message || plStemStatusLabel(it.stem) || "Separating…");
      touched = true;
    });
    if (touched) {
      Studio.deckOrder.forEach((id) => {
        if (deckSepShowsOnDeck(id)) setDeckPlayState(id);
      });
    }
  }

  function deckAwaitingPlaylistStems(deckId) {
    if (deckHasContent(deckId)) return false;
    const it = playlistItemForDeck(deckId);
    if (!it?.stem) return false;
    return it.stem.status === "starting" || it.stem.status === "running" || it.stem.status === "idle";
  }

  function plStemStatusLabel(stem) {
    if (!stem) return "";
    if (stem.status === "ready") return "Ready";
    if (stem.status === "error") return "Failed";
    if (stem.status === "starting") return "Starting…";
    if (stem.status === "running") {
      const msg = String(stem.message || "");
      if (/queued|waiting/i.test(msg)) return "Queued…";
      if (/analyz|identif|detect/i.test(msg)) return "Analyzing…";
      if (/prepar|check|cache|load/i.test(msg)) return "Preparing…";
      return "Splitting…";
    }
    return "";
  }
  window.plStemStatusLabel = plStemStatusLabel;

  function syncPlStemFromSnapshot(it, sjob) {
    const stem = initPlStem(it);
    stem.stemId = sjob.id || stem.stemId;
    stem.progress = sjob.progress ?? stem.progress;
    stem.message = sjob.message || stem.message;
    if (sjob.status === "ready") {
      stem.status = "ready";
      stem.progress = 1;
      stem.message = sjob.message || "Ready";
      stem.error = null;
      window.autoFillPlaylistToDecks?.();
    } else if (sjob.status === "error") {
      stem.status = "error";
      stem.error = sjob.error || "Separation failed";
      stem.message = stem.error;
    } else if (sjob.status === "running") {
      stem.status = "running";
    }
    window.updatePlaylistStemRow?.(it.key);
    syncDeckSepFromPlItem(it);
  }

  function clearPlaylistStemPoll(key) {
    const id = playlistStemPolls.get(key);
    if (id) {
      clearInterval(id);
      playlistStemPolls.delete(key);
    }
  }

  function notifyPlaylistStemWaiters(key, err = null) {
    const waiters = playlistStemWaiters.get(key) || [];
    playlistStemWaiters.delete(key);
    waiters.forEach(({ resolve, reject }) => {
      if (err) reject(err);
      else resolve();
    });
    if (!err) {
      window.autoFillPlaylistToDecks?.();
    }
  }

  async function requestStemJobForItem(it) {
    await ensureJobAdopted(it.jobId);
    return api(`/api/jobs/${it.jobId}/stems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_index: it.index, start: it.start, end: it.end,
        title: it.title || "", quality: window.currentQuality || "high",
      }),
    });
  }

  function pollPlaylistStem(key) {
    clearPlaylistStemPoll(key);
    const it = findPlaylistItem(key);
    if (!it?.stem?.stemId) return;
    let fails = 0;
    const pollId = setInterval(async () => {
      const live = findPlaylistItem(key);
      if (!live?.stem?.stemId) {
        clearPlaylistStemPoll(key);
        return;
      }
      const stem = live.stem;
      let s;
      try {
        s = await api(`/api/stems/${stem.stemId}`);
        fails = 0;
      } catch (e) {
        fails += 1;
        if (fails >= 8) {
          clearPlaylistStemPoll(key);
          stem.status = "error";
          stem.error = e.message || "Lost connection to stem job";
          stem.message = stem.error;
          window.updatePlaylistStemRow?.(key);
          notifyPlaylistStemWaiters(key, new Error(stem.error));
          if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        }
        return;
      }
      syncPlStemFromSnapshot(live, s);
      if (s.status === "error") {
        clearPlaylistStemPoll(key);
        notifyPlaylistStemWaiters(key, new Error(stem.error || "Separation failed"));
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
      } else if (s.status === "ready") {
        clearPlaylistStemPoll(key);
        notifyPlaylistStemWaiters(key);
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
      }
    }, 700);
    playlistStemPolls.set(key, pollId);
  }

  function waitForPlaylistStem(key) {
    const it = findPlaylistItem(key);
    if (!it?.stem) return Promise.reject(new Error("Track not in playlist"));
    if (it.stem.status === "ready") return Promise.resolve(it.stem);
    if (it.stem.status === "error") {
      return Promise.reject(new Error(it.stem.error || "Separation failed"));
    }
    return new Promise((resolve, reject) => {
      const list = playlistStemWaiters.get(key) || [];
      list.push({ resolve: () => resolve(it.stem), reject });
      playlistStemWaiters.set(key, list);
    });
  }

  window.isPlaylistStemActive = () => {
    if (playlistStemPolls.size) return true;
    return (window.PL?.items || []).some((it) => {
      const s = it.stem;
      return s && (s.status === "starting" || s.status === "running");
    });
  };

  // Controlled stem separation queue: processes 1 heavy stem separation at a time
  // to keep the system fast, responsive, and crash-free even when adding 20+ tracks.
  const stemSplitQueue = [];
  let activeStemSplits = 0;
  const MAX_CONCURRENT_STEM_SPLITS = 1;

  function processStemSplitQueue() {
    if (activeStemSplits >= MAX_CONCURRENT_STEM_SPLITS || !stemSplitQueue.length) return;
    const it = stemSplitQueue.shift();
    const live = findPlaylistItem(it?.key);
    if (!live) {
      processStemSplitQueue();
      return;
    }
    activeStemSplits++;
    runSingleStemSplit(live).finally(() => {
      activeStemSplits = Math.max(0, activeStemSplits - 1);
      processStemSplitQueue();
    });
  }

  async function runSingleStemSplit(it) {
    const stem = initPlStem(it);
    stem.status = "running";
    stem.progress = 0;
    stem.message = "Starting…";
    stem.error = null;
    window.updatePlaylistStemRow?.(it.key);

    try {
      const sjob = await requestStemJobForItem(it);
      const live = findPlaylistItem(it.key);
      if (!live) return;
      const liveStem = initPlStem(live);
      liveStem.stemId = sjob.id;
      if (sjob.status === "ready") {
        syncPlStemFromSnapshot(live, sjob);
        notifyPlaylistStemWaiters(it.key);
        return;
      }
      liveStem.status = "running";
      liveStem.progress = sjob.progress || 0;
      liveStem.message = sjob.message || "Splitting…";
      window.updatePlaylistStemRow?.(it.key);
      await new Promise((resolve) => {
        pollPlaylistStemWithCallback(it.key, resolve);
      });
    } catch (e) {
      const live = findPlaylistItem(it.key);
      if (!live) return;
      const liveStem = initPlStem(live);
      liveStem.status = "error";
      liveStem.error = e.message;
      liveStem.message = e.message;
      window.updatePlaylistStemRow?.(it.key);
      notifyPlaylistStemWaiters(it.key, e);
    }
  }

  function pollPlaylistStemWithCallback(key, onDone) {
    clearPlaylistStemPoll(key);
    const it = findPlaylistItem(key);
    if (!it?.stem?.stemId) {
      onDone?.();
      return;
    }
    let fails = 0;
    const pollId = setInterval(async () => {
      const live = findPlaylistItem(key);
      if (!live?.stem?.stemId) {
        clearPlaylistStemPoll(key);
        onDone?.();
        return;
      }
      const stem = live.stem;
      let s;
      try {
        s = await api(`/api/stems/${stem.stemId}`);
        fails = 0;
      } catch (e) {
        fails += 1;
        if (fails >= 8) {
          clearPlaylistStemPoll(key);
          stem.status = "error";
          stem.error = e.message || "Lost connection to stem job";
          stem.message = stem.error;
          window.updatePlaylistStemRow?.(key);
          notifyPlaylistStemWaiters(key, new Error(stem.error));
          if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
          onDone?.();
        }
        return;
      }
      syncPlStemFromSnapshot(live, s);
      if (s.status === "error") {
        clearPlaylistStemPoll(key);
        notifyPlaylistStemWaiters(key, new Error(stem.error || "Separation failed"));
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        onDone?.();
      } else if (s.status === "ready") {
        clearPlaylistStemPoll(key);
        notifyPlaylistStemWaiters(key);
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        onDone?.();
      }
    }, 800);
    playlistStemPolls.set(key, pollId);
  }

  window.startPlaylistStemSplit = function startPlaylistStemSplit(it) {
    if (!isSplittablePlItem(it)) return;
    const stem = initPlStem(it);
    if (stem.status === "ready") return;

    const cacheKey = stemCacheKey(it.jobId, { index: it.index, start: it.start, end: it.end });
    const memCached = stemCacheGet(cacheKey);
    if (memCached?.stemId) {
      stem.status = "ready";
      stem.progress = 1;
      stem.message = "Ready";
      stem.stemId = memCached.stemId;
      stem.error = null;
      window.updatePlaylistStemRow?.(it.key);
      return;
    }

    if (stem.status === "running" && (playlistStemPolls.has(it.key) || stemSplitQueue.some((x) => x.key === it.key))) {
      return;
    }

    stem.status = "running";
    stem.progress = 0;
    stem.message = "Queued…";
    stem.error = null;
    window.updatePlaylistStemRow?.(it.key);

    if (!stemSplitQueue.some((x) => x.key === it.key)) {
      stemSplitQueue.push(it);
    }
    processStemSplitQueue();
  };

  window.stopPlaylistStemSplit = function stopPlaylistStemSplit(key) {
    const idx = stemSplitQueue.findIndex((x) => x.key === key);
    if (idx >= 0) stemSplitQueue.splice(idx, 1);
    clearPlaylistStemPoll(key);
    notifyPlaylistStemWaiters(key, new Error("Removed from playlist"));
  };

  async function applyPlaylistStemToDeck(deckId) {
    const d = getDeck(deckId);
    const plItem = findPlaylistItemForTrack(d.jobId, d.track);
    if (!plItem || !isSplittablePlItem(plItem)) return false;

    const stem = initPlStem(plItem);
    if (stem.status === "ready" && stem.stemId) {
      d.stemId = stem.stemId;
      const sjob = await api(`/api/stems/${stem.stemId}`);
      await applyStemSnapshot(sjob, deckId, { silent: true });
      return true;
    }

    if (stem.status === "error") {
      stem.status = "idle";
      stem.error = null;
      window.startPlaylistStemSplit(plItem);
    } else if (stem.status === "idle") {
      window.startPlaylistStemSplit(plItem);
    }

    d.stemId = stem.stemId || d.stemId;
    updateStemRowsPlaceholder(deckId);
    applyDeckSepProgress(deckId, stem.progress || 0, stem.message || plStemStatusLabel(stem) || "Separating…");
    updateStudioPanels();

    try {
      await waitForPlaylistStem(plItem.key);
      const readyStem = initPlStem(findPlaylistItem(plItem.key) || plItem);
      d.stemId = readyStem.stemId;
      const sjob = await api(`/api/stems/${readyStem.stemId}`);
      await applyStemSnapshot(sjob, deckId, { silent: true });
      return true;
    } catch (e) {
      setDeckErr(e.message, deckId);
      updateStemRowsPlaceholder(deckId);
      if (!anyDeckWorking() && !window.isPlaylistStemActive()) setLoadStatus(anyDeckPlaying());
      return false;
    }
  }

  async function requestStemJob(deckId) {
    const d = getDeck(deckId);
    const t = d.track;
    await ensureJobAdopted(d.jobId);
    return api(`/api/jobs/${d.jobId}/stems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_index: t.index, start: t.start, end: t.end,
        title: t.title || "", quality: window.currentQuality || "high",
      }),
    });
  }

  async function tryRecoverStems(deckId) {
    const d = getDeck(deckId);
    if (!d?.track || d.jobId == null) return false;
    if (deckId === Studio.focusedId) setDeckProgressMsg("Reconnecting — checking for cached stems…");
    try {
      const sjob = await requestStemJob(deckId);
      d.stemId = sjob.id;
      if (sjob.status === "ready") {
        await applyStemSnapshot(sjob, deckId);
        return true;
      }
      if (sjob.status === "running") {
        pollStems(deckId);
        return true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }

  async function fetchStemAudio(deckId, name, allowRecover = true) {
    const d = getDeck(deckId);
    const res = await fetch(`/api/stems/${d.stemId}/audio/${name}`);
    if (!res.ok) {
      if (allowRecover && (res.status === 404 || res.status === 502 || res.status === 503)) {
        const ok = await tryRecoverStems(deckId);
        if (ok) return fetchStemAudio(deckId, name, false);
      }
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.arrayBuffer();
  }

  function toast(msg, bad) {
    if (bad) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function updateDeckCountUI() {
    const n = Studio.deckOrder.length;
    const el = $("#deck-count");
    if (el) el.textContent = `${n} / ${MAX_DECKS}`;
    const wrap = $("#decks");
    if (wrap) wrap.dataset.deckCount = String(n);
    const addBtn = $("#add-deck");
    if (addBtn) addBtn.disabled = n >= MAX_DECKS;
    Studio.deckOrder.forEach((id) => {
      const rm = $d(".deck-remove", id);
      if (rm) rm.classList.toggle("hidden", n <= MIN_DECKS);
    });
  }

  function updateFocusUI() {
    Studio.deckOrder.forEach((id) => {
      deckEl(id)?.classList.toggle("focused", id === Studio.focusedId);
    });
    window.onStudioFocusDeck?.(Studio.focusedId);
  }

  function updateDeckTitle(id) {
    const d = getDeck(id);
    const titleEl = $d(".deck-title", id);
    if (!titleEl) return;
    if (!d.track) {
      setLcd(titleEl, "No track loaded");
      return;
    }
    setLcd(titleEl, d.track.title || `Track ${d.track.index}`);
  }

  const DECK_DOT_CELLS = 40;

  function initDeckDotLoader(deckId) {
    const bar = $d(".deck-dot-loader", deckId);
    if (!bar || bar.dataset.ready) return;
    bar.innerHTML = "";
    for (let i = 0; i < DECK_DOT_CELLS; i++) {
      const cell = document.createElement("span");
      cell.className = "dot-cell";
      bar.appendChild(cell);
    }
    bar.dataset.ready = "1";
  }

  function setDeckDotPct(deckId, pct) {
    const el = $d(".deck-progress-pct", deckId);
    if (!el) return;
    const n = Math.max(0, Math.min(100, Math.round(pct)));
    const digits = String(n);
    el.dataset.mask = digits.replace(/[0-9]/g, "8") + "%";
    const inner = el.querySelector(".seg7-v");
    if (inner) inner.textContent = `${digits}%`;
  }

  function setDeckDotProgress(deckId, frac) {
    initDeckDotLoader(deckId);
    const bar = $d(".deck-dot-loader", deckId);
    if (!bar) return;
    const pct = Math.max(0, Math.min(100, Math.round((frac || 0) * 100)));
    bar.setAttribute("aria-valuenow", String(pct));
    const cells = bar.querySelectorAll(".dot-cell");
    const lit = Math.round((pct / 100) * cells.length);
    cells.forEach((cell, i) => cell.classList.toggle("on", i < lit));
    setDeckDotPct(deckId, pct);
  }

  function setDeckBusyLed(deckId, on) {
    $d(".deck-busy-led", deckId)?.classList.toggle("on", !!on);
  }

  function setDeckErr(msg, deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    d.studioErr = msg;
    const el = $d(".deck-sub", deckId);
    if (!el) return;
    el.textContent = msg;
    el.classList.add("lcd-err");
    el.classList.remove("hidden");
    $d(".deck-seek", deckId)?.classList.add("hidden");
    clearDeckSepProgress(deckId);
    const st = $d(".deck-play-state", deckId);
    if (st) { st.textContent = "ERROR"; st.className = "deck-play-state lcd-status paused"; }
    setDeckBusyLed(deckId, false);
  }

  function clearDeckErr(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    d.studioErr = null;
    $d(".deck-sub", deckId)?.classList.remove("lcd-err");
    renderDeckSub(deckId);
    syncDeckLcdSeekVisible(deckId);
  }

  function setDeckProgressMsg(msg, isError = false, deckId = Studio.focusedId) {
    const el = $d(".deck-msg", deckId);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("lcd-err", isError);
    el.classList.toggle("muted", !isError);
  }

  function clearDeckSub(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const el = $d(".deck-sub", deckId);
    if (!el || d.studioErr) return;
    el.textContent = "";
    el.classList.remove("lcd-err");
  }

  function deckSeekLane(deckId) {
    return $d(".deck-seek-lane", deckId);
  }

  function syncDeckSeekA11y(deckId) {
    const lane = deckSeekLane(deckId);
    const d = getDeck(deckId);
    if (!lane) return;
    const pos = currentPos(d);
    lane.setAttribute("aria-valuenow", d.duration ? String(Math.round((pos / d.duration) * 1000)) : "0");
  }

  function wireDeckSeek(deckId) {
    const lane = deckSeekLane(deckId);
    if (!lane || lane.dataset.wired) return;
    lane.dataset.wired = "1";
    let dragging = false;

    const scrubTo = (clientX) => {
      if (!ensureDeckPlaybackState(deckId)) return;
      const d = getDeck(deckId);
      if (!d.duration) return;
      seek(seekRatioFromLane(lane, clientX) * d.duration, deckId);
    };

    lane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      lane.classList.add("scrubbing");
      lane.setPointerCapture(e.pointerId);
      scrubTo(e.clientX);
    });
    lane.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      scrubTo(e.clientX);
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      lane.classList.remove("scrubbing");
      lane.releasePointerCapture?.(e.pointerId);
    };
    lane.addEventListener("pointerup", endDrag);
    lane.addEventListener("pointercancel", endDrag);
    lane.addEventListener("keydown", (e) => {
      const d = getDeck(deckId);
      if (!d.duration) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        seek(Math.min(d.duration, currentPos(d) + step), deckId);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek(Math.max(0, currentPos(d) - step), deckId);
      }
    });
  }

  function deckPlaybackDuration(d) {
    if (d.duration > 0) return d.duration;
    if (!d.track) return 0;
    const start = Number(d.track.start);
    const end = Number(d.track.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
    return 0;
  }

  function hideDeckJobProgress(deckId) {
    if (deckSepShowsOnDeck(deckId)) return;
    clearDeckSepProgress(deckId);
  }

  function syncDeckTrackProgress(deckId) {
    hideDeckJobProgress(deckId);
    syncDeckLcdSeekVisible(deckId);
    updateTimeReadout(deckId);
  }

  function syncDeckLcdSeekVisible(deckId) {
    const d = getDeck(deckId);
    const seek = $d(".deck-seek", deckId);
    const sub = $d(".deck-sub", deckId);
    if (!seek) return;
    const busy = deckSepShowsOnDeck(deckId);
    const dur = deckPlaybackDuration(d);
    const showSeek = !d.studioErr && !busy && !!d.track && (dur > 0 || !!d.sets.stems || !!d.sets.simple);
    seek.classList.toggle("hidden", !showSeek);
    if (sub && !d.studioErr) {
      sub.classList.toggle("hidden", showSeek);
      if (!showSeek && !sub.textContent.trim()) {
        sub.textContent = d.track ? "" : "Load a track from the playlist (⏏)";
      }
    }
    if (showSeek) syncDeckSeekBars(deckId);
  }

  function syncAllDeckLcds() {
    Studio.deckOrder.forEach((id) => syncDeckLcdSeekVisible(id));
  }

  function setDeckPlayState(deckId) {
    const d = getDeck(deckId);
    const el = $d(".deck-play-state", deckId);
    if (!el) return;
    if (deckSepShowsOnDeck(deckId)) {
      el.textContent = "SEPARATING";
      el.className = "deck-play-state lcd-status working";
      applyDeckSepProgress(deckId, d.lastSepFrac ?? 0, d.lastSepMsg || "Separating…");
      return;
    }
    $d(".deck-sep-pct", deckId)?.classList.add("hidden");
    el.textContent = d.playing ? "PLAYING" : "PAUSED";
    el.classList.toggle("playing", d.playing);
    el.classList.toggle("paused", !d.playing);
  }

  function setDeckLoadStatus(deckId, working) {
    const d = getDeck(deckId);
    const separating = working || deckSepShowsOnDeck(deckId);
    if (separating) {
      setDeckPlayState(deckId);
      setDeckBusyLed(deckId, true);
      if (working) clearDeckSub(deckId);
      return;
    }
    setDeckBusyLed(deckId, false);
    setDeckPlayState(deckId);
  }

  function refreshAllDeckLoadStatus() {
    Studio.deckOrder.forEach((id) => {
      setDeckLoadStatus(id, deckSepShowsOnDeck(id));
    });
  }

  function updateStudioPanels() {
    Studio.deckOrder.forEach((id) => {
      const showSepProgress = deckSepShowsOnDeck(id);
      const prog = $d(".deck-progress", id);
      if (prog) {
        if (showSepProgress) {
          prog.classList.remove("hidden");
          syncDeckSepProgress(id);
        } else {
          prog.classList.add("hidden");
        }
      }
      setDeckLoadStatus(id, showSepProgress);
      syncDeckTrackProgress(id);
    });
  }

  function syncCueButton(id) {
    const d = getDeck(id);
    const btn = $d(".st-cue", id);
    if (!btn) return;
    const isAtCue = Math.abs(currentPos(d) - (d.cuePos || 0)) < 0.08;
    btn.classList.toggle("at-cue", isAtCue && !d.playing);
  }

  function syncPlayButton(id) {
    const d = getDeck(id);
    const btn = $d(".st-play", id);
    if (!btn) return;
    btn.classList.toggle("playing", !!d.playing);
    btn.innerHTML = transportIconSvg(d.playing ? "pause" : "play");
    syncCueButton(id);
  }

  function syncMuteAllButton(id) {
    const btn = $d(".st-muteall", id);
    if (!btn) return;
    const muted = allMuted();
    btn.innerHTML = transportIconSvg(muted ? "muteOff" : "muteOn");
    btn.title = muted ? "Unmute all" : "Mute all";
    btn.classList.toggle("on", muted);
  }

  function setDeckStatus(msg, isError = false, deckId = Studio.focusedId) {
    const el = $d(".deck-status", deckId);
    if (!el) return;
    if (!msg) {
      el.textContent = "";
      el.classList.add("hidden");
      el.classList.remove("lcd-err");
      return;
    }
    el.textContent = msg;
    el.classList.toggle("lcd-err", isError);
    el.classList.remove("hidden");
  }

  function anyDeckWorking() {
    return Studio.deckOrder.some((id) => !!getDeck(id).poll);
  }

  function anyDeckPlaying() {
    return Studio.deckOrder.some((id) => getDeck(id).playing);
  }

  function anyDeckLoopsActive() {
    return Studio.deckOrder.some((id) => Object.keys(getDeck(id).loops).length > 0);
  }

  function stopRaf() {
    if (Studio.raf) {
      cancelAnimationFrame(Studio.raf);
      Studio.raf = null;
    }
  }

  function syncAudioContextPower() {
    if (!Studio.ctx) return;
    const needActive = anyDeckPlaying() || anyDeckLoopsActive();
    if (needActive) {
      if (Studio.ctx.state === "suspended") Studio.ctx.resume();
    } else if (Studio.ctx.state === "running") {
      Studio.ctx.suspend();
    }
  }

  function deckHasContent(id) {
    const d = getDeck(id);
    return !!(d.sets.stems || d.sets.simple);
  }

  function seekRatioFromLane(lane, clientX) {
    const rect = lane.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function ensureRafRunning() {
    if (!anyDeckPlaying() && Studio.scratch.deckId == null) {
      stopRaf();
      updateUI();
      return;
    }
    if (!Studio.raf) updateUI();
  }

  // ---------- playlist live deck waves (scratch / tempo / sync) ----------
  const WAVE_DECK_COLORS = ["", "#27dfe0", "#ff4d8d", "#ff9f3e", "#46e08a"];

  function buildDeckPeaks(deckId) {
    const d = getDeck(deckId);
    const buf = d.sets.stems?.stems?.[d.order[0]]?.buffer
      || d.sets.stems?.stems?.[d.sets.stems?.order?.[0]]?.buffer;
    if (!buf) { d.peaks = null; return; }
    const ch = buf.getChannelData(0);
    const n = Math.max(1, Math.round(buf.duration * WAVE_PPS));
    const peaks = new Float32Array(n);
    const step = ch.length / n;
    let gmax = 1e-6;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step);
      const b = Math.floor((i + 1) * step);
      let mx = 0;
      for (let j = a; j < b; j++) { const v = Math.abs(ch[j]); if (v > mx) mx = v; }
      peaks[i] = mx;
      if (mx > gmax) gmax = mx;
    }
    for (let i = 0; i < n; i++) peaks[i] /= gmax;
    d.peaks = peaks;
  }

  function deckWaveLaneEl(deckId) {
    return document.querySelector(`.pl-wave-lane[data-deck-id="${deckId}"]`);
  }

  function refreshPlaylistWaveLanes() {
    const host = $("#playlist-wave-lanes");
    if (!host) return;
    const live = Studio.deckOrder.filter((id) => {
      const d = getDeck(id);
      return d.track && d.duration > 0;
    });
    host.querySelectorAll(".pl-wave-lane").forEach((lane) => {
      const id = parseInt(lane.dataset.deckId, 10);
      if (!live.includes(id)) lane.remove();
    });
    const empty = host.querySelector(".playlist-waves-empty");
    if (!live.length) {
      if (!empty) {
        host.innerHTML = `<p class="playlist-waves-empty muted small">Load &amp; play a deck — drag the wave to scratch</p>`;
      }
      updatePlaylistSyncStatus();
      return;
    }
    empty?.remove();
    live.forEach((deckId) => {
      if (deckWaveLaneEl(deckId)) return;
      const lane = document.createElement("div");
      lane.className = "pl-wave-lane";
      lane.dataset.deckId = String(deckId);
      lane.innerHTML = `
        <span class="pl-wave-tag">D${deckId}</span>
        <div class="deck-wave-wrap">
          <canvas class="deck-wave pl-deck-wave" aria-label="Deck ${deckId} waveform"></canvas>
        </div>`;
      host.appendChild(lane);
      wirePlaylistWaveLane(deckId);
      syncDeckTempoUI(deckId);
    });
    updatePlaylistSyncStatus();
  }

  function applyDeckPlaybackRateLive(d) {
    const r = d.rate || 1;
    d.simpleStemSources?.forEach((s) => { if (s.playbackRate) s.playbackRate.value = r; });
    if (d.sharedSource?.playbackRate) d.sharedSource.playbackRate.value = r;
    d.order.forEach((n) => {
      const s = d.stems[n]?.source;
      if (s?.playbackRate) s.playbackRate.value = r;
    });
  }

  function syncDeckTempoUI(deckId) {
    const d = getDeck(deckId);
    const pct = d?.tempoPct || 0;
    const tempo = $d(".deck-tempo", deckId);
    const rateEl = $d(".deck-tempo-rate", deckId);
    deckTempoUiSilent.add(deckId);
    if (tempo) tempo.value = String(pct);
    if (rateEl) rateEl.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    // Defer clearing so programmatic slider writes cannot echo into input handlers.
    queueMicrotask(() => deckTempoUiSilent.delete(deckId));
  }

  function cancelDeckTempoFade(deckId) {
    const raf = deckTempoFadeRafs.get(deckId);
    if (raf == null) return;
    cancelAnimationFrame(raf);
    deckTempoFadeRafs.delete(deckId);
  }

  function cancelAllDeckTempoFades() {
    Studio.deckOrder.forEach((id) => cancelDeckTempoFade(id));
  }

  function resetDeckTempoSmooth(deckId) {
    const d = getDeck(deckId);
    if (!d || Math.abs(d.tempoPct || 0) < 0.05) return;
    cancelDeckTempoFade(deckId);
    const startPct = d.tempoPct;
    const t0 = performance.now();
    const tick = (now) => {
      if (!deckTempoFadeRafs.has(deckId)) return;
      const t = Math.min(1, (now - t0) / TEMPO_RESET_MS);
      const eased = 1 - (1 - t) ** 2; // ease-out quad
      setDeckTempo(deckId, startPct * (1 - eased), { live: true, fromFade: true });
      if (t < 1) {
        deckTempoFadeRafs.set(deckId, requestAnimationFrame(tick));
      } else {
        deckTempoFadeRafs.delete(deckId);
        setDeckTempo(deckId, 0, { live: true, fromFade: true });
        updatePlaylistSyncStatus();
      }
    };
    deckTempoFadeRafs.set(deckId, requestAnimationFrame(tick));
  }

  function setDeckTempo(deckId, pct, opts = {}) {
    const d = getDeck(deckId);
    if (!d) return;
    if (!opts.fromFade) cancelDeckTempoFade(deckId);
    const nextRate = 1 + pct / 100;
    // Idempotent: repeated identical writes must not re-anchor playback (RAF/fade/input echo).
    if (!opts.fromFade
      && Math.abs((d.tempoPct || 0) - pct) < 0.001
      && Math.abs((d.rate || 1) - nextRate) < 0.0001) {
      return;
    }
    const prevRate = d.rate || 1;
    const pos = (d.playing && Studio.ctx)
      ? Math.min(d.duration || 0, d.offset + (Studio.ctx.currentTime - d.startCtxTime) * prevRate)
      : d.offset;
    d.tempoPct = pct;
    d.rate = nextRate;
    syncDeckTempoUI(deckId);
    updateLoopBpm(deckId);
    if (d.playing) {
      if (opts.live) {
        d.offset = pos;
        d.startCtxTime = Studio.ctx.currentTime;
        applyDeckPlaybackRateLive(d);
      } else {
        stopSources(d);
        d.offset = pos;
        startSources(d);
        d.playing = true;
        syncPlayButton(deckId);
      }
    }
  }

  function setDeckScratchRate(deckId, rate) {
    cancelDeckTempoFade(deckId);
    const d = getDeck(deckId);
    d.rate = clampN(rate, 0.25, 2);
    if (d.playing) applyDeckPlaybackRateLive(d);
  }

  function deckBeatPhase(d) {
    if (!d.bpm) return 0;
    const interval = 60 / d.bpm;
    return mod(currentPos(d) - d.beatOffset, interval) / interval;
  }

  function decksPhaseDelta(deckId, refId) {
    const d = getDeck(deckId);
    const ref = getDeck(refId);
    if (!d.bpm || !ref.bpm) return 1;
    let diff = deckBeatPhase(ref) - deckBeatPhase(d);
    diff = diff - Math.round(diff);
    return Math.abs(diff);
  }

  /** Among playing decks with BPM, pick longest continuous play (earliest playStartedAt). */
  function longestPlayingDeckId(playingIds) {
    if (!playingIds.length) return null;
    let best = playingIds[0];
    let bestStart = getDeck(best).playStartedAt ?? Infinity;
    for (let i = 1; i < playingIds.length; i++) {
      const id = playingIds[i];
      const start = getDeck(id).playStartedAt ?? Infinity;
      if (start < bestStart || (start === bestStart && id < best)) {
        best = id;
        bestStart = start;
      }
    }
    return best;
  }

  function syncDeckToReference(deckId, refId, silent = false) {
    const d = getDeck(deckId);
    const ref = getDeck(refId);
    if (!d?.bpm || !ref?.bpm) {
      if (!silent) setDeckStatus("Need BPM on both decks to sync.", true, deckId);
      return false;
    }
    const targetEff = ref.bpm * (ref.rate || 1);
    // Prefer half/double BPM when that lands closer to 1.0 within ±20%.
    let rate = targetEff / d.bpm;
    for (const cand of [targetEff / (d.bpm * 2), targetEff / (d.bpm / 2)]) {
      if (cand < SYNC_TEMPO_MIN || cand > SYNC_TEMPO_MAX) continue;
      if (Math.abs(Math.log(cand)) < Math.abs(Math.log(rate))) rate = cand;
    }
    rate = clampN(rate, SYNC_TEMPO_MIN, SYNC_TEMPO_MAX);
    const targetPct = (rate - 1) * 100;
    // One-shot absolute rate from base BPM — never compound against d.rate.
    setDeckTempo(deckId, targetPct, { live: true });

    // Phase-align only when both decks are playing (match Serato/VDJ behavior).
    // Must actually seek audio — updating offset alone leaves sources out of phase.
    if (ref.playing && d.playing && Studio.ctx) {
      const intD = 60 / d.bpm;
      const posD = currentPos(d);
      const posO = currentPos(ref);
      const phaseO = mod(posO - ref.beatOffset, 60 / ref.bpm) / (60 / ref.bpm);
      const phaseD = mod(posD - d.beatOffset, intD) / intD;
      let diff = phaseO - phaseD;
      diff = diff - Math.round(diff);
      const aligned = clampN(posD + diff * intD, 0, d.duration);
      if (Math.abs(aligned - posD) > 0.002) {
        seek(aligned, deckId);
      }
    }
    if (!silent) setDeckStatus(`Synced to deck ${refId}.`, false, deckId);
    return true;
  }

  async function masterSyncAllDecks() {
    if (Studio.syncInFlight) return;
    Studio.syncInFlight = true;
    const status = $("#pl-sync-status");
    cancelAllDeckTempoFades();
    const playing = Studio.deckOrder.filter((id) => {
      const d = getDeck(id);
      return d.playing && d.duration > 0;
    });
    const loaded = Studio.deckOrder.filter((id) => {
      const d = getDeck(id);
      return d.track && d.duration > 0;
    });
    try {
      if (!playing.length) {
        if (status) status.textContent = "NO PLAYING DECKS";
        status?.classList.remove("sync-ok");
        status?.classList.add("sync-warn");
        updatePlaylistSyncStatus();
        return;
      }
      await Promise.all(loaded.map((id) => ensureBpm(id)));

      const playingWithBpm = playing.filter((id) => getDeck(id).bpm > 0);
      if (!playingWithBpm.length) {
        if (status) status.textContent = "NEED BPM ON MASTER";
        status?.classList.remove("sync-ok");
        status?.classList.add("sync-warn");
        updatePlaylistSyncStatus();
        return;
      }
      const refId = longestPlayingDeckId(playingWithBpm);
      const ref = getDeck(refId);
      const targets = loaded.filter((id) => {
        if (id === refId) return false;
        return getDeck(id).bpm > 0;
      });
      if (!targets.length) {
        if (status) status.textContent = "ONE DECK WITH BPM";
        status?.classList.remove("sync-ok");
        status?.classList.add("sync-warn");
        updatePlaylistSyncStatus();
        return;
      }
      let n = 1;
      targets.forEach((id) => {
        if (syncDeckToReference(id, refId, true)) n++;
      });
      Studio.syncAdjustUntil = performance.now() + 300;
      if (status) {
        const eff = ref.bpm * (ref.rate || 1);
        status.textContent = `SYNCED ${n} DECKS · D${refId} · ${Math.round(eff)} BPM`;
        status.classList.add("sync-ok");
        status.classList.remove("sync-warn");
      }
      updatePlaylistSyncStatus();
      ensureRafRunning();
    } finally {
      Studio.syncInFlight = false;
    }
  }

  function deckSyncLedState(deckId, refId, delta) {
    const led = $d(".deck-sync-led", deckId);
    if (!led) return;
    const adjusting = deckId !== refId && performance.now() < Studio.syncAdjustUntil;
    led.classList.toggle("adjusting", adjusting);
    if (adjusting) {
      led.classList.remove("in-sync", "out-sync");
      return;
    }
    const wasIn = led.classList.contains("in-sync");
    const inSync = wasIn ? delta <= SYNC_PHASE_OUT : delta <= SYNC_PHASE_IN;
    led.classList.toggle("in-sync", inSync);
    led.classList.toggle("out-sync", !inSync);
  }

  function updatePlaylistSyncStatus() {
    const playing = Studio.deckOrder.filter((id) => getDeck(id).playing && getDeck(id).bpm);
    const refId = longestPlayingDeckId(playing);
    Studio.deckOrder.forEach((deckId) => {
      const led = $d(".deck-sync-led", deckId);
      if (!led) return;
      const d = getDeck(deckId);
      if (!d.bpm || !refId || playing.length < 1) {
        led.classList.remove("in-sync", "out-sync", "adjusting");
        return;
      }
      if (deckId === refId) {
        led.classList.remove("adjusting", "out-sync");
        led.classList.add("in-sync");
        return;
      }
      if (playing.length < 2 || !d.playing) {
        // Tempo may be matched but phase is only meaningful when both play.
        led.classList.remove("in-sync", "out-sync", "adjusting");
        return;
      }
      deckSyncLedState(deckId, refId, decksPhaseDelta(deckId, refId));
    });
    const status = $("#pl-sync-status");
    if (!status || playing.length < 2) return;
    if (performance.now() < Studio.syncAdjustUntil) {
      status.textContent = "SYNCING…";
      status.classList.remove("sync-ok");
      status.classList.add("sync-warn");
      return;
    }
    const allOk = playing.every((id) => id === refId || decksPhaseDelta(id, refId) <= SYNC_PHASE_IN);
    if (allOk) {
      status.textContent = "IN SYNC";
      status.classList.add("sync-ok");
      status.classList.remove("sync-warn");
    } else {
      status.textContent = "ALIGN BEATS";
      status.classList.remove("sync-ok");
      status.classList.add("sync-warn");
    }
  }

  function drawPlaylistDeckWave(deckId) {
    const d = getDeck(deckId);
    const lane = deckWaveLaneEl(deckId);
    const canvas = lane?.querySelector(".pl-deck-wave");
    if (!canvas || !d.track) return;
    const g = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 300;
    const cssH = 52;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const mid = cssH / 2;
    const pos = currentPos(d);
    const t0 = pos - WAVE_WINDOW_SEC / 2;
    const t1 = pos + WAVE_WINDOW_SEC / 2;
    const pxPerSec = cssW / WAVE_WINDOW_SEC;
    const accent = WAVE_DECK_COLORS[deckId] || WAVE_DECK_COLORS[1];

    if (d.bpm) {
      const interval = 60 / d.bpm;
      let k = Math.ceil((t0 - d.beatOffset) / interval);
      for (let tb = d.beatOffset + k * interval; tb <= t1; tb += interval, k++) {
        const x = (tb - pos) * pxPerSec + cssW / 2;
        const downbeat = mod(k, 4) === 0;
        g.strokeStyle = downbeat ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.1)";
        g.lineWidth = downbeat ? 1.5 : 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, cssH);
        g.stroke();
      }
    }

    if (d.peaks) {
      g.fillStyle = accent;
      const i0 = Math.max(0, Math.floor(t0 * WAVE_PPS));
      const i1 = Math.min(d.peaks.length - 1, Math.ceil(t1 * WAVE_PPS));
      const bw = Math.max(1, pxPerSec / WAVE_PPS);
      for (let i = i0; i <= i1; i++) {
        const tt = i / WAVE_PPS;
        const x = (tt - pos) * pxPerSec + cssW / 2;
        const h = d.peaks[i] * (cssH * 0.44);
        g.fillRect(x, mid - h, bw, h * 2);
      }
    }

    g.strokeStyle = "rgba(255,255,255,0.92)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cssW / 2, 0);
    g.lineTo(cssW / 2, cssH);
    g.stroke();
  }

  function wirePlaylistWaveLane(deckId) {
    const lane = deckWaveLaneEl(deckId);
    const canvas = lane?.querySelector(".pl-deck-wave");
    if (!lane || !canvas || canvas.dataset.wired) return;
    canvas.dataset.wired = "1";

    let dragging = false;
    let lastX = 0;
    let lastT = 0;

    const endScratch = () => {
      if (!dragging) return;
      dragging = false;
      lane.classList.remove("scrubbing");
      Studio.scratch.deckId = null;
      const d = getDeck(deckId);
      setDeckTempo(deckId, d.tempoPct || 0, { live: true });
      ensureRafRunning();
    };

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      cancelDeckTempoFade(deckId);
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      dragging = true;
      lane.classList.add("scrubbing");
      lastX = e.clientX;
      lastT = performance.now();
      const d = getDeck(deckId);
      Studio.scratch.deckId = deckId;
      Studio.scratch.baseRate = d.rate || 1;
      canvas.setPointerCapture(e.pointerId);
      ensureRafRunning();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const d = getDeck(deckId);
      const now = performance.now();
      const dx = e.clientX - lastX;
      const dt = Math.max(1, now - lastT);
      const rect = canvas.getBoundingClientRect();
      const pxPerSec = rect.width / WAVE_WINDOW_SEC;
      const deltaSec = dx / pxPerSec;
      const vel = dx / dt;
      const pos = d.playing ? currentPos(d) : d.offset;
      const newPos = clampN(pos + deltaSec, 0, d.duration || 0);

      if (Math.abs(vel) > 0.08 && !e.shiftKey) {
        if (!d.playing && d.duration > 0) {
          d.offset = newPos;
          play(deckId);
        }
        setDeckScratchRate(deckId, vel * 0.035);
        if (d.playing) {
          d.offset = newPos;
          d.startCtxTime = Studio.ctx.currentTime;
        } else {
          d.offset = newPos;
        }
      } else if (Math.abs(deltaSec) > 0.001) {
        if (d.playing) {
          stopSources(d);
          d.playing = false;
          d.offset = newPos;
          play(deckId);
        } else {
          d.offset = newPos;
        }
      }

      lastX = e.clientX;
      lastT = now;
      updateTimeReadout(deckId);
      drawPlaylistDeckWave(deckId);
      updatePlaylistSyncStatus();
    });

    canvas.addEventListener("pointerup", endScratch);
    canvas.addEventListener("pointercancel", endScratch);
  }

  window.masterSyncAllDecks = masterSyncAllDecks;

  function applyMixer() {
    applyDeckMixer(Studio.focusedId);
  }

  function syncMixerUIFromDeck() {
    syncDeckMixerUI();
    updateModeButtons(Studio.focusedId);
    Studio.deckOrder.forEach((id) => syncPlayButton(id));
  }

  function resetMixerUI() {
    Studio.deckOrder.forEach((id) => {
      toggleStemFilterPop(id, false);
      const chips = $d(".deck-stem-filter-chips", id);
      if (chips) chips.innerHTML = "";
    });
    syncFocusedMainLoopUI();
  }

  function setLoadStatus() {
    refreshAllDeckLoadStatus();
  }

  function setStatus(playing) {
    Studio.deckOrder.forEach((id) => setDeckPlayState(id));
  }

  window.isStemCached = function (jobId, track) {
    if (!jobId || !track) return false;
    const key = stemCacheKey(jobId, track);
    return !!stemCacheGet(key);
  };
  window.isPlaylistTrackReady = function (it) {
    if (!it) return false;
    if (window.Spotify && Spotify.isItem(it)) return true;
    if (window.AppleMusic && AppleMusic.isItem(it)) return true;
    if (it.stem && it.stem.status === "ready") return true;
    if (it.jobId && window.isStemCached(it.jobId, it)) return true;
    return false;
  };
  window.isStemSeparationActive = () => anyDeckWorking() || window.isPlaylistStemActive?.();
  window.isStudioPlaybackActive = () => anyDeckPlaying();
  window.getStudioFocusedDeckId = () => Studio.focusedId;
  window.getStudioDeckIds = () => [...Studio.deckOrder];

  const STEM_ICON_SVG = {
    attrs: 'class="stem-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"',
    muteOff: '<path d="M2.5 6.5H4.5L7 4v8L4.5 9.5H2.5V6.5z"/><path d="M10 6.2a3 3 0 010 3.6"/><path d="M11.8 4.5a5.5 5.5 0 010 7"/>',
    muteOn: '<path d="M2.5 6.5H4.5L7 4v8L4.5 9.5H2.5V6.5z"/><path d="M10 5.5l4.5 5M14.5 5.5l-4.5 5"/>',
    solo: '<path d="M4.5 8.5V6.5a3.5 3.5 0 017 0v2"/><rect x="3" y="8.5" width="2.5" height="4" rx="0.8"/><rect x="10.5" y="8.5" width="2.5" height="4" rx="0.8"/>',
    mic: '<rect x="6" y="2.8" width="4" height="6.2" rx="2"/><path d="M4.2 8.2a3.8 3.8 0 007.6 0"/><path d="M8 12v1.8"/><path d="M5.8 13.8h4.4"/>',
    loop: '<path d="M3.5 5.5v5"/><path d="M12.5 10.5v-5"/><path d="M5.8 5.5h2.2l-1.4-1.3"/><path d="M10.2 10.5H8l1.4 1.3"/>',
  };

  const TRANSPORT_ICON_SVG = {
    attrs: 'class="tr-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"',
    play: '<path d="M5.5 4.2l6.2 3.8-6.2 3.8V4.2z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M5 4.5h2.2v7H5zM8.8 4.5h2.2v7H8.8z" fill="currentColor" stroke="none"/>',
    reset: '<path d="M3.5 5v8"/><path d="M8 5v8"/><path d="M12.5 5v8"/><path d="M2.3 6.2h2.4"/><path d="M6.8 6.2h2.4"/><path d="M11.3 6.2h2.4"/>',
  };

  function stemSoloIcon(name) {
    return stemIconSvg(name === "vocals" ? "mic" : "solo");
  }

  function stemIconSvg(kind) {
    const body = STEM_ICON_SVG[kind];
    return body ? `<svg ${STEM_ICON_SVG.attrs}>${body}</svg>` : "";
  }

  function stemLoopIcon() {
    return stemIconSvg("loop");
  }

  function transportIconSvg(kind) {
    if (kind === "muteOff" || kind === "muteOn") {
      return stemIconSvg(kind).replace('class="stem-icon"', 'class="tr-icon"').replace('width="14" height="14"', 'width="20" height="20"');
    }
    const body = TRANSPORT_ICON_SVG[kind];
    return body ? `<svg ${TRANSPORT_ICON_SVG.attrs}>${body}</svg>` : "";
  }

  function initTransportIcons(id) {
    const reset = $d(".st-reset", id);
    if (reset) reset.innerHTML = transportIconSvg("reset");
    syncPlayButton(id);
    if (id === Studio.focusedId) syncMuteAllButton(id);
    else {
      const muteBtn = $d(".st-muteall", id);
      if (muteBtn) muteBtn.innerHTML = transportIconSvg("muteOn");
    }
  }

  function stemMuteIcon(muted) {
    return stemIconSvg(muted ? "muteOn" : "muteOff");
  }

  function syncStemMuteIcon(btn, muted) {
    if (btn) btn.innerHTML = stemMuteIcon(!!muted);
  }

  function rdeckMuteIcon(isMuted) {
    return stemIconSvg(isMuted ? "muteOn" : "muteOff").replace('width="14" height="14"', 'width="16" height="16"');
  }

  function syncRdeckMuteIcon(btn, isMuted) {
    if (btn) btn.innerHTML = rdeckMuteIcon(!!isMuted);
  }

  window.openStudio = async function (jobId, track, deckId = Studio.focusedId) {
    if (!Studio.decks[deckId]) deckId = Studio.focusedId;
    const cacheKey = stemCacheKey(jobId, track);
    const memCached = stemCacheGet(cacheKey);
    const d0 = getDeck(deckId);
    const sameTrack = d0.track && stemCacheKey(d0.jobId, d0.track) === cacheKey;
    if (sameTrack && deckHasContent(deckId) && !d0.poll && !d0.sepStarting) {
      if (deckId !== Studio.focusedId) focusDeck(deckId, { autoSep: false });
      S = getDeck(deckId);
      S.studioErr = null;
      $d(".deck-sub", deckId)?.classList.remove("lcd-err");
      $("#studio").classList.remove("hidden");
      updateDeckTitle(deckId);
      window.updateNextTrackDisplay?.();
      activateSet(S.mode === "simple" && S.sets.simple ? "simple" : "stems");
      return;
    }
    if (memCached) {
      if (deckId !== Studio.focusedId) focusDeck(deckId, { autoSep: false });
      resetDeck(deckId);
      S = getDeck(deckId);
      S.jobId = jobId;
      S.track = track;
      S.studioErr = null;
      $d(".deck-sub", deckId)?.classList.remove("lcd-err");
      setDeckStatus("", false, deckId);
      updateDeckTitle(deckId);
      $("#studio").classList.remove("hidden");
      window.updateNextTrackDisplay?.();
      await restoreFromStemCache(deckId, memCached, track);
      return;
    }
    if (deckId !== Studio.focusedId) focusDeck(deckId, { autoSep: false });
    resetDeck(deckId);
    S = getDeck(deckId);
    S.jobId = jobId;
    S.track = track;
    S.studioErr = null;
    $d(".deck-sub", deckId)?.classList.remove("lcd-err");
    setDeckStatus("", false, deckId);
    updateDeckTitle(deckId);
    syncDeckTrackProgress(deckId);
    $("#studio").classList.remove("hidden");
    window.updateNextTrackDisplay?.();
    await beginStemSeparation(deckId);
    syncDeckTrackProgress(deckId);
  };

  async function applyStemSnapshot(sjob, deckId, opts = {}) {
    const d = getDeck(deckId);
    d.stemId = sjob.id;
    const plItem = findPlaylistItemForTrack(d.jobId, d.track);
    if (plItem) syncPlStemFromSnapshot(plItem, sjob);
    if (!opts.silent) {
      setDeckProgressMsg(sjob.message || "Stems ready.", false, deckId);
      setDeckDotProgress(deckId, 1);
      updateStudioPanels();
    }
    if (deckId === Studio.focusedId) {
      await loadStems(sjob, deckId, opts);
    } else {
      await loadStemsBackground(sjob, deckId);
      syncDeckTrackProgress(deckId);
    }
    if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
    syncDeckTrackProgress(deckId);
  }

  async function beginStemSeparation(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (!d?.track || d.jobId == null) {
      setDeckErr("Missing track data — load again from the playlist (⏏).", deckId);
      updateStemRowsPlaceholder(deckId);
      return false;
    }
    if (d.poll || d.sepStarting) return true;

    const memCached = stemCacheGet(stemCacheKey(d.jobId, d.track));
    if (memCached) {
      restoreFromStemCache(deckId, memCached, d.track);
      return true;
    }

    const plItem = findPlaylistItemForTrack(d.jobId, d.track);
    if (plItem && isSplittablePlItem(plItem)) {
      d.sepStarting = true;
      try {
        return await applyPlaylistStemToDeck(deckId);
      } finally {
        d.sepStarting = false;
      }
    }

    d.sepStarting = true;
    setLoadStatus(true);
    setDeckProgressMsg("Checking stem cache…", false, deckId);

    try {
      const sjob = await requestStemJob(deckId);
      if (sjob.status === "ready") {
        setDeckProgressMsg(sjob.message || "Loaded cached stems.", false, deckId);
        setDeckDotProgress(deckId, 1);
        $d(".deck-progress", deckId)?.classList.add("hidden");
        updateStudioPanels();
        await applyStemSnapshot(sjob, deckId);
        return true;
      }
      setDeckProgressMsg("Starting stem separation…", false, deckId);
      applyDeckSepProgress(deckId, 0, "Starting stem separation…");
      updateStudioPanels();
      updateStemRowsPlaceholder(deckId);
      d.stemId = sjob.id;
      pollStems(deckId);
      return true;
    } catch (e) {
      const recovered = await tryRecoverStems(deckId);
      if (!recovered) {
        setDeckProgressMsg(e.message, true, deckId);
        setDeckErr(e.message, deckId);
        updateStudioPanels();
        updateStemRowsPlaceholder(deckId);
      }
      if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
      return false;
    } finally {
      d.sepStarting = false;
    }
  }

  window.retryStemSeparation = (deckId = Studio.focusedId) => beginStemSeparation(deckId);

  function pollStems(deckId) {
    const d = getDeck(deckId);
    clearInterval(d.poll);
    d.pollFails = 0;
    d.poll = setInterval(async () => {
      let s;
      try {
        s = await api(`/api/stems/${d.stemId}`);
        d.pollFails = 0;
      } catch (e) {
        d.pollFails = (d.pollFails || 0) + 1;
        if (d.pollFails >= 8) {
          clearInterval(d.poll);
          d.poll = null;
          const recovered = await tryRecoverStems(deckId);
          if (!recovered) {
            const err = e.message || "Lost connection to stem job";
            setDeckProgressMsg(err, true, deckId);
            setDeckErr(err, deckId);
            updateStudioPanels();
            updateStemRowsPlaceholder(deckId);
          }
          if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        }
        return;
      }
      setDeckDotProgress(deckId, s.progress || 0);
      d.lastSepFrac = s.progress || 0;
      d.lastSepMsg = s.message || "";
      applyDeckSepProgress(deckId, d.lastSepFrac, d.lastSepMsg);
      updateStudioPanels();
      const plItem = findPlaylistItemForTrack(d.jobId, d.track);
      if (plItem) syncPlStemFromSnapshot(plItem, s);
      if (s.status === "error") {
        clearInterval(d.poll);
        d.poll = null;
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        const err = s.error || "Separation failed";
        setDeckProgressMsg(err, true, deckId);
        setDeckErr(err, deckId);
        updateStudioPanels();
      } else if (s.status === "ready") {
        clearInterval(d.poll);
        d.poll = null;
        d.stemId = s.id || d.stemId;
        if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
        updateStudioPanels();
        if (deckId === Studio.focusedId) {
          loadStems(s, deckId);
        } else {
          loadStemsBackground(s, deckId);
        }
      }
    }, 700);
  }

  async function loadStemsBackground(snap, deckId) {
    const d = getDeck(deckId);
    ensureDeckAudio(deckId);
    const order = snap.order && snap.order.length ? snap.order : Object.keys(snap.stems);
    const stems = {};
    let duration = 0;
    for (const name of order) {
      try {
        const buf = await fetchStemAudio(deckId, name);
        const audioBuf = await Studio.ctx.decodeAudioData(buf);
        const gain = Studio.ctx.createGain();
        gain.connect(d.mainBus);
        stems[name] = { buffer: audioBuf, gain, input: gain, source: null, mute: false, solo: false, volume: 1, include: true };
        if (d.stemVisible[name] === undefined) d.stemVisible[name] = true;
        duration = Math.max(duration, audioBuf.duration);
      } catch (_) { /* skip failed stem */ }
    }
    d.sets.stems = { stems, order: order.filter((n) => stems[n]), duration };
    d.stems = stems;
    d.order = order.filter((n) => stems[n]);
    d.duration = duration;
    d.mode = "stems";
    updateDeckTitle(deckId);
    prefetchSimpleBands(deckId);
    if (deckId === Studio.focusedId) activateSet("stems");
    else {
      buildRowPane("stems", deckId);
      syncDeckStemRackUI(deckId);
      updateStemRowsPlaceholder(deckId);
      updateStudioPanels();
    }
    buildDeckPeaks(deckId);
    refreshPlaylistWaveLanes();
    if (!anyDeckWorking()) setLoadStatus(anyDeckPlaying());
    saveStemCache(deckId);
    updateLoopBpm(deckId);
    ensureBpm(deckId);
  }

  function renderDeckSub(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (d.studioErr) return;
    const seek = $d(".deck-seek", deckId);
    if (seek && !seek.classList.contains("hidden")) return;
    const sub = $d(".deck-sub", deckId);
    if (!sub) return;
    if (d.subSuffix) sub.textContent = d.subSuffix;
    else if (!d.track) sub.textContent = "Load a track from the playlist (⏏)";
  }

  function updateTimeReadout(deckId) {
    const d = getDeck(deckId);
    const elapsedEl = $d(".deck-time-elapsed", deckId);
    const remainEl = $d(".deck-time-remaining", deckId);
    const pos = currentPos(d);
    const dur = deckPlaybackDuration(d);
    if (elapsedEl) elapsedEl.textContent = fmt(pos);
    if (remainEl) remainEl.textContent = `-${fmt(Math.max(0, dur - pos))}`;
    syncDeckSeekBars(deckId);
  }

  function syncDeckSeekBars(deckId) {
    const lane = deckSeekLane(deckId);
    const d = getDeck(deckId);
    if (!lane) return;
    const dur = deckPlaybackDuration(d);
    if (!dur) {
      lane.style.setProperty("--bar-step", "6%");
      lane.style.setProperty("--bar-off", "0%");
      lane.style.setProperty("--seek-p", "0");
      syncDeckSeekA11y(deckId);
      return;
    }
    const stepPct = d.barLen > 0
      ? (d.barLen / dur) * 100
      : 100 / Math.max(12, Math.round(dur / 2));
    const offPct = d.barLen > 0 ? (d.beatOffset / dur) * 100 : 0;
    const pos = currentPos(d);
    lane.style.setProperty("--bar-step", `${Math.max(1.2, Math.min(8, stepPct))}%`);
    lane.style.setProperty("--bar-off", `${offPct}%`);
    lane.style.setProperty("--seek-p", ((pos / dur) * 100).toFixed(2));
    syncDeckSeekA11y(deckId);
  }

  async function ensureBpm(deckIdOrState = Studio.focusedId) {
    const deckState = typeof deckIdOrState === "number" ? getDeck(deckIdOrState) : deckIdOrState;
    if (!deckState?.track || deckState.jobId == null) return;
    if (deckState.bpm) return;
    try {
      const r = await api(`/api/jobs/${deckState.jobId}/bpm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: deckState.track.start, end: deckState.track.end }),
      });
      deckState.bpm = r.bpm || 0;
      deckState.beatOffset = r.beat_offset || 0;
      deckState.barLen = deckState.bpm ? (4 * 60) / deckState.bpm : 0;
    } catch (_) {}
    updateLoopBpm(deckState.id);
    syncDeckSeekBars(deckState.id);
    if (deckState.bpm && deckState.order?.length) saveStemCache(deckState.id);
  }

  function updateLoopBpm(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const el = $d(".deck-bpm", deckId);
    if (el) {
      const eff = d.bpm ? d.bpm * (d.rate || 1) : 0;
      el.textContent = eff ? `BPM ${eff.toFixed(1)}` : (d.bpm ? `BPM ${d.bpm.toFixed(1)}` : "BPM —");
      el.classList.toggle("hidden", !d.track && !d.bpm);
    }
    syncDeckSeekBars(deckId);
  }

  function syncAllDeckBpms() {
    Studio.deckOrder.forEach((id) => updateLoopBpm(id));
  }

  function loopRegion(deckState = S) {
    const dur = deckState.duration || 0;
    if (!deckState.barLen) {
      const len = Math.min(dur, 4);
      const start = Math.min(Math.max(0, currentPos(deckState)), Math.max(0, dur - len));
      return { start, end: start + len, barAligned: false };
    }
    const span = deckState.loopBars * deckState.barLen;
    const pos = currentPos(deckState);
    let barIdx = Math.floor((pos - deckState.beatOffset) / deckState.barLen);
    if (barIdx < 0) barIdx = 0;
    let start = deckState.beatOffset + barIdx * deckState.barLen;
    if (start < 0) start = 0;
    let end = start + span;
    if (end > dur) { end = dur; start = Math.max(0, end - span); }
    return { start, end, barAligned: true };
  }

  function launchLoop(name, deckState = S) {
    ensureDeckAudio(deckState.id);
    const st = deckState.stems[name];
    if (!st) return;
    const buf = st.buffer;
    const { start, end } = loopRegion(deckState);
    if (end - start < 0.05) { setDeckStatus("Track too short to loop.", true, deckState.id); return; }
    setDeckStatus("", false, deckState.id);

    const gain = Studio.ctx.createGain();
    gain.gain.value = st.volume;
    gain.connect(deckState.loopBus);
    const src = Studio.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    src.connect(gain);

    let when = Studio.ctx.currentTime + 0.03;
    let offset = start;
    if (deckState.playing && deckState.barLen) {
      const pos = currentPos(deckState);
      const nextBar = deckState.beatOffset + Math.ceil((pos - deckState.beatOffset) / deckState.barLen) * deckState.barLen;
      const delay = Math.max(0.03, nextBar - pos);
      when = Studio.ctx.currentTime + delay;
      offset = start;
    }
    src.start(when, offset);
    deckState.loops[name] = { src, gain, loopStart: start, loopEnd: end };
    syncAudioContextPower();
    if (deckState.id === Studio.focusedId) markLoopBtn(name, true, deckState);
  }

  function stopLoop(name, deckState = S) {
    const l = deckState.loops[name];
    if (!l) return;
    try { l.src.stop(); } catch (_) {}
    try { l.src.disconnect(); l.gain.disconnect(); } catch (_) {}
    delete deckState.loops[name];
    syncAudioContextPower();
    markLoopBtn(name, false, deckState);
  }

  function stopAllLoops(deckState = S) {
    Object.keys(deckState.loops).forEach((name) => stopLoop(name, deckState));
  }

  function syncDeckLoopUI(deckState = S) {
    ["stems", "simple"].forEach((mode) => {
      const pane = rowPaneEl(mode, deckState.id);
      if (!pane) return;
      getDeck(deckState.id).sets[mode]?.order?.forEach((n) => {
        const row = pane.querySelector(`.stem-row[data-name="${n}"]`);
        if (!row) return;
        const on = !!deckState.loops[n];
        row.classList.toggle("looping", on);
        const btn = row.querySelector(".loop");
        if (btn) {
          btn.classList.toggle("on", on);
          btn.title = on ? `Stop ${n} loop` : `Loop ${n}`;
          btn.setAttribute("aria-label", on ? `Stop ${n} loop` : `Loop ${n}`);
        }
      });
    });
  }

  async function toggleLoop(name, deckId = Studio.focusedId) {
    if (deckId !== Studio.focusedId) focusDeck(deckId);
    const d = getDeck(deckId);
    if (d.loops[name]) { stopLoop(name, d); return; }
    setDeckStatus("", false, deckId);
    if (Studio.ctx && Studio.ctx.state === "suspended") await Studio.ctx.resume();
    await ensureBpm();
    launchLoop(name, d);
  }

  function markLoopBtn(name, on, deckState = S) {
    ["stems", "simple"].forEach((mode) => {
      const row = rowPaneEl(mode, deckState.id)?.querySelector(`.stem-row[data-name="${name}"]`);
      row?.classList.toggle("looping", on);
    });
    syncDeckLoopUI(deckState);
  }

  function ensureCtx() {
    if (Studio.ctx) return;
    Studio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    Studio.master = Studio.ctx.createGain();
    Studio.master.connect(Studio.ctx.destination);
    applyMasterOutput();
  }

  function ensureDeckAudio(deckId) {
    ensureCtx();
    const d = getDeck(deckId);
    if (d.outBus) return;
    d.mainBus = Studio.ctx.createGain();
    d.loopBus = Studio.ctx.createGain();
    d.outBus = Studio.ctx.createGain();
    d.mainBus.connect(d.outBus);
    d.loopBus.connect(d.outBus);
    d.outBus.connect(Studio.master);
    applyDeckMixer(deckId);
  }

  function disposeDeckAudio(deckId) {
    const d = getDeck(deckId);
    if (!d) return;
    stopSources(d);
    stopAllLoops(d);
    releaseDeckGraph(d);
    [d.mainBus, d.loopBus, d.outBus].forEach((node) => {
      if (node) { try { node.disconnect(); } catch (_) {} }
    });
    d.mainBus = d.loopBus = d.outBus = null;
  }

  // Detach every per-stem gain/EQ node from the deck's stems and simple-band
  // graphs and drop the buffer references this deck holds. Any buffer still
  // retained by the (bounded) stemCache survives via the cache's own reference;
  // everything else becomes eligible for GC once the deck state is replaced.
  // Sources are already stopped/disconnected by stopSources() before this runs.
  function releaseDeckGraph(d) {
    const disconnect = (node) => { if (node) { try { node.disconnect(); } catch (_) {} } };
    ["stems", "simple"].forEach((mode) => {
      const set = d.sets?.[mode];
      if (!set?.stems) return;
      Object.values(set.stems).forEach((st) => {
        if (!st) return;
        disconnect(st.gain);
        if (st.input && st.input !== st.gain) disconnect(st.input);
        st.source = null;
        st.buffer = null; // cache keeps its own ref; this releases the deck's
      });
      disconnect(set.sharedInput); // simple-band split node (low/high crossover feed)
      set.sharedInput = null;
    });
    d.fullBuffer = null;
    d.sharedInput = null;
  }

  function applyMasterOutput() {
    if (!Studio.master) return;
    Studio.master.gain.value = Studio.masterMuted ? 0 : Studio.masterVol;
  }

  function applyDeckMixer(deckId) {
    const d = getDeck(deckId);
    if (!d.outBus) return;
    const x = d.cross;
    const mainX = Math.min(1, 2 * (1 - x));
    const loopX = Math.min(1, 2 * x);
    const fx = Studio.fxLoopMuted ? 0 : Studio.fxLoopVol;
    d.mainBus.gain.value = d.mainMuted ? 0 : d.mainVol * mainX;
    d.loopBus.gain.value = fx * (d.loopMuted ? 0 : d.loopVol * loopX);
    d.outBus.gain.value = d.deckMuted ? 0 : d.deckVol;
  }

  function applyAllDeckMixers() {
    Studio.deckOrder.forEach((id) => applyDeckMixer(id));
    applyMasterOutput();
  }

  function resetFocusedMixerUI() {
    const xf = $("#rxfader");
    if (xf) xf.value = 0.5;
  }

  function syncFocusedMainLoopUI() {
    const xf = $("#rxfader");
    if (xf) xf.value = S.cross;
  }

  function syncGlobalMixerUI() {
    const mv = $("#master-vol");
    if (mv) mv.value = Studio.masterVol;
    const mm = $("#master-mute");
    if (mm) {
      syncRdeckMuteIcon(mm, Studio.masterMuted);
      mm.classList.toggle("on", Studio.masterMuted);
    }
    const fv = $("#fxloop-vol");
    if (fv) fv.value = Studio.fxLoopVol;
    const fm = $("#fxloop-mute");
    if (fm) {
      syncRdeckMuteIcon(fm, Studio.fxLoopMuted);
      fm.classList.toggle("on", Studio.fxLoopMuted);
    }
  }

  function syncDeckMixerUI() {
    Studio.deckOrder.forEach((id) => {
      const d = getDeck(id);
      const vol = document.querySelector(`.rdeck-vol[data-deck-id="${id}"]`);
      const mute = document.querySelector(`.rdeck-mute[data-deck-id="${id}"]`);
      if (vol) vol.value = d.deckVol;
      if (mute) {
        syncRdeckMuteIcon(mute, d.deckMuted);
        mute.classList.toggle("on", d.deckMuted);
      }
    });
    syncFocusedMainLoopUI();
    syncGlobalMixerUI();
  }

  function buildDeckMixerUI() {
    const strips = $("#deck-mixer-strips");
    if (!strips) return;
    strips.innerHTML = "";
    Studio.deckOrder.forEach((id) => {
      ensureDeckAudio(id);
      const d = getDeck(id);
      const strip = document.createElement("div");
      strip.className = "mix-strip rdeck deck-strip";
      strip.dataset.deckId = String(id);
      strip.innerHTML = `
        <span class="mix-strip-tag deck-strip-tag">DECK ${id}</span>
        <div class="stem-fader-grow">
          <span class="fader-v"><input type="range" class="rdeck-vol" data-deck-id="${id}" min="0" max="1" step="0.01" value="${d.deckVol}" title="Deck ${id} level" /></span>
        </div>
        <button type="button" class="rdeck-mute ghost" data-deck-id="${id}" title="Mute / unmute deck ${id}" aria-label="Mute deck ${id}"></button>`;
      const capLed = DECK_COLORS[id] || DECK_COLORS[1];
      strip.querySelector(".fader-v input").style.setProperty("--cap-led", capLed);
      strips.appendChild(strip);
    });
    strips.querySelectorAll(".rdeck-vol[data-deck-id]").forEach((v) => {
      v.addEventListener("input", (e) => {
        const id = parseInt(e.target.dataset.deckId, 10);
        getDeck(id).deckVol = parseFloat(e.target.value);
        applyDeckMixer(id);
      });
    });
    strips.querySelectorAll(".rdeck-mute[data-deck-id]").forEach((b) => {
      b.addEventListener("click", () => {
        const id = parseInt(b.dataset.deckId, 10);
        const d = getDeck(id);
        d.deckMuted = !d.deckMuted;
        syncRdeckMuteIcon(b, d.deckMuted);
        b.classList.toggle("on", d.deckMuted);
        applyDeckMixer(id);
      });
    });
    syncDeckMixerUI();
  }

  async function loadStems(snap, deckId = Studio.focusedId, opts = {}) {
    if (!opts.silent) {
      setDeckLoadStatus(deckId, true);
      setDeckProgressMsg("Loading stems…", false, deckId);
      $d(".deck-progress", deckId)?.classList.remove("hidden");
      updateStudioPanels();
    }
    ensureDeckAudio(deckId);
    const d = getDeck(deckId);
    const order = snap.order && snap.order.length ? snap.order : Object.keys(snap.stems);
    const stems = {};
    let duration = 0;
    for (const name of order) {
      try {
        const buf = await fetchStemAudio(deckId, name);
        const audioBuf = await Studio.ctx.decodeAudioData(buf);
        const gain = Studio.ctx.createGain();
        gain.connect(d.mainBus);
        stems[name] = { buffer: audioBuf, gain, input: gain, source: null, mute: false, solo: false, volume: 1, include: true };
        if (d.stemVisible[name] === undefined) d.stemVisible[name] = true;
        duration = Math.max(duration, audioBuf.duration);
      } catch (e) {
        setDeckProgressMsg(`Failed to load ${name}: ${e.message}`, true, deckId);
        setDeckErr(`Failed to load ${name}.`, deckId);
      }
    }
    d.stems = stems;
    d.order = order.filter((n) => stems[n]);
    d.sets.stems = { stems, order: d.order, duration };
    d.duration = duration;
    if (d.order.length) {
      clearDeckErr(deckId);
      saveStemCache(deckId);
    } else {
      const recovered = await tryRecoverStems(deckId);
      if (!recovered) setDeckErr("Stem load failed — try loading the track again.", deckId);
    }
    hideDeckJobProgress(deckId);
    if (!opts.silent) setDeckProgressMsg("", false, deckId);
    prefetchSimpleBands(deckId);
    if (deckId === Studio.focusedId) {
      if (d.order.length && (d.mode === "stems" || !d.sets.simple)) {
        if (d.mode !== "stems") { d.mode = "stems"; updateModeButtons(deckId); }
        activateSet("stems");
      } else if (d.mode === "simple" && d.sets.simple) {
        activateSet("simple");
      } else {
        updateStemRowsPlaceholder(deckId);
      }
    }
    updateStudioPanels();
    syncDeckTrackProgress(deckId);
    buildDeckPeaks(deckId);
    refreshPlaylistWaveLanes();
    saveStemCache(deckId);
    updateLoopBpm(deckId);
    ensureBpm(deckId);
  }

  function crossover(kind, freq) {
    const a = Studio.ctx.createBiquadFilter();
    const b = Studio.ctx.createBiquadFilter();
    a.type = b.type = kind;
    a.frequency.value = b.frequency.value = freq;
    a.Q.value = b.Q.value = 0.707;
    a.connect(b);
    return { input: a, output: b };
  }

  function buildSimpleGraph(deckId) {
    const d = getDeck(deckId);
    const stemSet = d.sets.stems;
    const refBuf = stemSet?.stems?.[stemSet.order[0]]?.buffer || d.fullBuffer;
    const duration = stemSet?.duration || d.fullBuffer?.duration || 0;
    if (!refBuf || !duration) return false;
    const ctx = Studio.ctx;
    const srcBus = ctx.createGain();
    const low = crossover("lowpass", XLOW);
    const high = crossover("highpass", XHIGH);
    srcBus.connect(low.input);
    srcBus.connect(high.input);

    const lowGain = ctx.createGain(); lowGain.connect(d.mainBus);
    const midGain = ctx.createGain(); midGain.connect(d.mainBus);
    const highGain = ctx.createGain(); highGain.connect(d.mainBus);
    low.output.connect(lowGain);
    high.output.connect(highGain);

    const midMix = ctx.createGain(); midMix.gain.value = 1;
    srcBus.connect(midMix);
    const invL = ctx.createGain(); invL.gain.value = -1; low.output.connect(invL); invL.connect(midMix);
    const invH = ctx.createGain(); invH.gain.value = -1; high.output.connect(invH); invH.connect(midMix);
    midMix.connect(midGain);

    const gains = { low: lowGain, mid: midGain, high: highGain };
    const order = ["high", "mid", "low"];
    const stems = {};
    order.forEach((name) => {
      if (d.stemVisible[name] === undefined) d.stemVisible[name] = true;
      stems[name] = {
        buffer: refBuf, gain: gains[name], input: null,
        source: null, mute: false, solo: false, volume: 1, include: true,
      };
    });
    d.sets.simple = { stems, order, duration, sharedInput: srcBus };
    return true;
  }

  function loadSimpleSync(deckId) {
    const d = getDeck(deckId);
    ensureDeckAudio(deckId);
    ensureCtx();
    if (!buildSimpleGraph(deckId)) return false;
    buildRowPane("simple", deckId);
    return true;
  }

  async function loadSimpleFromRegion(deckId) {
    const d = getDeck(deckId);
    ensureDeckAudio(deckId);
    ensureCtx();
    if (!d.fullBuffer) {
      const t = d.track;
      const buf = await (await fetch(`/api/jobs/${d.jobId}/region?start=${t.start}&end=${t.end}`)).arrayBuffer();
      d.fullBuffer = await Studio.ctx.decodeAudioData(buf);
    }
    loadSimpleSync(deckId);
  }

  function loadSimple(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (!d?.track) return Promise.resolve();
    if (d.sets.simple) {
      if (!d.rowsBuilt?.simple) buildRowPane("simple", deckId);
      return Promise.resolve();
    }
    if (d.sets.stems?.order?.length) {
      loadSimpleSync(deckId);
      if (deckId === Studio.focusedId) syncModeToggleReady(deckId);
      return Promise.resolve();
    }
    if (d._loadSimpleP) return d._loadSimpleP;
    if (deckId === Studio.focusedId) syncModeToggleReady(deckId);
    d._loadSimpleP = loadSimpleFromRegion(deckId).finally(() => {
      delete d._loadSimpleP;
      if (deckId === Studio.focusedId) syncModeToggleReady(deckId);
    });
    return d._loadSimpleP;
  }

  function prefetchSimpleBands(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (!d?.track || d.jobId == null || d.poll || d.sepStarting) return;
    if (!d.sets.stems?.order?.length) return;
    if (d.sets.simple || d._loadSimpleP) return;
    loadSimple(deckId).catch(() => {
      if (deckId === Studio.focusedId) syncModeToggleReady(deckId);
    });
  }

  function switchActiveSet(mode) {
    const set = S.sets[mode];
    if (!set) return false;
    S.stems = set.stems;
    S.order = set.order;
    S.duration = set.duration;
    S.sharedInput = set.sharedInput || null;
    S.subSuffix = mode === "simple" ? "EQ · LO · MID · HI" : `${set.order.length} stems`;
    renderDeckSub(Studio.focusedId);
    ensureStemRowPane(mode, Studio.focusedId);
    applyGains(Studio.focusedId);
    syncMuteButtons(Studio.focusedId);
    applyStemVisibility(Studio.focusedId);
    syncMixerRackUI();
    syncStemShowBtn(Studio.focusedId);
    syncDeckLoopUI(S);
    ensureRafRunning();
    syncDeckSeekA11y();
    syncAudioContextPower();
    if (mode === "stems") ensureBpm();
    requestAnimationFrame(() => {
      if (S.mode !== mode) return;
      buildStemFilter(Studio.focusedId);
    });
    return true;
  }

  function syncDeckStemRackUI(deckId) {
    const d = getDeck(deckId);
    const ready = d.order.length > 0;
    $d(".deck-stem-rows", deckId)?.classList.toggle("simple-mode", d.mode === "simple");
    $d(".deck-stem-show", deckId)?.classList.toggle("hidden", !ready);
    $d(".deck-st-download", deckId)?.classList.toggle("hidden", !ready);
    $d(".deck-stems-toggle", deckId)?.classList.toggle("ready", ready);
    updateModeButtons(deckId);
    syncStemShowBtn(deckId);
  }

  function syncMixerRackUI() {
    Studio.deckOrder.forEach((id) => syncDeckStemRackUI(id));
    const fd = getDeck(Studio.focusedId);
    $("#focused-main-loop")?.classList.toggle("hidden", !fd.order.length);
  }

  function activateSet(mode) {
    const set = S.sets[mode];
    if (!set) return;
    buildRowPane("stems", S.id);
    if (S.sets.stems?.order?.length) loadSimple(S.id);
    else if (S.sets.simple) buildRowPane("simple", S.id);
    switchActiveSet(mode);
    if (!anyDeckWorking() && !deckSepShowsOnDeck(S.id)) clearDeckSepProgress(S.id);
    updateStudioPanels();
    toggleStemFilterPop(S.id, false);
    updateLoopBpm();
    syncAllDeckLcds();
    if (mode === "stems") prefetchSimpleBands(S.id);
  }

  function syncStemShowBtn(deckId = Studio.focusedId) {
    const btn = $d(".deck-stem-show", deckId);
    const pop = $d(".deck-stem-filter", deckId);
    if (!btn) return;
    const d = getDeck(deckId);
    const open = pop && !pop.classList.contains("hidden");
    const filtered = d.order.some((n) => d.stemVisible[n] === false);
    btn.classList.toggle("on", open || filtered);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function toggleStemFilterPop(deckId, force) {
    const pop = $d(".deck-stem-filter", deckId);
    const btn = $d(".deck-stem-show", deckId);
    if (!pop || !btn || btn.classList.contains("hidden")) return;
    const show = force !== undefined ? force : pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !show);
    syncStemShowBtn(deckId);
  }

  function buildStemFilter(deckId = Studio.focusedId) {
    const chips = $d(".deck-stem-filter-chips", deckId);
    const btn = $d(".deck-stem-show", deckId);
    if (!chips) return;
    const d = getDeck(deckId);
    chips.innerHTML = "";
    if (!d.order.length) {
      toggleStemFilterPop(deckId, false);
      btn?.classList.add("hidden");
      return;
    }
    btn?.classList.remove("hidden");
    syncStemShowBtn(deckId);
    d.order.forEach((name) => {
      const visible = d.stemVisible[name] !== false;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `stem-filter-chip${visible ? " on" : ""}`;
      chip.dataset.name = name;
      chip.innerHTML = `<span class="stem-dot dot-${COLORS[name] || "other"}"></span>${name}`;
      chip.title = visible ? `Hide ${name} in mixer` : `Show ${name} in mixer`;
      chip.addEventListener("click", () => {
        if (deckId !== Studio.focusedId) focusDeck(deckId);
        d.stemVisible[name] = d.stemVisible[name] === false ? true : false;
        buildStemFilter(deckId);
        applyStemVisibility(deckId);
      });
      chips.appendChild(chip);
    });
  }

  function applyStemVisibility(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const pane = activeRowPane(deckId);
    if (!pane) return;
    d.order.forEach((name) => {
      const row = pane.querySelector(`.stem-row[data-name="${name}"]`);
      if (row) row.classList.toggle("hidden", d.stemVisible[name] === false);
    });
  }

  function syncModeToggleReady(deckId = Studio.focusedId) {
    const btn = $d(".deck-st-mode-toggle", deckId);
    const slot = $d(".deck-st-mode-slot", deckId);
    if (!btn) return;
    const d = getDeck(deckId);
    const pending = d.mode === "stems" && !d.sets.simple && !!d._loadSimpleP;
    btn.classList.toggle("eq-pending", pending);
    slot?.classList.toggle("eq-pending", pending);
    btn.disabled = pending;
    updateModeButtons(deckId);
  }

  function updateModeButtons(deckId = Studio.focusedId) {
    const btn = $d(".deck-st-mode-toggle", deckId);
    if (!btn) return;
    const d = getDeck(deckId);
    const stems = d.mode === "stems";
    const pending = stems && !d.sets.simple && !!d._loadSimpleP;
    btn.classList.toggle("on", true);
    btn.classList.toggle("mode-simple", !stems);
    btn.querySelector(".mode-stems")?.classList.toggle("hidden", !stems);
    btn.querySelector(".mode-simple")?.classList.toggle("hidden", stems);
    btn.title = pending
      ? "Preparing EQ bands — keep playing, switch is almost ready"
      : stems
        ? "Instruments — AI stem separation (click for HI/MID/LO)"
        : "Simple — HI / MID / LO bands (click for instruments)";
    btn.setAttribute("aria-label", pending ? "Preparing EQ bands" : stems ? "Instruments mode" : "Simple band mode");
    btn.setAttribute("aria-pressed", stems ? "true" : "false");
    const lab = $d(".deck-st-mode-lab", deckId);
    if (lab) lab.textContent = pending ? "…" : stems ? "STEM" : "EQ";
    $d(".deck-st-mode-slot", deckId)?.classList.toggle("mode-simple", !stems);
  }

  function setMode(mode, deckId = Studio.focusedId) {
    if (deckId !== Studio.focusedId) focusDeck(deckId);
    if (!S.track) {
      setDeckErr("Load a track from the playlist first.");
      updateModeButtons(deckId);
      return;
    }
    if (deckSepShowsOnDeck(Studio.focusedId)) {
      setDeckStatus("Stem separation still running — wait for it to finish.", false);
      updateModeButtons(deckId);
      return;
    }
    if (mode === S.mode && S.sets[mode]) return;
    clearDeckErr();
    const prevMode = S.mode;
    if (mode === "simple") {
      if (!S.sets.simple) {
        if (S._loadSimpleP) return;
        if (!S.sets.stems?.order?.length) {
          setDeckErr("Separating stems…");
          return;
        }
        loadSimple(Studio.focusedId);
        if (!S.sets.simple) {
          setDeckErr("EQ bands not ready.");
          return;
        }
      }
    } else if (!S.sets.stems) {
      setDeckErr("Separating stems…");
      return;
    }
    const pos = currentPos(S);
    const wasPlaying = S.playing;
    if (Object.keys(S.loops).length) stopAllLoops(S);
    S.mode = mode;
    updateModeButtons(deckId);
    if (!switchActiveSet(mode)) {
      S.mode = prevMode;
      updateModeButtons(deckId);
      setDeckErr("Mode switch failed.");
      return;
    }
    S.offset = Math.min(pos, S.duration || 0);
    updateTimeReadout(Studio.focusedId);
    syncAllDeckLcds();
    if (wasPlaying) {
      stopSources(S);
      startSources(S);
    }
  }

  function setLcd(el, text) {
    if (!el) return;
    el.innerHTML = "";
    const inner = document.createElement("span");
    inner.className = "marq";
    inner.textContent = text;
    el.appendChild(inner);
    requestAnimationFrame(() => {
      const overflow = inner.scrollWidth - el.clientWidth;
      if (overflow > 4) {
        inner.style.setProperty("--marq-shift", `-${overflow + 12}px`);
        inner.style.setProperty("--marq-dur", `${Math.max(7, (overflow + 80) / 28)}s`);
        inner.classList.add("scroll");
      }
    });
  }

  function updateStemRowsPlaceholder(deckId = Studio.focusedId) {
    const wrap = $d(".deck-stem-rows", deckId);
    if (!wrap) return;
    if (rowPaneEl("stems", deckId)?.querySelector(".stem-row") || rowPaneEl("simple", deckId)?.querySelector(".stem-row")) return;
    let msg = "Load a track from the playlist (⏏) — separated stems appear here.";
    const d = getDeck(deckId);
    if (d.poll || deckSepShowsOnDeck(deckId)) {
      msg = "Separating stems… vocal, drums, bass and other rows will appear here when done.";
    } else if (d.studioErr) {
      msg = d.studioErr;
    } else if (d.track && d.jobId != null && !d.sets.stems && !d.sets.simple) {
      if (deckAwaitingPlaylistStems(deckId)) {
        msg = "Separating stems… vocal, drums, bass and EQ rows will appear here when ready.";
      } else {
        msg = "Preparing stems…";
        beginStemSeparation(deckId);
      }
    } else if (d.sets.stems && !Object.keys(d.sets.stems.stems || {}).length) {
      msg = "Loading stems…";
    }
    let el = wrap.querySelector(".stem-rows-empty");
    if (!el) {
      el = document.createElement("p");
      el.className = "stem-rows-empty muted small";
      wrap.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("lcd-err", !!d.studioErr);
  }

  function rowPaneEl(mode, deckId = Studio.focusedId) {
    const sel = mode === "simple" ? ".stem-rows-eq" : ".stem-rows-stems";
    return $d(sel, deckId);
  }

  function activeRowPane(deckId = Studio.focusedId) {
    return rowPaneEl(getDeck(deckId).mode, deckId);
  }

  function showRowPane(mode, deckId = Studio.focusedId) {
    rowPaneEl("stems", deckId)?.classList.toggle("hidden", mode !== "stems");
    rowPaneEl("simple", deckId)?.classList.toggle("hidden", mode !== "simple");
    const activePane = rowPaneEl(mode, deckId);
    const hasRows = !!activePane?.querySelector(".stem-row");
    const empty = $d(".deck-stem-rows", deckId)?.querySelector(".stem-rows-empty");
    if (empty) empty.classList.toggle("hidden", hasRows);
  }

  function ensureStemRowPane(mode, deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const set = d.sets[mode];
    if (!set?.order?.length) {
      showRowPane(mode, deckId);
      updateStemRowsPlaceholder(deckId);
      return;
    }
    const pane = rowPaneEl(mode, deckId);
    if (pane && !pane.querySelector(".stem-row")) {
      if (d.rowsBuilt?.[mode]) d.rowsBuilt[mode] = false;
      buildRowPane(mode, deckId);
    }
    showRowPane(mode, deckId);
  }

  function clearRowPanes(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    d.rowsBuilt = { stems: false, simple: false };
    const stemsPane = rowPaneEl("stems", deckId);
    const eqPane = rowPaneEl("simple", deckId);
    if (stemsPane) stemsPane.innerHTML = "";
    if (eqPane) eqPane.innerHTML = "";
    showRowPane(d.mode, deckId);
    updateStemRowsPlaceholder(deckId);
  }

  function wireStemRow(row, name, deckId) {
    row.querySelector(".mute").addEventListener("click", (e) => {
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      const btn = e.currentTarget;
      const st = getDeck(deckId).stems[name];
      st.mute = !st.mute;
      btn.classList.toggle("on", st.mute);
      syncStemMuteIcon(btn, st.mute);
      applyGains(deckId);
      syncMuteButtons(deckId);
    });
    row.querySelector(".solo").addEventListener("click", (e) => {
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      const btn = e.currentTarget;
      const st = getDeck(deckId).stems[name];
      st.solo = !st.solo;
      btn.classList.toggle("on", st.solo);
      applyGains(deckId);
    });
    row.querySelector(".loop").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleLoop(name, deckId);
    });
    row.querySelector(".vol").addEventListener("input", (e) => {
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      const st = getDeck(deckId).stems[name];
      st.volume = parseFloat(e.target.value);
      applyGains(deckId);
      const loops = getDeck(deckId).loops;
      if (loops[name]) loops[name].gain.gain.value = st.volume;
    });
    row.querySelector(".inc").addEventListener("change", (e) => {
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      getDeck(deckId).stems[name].include = e.target.checked;
    });
  }

  function buildRowPane(mode, deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (d.rowsBuilt?.[mode]) return;
    const set = d.sets[mode];
    if (!set?.order?.length) return;
    const pane = rowPaneEl(mode, deckId);
    if (!pane) return;
    pane.innerHTML = "";
    set.order.filter((name) => set.stems[name]).forEach((name) => {
      const st = set.stems[name];
      const row = document.createElement("div");
      row.className = "stem-row";
      if (d.stemVisible[name] === false) row.classList.add("hidden");
      row.dataset.name = name;
      row.innerHTML = `
        <span class="stem-tag mix-strip-tag stem-${COLORS[name] || "other"}" title="${name}">${STEM_LABELS[name] || name.toUpperCase()}</span>
        <canvas class="stem-wave" width="52" height="36"></canvas>
        <div class="stem-btns">
          <button type="button" class="ghost mute iconbtn" title="Mute" aria-label="Mute">${stemMuteIcon(st.mute)}</button>
          <button type="button" class="ghost solo iconbtn" title="Solo" aria-label="Solo">${stemSoloIcon(name)}</button>
          <button type="button" class="ghost loop iconbtn" title="Loop ${name}" aria-label="Loop ${name}">${stemLoopIcon()}</button>
        </div>
        <div class="stem-fader-grow">
          <span class="fader-v stem-fader"><input type="range" class="vol" min="0" max="1" step="0.01" value="${st.volume}" title="Volume" /></span>
        </div>
        <label class="stem-inc"><input type="checkbox" class="inc"${st.include ? " checked" : ""} /><span>IN</span></label>`;
      pane.appendChild(row);
      const volInput = row.querySelector(".fader-v input");
      if (volInput) volInput.style.setProperty("--cap-led", STEM_LEDS[name] || STEM_LEDS.other);
      if (d.loops[name]) row.classList.add("looping");
      if (st.solo) row.querySelector(".solo")?.classList.add("on");
      if (d.loops[name]) row.querySelector(".loop")?.classList.add("on");
      wireStemRow(row, name, deckId);
    });
    d.rowsBuilt = d.rowsBuilt || { stems: false, simple: false };
    d.rowsBuilt[mode] = true;
    if (deckId === Studio.focusedId && mode === S.mode) syncDeckLoopUI(d);
  }

  function applyWaveVisibility(deckId) {
    if (deckId != null) {
      $d(".deck-stem-rows", deckId)?.classList.add("waves-off");
      return;
    }
    Studio.deckOrder.forEach((id) => $d(".deck-stem-rows", id)?.classList.add("waves-off"));
  }

  function toggleDeckStemDrawer(deckId, force) {
    const d = getDeck(deckId);
    const drawer = $d(".deck-stem-drawer", deckId);
    const btn = $d(".deck-stems-toggle", deckId);
    const root = deckEl(deckId);
    if (!drawer || !btn) return;
    const open = force !== undefined ? force : !d.stemsOpen;
    if (open) {
      Studio.deckOrder.forEach((id) => {
        if (id !== deckId && getDeck(id).stemsOpen) toggleDeckStemDrawer(id, false);
      });
    }
    d.stemsOpen = open;
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", open ? "false" : "true");
    btn.classList.toggle("on", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    root?.classList.toggle("stems-open", open);
    if (open) {
      if (deckId !== Studio.focusedId) focusDeck(deckId);
      ensureStemRowPane(d.mode, deckId);
      showRowPane(d.mode, deckId);
      syncDeckStemRackUI(deckId);
    }
  }

  function anySolo() { return S.order.some((n) => S.stems[n].solo); }
  function allMuted() { return S.order.length > 0 && S.order.every((n) => S.stems[n].mute); }

  function syncMuteButtons(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const pane = activeRowPane(deckId);
    d.order.forEach((n) => {
      const row = pane?.querySelector(`.stem-row[data-name="${n}"]`);
      if (!row) return;
      const muteBtn = row.querySelector(".mute");
      muteBtn?.classList.toggle("on", S.stems[n].mute);
      syncStemMuteIcon(muteBtn, d.stems[n].mute);
    });
    const btn = $d(".st-muteall", deckId);
    if (btn) syncMuteAllButton(deckId);
  }

  function resetMix(deckId = Studio.focusedId) {
    if (deckId !== Studio.focusedId) focusDeck(deckId);
    const d = getDeck(deckId);
    const pane = activeRowPane(deckId);
    d.order.forEach((n) => {
      const st = d.stems[n];
      st.mute = false; st.solo = false; st.volume = 1;
      const row = pane?.querySelector(`.stem-row[data-name="${n}"]`);
      if (row) {
        row.querySelector(".mute").classList.remove("on");
        syncStemMuteIcon(row.querySelector(".mute"), false);
        row.querySelector(".solo").classList.remove("on");
        const vol = row.querySelector(".vol");
        if (vol) vol.value = 1;
      }
    });
    applyGains(deckId);
    syncMuteButtons(deckId);
  }

  function toggleMuteAll(deckId = Studio.focusedId) {
    if (deckId !== Studio.focusedId) focusDeck(deckId);
    const d = getDeck(deckId);
    const target = !d.order.every((n) => d.stems[n].mute);
    const pane = activeRowPane(deckId);
    d.order.forEach((n) => {
      d.stems[n].mute = target;
      if (target) d.stems[n].solo = false;
    });
    if (target) {
      d.order.forEach((n) => {
        const row = pane?.querySelector(`.stem-row[data-name="${n}"]`);
        if (row) row.querySelector(".solo").classList.remove("on");
      });
    }
    applyGains(deckId);
    syncMuteButtons(deckId);
  }

  function applyGains(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    const solo = d.order.some((n) => d.stems[n].solo);
    d.order.forEach((n) => {
      const st = d.stems[n];
      const audible = solo ? st.solo : !st.mute;
      if (st.gain) st.gain.gain.value = audible ? st.volume : 0;
      const row = activeRowPane(deckId)?.querySelector(`.stem-row[data-name="${n}"]`);
      if (row) row.classList.toggle("dim", !audible);
    });
  }

  function startSources(deckState) {
    const d = deckState || S;
    const off = Math.max(0, Math.min(d.offset, (d.duration || 0) - 0.01));
    const rate = d.rate || 1;
    if (d.sharedInput && d.mode === "simple" && d.sets.stems?.order?.length) {
      d.simpleStemSources = [];
      d.sets.stems.order.forEach((n) => {
        const st = d.sets.stems.stems[n];
        if (!st?.buffer) return;
        const src = Studio.ctx.createBufferSource();
        src.buffer = st.buffer;
        src.playbackRate.value = rate;
        src.connect(d.sharedInput);
        src.start(0, Math.min(off, st.buffer.duration - 0.01));
        d.simpleStemSources.push(src);
      });
    } else if (d.sharedInput && d.fullBuffer) {
      const src = Studio.ctx.createBufferSource();
      src.buffer = d.fullBuffer;
      src.playbackRate.value = rate;
      src.connect(d.sharedInput);
      src.start(0, Math.min(off, d.fullBuffer.duration - 0.01));
      d.sharedSource = src;
    } else {
      d.order.forEach((n) => {
        const st = d.stems[n];
        const src = Studio.ctx.createBufferSource();
        src.buffer = st.buffer;
        src.playbackRate.value = rate;
        src.connect(st.input || st.gain);
        src.start(0, Math.min(off, st.buffer.duration - 0.01));
        st.source = src;
      });
    }
    d.startCtxTime = Studio.ctx.currentTime;
  }

  function stopSources(deckState) {
    const d = deckState || S;
    if (d.simpleStemSources) {
      d.simpleStemSources.forEach((src) => {
        try { src.stop(); } catch (_) {}
        try { src.disconnect(); } catch (_) {}
      });
      d.simpleStemSources = null;
    }
    if (d.sharedSource) {
      try { d.sharedSource.stop(); } catch (_) {}
      try { d.sharedSource.disconnect(); } catch (_) {}
      d.sharedSource = null;
    }
    (d.order || []).forEach((n) => {
      const st = d.stems[n];
      if (st?.source) { try { st.source.stop(); } catch (_) {} try { st.source.disconnect(); } catch (_) {} st.source = null; }
    });
  }

  function currentPos(deckState = S) {
    if (!deckState.playing || !Studio.ctx) return deckState.offset;
    const rate = deckState.rate || 1;
    return Math.min(deckState.duration, deckState.offset + (Studio.ctx.currentTime - deckState.startCtxTime) * rate);
  }

  function ensureDeckPlaybackState(deckId) {
    const d = getDeck(deckId);
    if (d.poll) return false;
    const set = d.sets[d.mode];
    if (!set) return false;
    if (!d.duration) {
      d.stems = set.stems;
      d.order = set.order;
      d.duration = set.duration;
      d.sharedInput = set.sharedInput || null;
    }
    return d.duration > 0;
  }

  function play(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (deckSepShowsOnDeck(deckId)) {
      setDeckStatus("Separating stems — ready soon…", false);
      return;
    }
    if (deckAwaitingPlaylistStems(deckId)) {
      setDeckStatus("Separating stems — ready soon…", false);
      return;
    }
    if (!ensureDeckPlaybackState(deckId)) {
      if (d.track && d.jobId != null && !deckHasContent(deckId)) {
        beginStemSeparation(deckId);
      } else {
        setDeckStatus("No track loaded — load a track from playlist.", false);
      }
      return;
    }
    ensureCtx();
    if (Studio.ctx.state === "suspended") Studio.ctx.resume();
    ensureDeckAudio(deckId);
    if (d.offset >= d.duration) d.offset = 0;
    startSources(d);
    d.playing = true;
    if (d.playStartedAt == null) d.playStartedAt = Studio.ctx.currentTime;
    syncPlayButton(deckId);
    setStatus(anyDeckPlaying());
    syncAudioContextPower();
    refreshPlaylistWaveLanes();
    ensureRafRunning();
    ensureBpm(deckId).then(() => updatePlaylistSyncStatus());
  }

  function pause(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (!d.playing) return;
    d.offset = currentPos(d);
    stopSources(d);
    d.playing = false;
    syncPlayButton(deckId);
    setStatus(anyDeckPlaying());
    syncAudioContextPower();
    ensureRafRunning();
  }

  function stopCue(deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (d.playing) {
      pause(deckId);
    }
    d.offset = d.cuePos || 0;
    d.playStartedAt = null;
    updateTimeReadout(deckId);
    syncPlayButton(deckId);
    syncCueButton(deckId);
    if (deckWaveLaneEl(deckId)) drawPlaylistDeckWave(deckId);
  }

  function seek(t, deckId = Studio.focusedId) {
    const d = getDeck(deckId);
    if (!ensureDeckPlaybackState(deckId)) return;
    const wasPlaying = d.playing;
    if (d.playing) { stopSources(d); d.playing = false; }
    d.offset = Math.max(0, Math.min(d.duration, t));
    if (wasPlaying) play(deckId);
    updateTimeReadout(deckId);
  }

  const AUTO_TRANSITION_SEC = 6;

  function updateUI() {
    const nowCtx = Studio.ctx?.currentTime || 0;

    // Handle ongoing auto-crossfade transition
    if (Studio.autoTransition) {
      const tr = Studio.autoTransition;
      const elapsed = Math.max(0, nowCtx - tr.startCtxTime);
      const frac = Math.min(1, elapsed / tr.dur);
      const fromD = getDeck(tr.fromId);
      const toD = getDeck(tr.toId);
      if (fromD) fromD.deckVol = Math.cos(frac * Math.PI / 2);
      if (toD) toD.deckVol = Math.sin(frac * Math.PI / 2);
      applyDeckMixer(tr.fromId);
      applyDeckMixer(tr.toId);

      if (frac >= 1 || (fromD && currentPos(fromD) >= fromD.duration - 0.05)) {
        pause(tr.fromId);
        seek(0, tr.fromId);
        if (fromD) fromD.deckVol = 1.0;
        if (toD) toD.deckVol = 1.0;
        applyAllDeckMixers();
        focusDeck(tr.toId);

        // Preload upcoming track into fromDeck
        if (toD?.track) {
          const nextUp = window.getNextTrackAfter?.(toD.track);
          if (nextUp && window.isPlaylistTrackReady?.(nextUp)) {
            window.loadTrackToDeck?.(nextUp, tr.fromId, { silent: true });
          }
        }
        Studio.autoTransition = null;
      }
    }

    Studio.deckOrder.forEach((deckId) => {
      const deck = getDeck(deckId);
      if (deck.duration > 0 && deck.track && deckWaveLaneEl(deckId)) drawPlaylistDeckWave(deckId);
      if (!deck.playing) return;
      updateTimeReadout(deckId);

      const pos = currentPos(deck);
      const rem = deck.duration - pos;

      // Check if we should initiate seamless transition to next deck
      if (!Studio.autoTransition && deck.duration > AUTO_TRANSITION_SEC * 1.5 && rem <= AUTO_TRANSITION_SEC) {
        const otherId = Studio.deckOrder.find((id) => id !== deckId) || (deckId === 1 ? 2 : 1);
        const otherDeck = getDeck(otherId);
        const nextTrack = window.getNextTrackAfter?.(deck.track);

        if (nextTrack && otherDeck) {
          if (!otherDeck.track || (otherDeck.track.key !== nextTrack.key && otherDeck.jobId !== nextTrack.jobId)) {
            if (window.isPlaylistTrackReady?.(nextTrack)) {
              window.loadTrackToDeck?.(nextTrack, otherId, { silent: true });
            }
          }
          if (otherDeck.duration > 0 && otherDeck.track) {
            otherDeck.deckVol = 0;
            applyDeckMixer(otherId);
            if (deck.bpm && otherDeck.bpm) {
              try { masterSyncAllDecks(deckId); } catch (_) {}
            }
            if (!otherDeck.playing) play(otherId);
            Studio.autoTransition = {
              fromId: deckId,
              toId: otherId,
              startCtxTime: nowCtx,
              dur: Math.max(2, rem),
            };
          }
        }
      }

      // Hard stop fallback if track ends without active transition
      if (pos >= deck.duration - 0.05 && !Studio.autoTransition) {
        pause(deckId);
        deck.offset = 0;
        deck.playStartedAt = null;
        const nextTrack = window.getNextTrackAfter?.(deck.track);
        if (nextTrack && window.isPlaylistTrackReady?.(nextTrack)) {
          const nextDeckId = Studio.deckOrder.find((id) => id !== deckId) || deckId;
          window.loadTrackToDeck?.(nextTrack, nextDeckId, { silent: true }).then(() => {
            play(nextDeckId);
          });
        }
      }
    });

    updatePlaylistSyncStatus();
    const keepRaf = anyDeckPlaying() || Studio.scratch.deckId != null || !!Studio.autoTransition;
    if (!keepRaf) {
      stopRaf();
      syncAudioContextPower();
      return;
    }
    Studio.raf = requestAnimationFrame(updateUI);
  }

  function resetDeck(deckId) {
    const d = getDeck(deckId);
    if (!d) return;
    cancelDeckTempoFade(deckId);
    deckTempoFadeRafs.delete(deckId);
    clearInterval(d.poll);
    disposeDeckAudio(deckId);
    Object.assign(d, createDeckState(deckId));
    // Keep other decks' waveforms animating: only stop the RAF loop if nothing
    // else is playing/scratching (ensureRafRunning handles both cases).
    ensureRafRunning();
    syncAudioContextPower();
    setDeckStatus("", false, deckId);
    updateDeckTitle(deckId);
    syncPlayButton(deckId);
    updateTimeReadout(deckId);
    clearRowPanes(deckId);
    toggleStemFilterPop(deckId, false);
    toggleDeckStemDrawer(deckId, false);
    const chips = $d(".deck-stem-filter-chips", deckId);
    if (chips) chips.innerHTML = "";
    updateStemRowsPlaceholder(deckId);
    if (deckId === Studio.focusedId) {
      resetFocusedMixerUI();
      S.mainVol = 1; S.loopVol = 1; S.mainMuted = false; S.loopMuted = false; S.cross = 0.5;
      S.deckVol = 1; S.deckMuted = false;
      syncMixerRackUI();
    } else {
      syncDeckStemRackUI(deckId);
    }
    buildDeckMixerUI();
    setStatus(anyDeckPlaying());
    updateStudioPanels();
    syncDeckTempoUI(deckId);
    window.updateNextTrackDisplay?.();
    refreshPlaylistWaveLanes();
  }

  function focusDeck(id, opts = {}) {
    if (!Studio.decks[id]) return;
    if (Studio.focusedId === id) {
      updateFocusUI();
      return;
    }
    Studio.focusedId = id;
    S = getDeck(id);
    updateFocusUI();
    syncMuteAllButton(id);
    syncDeckMixerUI();
    syncDeckLoopUI(S);
    updateDeckTitle(id);

    if (S.poll) {
      updateStudioPanels();
      updateStemRowsPlaceholder(id);
    } else if (S.sets.stems) {
      activateSet(S.mode === "simple" && S.sets.simple ? "simple" : "stems");
    } else if (S.sets.simple) {
      activateSet("simple");
    } else if (S.track && S.jobId != null) {
      buildDeckMixerUI();
      updateStudioPanels();
      updateStemRowsPlaceholder(id);
      if (opts.autoSep !== false) beginStemSeparation(id);
    } else {
      clearRowPanes(id);
      buildDeckMixerUI();
      updateStudioPanels();
      updateStemRowsPlaceholder(id);
    }
    syncMixerRackUI();
    ensureRafRunning();
    syncAllDeckLcds();
    syncAllDeckBpms();
    Studio.deckOrder.forEach((deckId) => updateTimeReadout(deckId));
    window.updateNextTrackDisplay?.();
  }

  function mountDeck(id) {
    const tpl = $("#deck-tpl");
    if (!tpl || deckEl(id)) return;
    const node = tpl.content.cloneNode(true);
    const section = node.querySelector(".deck");
    section.dataset.deckId = String(id);
    section.querySelector(".deck-num").textContent = String(id);
    section.querySelector(".deck-num-lcd").textContent = String(id);
    $("#decks").appendChild(node);
    if (!Studio.decks[id]) Studio.decks[id] = createDeckState(id);
    if (!Studio.deckOrder.includes(id)) Studio.deckOrder.push(id);
    wireDeck(id);
    applyWaveVisibility(id);
    updateStemRowsPlaceholder(id);
    updateModeButtons(id);
    updateDeckCountUI();
    updateDeckTitle(id);
    buildDeckMixerUI();
    if (id === Studio.focusedId) section.classList.add("focused");
  }

  function removeDeck(id) {
    if (Studio.deckOrder.length <= MIN_DECKS) return;
    resetDeck(id);
    delete Studio.decks[id];
    Studio.deckOrder = Studio.deckOrder.filter((x) => x !== id);
    deckEl(id)?.remove();
    if (Studio.focusedId === id) {
      focusDeck(Studio.deckOrder[0]);
    }
    window.onStudioRemoveDeck?.(id);
    updateDeckCountUI();
    buildDeckMixerUI();
  }

  function wireDeck(id) {
    const root = deckEl(id);
    if (!root || root.dataset.wired) return;
    root.dataset.wired = "1";
    initTransportIcons(id);
    wireDeckSeek(id);
    initDeckDotLoader(id);
    syncDeckTempoUI(id);

    root.addEventListener("click", (e) => {
      if (e.target.closest("button, input")) return;
      focusDeck(id);
    });

    $d(".st-cue", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (id !== Studio.focusedId) focusDeck(id);
      stopCue(id);
    });
    $d(".st-play", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (id !== Studio.focusedId) focusDeck(id);
      const d = getDeck(id);
      d.playing ? pause(id) : play(id);
    });
    $d(".st-muteall", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMuteAll(id);
    });
    $d(".st-reset", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      resetMix(id);
    });
    $d(".deck-stems-toggle", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDeckStemDrawer(id);
    });
    $d(".deck-tempo", id)?.addEventListener("input", (e) => {
      e.stopPropagation();
      if (deckTempoUiSilent.has(id)) return;
      setDeckTempo(id, parseFloat(e.target.value), { live: true });
      updatePlaylistSyncStatus();
    });
    $d(".deck-tempo-reset", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (id !== Studio.focusedId) focusDeck(id);
      resetDeckTempoSmooth(id);
    });
    $d(".deck-st-mode-toggle", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      const d = getDeck(id);
      setMode(d.mode === "stems" ? "simple" : "stems", id);
    });
    $d(".deck-stem-show", id)?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (id !== Studio.focusedId) focusDeck(id);
      toggleStemFilterPop(id);
    });
    $d(".deck-st-download", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadDeckMix(id);
    });
    root.querySelectorAll(".loop-len .seg").forEach((b) => {
      b.addEventListener("click", () => {
        if (id !== Studio.focusedId) focusDeck(id);
        S.loopBars = parseInt(b.dataset.bars, 10) || 4;
        root.querySelectorAll(".loop-len .seg").forEach((x) => x.classList.toggle("on", x === b));
      });
    });
    $d(".deck-remove", id)?.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDeck(id);
    });
  }

  async function downloadDeckMix(deckId = Studio.focusedId) {
    if (deckId !== Studio.focusedId) focusDeck(deckId);
    const d = getDeck(deckId);
    const chosen = d.order.filter((n) => d.stems[n]?.include);
    if (!chosen.length) {
      setDeckErr("Tick at least one stem to include.");
      return;
    }
    clearDeckErr();
    const btn = $d(".deck-st-download", deckId);
    if (!btn) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Mixing…";
    try {
      const info = await api(`/api/stems/${d.stemId}/mix`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stems: chosen, title: d.track.title || `Track ${d.track.index}`, artist: "" }),
      });
      const a = document.createElement("a");
      a.href = `/api/stems/${d.stemId}/download/${encodeURIComponent(info.filename)}`;
      a.download = info.filename;
      document.body.appendChild(a); a.click(); a.remove();
      toast(`Downloaded ${chosen.join(" + ")}.`);
    } catch (err) {
      setDeckErr(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  // focused deck MAIN/LOOP crossfade
  $("#rxfader")?.addEventListener("input", (e) => { S.cross = parseFloat(e.target.value); applyDeckMixer(Studio.focusedId); });
  $("#fxloop-vol")?.addEventListener("input", (e) => {
    Studio.fxLoopVol = parseFloat(e.target.value);
    applyAllDeckMixers();
  });
  $("#fxloop-mute")?.addEventListener("click", () => {
    Studio.fxLoopMuted = !Studio.fxLoopMuted;
    const b = $("#fxloop-mute");
    if (b) {
      syncRdeckMuteIcon(b, Studio.fxLoopMuted);
      b.classList.toggle("on", Studio.fxLoopMuted);
    }
    applyAllDeckMixers();
  });
  $("#master-vol")?.addEventListener("input", (e) => {
    Studio.masterVol = parseFloat(e.target.value);
    applyMasterOutput();
  });
  $("#master-mute")?.addEventListener("click", () => {
    Studio.masterMuted = !Studio.masterMuted;
    const b = $("#master-mute");
    if (b) {
      syncRdeckMuteIcon(b, Studio.masterMuted);
      b.classList.toggle("on", Studio.masterMuted);
    }
    applyMasterOutput();
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".stem-show-wrap")) return;
    Studio.deckOrder.forEach((id) => toggleStemFilterPop(id, false));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    Studio.deckOrder.forEach((id) => {
      toggleStemFilterPop(id, false);
    });
  });

  $("#add-deck")?.addEventListener("click", () => {
    if (Studio.deckOrder.length >= MAX_DECKS) return;
    const id = Studio.nextId++;
    mountDeck(id);
    focusDeck(id);
  });

  $("#mixer-sync")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void masterSyncAllDecks();
    e.currentTarget.classList.add("on");
    setTimeout(() => e.currentTarget.classList.remove("on"), 600);
  });

  mountDeck(1);
  mountDeck(2);
  S = Studio.decks[1];
  buildDeckMixerUI();
  applyWaveVisibility(1);
  updateStemRowsPlaceholder(1);
  syncMixerRackUI();
  updateFocusUI();
  updateDeckCountUI();
  window.autoFillPlaylistToDecks?.();
})();