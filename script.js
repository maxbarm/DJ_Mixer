// ---------- YouTube URL parsing ----------
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractPlaylistId(url) {
  const m = url.match(/[?&]list=([\w-]+)/);
  return m ? m[1] : null;
}

// ---------- YouTube IFrame API readiness ----------
let apiReady = false;
const pendingActions = [];

window.onYouTubeIframeAPIReady = function () {
  apiReady = true;
  pendingActions.forEach((fn) => fn());
  pendingActions.length = 0;
};

function whenApiReady(fn) {
  if (apiReady) fn();
  else pendingActions.push(fn);
}

// ---------- Track title + artist (public oEmbed endpoint, no API key) ----------
const trackInfoCache = {};

function fetchTrackInfo(videoId, onInfo) {
  fetch(
    "https://www.youtube.com/oembed?url=" +
      encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) +
      "&format=json"
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const info = {
        title: data && data.title ? data.title : videoId,
        author: data && data.author_name ? data.author_name : "",
      };
      trackInfoCache[videoId] = info;
      onInfo(info);
    })
    .catch(() => {
      const info = { title: videoId, author: "" };
      trackInfoCache[videoId] = info;
      onInfo(info);
    });
}

// Thumbnails are available at this fixed URL for any public video, no request needed.
function thumbUrl(videoId) {
  return "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg";
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

// ---------- Deck setup ----------
function setupDeck(rootEl, playerElId, defaultPlaylistUrl) {
  const urlInput = rootEl.querySelector(".url-input");
  const loadBtn = rootEl.querySelector(".load-btn");
  const playBtn = rootEl.querySelector(".play-btn");
  const nowTitle = rootEl.querySelector(".now-title");
  const nowArtist = rootEl.querySelector(".now-artist");
  const knob = rootEl.querySelector(".knob");
  const knobIndicator = rootEl.querySelector(".knob-indicator");
  const knobValueEl = rootEl.querySelector(".knob-value");
  const playlistInput = rootEl.querySelector(".playlist-input");
  const playlistLoadBtn = rootEl.querySelector(".playlist-load-btn");
  const playlistPanel = rootEl.querySelector(".playlist-panel");
  const playlistList = rootEl.querySelector(".playlist-list");
  const progressTrack = rootEl.querySelector(".progress-track");
  const progressFill = rootEl.querySelector(".progress-fill");
  const timeElapsed = rootEl.querySelector(".time-elapsed");
  const timeRemaining = rootEl.querySelector(".time-remaining");

  const deck = {
    player: null,
    volume: 80,
    faderGain: 1,
    playlistIds: [],
  };

  function applyVolume() {
    if (deck.player && deck.player.setVolume) {
      const effective = Math.round(deck.volume * deck.faderGain);
      deck.player.setVolume(effective);
      if (effective === 0) deck.player.mute();
      else deck.player.unMute();
    }
  }

  // Called by the crossfader; doesn't touch the volume knob itself.
  deck.setFaderGain = function (gain) {
    deck.faderGain = gain;
    applyVolume();
  };

  function updateKnobUI() {
    const angle = -135 + (deck.volume / 100) * 270;
    knobIndicator.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    knobValueEl.textContent = deck.volume;
  }
  updateKnobUI();

  function setVolume(v) {
    deck.volume = Math.max(0, Math.min(100, Math.round(v)));
    updateKnobUI();
    applyVolume();
  }

  // ---- Knob drag interaction (vertical drag = volume change) ----
  // Uses Pointer Events + setPointerCapture so the drag keeps receiving
  // move/up events even when the cursor passes over the YouTube iframe
  // (a plain window "mouseup" listener never fires in that case, which
  // used to leave the knob stuck in "dragging" mode).
  let dragging = false;
  let dragStartY = 0;
  let dragStartVolume = 0;

  function startDrag(clientY) {
    dragging = true;
    dragStartY = clientY;
    dragStartVolume = deck.volume;
    knob.style.cursor = "grabbing";
  }

  function moveDrag(clientY) {
    if (!dragging) return;
    const delta = dragStartY - clientY; // up = increase
    setVolume(dragStartVolume + delta * 0.6);
  }

  function endDrag() {
    dragging = false;
    knob.style.cursor = "grab";
  }

  knob.addEventListener("pointerdown", (e) => {
    knob.setPointerCapture(e.pointerId);
    startDrag(e.clientY);
    e.preventDefault();
  });
  knob.addEventListener("pointermove", (e) => moveDrag(e.clientY));
  knob.addEventListener("pointerup", endDrag);
  knob.addEventListener("pointercancel", endDrag);

  knob.addEventListener("wheel", (e) => {
    e.preventDefault();
    setVolume(deck.volume - Math.sign(e.deltaY) * 2);
  }, { passive: false });

  // ---- Playlist track list UI ----
  function setActivePlaylistItem(idx) {
    playlistList.querySelectorAll(".playlist-item").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.index) === idx);
    });
  }

  function renderPlaylist() {
    playlistPanel.classList.toggle("has-items", deck.playlistIds.length > 0);
    playlistList.innerHTML = "";
    deck.playlistIds.forEach((videoId, i) => {
      const li = document.createElement("li");
      li.className = "playlist-item";
      li.dataset.index = String(i);

      const idxSpan = document.createElement("span");
      idxSpan.className = "idx";
      idxSpan.textContent = String(i + 1);

      const thumbImg = document.createElement("img");
      thumbImg.className = "thumb";
      thumbImg.alt = "";
      thumbImg.src = thumbUrl(videoId);

      const meta = document.createElement("div");
      meta.className = "meta";

      const titleSpan = document.createElement("div");
      titleSpan.className = "title";

      const artistSpan = document.createElement("div");
      artistSpan.className = "artist";

      const cached = trackInfoCache[videoId];
      titleSpan.textContent = cached ? cached.title : "Loading title...";
      artistSpan.textContent = cached ? cached.author : "";

      meta.appendChild(titleSpan);
      meta.appendChild(artistSpan);

      li.appendChild(idxSpan);
      li.appendChild(thumbImg);
      li.appendChild(meta);
      li.addEventListener("click", () => {
        if (deck.player) deck.player.playVideoAt(i);
      });
      playlistList.appendChild(li);

      if (!cached) {
        fetchTrackInfo(videoId, (info) => {
          titleSpan.textContent = info.title;
          artistSpan.textContent = info.author;
        });
      }
    });
  }

  // Picks up the video-id list + current index from the player whenever
  // it changes (after cuePlaylist resolves, or the active track advances).
  function syncPlaylistFromPlayer(playerObj) {
    if (!playerObj || !playerObj.getPlaylist) return;
    const list = playerObj.getPlaylist();
    if (list && list.length) {
      const changed =
        list.length !== deck.playlistIds.length ||
        list.some((id, i) => id !== deck.playlistIds[i]);
      if (changed) {
        deck.playlistIds = list;
        renderPlaylist();
      }
      const idx = playerObj.getPlaylistIndex();
      if (typeof idx === "number" && idx >= 0) setActivePlaylistItem(idx);
    }
  }

  // ---- Progress bar (elapsed / time remaining, click-or-drag to seek) ----
  let scrubbing = false;

  function renderProgress(current, duration) {
    const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    progressFill.style.width = pct + "%";
    timeElapsed.textContent = formatTime(current);
    timeRemaining.textContent = "-" + formatTime(Math.max(0, duration - current));
  }

  function updateProgress() {
    if (scrubbing || !deck.player || !deck.player.getDuration) return;
    const duration = deck.player.getDuration();
    if (!duration) {
      renderProgress(0, 0);
      return;
    }
    renderProgress(deck.player.getCurrentTime(), duration);
  }
  setInterval(updateProgress, 500);

  function seekRatioFromClientX(clientX) {
    const rect = progressTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function scrubTo(clientX) {
    if (!deck.player || !deck.player.getDuration) return;
    const duration = deck.player.getDuration();
    if (!duration) return;
    renderProgress(seekRatioFromClientX(clientX) * duration, duration);
  }

  progressTrack.addEventListener("pointerdown", (e) => {
    if (!deck.player || !deck.player.getDuration || !deck.player.getDuration()) return;
    progressTrack.setPointerCapture(e.pointerId);
    scrubbing = true;
    scrubTo(e.clientX);
    e.preventDefault();
  });
  progressTrack.addEventListener("pointermove", (e) => {
    if (scrubbing) scrubTo(e.clientX);
  });
  progressTrack.addEventListener("pointerup", (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    const duration = deck.player.getDuration();
    if (duration) deck.player.seekTo(seekRatioFromClientX(e.clientX) * duration, true);
  });
  progressTrack.addEventListener("pointercancel", () => {
    scrubbing = false;
  });

  let displayedVideoId = null;

  function updateNowPlaying(data) {
    if (!data || !data.title) return;
    const videoId = data.video_id || null;
    displayedVideoId = videoId;
    nowTitle.textContent = data.title;

    // getVideoData().author is frequently blank; fall back to the cache /
    // an oEmbed fetch (the same source playlist rows use for the artist).
    if (data.author) {
      nowArtist.textContent = data.author;
      if (videoId && !trackInfoCache[videoId]) {
        trackInfoCache[videoId] = { title: data.title, author: data.author };
      }
      return;
    }
    if (!videoId) {
      nowArtist.textContent = "";
      return;
    }
    const cached = trackInfoCache[videoId];
    if (cached) {
      nowArtist.textContent = cached.author;
      return;
    }
    nowArtist.textContent = "";
    fetchTrackInfo(videoId, (info) => {
      if (displayedVideoId === videoId) {
        nowArtist.textContent = info.author;
      }
    });
  }

  // ---- Player creation / loading ----
  function createPlayer(playerVars, videoId) {
    const config = {
      height: "100%",
      width: "100%",
      playerVars: Object.assign({ rel: 0 }, playerVars),
      events: {},
    };
    if (videoId) config.videoId = videoId;

    config.events = {
      onReady: (e) => {
        applyVolume();
        updateNowPlaying(e.target.getVideoData());
        playBtn.disabled = false;
        syncPlaylistFromPlayer(e.target);
      },
      onStateChange: (e) => {
        updateNowPlaying(e.target.getVideoData());
        if (e.data === YT.PlayerState.PLAYING) {
          playBtn.textContent = "⏸";
        } else if (
          e.data === YT.PlayerState.PAUSED ||
          e.data === YT.PlayerState.ENDED
        ) {
          playBtn.textContent = "▶";
        }
        syncPlaylistFromPlayer(e.target);
      },
    };

    deck.player = new YT.Player(playerElId, config);
  }

  function loadSingleVideo(videoId) {
    deck.playlistIds = [];
    renderPlaylist();
    if (deck.player) {
      deck.player.loadVideoById(videoId);
    } else {
      createPlayer({}, videoId);
    }
  }

  function loadPlaylist(playlistId) {
    if (deck.player) {
      deck.player.cuePlaylist({ listType: "playlist", list: playlistId });
    } else {
      createPlayer({ listType: "playlist", list: playlistId });
    }
  }

  loadBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) return;
    const videoId = extractVideoId(url);
    if (!videoId) {
      nowTitle.textContent = "Invalid YouTube link";
      nowArtist.textContent = "";
      return;
    }
    nowTitle.textContent = "Loading...";
    nowArtist.textContent = "";
    whenApiReady(() => loadSingleVideo(videoId));
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadBtn.click();
  });

  function loadPlaylistFromUrl(url) {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) {
      playlistPanel.classList.add("has-items");
      playlistList.innerHTML = '<li class="playlist-item">Invalid playlist link</li>';
      return;
    }
    playlistPanel.classList.add("has-items");
    playlistList.innerHTML = '<li class="playlist-item">Loading playlist...</li>';
    whenApiReady(() => loadPlaylist(playlistId));
  }

  playlistLoadBtn.addEventListener("click", () => {
    const url = playlistInput.value.trim();
    if (!url) return;
    loadPlaylistFromUrl(url);
  });

  playlistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") playlistLoadBtn.click();
  });

  playBtn.addEventListener("click", () => {
    if (!deck.player) return;
    const state = deck.player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      deck.player.pauseVideo();
    } else {
      deck.player.playVideo();
    }
  });

  if (defaultPlaylistUrl) {
    playlistInput.value = defaultPlaylistUrl;
    loadPlaylistFromUrl(defaultPlaylistUrl);
  }

  return deck;
}

// ---------- Crossfader ----------
// Vertical fader between the two decks: top = deck A only, bottom = deck B
// only, middle = both decks at full volume. Each half stays at gain 1 until
// the handle crosses the center, then fades the *other* deck out linearly.
function setupCrossfader(deckA, deckB) {
  const track = document.getElementById("fader-track");
  const handle = document.getElementById("fader-handle");
  let pos = 0.5; // 0 = A end, 1 = B end
  let dragging = false;

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function render() {
    const travel = track.clientHeight - handle.offsetHeight;
    handle.style.top = pos * Math.max(0, travel) + "px";

    const gainA = pos <= 0.5 ? 1 : clamp01(1 - (pos - 0.5) * 2);
    const gainB = pos >= 0.5 ? 1 : clamp01(1 - (0.5 - pos) * 2);
    deckA.setFaderGain(gainA);
    deckB.setFaderGain(gainB);
  }

  function setPosFromClientY(clientY) {
    const rect = track.getBoundingClientRect();
    const usable = rect.height - handle.offsetHeight;
    if (usable <= 0) return;
    pos = clamp01((clientY - rect.top - handle.offsetHeight / 2) / usable);
    render();
  }

  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (dragging) setPosFromClientY(e.clientY);
  });
  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
  handle.addEventListener("pointercancel", () => {
    dragging = false;
  });

  // Clicking directly on the track jumps the handle straight to that point.
  track.addEventListener("pointerdown", (e) => {
    if (e.target === handle) return;
    setPosFromClientY(e.clientY);
  });

  render();
}

const DEFAULT_PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PLvrCIk7RXD2ZOJdsYjP8Q6Z5MkQ6LBdKw";

const deckA = setupDeck(document.getElementById("deck-a"), "player-a", DEFAULT_PLAYLIST_URL);
const deckB = setupDeck(document.getElementById("deck-b"), "player-b", DEFAULT_PLAYLIST_URL);
setupCrossfader(deckA, deckB);
