# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build, vanilla JS/HTML/CSS two-deck DJ mixer that plays YouTube videos/playlists via the YouTube IFrame Player API. No package.json, no bundler, no framework, no tests.

## Running it

The YouTube IFrame API requires the page to be served over HTTP — opening `index.html` via `file://` fails with "Помилка 153" / error 153. Serve it locally:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`. A `.claude/launch.json` config (`dj-mixer`, port 8080) is set up for `preview_start` in this environment.

There is no build step, linter, or test suite — verify changes by loading the page in a browser and exercising the UI directly (see testing notes below).

## Architecture

Three files, no modules: `index.html` (structure), `style.css` (all styling), `script.js` (all logic, plain top-level `const`/`function` declarations, loaded after the `youtube/iframe_api` script tag).

### Deck objects

`setupDeck(rootEl, playerElId, defaultPlaylistUrl)` is the core unit — called once per deck (`#deck-a`, `#deck-b`) and returns a `deck` object that is the public interface the rest of the app (crossfader, Auto mode) drives:

- `deck.player` — the underlying `YT.Player` instance (null until `onYouTubeIframeAPIReady` fires and a video/playlist loads)
- `deck.setFaderGain(gain)` — called by the crossfader; multiplies against the volume knob, never overwrites it
- `deck.isPlaying()`, `deck.getRemainingTime()` — polled by Auto mode
- `deck.play()` — resumes playback and invalidates any pending `cueRandomTrack` timer via `cueToken`
- `deck.cueRandomTrack()` — picks a random track from the deck's own playlist, plays it briefly, then pauses it once `getDuration()` confirms it actually loaded (retries on a dead/unembeddable pick)
- `deck.onEnded` — hook wired by Auto mode as a backstop for the native `ENDED` state

Each deck manages its own volume knob (pointer-drag + wheel), progress bar (pointer-drag to seek), playlist panel (click to jump to a track), and "now playing" title/artist/thumbnail display. Track metadata comes from the public oEmbed endpoint (`youtube.com/oembed`, no API key) with a global `trackInfoCache` keyed by video id; thumbnails use the fixed `i.ytimg.com/vi/{id}/mqdefault.jpg` URL pattern directly.

### Crossfader

`setupCrossfader(deckA, deckB)` owns a single `pos` value (0 = deck A, 1 = deck B, starts at 0). `render()` computes each deck's gain from `pos` (full volume on your own side, linear fade only once past center toward the other extreme) and toggles `.deck-active` / `.active` highlighting on the favored deck and its A/B button. Returns `{ getPosition, animateTo }` — `animateTo(target, durationMs, onDone)` drives `pos` smoothly via `requestAnimationFrame` and is how both Auto mode and the manual A/B buttons perform a crossfade instead of jumping instantly.

### Auto mode

`setupAutoMode(deckA, deckB, fader)` polls every 150ms. Two independent things happen in that poll:

1. Whichever deck the fader currently favors, once its remaining time drops to `fadeState.seconds + 1`, triggers `other.play()` + `fader.animateTo(...)` to crossfade over.
2. Independently, *any* playing deck within `CUE_LEAD_SECONDS` (0.8s) of its own natural end gets `cueRandomTrack()` called on it.

The 0.8s lead and 150ms poll interval are load-bearing, empirically-tuned values: YouTube's native cued-playlist auto-advance does **not** fire an `ENDED` state event when moving to the next video (confirmed by state-sequence logging — it jumps straight through intermediate states, never emitting `0`). Cueing must therefore happen *before* the natural end via polling, not in reaction to `ENDED`; the `deck.onEnded` hook is kept only as a harmless backstop for the case where a track genuinely ends outside playlist auto-advance. If you touch this timing, re-verify with real playback (see below) rather than assuming a shorter/longer value is safe — both bounds have failed in testing (too early races the current fade's `fadeState.seconds + 1` trigger; too late loses to YouTube's own advance).

### Manual A/B crossfade buttons

`setupQuickSwitch` wires the `A`/`B` end-labels of the crossfader as buttons: clicking one both crossfades to that side *and* calls `.play()` on it first if it was paused, so the button doubles as play + switch.

## Testing changes

Since there's no automated test suite, verify behavior via the browser: load the page, and where relevant, inspect live player state directly in the console/JS-exec (top-level `deckA`/`deckB`/`fader` are accessible), e.g. `YT.get('player-a').getPlayerState()`, `deckA.getRemainingTime()`, `fader.getPosition()`. This is how the Auto-mode race condition against YouTube's native advance was originally diagnosed and validated — by logging/inspecting state transitions across several full crossfade cycles, not by reading the code alone.

## Git

Public GitHub repo: `github.com/maxbarm/DJ_Mixer` (remote `origin`, branch `master`). Only commit/push when the user explicitly asks.
