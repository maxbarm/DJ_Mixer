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
function setupDeck(rootEl, playerElId, defaultPlaylistUrl, options) {
  const randomizeInitial = !!(options && options.randomizeInitial);
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
  const selectAllToggle = rootEl.querySelector(".select-all-toggle");
  const progressTrack = rootEl.querySelector(".progress-track");
  const progressFill = rootEl.querySelector(".progress-fill");
  const timeElapsed = rootEl.querySelector(".time-elapsed");
  const timeRemaining = rootEl.querySelector(".time-remaining");

  // Bumped whenever something else takes over playback (a manual play, a
  // playlist click, cueRandomTrack picking again) so a stale cueRandomTrack
  // retry/pause timer from an earlier pick knows to give up instead of
  // pausing or overwriting whatever's playing now.
  let cueToken = 0;
  let initialRandomizeApplied = !randomizeInitial;

  // The video id most recently handed to playVideoAt/loadVideoById — kept
  // so onError (below) knows which track just failed. getVideoData() often
  // isn't populated yet by the time an error fires.
  let lastRequestedVideoId = null;

  // Set while waiting for a manually-requested playlist load to actually
  // take effect. See the staleness check in syncPlaylistFromPlayer.
  let pendingPlaylistId = null;
  let pendingRecueAttempts = 0;
  // The playlist actually showing right now (once a load resolves). Lets
  // loadPlaylist tell "reloading the exact same playlist" apart from
  // "switching to a different one" — the stale-vs-fresh heuristic in
  // watchForPlaylistRefresh can't otherwise distinguish an identical
  // reload from genuinely-still-cached old data, since both look like an
  // unchanged track list.
  let currentPlaylistId = null;

  const deck = {
    player: null,
    volume: 80,
    faderGain: 1,
    playlistIds: [],
    // Video ids unchecked in the playlist panel — excluded from random
    // picks (initial load and Auto mode) but still playable by clicking
    // them directly.
    disabledIds: new Set(),
    // Video ids YouTube reported as actually unplayable (removed, private,
    // embedding disabled) via onError — still present in getPlaylist()'s
    // data, but hidden entirely rather than just unchecked, since clicking
    // one wouldn't play anything real anyway.
    brokenIds: new Set(),
  };

  // Indices into deck.playlistIds that are eligible for a random pick.
  // Falls back to the whole list if the user has unchecked everything,
  // rather than leaving the randomizer with nothing to choose from.
  function enabledIndices() {
    const indices = [];
    for (let i = 0; i < deck.playlistIds.length; i++) {
      const id = deck.playlistIds[i];
      if (!deck.disabledIds.has(id) && !deck.brokenIds.has(id)) indices.push(i);
    }
    if (indices.length) return indices;
    // Nothing eligible — fall back to anything not confirmed broken, and
    // only to the truly full list if literally everything is broken.
    const notBroken = [];
    for (let i = 0; i < deck.playlistIds.length; i++) {
      if (!deck.brokenIds.has(deck.playlistIds[i])) notBroken.push(i);
    }
    return notBroken.length ? notBroken : deck.playlistIds.map((_, i) => i);
  }

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
    let visibleCount = 0;
    deck.playlistIds.forEach((videoId, i) => {
      if (deck.brokenIds.has(videoId)) return; // confirmed unplayable — hide entirely

      const li = document.createElement("li");
      li.className = "playlist-item";
      li.dataset.index = String(i); // real playlist index, used by playVideoAt/setActivePlaylistItem

      visibleCount++;
      const idxSpan = document.createElement("span");
      idxSpan.className = "idx";
      idxSpan.textContent = String(visibleCount); // gap-free display numbering

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

      // Checked by default — unchecking excludes this track from random
      // picks (initial load + Auto mode) without affecting manual clicks.
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "track-toggle";
      toggle.title = "Include in random picks";
      toggle.checked = !deck.disabledIds.has(videoId);
      toggle.addEventListener("click", (e) => e.stopPropagation());
      toggle.addEventListener("change", () => {
        if (toggle.checked) deck.disabledIds.delete(videoId);
        else deck.disabledIds.add(videoId);
        updateSelectAllState();
      });

      li.appendChild(idxSpan);
      li.appendChild(thumbImg);
      li.appendChild(meta);
      li.appendChild(toggle);
      li.addEventListener("click", () => {
        cueToken++; // this manual pick overrides any pending auto-cue
        lastRequestedVideoId = videoId;
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
    updateSelectAllState();
  }

  // Gmail-style tri-state header checkbox: checked when every track is
  // enabled, unchecked when none are, dashed (indeterminate) in between.
  function updateSelectAllState() {
    if (!selectAllToggle) return;
    const visibleIds = deck.playlistIds.filter((id) => !deck.brokenIds.has(id));
    const total = visibleIds.length;
    const disabledCount = visibleIds.reduce(
      (n, id) => n + (deck.disabledIds.has(id) ? 1 : 0),
      0
    );
    selectAllToggle.indeterminate = disabledCount > 0 && disabledCount < total;
    selectAllToggle.checked = total > 0 && disabledCount === 0;
  }

  if (selectAllToggle) {
    selectAllToggle.addEventListener("change", () => {
      if (selectAllToggle.checked) {
        deck.disabledIds.clear();
      } else {
        deck.playlistIds.forEach((id) => deck.disabledIds.add(id));
      }
      renderPlaylist();
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

      // First time this deck's playlist resolves, jump off the default
      // index-0 track onto a random one, avoiding whatever the other deck
      // already reserved for itself so the two decks don't start out on
      // the same track. Navigates with playVideoAt (muted, then paused a
      // moment later) INSIDE the already-cued playlist rather than calling
      // cuePlaylist a second time — an earlier version re-cued the whole
      // playlist, which doubled each deck's playlist fetch and made the
      // real-world (Vercel) load intermittently hang or take 30+ seconds.
      if (changed && !initialRandomizeApplied) {
        initialRandomizeApplied = true;
        if (list.length > 1) {
          const myToken = ++cueToken;

          // Waits (in short steps, not one long one) for the pick to
          // actually leave UNSTARTED before pausing it. Calling
          // pauseVideo() while still UNSTARTED can wedge the player there
          // permanently — pausing something that never truly started —
          // which is what caused deck B to occasionally hang forever on
          // page load. If it's still stuck after a few checks, abandon
          // this pick and try a different track instead of waiting more.
          const settle = (waitAttempt) => {
            setTimeout(() => {
              if (myToken !== cueToken || !deck.player) return;
              const started = deck.player.getPlayerState() !== -1 && deck.player.getDuration();
              if (started) {
                deck.player.pauseVideo();
                applyVolume(); // restores real mute state for this deck's gain
              } else if (waitAttempt < 6) {
                settle(waitAttempt + 1);
              } else {
                pickInitial();
              }
            }, 500);
          };

          const pickInitial = () => {
            if (myToken !== cueToken || !deck.player) return;
            const candidates = enabledIndices();
            let idx = candidates[Math.floor(Math.random() * candidates.length)];
            let attempts = 0;
            while (list[idx] === reservedInitialVideoId && attempts < 50) {
              idx = candidates[Math.floor(Math.random() * candidates.length)];
              attempts++;
            }
            reservedInitialVideoId = list[idx];
            lastRequestedVideoId = list[idx];
            deck.player.mute();
            deck.player.playVideoAt(idx);
            showTrackInfo(list[idx]);
            settle(0);
          };
          pickInitial();
          return;
        }
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

  // Shows title + artist for a known video id, using the oEmbed cache (the
  // same source playlist rows use) as needed. Independent of the player's
  // own getVideoData(), which stays empty for a while when a video is
  // paused immediately after cueRandomTrack() starts it — pausing that
  // early seems to cut the metadata fetch off before it lands.
  function showTrackInfo(videoId) {
    if (!videoId) return;
    displayedVideoId = videoId;
    const cached = trackInfoCache[videoId];
    if (cached) {
      nowTitle.textContent = cached.title;
      nowArtist.textContent = cached.author;
      return;
    }
    nowTitle.textContent = "Loading...";
    nowArtist.textContent = "";
    fetchTrackInfo(videoId, (info) => {
      if (displayedVideoId === videoId) {
        nowTitle.textContent = info.title;
        nowArtist.textContent = info.author;
      }
    });
  }

  function updateNowPlaying(data) {
    const videoId = (data && data.video_id) || null;
    if (!videoId) return;
    if (data.title && data.author && !trackInfoCache[videoId]) {
      trackInfoCache[videoId] = { title: data.title, author: data.author };
    }
    if (data.title) {
      displayedVideoId = videoId;
      nowTitle.textContent = data.title;
      nowArtist.textContent = data.author || (trackInfoCache[videoId] || {}).author || "";
      if (!data.author) {
        const cached = trackInfoCache[videoId];
        if (cached) {
          nowArtist.textContent = cached.author;
        } else {
          fetchTrackInfo(videoId, (info) => {
            if (displayedVideoId === videoId) nowArtist.textContent = info.author;
          });
        }
      }
      return;
    }
    // getVideoData() hasn't populated a title yet — fall back entirely.
    showTrackInfo(videoId);
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
        // Belt-and-suspenders for Auto mode: it normally cues the next
        // track a beat *before* this fires (see setupAutoMode), but a
        // delayed timer tick can miss that narrow window. Reacting to the
        // real ENDED event as a backstop means even a missed poll gets
        // corrected immediately — cueRandomTrack() is safe to call twice.
        if (e.data === YT.PlayerState.ENDED && deck.onEnded) deck.onEnded();
        syncPlaylistFromPlayer(e.target);
      },
      // A track that's still listed in a cued playlist (per getPlaylist())
      // can nonetheless fail to actually play — removed, private, or
      // embedding disabled by its owner; YouTube's own "Video unavailable"
      // overlay shows in that case, even though the track is gone from the
      // playlist on YouTube's own site. Hide it from the panel entirely
      // (brokenIds, checked in renderPlaylist/enabledIndices), exclude it
      // from random picks, and swap in a replacement instead of leaving
      // the deck stuck showing that error.
      onError: () => {
        const videoId = lastRequestedVideoId;
        if (videoId && deck.playlistIds.includes(videoId)) {
          deck.disabledIds.add(videoId);
          deck.brokenIds.add(videoId);
          renderPlaylist();
        }
        if (deck.playlistIds.length) {
          if (deck.onEnded) deck.onEnded();
          else deck.cueRandomTrack();
        }
      },
    };

    deck.player = new YT.Player(playerElId, config);
  }

  function loadSingleVideo(videoId) {
    pendingPlaylistId = null;
    pendingRecueAttempts = 0;
    currentPlaylistId = null;
    lastRequestedVideoId = videoId;
    deck.playlistIds = [];
    renderPlaylist();
    if (deck.player) {
      deck.player.loadVideoById(videoId);
    } else {
      createPlayer({}, videoId);
    }
  }

  function loadPlaylist(playlistId) {
    if (playlistId === currentPlaylistId) {
      // Already showing this exact playlist — nothing to refresh, and
      // re-cueing it would look identical to still-cached old data to the
      // staleness heuristic below, sending it into needless retries.
      // (loadPlaylistFromUrl normally short-circuits before ever getting
      // here, but restore the panel too in case this is reached directly.)
      pendingPlaylistId = null;
      renderPlaylist();
      return;
    }
    currentPlaylistId = playlistId;
    pendingPlaylistId = playlistId;
    pendingRecueAttempts = 0;
    if (deck.player) {
      deck.player.cuePlaylist({ listType: "playlist", list: playlistId });
      watchForPlaylistRefresh(playlistId);
    } else {
      createPlayer({ listType: "playlist", list: playlistId });
    }
  }

  // Right after cuePlaylist() re-targets an *already-loaded* player at a
  // different playlist, getPlaylist() can keep returning the previous
  // playlist's tracks for several seconds even though getVideoData()
  // already reports the new one — an IFrame API caching quirk. That's what
  // made loading a new playlist need two clicks: the first click's stale
  // data looked like nothing had happened, and the second cuePlaylist()
  // call happened to force a refresh. Poll independently of onStateChange
  // (re-issuing cuePlaylist from inside that event's own callback turned
  // out not to trigger a fresh one — likely a postMessage reentrancy
  // quirk) and force the same refresh automatically.
  function watchForPlaylistRefresh(playlistId) {
    setTimeout(() => {
      if (pendingPlaylistId !== playlistId || !deck.player) return;
      pendingRecueAttempts++;

      const videoData = deck.player.getVideoData ? deck.player.getVideoData() : null;
      const list = deck.player.getPlaylist ? deck.player.getPlaylist() : null;
      const onTargetPlaylist = videoData && videoData.list === playlistId;
      const looksStale =
        onTargetPlaylist &&
        list &&
        list.length &&
        deck.playlistIds.length > 0 &&
        list.length === deck.playlistIds.length &&
        list.every((id, i) => id === deck.playlistIds[i]);

      if (onTargetPlaylist && !looksStale) {
        pendingPlaylistId = null; // getPlaylist() has caught up — done
        return;
      }
      if (pendingRecueAttempts >= 8) {
        pendingPlaylistId = null; // give up; whatever loaded is what stays loaded
        return;
      }
      if (looksStale) deck.player.cuePlaylist({ listType: "playlist", list: playlistId });
      watchForPlaylistRefresh(playlistId);
    }, 1000);
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
    if (playlistId === currentPlaylistId) return; // already showing it
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

  // ---- Used by Auto mode to drive this deck without a user click ----
  deck.getCurrentVideoId = function () {
    return displayedVideoId;
  };

  deck.isPlaying = function () {
    return (
      !!deck.player &&
      deck.player.getPlayerState &&
      deck.player.getPlayerState() === YT.PlayerState.PLAYING
    );
  };

  deck.getRemainingTime = function () {
    if (!deck.player || !deck.player.getDuration) return Infinity;
    const duration = deck.player.getDuration();
    if (!duration) return Infinity;
    return duration - deck.player.getCurrentTime();
  };

  // Set by Auto mode as a backstop — see the ENDED handling in onStateChange.
  deck.onEnded = null;

  // Cues a random track from this deck's own playlist — skipping the
  // currently cued one, and skipping excludeVideoId when the caller passes
  // the other deck's current track (see setupAutoMode) so the two decks
  // never end up playing the same song — lets it actually play for a
  // second — silently, since this deck is idle and its fader gain is 0 —
  // and then pauses it, ready for play() later.
  //
  // Letting it really play first (rather than pausing instantly) matters
  // two ways: it gives the YouTube widget time to populate real title/
  // author metadata, and it doubles as a liveness check — a track blocked
  // from embedding never reports a duration, so if that's still true after
  // the wait, this tries a different pick instead of leaving the deck
  // stuck silent at the next crossfade.
  //
  // Leaving it paused (rather than left playing) is also what lets a user
  // swap in a specific track by clicking the playlist while Auto mode is
  // still armed — see the cueToken guard below and in that click handler.
  deck.cueRandomTrack = function (excludeVideoId) {
    if (!deck.player || !deck.playlistIds.length) return false;
    const myToken = ++cueToken;

    const pickAndCue = () => {
      if (myToken !== cueToken || !deck.player) return;
      const currentIdx = deck.player.getPlaylistIndex ? deck.player.getPlaylistIndex() : -1;
      const candidates = enabledIndices();
      let idx = candidates[Math.floor(Math.random() * candidates.length)];
      if (candidates.length > 1) {
        let attempts = 0;
        while (
          (idx === currentIdx || deck.playlistIds[idx] === excludeVideoId) &&
          attempts < 50
        ) {
          idx = candidates[Math.floor(Math.random() * candidates.length)];
          attempts++;
        }
      }
      lastRequestedVideoId = deck.playlistIds[idx];
      deck.player.playVideoAt(idx);
      showTrackInfo(deck.playlistIds[idx]);

      setTimeout(() => {
        if (myToken !== cueToken || !deck.player) return;
        if (!deck.player.getDuration()) {
          pickAndCue(); // never loaded — dead pick, try another
        } else {
          deck.player.pauseVideo();
        }
      }, 1000);
    };
    pickAndCue();
    return true;
  };

  deck.play = function () {
    cueToken++; // cancel any pending auto-cue pause/retry for this deck
    if (deck.player) deck.player.playVideo();
  };

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
  const deckAEl = document.getElementById("deck-a");
  const deckBEl = document.getElementById("deck-b");
  const endBtnA = document.getElementById("fader-end-a");
  const endBtnB = document.getElementById("fader-end-b");
  let pos = 0; // 0 = A end, 1 = B end; starts parked on A
  let dragging = false;
  let animating = false; // true while Auto mode is driving the handle

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

    // Highlight whichever side the fader currently favors.
    const aIsFavored = pos <= 0.5;
    deckAEl.classList.toggle("deck-active", aIsFavored);
    deckBEl.classList.toggle("deck-active", !aIsFavored);
    endBtnA.classList.toggle("active", aIsFavored);
    endBtnB.classList.toggle("active", !aIsFavored);
  }

  function setPosFromClientY(clientY) {
    const rect = track.getBoundingClientRect();
    const usable = rect.height - handle.offsetHeight;
    if (usable <= 0) return;
    pos = clamp01((clientY - rect.top - handle.offsetHeight / 2) / usable);
    render();
  }

  handle.addEventListener("pointerdown", (e) => {
    if (animating) return;
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
    if (animating || e.target === handle) return;
    setPosFromClientY(e.clientY);
  });

  render();

  // Smoothly drives the handle to `target` (0-1) over `durationMs`, used by
  // Auto mode to perform the crossfade instead of jumping instantly.
  function animateTo(target, durationMs, onDone) {
    animating = true;
    const start = pos;
    const startTime = performance.now();

    function step(now) {
      const t = Math.min(1, (now - startTime) / durationMs);
      pos = start + (target - start) * t;
      render();
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        animating = false;
        if (onDone) onDone();
      }
    }
    requestAnimationFrame(step);
  }

  return {
    getPosition: () => pos,
    animateTo,
  };
}

// Set by whichever deck resolves its initial random-start pick first, so
// the other deck's initial pick (see setupDeck's randomizeInitial option)
// can avoid landing on the same track. JS callbacks run to completion
// without interleaving, so this simple shared slot is race-free even
// though both decks' playlists usually resolve around the same time.
let reservedInitialVideoId = null;

// ---------- Crossfade duration ----------
// Shared by Auto mode and the A/B quick-switch buttons below.
const fadeState = { seconds: 2 };

function setupFadeDuration() {
  const fadeButtons = document.querySelectorAll(".fade-btn");
  fadeButtons.forEach((b) => {
    b.addEventListener("click", () => {
      fadeState.seconds = Number(b.dataset.sec);
      fadeButtons.forEach((x) => x.classList.toggle("active", x === b));
    });
  });
}

// Starts `deck` playing (if it wasn't already) and only begins the
// crossfade animation once it's genuinely producing frames. Resuming a
// paused YouTube embed can stall the page for a second or two while it
// re-buffers; starting the fade's clock during that stall was making
// every crossfade run longer than fadeState.seconds regardless of which
// duration button was selected. Waiting here just shifts that stall to
// before the fade starts instead of into the middle of it.
function playThenAnimate(deck, targetPos, fader, onDone) {
  if (!deck.isPlaying()) deck.play();
  const waitReady = (attempt) => {
    if (deck.isPlaying() || attempt >= 10) {
      fader.animateTo(targetPos, fadeState.seconds * 1000, onDone);
    } else {
      setTimeout(() => waitReady(attempt + 1), 100);
    }
  };
  waitReady(0);
}

// ---------- A/B quick-switch buttons ----------
// Manually trigger the same crossfade Auto mode would do, at any time,
// regardless of whether Auto is on. If the deck being switched to is
// currently paused, wake it up first — the button becomes the crossfade AND
// the play button when the deck isn't already going.
function setupQuickSwitch(deckA, deckB, fader) {
  document.getElementById("fader-end-a").addEventListener("click", () => {
    playThenAnimate(deckA, 0, fader);
  });
  document.getElementById("fader-end-b").addEventListener("click", () => {
    playThenAnimate(deckB, 1, fader);
  });
}

// ---------- Auto mode ----------
// While enabled: watches whichever deck the crossfader currently favors and
// starts the crossfade `fadeState.seconds + 1` before that track ends — one
// second earlier than the fade itself needs, so the outgoing track keeps
// playing (now inaudible, gain already at 0) for a full second past the end
// of the fade instead of cutting off right as it finishes.
//
// Separately, ANY deck within CUE_LEAD_SECONDS of its own natural end gets a
// fresh random pick cued from its own playlist, then paused a second later —
// parked and ready for its next turn. Triggering this slightly *before* the
// real end (rather than waiting for it) matters: a cued YouTube playlist
// auto-advances to its next video the instant one truly ends, and that
// happens inside the iframe faster than we could react to it — so cueing a
// half-second early is what lets our own pick usually win instead of theirs.
// deck.onEnded (wired below) is the backstop for when a delayed poll tick
// still loses that race. Either way, a user can click a specific track in
// that deck's playlist to swap out the random pick any time before its next
// turn comes around.
function setupAutoMode(deckA, deckB, fader) {
  const btn = document.getElementById("auto-btn");
  const CUE_LEAD_SECONDS = 0.8;
  let enabled = false;
  let transitioning = false;

  deckA.onEnded = () => {
    if (enabled) deckA.cueRandomTrack(deckB.getCurrentVideoId());
  };
  deckB.onEnded = () => {
    if (enabled) deckB.cueRandomTrack(deckA.getCurrentVideoId());
  };

  function poll() {
    if (!enabled) return;

    if (!transitioning) {
      const side = fader.getPosition() <= 0.5 ? "A" : "B";
      const active = side === "A" ? deckA : deckB;
      const other = side === "A" ? deckB : deckA;

      if (active.isPlaying() && active.getRemainingTime() <= fadeState.seconds + 1) {
        transitioning = true;
        playThenAnimate(other, side === "A" ? 1 : 0, fader, () => {
          transitioning = false;
        });
      }
    }

    if (deckA.isPlaying() && deckA.getRemainingTime() <= CUE_LEAD_SECONDS) {
      deckA.cueRandomTrack(deckB.getCurrentVideoId());
    }
    if (deckB.isPlaying() && deckB.getRemainingTime() <= CUE_LEAD_SECONDS) {
      deckB.cueRandomTrack(deckA.getCurrentVideoId());
    }
  }
  setInterval(poll, 150);

  btn.addEventListener("click", () => {
    enabled = !enabled;
    btn.classList.toggle("active", enabled);
  });
}

const DEFAULT_PLAYLIST_URL =
  "https://www.youtube.com/playlist?list=PLvrCIk7RXD2ZOJdsYjP8Q6Z5MkQ6LBdKw";

const deckA = setupDeck(document.getElementById("deck-a"), "player-a", DEFAULT_PLAYLIST_URL, {
  randomizeInitial: true,
});
const deckB = setupDeck(document.getElementById("deck-b"), "player-b", DEFAULT_PLAYLIST_URL, {
  randomizeInitial: true,
});
const fader = setupCrossfader(deckA, deckB);
setupFadeDuration();
setupQuickSwitch(deckA, deckB, fader);
setupAutoMode(deckA, deckB, fader);
