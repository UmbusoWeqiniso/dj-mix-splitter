// DJ Mixer: two decks, Web Audio playback, scrolling beat-gridded waveforms,
// crossfader, per-deck tempo, and one-tap BPM auto-sync (beatmatch).
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const mod = (x, m) => ((x % m) + m) % m;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  const PPS = 100;            // waveform peaks computed per second
  const WINDOW_SEC = 6;       // seconds of track visible across the canvas
  const ACCENT = { A: "#27dfe0", B: "#ff4d8d" };

  const M = {
    jobId: null, data: null, duration: 0,
    ctx: null, master: null,
    decks: {}, xfade: 0.5, raf: null, open: false, autoSync: true,
  };

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "toast" + (bad ? " bad" : "");
    el.textContent = msg; document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
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

  function newDeck(id) {
    const root = $(`.deck[data-deck="${id}"]`);
    const gain = M.ctx.createGain();
    const xgain = M.ctx.createGain();
    // 3-band EQ: source -> low(shelf) -> mid(peaking) -> high(shelf) -> gain -> xgain
    const low = M.ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 120;
    const mid = M.ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
    const high = M.ctx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4000;
    low.connect(mid); mid.connect(high); high.connect(gain);
    gain.connect(xgain); xgain.connect(M.master);
    const canvas = root.querySelector(".deck-wave");
    return {
      id, root, gain, xgain, eqIn: low, eq: { lo: low, mid, hi: high },
      canvas, ctx2d: canvas.getContext("2d"),
      track: null, buffer: null, peaks: null, len: 0,
      source: null, playing: false, offset: 0, startCtxTime: 0,
      rate: 1, tempoPct: 0, bpm: 0, beatOffset: 0,
      vol: 1, loadToken: 0,
    };
  }

  function deckPos(d) {
    if (!d.playing) return d.offset;
    return clamp(d.offset + (M.ctx.currentTime - d.startCtxTime) * d.rate, 0, d.len);
  }

  // ---------- transport ----------
  function startSource(d) {
    const src = M.ctx.createBufferSource();
    src.buffer = d.buffer;
    src.playbackRate.value = d.rate;
    src.connect(d.eqIn);
    src.onended = () => {
      // only react to a natural end (source still the current one)
      if (d.source === src && d.playing && deckPos(d) >= d.len - 0.05) {
        d.playing = false; d.offset = 0; d.source = null;
        setPlayBtn(d);
        ensureMixerRaf();
      }
    };
    src.start(0, clamp(d.offset, 0, Math.max(0, d.buffer.duration - 0.01)));
    d.source = src;
    d.startCtxTime = M.ctx.currentTime;
  }
  function stopSource(d) {
    if (d.source) { try { d.source.onended = null; d.source.stop(); } catch (_) {} d.source.disconnect(); d.source = null; }
  }
  function playDeck(d) {
    if (!d.buffer) return;
    if (M.ctx.state === "suspended") M.ctx.resume();
    if (d.offset >= d.len) d.offset = 0;
    startSource(d); d.playing = true; setPlayBtn(d);
    ensureMixerRaf();
  }
  function pauseDeck(d) {
    if (!d.playing) return;
    d.offset = deckPos(d); stopSource(d); d.playing = false; setPlayBtn(d);
    ensureMixerRaf();
  }
  function seekDeck(d, t) {
    const was = d.playing;
    if (d.playing) { stopSource(d); d.playing = false; }
    d.offset = clamp(t, 0, d.len);
    if (was) playDeck(d); else setPlayBtn(d);
  }
  function setPlayBtn(d) { d.root.querySelector(".play").textContent = d.playing ? "⏸" : "▶"; }

  function setTempo(d, pct) {
    d.tempoPct = pct;
    const pos = deckPos(d);
    d.rate = 1 + pct / 100;
    if (d.playing) { d.offset = pos; d.startCtxTime = M.ctx.currentTime; }
    if (d.source) d.source.playbackRate.value = d.rate;
    d.root.querySelector(".tempo").value = pct;
    d.root.querySelector(".rate-pill").textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  }

  function syncDeck(d, silent) {
    const o = M.decks[d.id === "A" ? "B" : "A"];
    if (!d.bpm || !o.bpm) { if (!silent) toast("Need a BPM on both decks to sync.", true); return; }
    const targetEff = o.bpm * o.rate;
    let rate = targetEff / d.bpm;
    rate = clamp(rate, 0.8, 1.2);
    setTempo(d, (rate - 1) * 100);
    // phase-align so beats land together (only meaningful if the other deck plays)
    if (o.playing) {
      const intO = 60 / o.bpm, intD = 60 / d.bpm;
      const posO = deckPos(o), posD = deckPos(d);
      const phaseO = mod(posO - o.beatOffset, intO) / intO;
      const phaseD = mod(posD - d.beatOffset, intD) / intD;
      let diff = phaseO - phaseD;
      diff = diff - Math.round(diff); // wrap to [-0.5, 0.5]
      seekDeck(d, clamp(posD + diff * intD, 0, d.len));
    }
    if (!silent) toast(`Deck ${d.id} synced to ${Math.round(targetEff)} BPM.`);
  }

  // ---------- loading ----------
  function buildPeaks(buffer) {
    const ch = buffer.getChannelData(0);
    const n = Math.max(1, Math.round(buffer.duration * PPS));
    const peaks = new Float32Array(n);
    const step = ch.length / n;
    let gmax = 1e-6;
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.floor((i + 1) * step);
      let mx = 0;
      for (let j = a; j < b; j++) { const v = Math.abs(ch[j]); if (v > mx) mx = v; }
      peaks[i] = mx; if (mx > gmax) gmax = mx;
    }
    for (let i = 0; i < n; i++) peaks[i] /= gmax;
    return peaks;
  }

  async function loadDeck(d, trackIdx) {
    const t = M.data.tracks[trackIdx];
    if (!t) return;
    const token = ++d.loadToken;
    stopSource(d); d.playing = false; d.offset = 0;
    d.track = t; d.len = t.end - t.start;
    setTempo(d, 0);
    d.bpm = 0; d.beatOffset = 0;
    d.root.querySelector(".deck-pick").value = String(trackIdx);
    d.root.querySelector(".bpm-val").textContent = "…";
    setPlayBtn(d);
    try {
      const buf = await (await fetch(`/api/jobs/${M.jobId}/region?start=${t.start}&end=${t.end}`)).arrayBuffer();
      if (token !== d.loadToken) return;
      d.buffer = await M.ctx.decodeAudioData(buf);
      if (token !== d.loadToken) return;
      d.len = d.buffer.duration;
      d.peaks = buildPeaks(d.buffer);
    } catch (e) {
      toast(`Deck ${d.id}: ${e.message}`, true);
      return;
    }
    // BPM (cached server-side)
    try {
      const r = await api(`/api/jobs/${M.jobId}/bpm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: t.start, end: t.end }),
      });
      if (token !== d.loadToken) return;
      d.bpm = r.bpm || 0; d.beatOffset = r.beat_offset || 0;
    } catch (e) {
      if (token === d.loadToken) d.root.querySelector(".bpm-val").textContent = "?";
    }
    updateDeckMeta(d);
    // auto beat-match the freshly loaded deck to the other deck
    if (M.autoSync) {
      const o = M.decks[d.id === "A" ? "B" : "A"];
      if (o && o.bpm && d.bpm) syncDeck(d, true);
    }
  }

  function updateDeckMeta(d) {
    const eff = d.bpm ? d.bpm * d.rate : 0;
    d.root.querySelector(".bpm-val").textContent = eff ? eff.toFixed(1) : "—";
  }

  // ---------- gains ----------
  function applyGains() {
    // equal-power crossfade
    const a = Math.cos(M.xfade * Math.PI / 2);
    const b = Math.cos((1 - M.xfade) * Math.PI / 2);
    if (M.decks.A) M.decks.A.xgain.gain.value = a;
    if (M.decks.B) M.decks.B.xgain.gain.value = b;
    if (M.decks.A) M.decks.A.gain.gain.value = M.decks.A.vol;
    if (M.decks.B) M.decks.B.gain.gain.value = M.decks.B.vol;
  }

  // ---------- render loop ----------
  function drawDeck(d) {
    const c = d.canvas, g = d.ctx2d;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 800, cssH = 120;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const mid = cssH / 2;
    const pos = d.track ? deckPos(d) : 0;
    const t0 = pos - WINDOW_SEC / 2, t1 = pos + WINDOW_SEC / 2;
    const pxPerSec = cssW / WINDOW_SEC;

    // beat grid
    if (d.bpm) {
      const interval = 60 / d.bpm;
      let k = Math.ceil((t0 - d.beatOffset) / interval);
      for (let tb = d.beatOffset + k * interval; tb <= t1; tb += interval, k++) {
        const x = (tb - pos) * pxPerSec + cssW / 2;
        const downbeat = mod(k, 4) === 0;
        g.strokeStyle = downbeat ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.12)";
        g.lineWidth = downbeat ? 1.5 : 1;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, cssH); g.stroke();
      }
    }

    // waveform
    if (d.peaks) {
      g.fillStyle = ACCENT[d.id];
      const i0 = Math.max(0, Math.floor(t0 * PPS));
      const i1 = Math.min(d.peaks.length - 1, Math.ceil(t1 * PPS));
      const bw = Math.max(1, pxPerSec / PPS);
      for (let i = i0; i <= i1; i++) {
        const tt = i / PPS;
        const x = (tt - pos) * pxPerSec + cssW / 2;
        const h = d.peaks[i] * (cssH * 0.46);
        g.fillRect(x, mid - h, bw, h * 2);
      }
    }

    // center playhead
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(cssW / 2, 0); g.lineTo(cssW / 2, cssH); g.stroke();

    // time + effective bpm
    if (d.track) {
      d.root.querySelector(".deck-time").textContent = `${fmt(pos)} / ${fmt(d.len)}`;
      updateDeckMeta(d);
    }
  }

  function loop() {
    if (!M.open) return;
    drawDeck(M.decks.A);
    drawDeck(M.decks.B);
    if (M.decks.A?.playing || M.decks.B?.playing) {
      M.raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(M.raf);
      M.raf = null;
    }
  }

  function ensureMixerRaf() {
    if (!M.open) return;
    if (M.decks.A?.playing || M.decks.B?.playing) {
      if (!M.raf) loop();
    } else {
      cancelAnimationFrame(M.raf);
      M.raf = null;
      drawDeck(M.decks.A);
      drawDeck(M.decks.B);
    }
  }

  // ---------- wiring ----------
  function setEq(d, band, db) {
    if (d.eq && d.eq[band]) d.eq[band].gain.value = db;
    const slider = d.root.querySelector(`.eq-${band}`);
    if (slider && parseFloat(slider.value) !== db) slider.value = db;
    const kill = d.root.querySelector(`.eq-kill[data-band="${band}"]`);
    if (kill) kill.classList.toggle("on", db <= -26);
  }

  function wireDeck(d) {
    d.root.querySelector(".play").onclick = () => { d.playing ? pauseDeck(d) : playDeck(d); };
    d.root.querySelector(".cue").onclick = () => seekDeck(d, 0);
    d.root.querySelector(".sync").onclick = () => syncDeck(d);
    d.root.querySelector(".tempo").oninput = (e) => setTempo(d, parseFloat(e.target.value));
    d.root.querySelector(".vol").oninput = (e) => { d.vol = parseFloat(e.target.value); applyGains(); };
    d.root.querySelector(".deck-pick").onchange = (e) => loadDeck(d, parseInt(e.target.value, 10));
    ["hi", "mid", "lo"].forEach((band) => {
      d.root.querySelector(`.eq-${band}`).oninput = (e) => setEq(d, band, parseFloat(e.target.value));
      d.root.querySelector(`.eq-kill[data-band="${band}"]`).onclick = () => {
        const cur = d.eq[band].gain.value;
        setEq(d, band, cur <= -26 ? 0 : -26);  // toggle kill / unity
      };
    });
    // click waveform to scrub within the visible window
    d.canvas.onpointerdown = (e) => {
      if (!d.track) return;
      const rect = d.canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width - 0.5;
      seekDeck(d, deckPos(d) + frac * WINDOW_SEC);
    };
  }

  function fillPicker(d) {
    const sel = d.root.querySelector(".deck-pick");
    sel.innerHTML = "";
    M.data.tracks.forEach((t, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = `${t.index}. ${t.title || "Track " + t.index}`;
      sel.appendChild(o);
    });
  }

  window.openMixer = async function (jobId, data, duration, opts) {
    opts = opts || {};
    const reuse = M.open && M.jobId === jobId && M.ctx;
    M.jobId = jobId; M.data = data; M.duration = duration;

    if (!reuse) {
      teardown();
      M.ctx = new (window.AudioContext || window.webkitAudioContext)();
      M.master = M.ctx.createGain();
      M.master.gain.value = parseFloat($("#master-vol").value);
      M.master.connect(M.ctx.destination);
      M.decks.A = newDeck("A");
      M.decks.B = newDeck("B");
      wireDeck(M.decks.A); wireDeck(M.decks.B);
      M.xfade = parseFloat($("#xfader").value);
      applyGains();
    }
    fillPicker(M.decks.A); fillPicker(M.decks.B);

    $("#mixer").classList.remove("hidden");
    M.open = true;
    cancelAnimationFrame(M.raf);
    ensureMixerRaf();

    // initial load
    if (opts.loadIndex != null) {
      const idx = M.data.tracks.findIndex((t) => t.index === opts.loadIndex);
      const target = (!M.decks.A.track) ? M.decks.A : (!M.decks.B.track ? M.decks.B : M.decks.A);
      await loadDeck(target, idx >= 0 ? idx : 0);
    } else if (!reuse) {
      await loadDeck(M.decks.A, 0);
      if (M.data.tracks.length > 1) await loadDeck(M.decks.B, 1);
    }
  };

  function teardown() {
    cancelAnimationFrame(M.raf);
    ["A", "B"].forEach((id) => { if (M.decks[id]) stopSource(M.decks[id]); });
    if (M.ctx) { try { M.ctx.close(); } catch (_) {} }
    M.ctx = null; M.master = null; M.decks = {};
  }

  function closeMixer() {
    M.open = false;
    teardown();
    $("#mixer").classList.add("hidden");
  }

  // global controls
  $("#auto-sync").addEventListener("click", (e) => {
    M.autoSync = !M.autoSync;
    e.currentTarget.classList.toggle("on", M.autoSync);
    const scr = $("#auto-sync-screen");
    if (scr) { scr.textContent = `AUTO-SYNC ${M.autoSync ? "ON" : "OFF"}`; scr.classList.toggle("off", !M.autoSync); }
    if (M.autoSync && M.decks.B && M.decks.B.bpm && M.decks.A && M.decks.A.bpm) syncDeck(M.decks.B, true);
  });
  $("#xfader").addEventListener("input", (e) => { M.xfade = parseFloat(e.target.value); applyGains(); });
  $("#master-vol").addEventListener("input", (e) => { if (M.master) M.master.gain.value = parseFloat(e.target.value); });
  $("#mixer-close").addEventListener("click", closeMixer);
  $("#mixer").addEventListener("click", (e) => { if (e.target.id === "mixer") closeMixer(); });
})();
