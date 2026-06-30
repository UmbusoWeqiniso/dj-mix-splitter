// Apple Music — MusicKit playback via pasted links (no load-modal UI).
(function () {
  const AM = {
    ready: false,
    configured: false,
    authorized: false,
    storefront: "us",
    music: null,
    playingKey: null,
    scriptLoaded: false,
  };

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

  function loadMusicKitScript() {
    if (AM.scriptLoaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
      s.async = true;
      s.onload = () => { AM.scriptLoaded = true; resolve(); };
      s.onerror = () => reject(new Error("Could not load MusicKit JS."));
      document.head.appendChild(s);
    });
  }

  async function waitForMusicKit() {
    if (window.MusicKit) return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("MusicKit timed out.")), 15000);
      document.addEventListener("musickitloaded", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  function songAttrs(song) {
    const a = song.attributes || {};
    const art = a.artwork || {};
    const urlTpl = art.url || "";
    const artworkUrl = urlTpl ? urlTpl.replace("{w}", "88").replace("{h}", "88") : "";
    return {
      catalogId: song.id,
      title: a.name || "Unknown",
      artist: a.artistName || "",
      album: a.albumName || "",
      duration: (a.durationInMillis || 0) / 1000,
      artworkUrl,
      url: a.url || "",
    };
  }

  function parseAppleMusicUrl(raw) {
    let u;
    try { u = new URL(raw.trim()); } catch (_) { return null; }
    if (!/\.?music\.apple\.com$/i.test(u.hostname.replace(/^www\./, ""))
        && u.hostname !== "music.apple.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const songIdx = parts.indexOf("song");
    if (songIdx >= 0 && parts[songIdx + 2]) return { id: parts[songIdx + 2] };
    const i = u.searchParams.get("i");
    if (i) return { id: i };
    return null;
  }

  async function configureMusicKit() {
    const { token } = await api("/api/apple-music/token");
    await loadMusicKitScript();
    await waitForMusicKit();
    await MusicKit.configure({
      developerToken: token,
      app: { name: "Mix Station", build: "1.0.0" },
    });
    AM.music = MusicKit.getInstance();
    AM.ready = true;
    AM.authorized = AM.music.isAuthorized;
    bindPlayerEvents();
  }

  function bindPlayerEvents() {
    if (!AM.music) return;
    AM.music.addEventListener("playbackStateDidChange", () => {
      if (window.refreshHealth) window.refreshHealth();
      if (window.refreshServicesPanel) window.refreshServicesPanel();
      if (window.updatePreviewButtons) window.updatePreviewButtons();
    });
    AM.music.addEventListener("mediaItemDidChange", () => {
      if (window.refreshHealth) window.refreshHealth();
      if (window.refreshServicesPanel) window.refreshServicesPanel();
      if (window.updatePreviewButtons) window.updatePreviewButtons();
    });
  }

  async function initAppleMusic() {
    try {
      const st = await api("/api/apple-music/status");
      AM.configured = !!st.configured;
      AM.storefront = st.storefront || "us";
    } catch (_) {
      AM.configured = false;
    }
    if (!AM.configured) {
      if (window.refreshHealth) window.refreshHealth();
      if (window.refreshServicesPanel) window.refreshServicesPanel();
      return;
    }
    try {
      await configureMusicKit();
    } catch (e) {
      toast(e.message, true);
    }
    if (window.refreshHealth) window.refreshHealth();
  }

  async function ensureAuthorized() {
    if (!AM.ready || !AM.music) throw new Error("Apple Music is not configured.");
    if (AM.authorized) return;
    try {
      await AM.music.authorize();
      AM.authorized = true;
      if (window.refreshHealth) window.refreshHealth();
      if (window.refreshServicesPanel) window.refreshServicesPanel();
    } catch (e) {
      throw new Error(e.message || "Apple Music sign-in required.");
    }
  }

  async function connect() {
    if (!AM.configured) {
      toast("Apple Music is not configured on the server.", true);
      return;
    }
    if (!AM.ready || !AM.music) {
      toast("Apple Music is not ready yet.", true);
      return;
    }
    if (AM.authorized) {
      try { await AM.music.unauthorize(); } catch (_) {}
      AM.authorized = false;
      AM.playingKey = null;
      if (window.refreshHealth) window.refreshHealth();
      if (window.refreshServicesPanel) window.refreshServicesPanel();
      toast("Apple Music disconnected.");
      return;
    }
    try {
      await ensureAuthorized();
      toast("Apple Music connected — paste a music.apple.com link to add tracks.");
    } catch (e) {
      toast(e.message, true);
    }
    if (window.refreshHealth) window.refreshHealth();
  }

  async function lookupSong(id) {
    const song = await api(`/api/apple-music/songs/${encodeURIComponent(id)}`);
    return songAttrs(song);
  }

  function playlistItemFromSong(song) {
    return {
      key: `am:${song.catalogId}`,
      source: "apple-music",
      catalogId: song.catalogId,
      title: song.title,
      artist: song.artist,
      mix: "Apple Music",
      start: 0,
      end: song.duration || 0,
      artworkUrl: song.artworkUrl,
      url: song.url,
    };
  }

  async function playItem(it) {
    if (!AM.ready || !AM.music) throw new Error("Apple Music is not configured.");
    await ensureAuthorized();
    await AM.music.setQueue({ song: it.catalogId });
    await AM.music.play();
    AM.playingKey = it.key;
  }

  async function toggleItem(it) {
    if (!AM.music) return;
    const now = AM.music.nowPlayingItem;
    const same = AM.playingKey === it.key && now;
    if (same && !AM.music.isPlaying) {
      await AM.music.play();
      return;
    }
    if (same && AM.music.isPlaying) {
      AM.music.pause();
      return;
    }
    await playItem(it);
  }

  function stopPlayback() {
    if (!AM.music) return;
    try { AM.music.stop(); } catch (_) {}
    AM.playingKey = null;
  }

  function isPlayingKey(key) {
    return !!(AM.music && AM.playingKey === key && AM.music.isPlaying);
  }

  async function openAppleUrl(url) {
    const hit = parseAppleMusicUrl(url);
    if (!hit) return false;
    try {
      const song = await lookupSong(hit.id);
      const it = playlistItemFromSong(song);
      if (window.addToPlaylist) window.addToPlaylist(it);
      try { await playItem(it); } catch (e) { toast(e.message, true); }
      return true;
    } catch (e) {
      toast(e.message, true);
      return true;
    }
  }

  window.AppleMusic = {
    init: initAppleMusic,
    connect,
    parseUrl: parseAppleMusicUrl,
    openUrl: openAppleUrl,
    playItem,
    toggleItem,
    stop: stopPlayback,
    isPlayingKey,
    isItem: (it) => it && it.source === "apple-music",
    configured: () => AM.configured,
    authorized: () => AM.authorized,
  };

  initAppleMusic();
})();
