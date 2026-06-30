// Settings panel — stem separation quality, mix split defaults, services.
(function () {
  const $ = (s) => document.querySelector(s);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const QUALITY_KEY = "mixstation.stemQuality";
  const SENS_KEY = "mixstation.defaultSensitivity";

  const QUALITY_NOTES = {
    vocal: "Vocal — 2 stems (vocals + instrumental), fastest. Best for acapellas/instrumentals.",
    fast: "Fast — 5 stems (vocals, kick, drums, bass, other), about 1 min per track.",
    balanced: "Balanced — 8 stems, about 2–3 min per track. Recommended default.",
    high: "High quality runs the AI model twice to reduce bleed. Expect roughly 4–8 min per track.",
  };
  const QUALITIES = ["vocal", "fast", "balanced", "high"];

  let servicesData = null;
  let storageData = null;

  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
    return `${b} B`;
  }

  function renderStorage() {
    const summary = $("#storage-summary");
    const breakdown = $("#storage-breakdown");
    const mixes = $("#storage-mixes");
    if (!summary || !breakdown || !mixes) return;
    if (!storageData) {
      summary.textContent = "Could not load storage info.";
      breakdown.innerHTML = "";
      mixes.innerHTML = "";
      return;
    }
    summary.textContent = `${formatBytes(storageData.total_bytes)} across ${storageData.mix_count} mix${storageData.mix_count === 1 ? "" : "es"}`;
    const bd = storageData.breakdown || {};
    const labels = [
      ["source", "Source"],
      ["stems", "Stems"],
      ["regions", "Previews"],
      ["tracks", "Exports"],
      ["other", "Other"],
    ];
    breakdown.innerHTML = labels
      .filter(([k]) => bd[k])
      .map(([k, label]) => `<span><strong>${escapeHtml(label)}</strong> ${escapeHtml(formatBytes(bd[k]))}</span>`)
      .join("");
    const top = (storageData.per_mix || []).slice(0, 8);
    mixes.innerHTML = top.map((m) => {
      const meta = [
        formatBytes(m.bytes),
        m.stem_bytes ? `stems ${formatBytes(m.stem_bytes)}` : null,
        m.region_bytes ? `previews ${formatBytes(m.region_bytes)}` : null,
      ].filter(Boolean).join(" · ");
      const canClear = m.stem_bytes > 0;
      return `
        <div class="storage-mix" data-id="${escapeHtml(m.id)}">
          <div class="storage-mix-info">
            <div class="storage-mix-title" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</div>
            <div class="storage-mix-meta muted">${escapeHtml(meta)}</div>
          </div>
          ${canClear
            ? `<button type="button" class="ghost storage-clear-stems" data-id="${escapeHtml(m.id)}">Clear stems</button>`
            : ""}
        </div>`;
    }).join("") || `<p class="muted small">No mixes on disk yet.</p>`;

    mixes.querySelectorAll(".storage-clear-stems").forEach((btn) => {
      btn.addEventListener("click", () => clearStemsForMix(btn.dataset.id, btn));
    });
  }

  async function loadStorage() {
    storageData = await api("/api/storage");
    renderStorage();
  }

  async function clearStemsForMix(jobId, btn) {
    if (!jobId) return;
    btn.disabled = true;
    try {
      const res = await api("/api/storage/clear-stems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      toast(`Cleared ${formatBytes(res.cleared_bytes || 0)} of stems.`);
      await loadStorage();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  }

  async function cleanupRegions() {
    const btn = $("#storage-cleanup-regions");
    if (btn) btn.disabled = true;
    try {
      const res = await api("/api/storage/cleanup-regions", { method: "POST" });
      toast(`Removed ${formatBytes(res.cleared_bytes || 0)} of cached preview clips.`);
      await loadStorage();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function loadQuality() {
    const q = localStorage.getItem(QUALITY_KEY);
    if (QUALITIES.includes(q)) return q;
    return "balanced";
  }

  function loadDefaultSensitivity() {
    const v = localStorage.getItem(SENS_KEY);
    if (v == null || v === "") return 5;
    const n = Number(v);
    return Number.isFinite(n) ? n : 5;
  }

  function syncQualityUi() {
    document.querySelectorAll(".settings-quality .seg").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.quality === window.currentQuality);
    });
    const note = $("#settings-quality-note");
    if (note) note.textContent = QUALITY_NOTES[window.currentQuality] || "";
  }

  function setQuality(q) {
    if (!QUALITIES.includes(q)) return;
    localStorage.setItem(QUALITY_KEY, q);
    window.currentQuality = q;
    syncQualityUi();
  }

  function setDefaultSensitivity(value) {
    localStorage.setItem(SENS_KEY, String(value));
    const valEl = $("#settings-sens-val");
    if (valEl) valEl.textContent = value;
  }

  window.currentQuality = loadQuality();
  syncQualityUi();

  window.getDefaultSensitivity = loadDefaultSensitivity;

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
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

  function serviceConnected(svc) {
    if (svc.id === "apple_music" && window.AppleMusic) return AppleMusic.authorized();
    if (svc.id === "spotify" && window.Spotify) return Spotify.connected();
    return !!svc.connected;
  }

  function statusLabel(svc) {
    const connected = serviceConnected(svc);
    if (svc.group === "load") {
      return svc.configured ? "Ready" : "Needs ffmpeg";
    }
    if (!svc.configured) return "Not configured";
    return connected ? "Connected" : "Not connected";
  }

  function statusClass(svc) {
    const connected = serviceConnected(svc);
    if (svc.group === "load") return svc.configured ? "ok" : "bad";
    if (!svc.configured) return "";
    return connected ? "ok" : "warn";
  }

  function renderServiceCard(svc) {
    const st = statusLabel(svc);
    const cls = statusClass(svc);
    const connected = serviceConnected(svc);
    const canConnect = svc.id === "spotify" || svc.id === "apple_music";
    let action = "";
    if (canConnect && svc.configured) {
      action = connected
        ? `<button type="button" class="ghost svc-disconnect" data-id="${escapeHtml(svc.id)}">Disconnect</button>`
        : `<button type="button" class="primary svc-connect" data-id="${escapeHtml(svc.id)}">Connect</button>`;
    } else if (canConnect && !svc.configured) {
      action = `<span class="muted small svc-hint">Add keys to .env</span>`;
    }
    const account = svc.account
      ? `<span class="svc-account">${escapeHtml(svc.account)}</span>`
      : (svc.id === "apple_music" && window.AppleMusic && AppleMusic.authorized()
        ? `<span class="svc-account">Signed in</span>` : "");
    const caps = [
      svc.can_split ? "Split" : null,
      svc.can_play ? "Play" : null,
    ].filter(Boolean).join(" · ");
    const env = (svc.env || []).length
      ? `<details class="svc-env"><summary class="muted small">Setup (.env)</summary><code class="svc-env-code">${(svc.env || []).map(escapeHtml).join("\n")}</code></details>`
      : "";
    return `
      <article class="svc-card" data-id="${escapeHtml(svc.id)}">
        <div class="svc-card-head">
          <span class="svc-name">${escapeHtml(svc.name)}</span>
          <span class="pill svc-pill ${cls}">${escapeHtml(st)}</span>
        </div>
        ${account}
        <p class="svc-note muted small">${escapeHtml(svc.note)}</p>
        ${caps ? `<p class="svc-caps muted small">${escapeHtml(caps)}</p>` : ""}
        ${env}
        <div class="svc-actions">${action}</div>
      </article>`;
  }

  function renderServices() {
    const list = $("#services-list");
    if (!list || !servicesData) return;
    const groups = [
      { key: "load", title: "Load & split" },
      { key: "stream", title: "Streaming" },
      { key: "tool", title: "Tools" },
    ];
    list.innerHTML = groups.map((g) => {
      const items = (servicesData.services || []).filter((s) => s.group === g.key);
      if (!items.length) return "";
      return `
        <section class="svc-group">
          <h4 class="svc-group-title">${escapeHtml(g.title)}</h4>
          <div class="svc-grid">${items.map(renderServiceCard).join("")}</div>
        </section>`;
    }).join("");

    list.querySelectorAll(".svc-connect").forEach((btn) => {
      btn.addEventListener("click", () => connectService(btn.dataset.id));
    });
    list.querySelectorAll(".svc-disconnect").forEach((btn) => {
      btn.addEventListener("click", () => disconnectService(btn.dataset.id));
    });
  }

  async function loadServices() {
    servicesData = await api("/api/services");
    renderServices();
  }

  function refreshPanel() {
    syncQualityUi();
    if (servicesData) renderServices();
    if (storageData) renderStorage();
  }

  window.refreshSettingsPanel = refreshPanel;
  window.refreshServicesPanel = refreshPanel;

  function togglePanel(force) {
    const m = $("#settings-panel");
    if (!m) return;
    const show = force !== undefined ? force : m.classList.contains("hidden");
    m.classList.toggle("hidden", !show);
    if (show) {
      syncQualityUi();
      loadServices().catch((e) => toast(e.message, true));
      loadStorage().catch((e) => toast(e.message, true));
    }
  }

  async function connectService(id) {
    if (id === "apple_music") {
      if (window.AppleMusic) await AppleMusic.connect();
      renderServices();
      return;
    }
    if (id === "spotify") {
      try {
        const { url } = await api("/api/services/spotify/login");
        window.location.href = url;
      } catch (e) {
        toast(e.message, true);
      }
    }
  }

  async function disconnectService(id) {
    if (id === "apple_music") {
      if (window.AppleMusic) await AppleMusic.connect();
      renderServices();
      return;
    }
    if (id === "spotify") {
      try {
        await api("/api/services/spotify/disconnect", { method: "POST" });
        if (window.Spotify) await Spotify.refreshStatus();
        toast("Spotify disconnected.");
        renderServices();
      } catch (e) {
        toast(e.message, true);
      }
    }
  }

  function handleOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("services");
    if (!flag) return;
    if (flag === "spotify-connected") {
      toast("Spotify connected.");
      if (window.Spotify) Spotify.refreshStatus();
      togglePanel(true);
    } else if (flag === "spotify-error") {
      toast(params.get("msg") || "Spotify sign-in failed.", true);
      togglePanel(true);
    }
    params.delete("services");
    params.delete("msg");
    const q = params.toString();
    const clean = window.location.pathname + (q ? `?${q}` : "") + window.location.hash;
    window.history.replaceState({}, "", clean);
  }

  document.querySelectorAll(".settings-quality .seg").forEach((btn) => {
    btn.addEventListener("click", () => setQuality(btn.dataset.quality));
  });

  const sensInput = $("#settings-sensitivity");
  if (sensInput) {
    sensInput.value = loadDefaultSensitivity();
    setDefaultSensitivity(sensInput.value);
    sensInput.addEventListener("input", (e) => setDefaultSensitivity(e.target.value));
  }

  $("#settings-open")?.addEventListener("click", () => togglePanel(true));
  $("#settings-close")?.addEventListener("click", () => togglePanel(false));
  $("#storage-cleanup-regions")?.addEventListener("click", () => cleanupRegions());
  $("#settings-panel")?.addEventListener("click", (e) => {
    if (e.target.id === "settings-panel") togglePanel(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const panel = $("#settings-panel");
    if (panel && !panel.classList.contains("hidden")) togglePanel(false);
  });

  window.openSettingsPanel = () => togglePanel(true);
  window.openServicesPanel = () => togglePanel(true);

  handleOAuthReturn();
})();
