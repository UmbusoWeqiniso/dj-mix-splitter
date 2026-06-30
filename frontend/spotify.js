// Spotify — catalog links + playlist (playback opens in Spotify; no split/stem).
(function () {
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

  const SP = { configured: false, connected: false };

  async function refreshStatus() {
    try {
      const data = await api("/api/services");
      const svc = (data.services || []).find((s) => s.id === "spotify");
      SP.configured = !!(svc && svc.configured);
      SP.connected = !!(svc && svc.connected);
    } catch (_) {
      SP.configured = false;
      SP.connected = false;
    }
    if (window.refreshServicesPanel) window.refreshServicesPanel();
    if (window.refreshHealth) window.refreshHealth();
  }

  function parseSpotifyUrl(raw) {
    const s = raw.trim();
    if (/^spotify:track:([a-zA-Z0-9]+)/i.test(s)) {
      return { id: s.match(/^spotify:track:([a-zA-Z0-9]+)/i)[1] };
    }
    let u;
    try { u = new URL(s); } catch (_) { return null; }
    if (!/^(open\.)?spotify\.com$/i.test(u.hostname.replace(/^www\./, ""))) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("track");
    if (idx >= 0 && parts[idx + 1]) return { id: parts[idx + 1] };
    return null;
  }

  function playlistItemFromTrack(t) {
    return {
      key: `sp:${t.id}`,
      source: "spotify",
      spotifyId: t.id,
      title: t.title,
      artist: t.artist,
      mix: "Spotify",
      start: 0,
      end: t.duration || 0,
      artworkUrl: t.artworkUrl,
      url: t.url,
    };
  }

  async function openUrl(url) {
    const hit = parseSpotifyUrl(url);
    if (!hit) return false;
    try {
      const track = await api(`/api/services/spotify/tracks/${encodeURIComponent(hit.id)}`);
      const it = playlistItemFromTrack(track);
      if (window.addToPlaylist) window.addToPlaylist(it);
      if (it.url) window.open(it.url, "_blank", "noopener,noreferrer");
      toast(`Added “${it.title}” — opened in Spotify.`);
      return true;
    } catch (e) {
      toast(e.message, true);
      return true;
    }
  }

  function playItem(it) {
    if (it.url) window.open(it.url, "_blank", "noopener,noreferrer");
    else toast("No Spotify link for this track.", true);
  }

  function toggleItem(it) {
    playItem(it);
  }

  function stopPlayback() {}

  function isPlayingKey() { return false; }

  window.Spotify = {
    refreshStatus,
    parseUrl: parseSpotifyUrl,
    openUrl,
    playItem,
    toggleItem,
    stop: stopPlayback,
    isPlayingKey,
    isItem: (it) => it && it.source === "spotify",
    configured: () => SP.configured,
    connected: () => SP.connected,
  };

  refreshStatus();
})();
