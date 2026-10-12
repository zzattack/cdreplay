# cdreplay

A standalone replay viewer for [Chrono Divide](https://chronodivide.com), the browser remake of Red Alert 2. It is the
real game client in an Electron window with a seek bar and observer overlays added:

- **Seeking** both ways on a media-player style bar. Backward seeks use keyframes: extra game instances are built
  with the client's own loader, advanced in idle time and parked, so a jump costs about a second plus the remaining
  simulation at 5,000 to 8,000 ticks per second.
- **Overlays**: match header (players, flags, MMR, power, credits, map, region, date), unit counters with cameos over
  the sidebar, production queues with cameos, health bars for every unit and the owner's current selection, the
  client's target lines for all units, APM per player. Team games are grouped by alliance.
- **End screen** with the result, MMR changes, units built/lost/killed and animated graphs of credits earned, army
  value and APM.
- **Game browser**: ladder standings, recent games (per ladder), a player's games with filters, drag-and-drop of local
  `.rpl` files. Replays switch in about a second without reloading the engine.

cdreplay is not affiliated with Chrono Divide. It downloads the official client from game.chronodivide.com on first run
and patches it in memory; nothing of Chrono Divide or Red Alert 2 is included in this repository or in the builds.

## Install

1. Download `cdreplay.exe` from the latest release (portable, no installer; unsigned, so SmartScreen warns once).
2. Run it. The client asks for the Red Alert 2 game files once: choose "browse folder" and pick your RA2 install
   (the one you imported into the web client works too). Everything is kept in `%LOCALAPPDATA%\cdreplay`.
3. Optional, to open replay links from the ladder site directly in the app: the browser extension in
   `chrome-extension/`. Chrome: `chrome://extensions`, developer mode, "Load unpacked", pick the folder. Firefox: install
   the signed `.xpi` from the release. Add `&web` to a replay link to get the web client instead.

Keys in a replay: space pause, comma/period seek 10 s, `<` `>` seek 1 min, F12 developer tools (`window.cdr`).

## From source

```
npm install
npm start -- [file.rpl | ladder replay url | game id]     game browser, or that replay
npm run dist                                              dist\cdreplay.exe
npm run ext:lint / npm run ext:sign                       Mozilla validator / sign the Firefox add-on (credentials in
                                                          web-ext-config.cjs, see web-ext docs)
```

`cdreplay.bat` launches it from a working copy, with the same optional argument. `npm run dist:offline` adds a
snapshot of the cached client to the exe for a machine without network access; do not distribute that build, the
client is proprietary.

## How it works

`serve.js` is a small http server: it mirrors the client files from game.chronodivide.com into the cache (per version),
injects `cdreplay.js` into `index.html`, proxies maps, mods and the ladder API under the same origin, and serves replay
files. `cdreplay.js` hooks the client's modules by their SystemJS names (`gui/screen/replay/ReplayScreen`,
`network/gamestate/ReplayTurnManager`, `game/Game`, ...) and patches prototypes. `main.js` is the Electron shell,
`browser.html` the game browser.

The engine cannot snapshot its state (task callbacks are closures over live objects), which is why keyframes are
simulated copies rather than saved states. Client patches: no pointer lock and no edge scrolling (the OS cursor works on
the overlays), the viewport always fills the window, the splash delay is skipped, and detect-gpu's fallback for cards
newer than its list no longer reports "unsupported".

A client update can break the hooks; the page reports errors to `cache/client.log`. Replays of older engine versions go
through the official `/old/` client builds, like the web client does.

## CI

`.gitlab-ci.yml` (checks on push, Windows build and release on tags, manual Firefox signing) and
`.github/workflows/release.yml` (build and release on tags). `ci/gitlab-runner/` holds a compose file for a
docker-executor GitLab runner.
