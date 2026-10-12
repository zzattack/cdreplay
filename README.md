# cdreplay

Standalone Chrono Divide replay viewer with seeking. It is the real game client, served from a local cache of
game.chronodivide.com with `cdreplay.js` injected, inside an Electron window.

```
cdreplay.bat [file.rpl | ladder replay url | game id]     double-click: game browser; with an argument: that replay
npm start -- <same>                                        the same through npm
npm run serve                                              plain http server on :8787 for use in a normal browser
```

First run: the client asks for the game files; choose "browse folder" and pick `C:\Westwood\RA2`. They are stored in
the app's own storage under `cache/electron`.

## What the injected script adds

- Seek bar inside the client's bottom action bar (keyboard: comma/period 10 s, angle brackets 1 min).
- Forward seeks step the engine as fast as it goes (5-8k ticks/s). Backward seeks use keyframes: up to six extra
  Game instances built with the client's own loader, advanced in idle time to evenly spaced ticks and parked. A seek
  takes the cheapest source (live game, parked game plus a screen rebuild of ~1 s, or a restart), then fast-forwards.
  The engine cannot snapshot (task callbacks are closures over live objects), which is why copies are simulated.
- Overlays: match header top centre (players, flags, MMR, power, credits, map, region, date), unit counters with
  cameos over the sidebar slots (credits and spent above), power, APM and production queues with cameos in the bottom
  corners, the client's own target lines for every unit (toggle on the bar). Teams from the lobby alliances group
  everything (2x2 for four players). Hidden while the game menu is open. Stop button top right returns to the browser.
- End screen when the game ends: winner or winning team, MMR changes, units built/lost/killed, and animated graphs of
  credits earned, army value and APM. Ladder data comes from the browser or is looked up by player name.
- Game browser (`browser.html`): ladder standings per ladder, recent games, games per player, drag-and-drop of local
  .rpl files. Lives as an overlay inside the client page so switching replays takes about a second.
- Client patches: no pointer lock and no edge scrolling (the OS cursor works on the overlay), viewport always fills
  the window, the 5 s splash minimum is stripped, detect-gpu's unknown-card fallback is raised so new GPUs are not
  reported as unsupported.

## Packaging

```
npm run dist          electron-builder: dist\cdreplay.exe (portable, single file) and dist\cdreplay-<version>-win.zip
```

```
npm run dist:offline  dist-offline\cdreplay-offline.exe: the same plus a snapshot of the cached client and maps, for a
                      machine without network access (still needs the RA2 game files). Private use only: the client is
                      proprietary.
```

The packaged app keeps its caches in `%LOCALAPPDATA%\cdreplay` (client files, replays, imported game files, flags).
The standard build contains only this project's files plus Electron; the client is mirrored from game.chronodivide.com
on first run. Unsigned, so SmartScreen warns once.

## Replay links from Chrome

The exe registers the `cdreplay://` url scheme. `chrome-extension/` is a two-file extension that sends
`game.chronodivide.com/#/replay/...` links to the app: in Chrome open `chrome://extensions`, enable developer mode,
"Load unpacked", pick that folder. Firefox: `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", pick
`manifest.json` (temporary add-ons are dropped when Firefox restarts). Permanent install needs Mozilla's signature:
API credentials from https://addons.mozilla.org/developers/addon/api/key/ live in `web-ext-config.cjs` (not committed), then

```
npm run ext:sign                  signed .xpi lands in dist-ext\; open it in Firefox to install
npm run ext:lint                  Mozilla's validator, run before signing
``` Firefox asks once whether the
site may open `cdreplay` links. Add `&web` to a replay link to get the web client instead. Run the exe once from its
final location so the registered path is right.

## Layout

`main.js` Electron main process. `serve.js` http server: client file cache and patches, map/mod CDN proxy, ladder API
proxy, replay download and upload, country flag store. `cdreplay.js` in-page controller (`window.cdr` in DevTools, F12).
`browser.html` game browser. `cache/` everything downloaded or generated (gitignored).

Client internals are referenced by SystemJS module name (`gui/screen/replay/ReplayScreen`, `game/Game`, ...) and
patched on prototypes; a client update can break them, `cache/client.log` receives the page's error reports.
