// Electron main process: runs the replay server in-process and shows the client in its own window.
// electron . [file.rpl | ladder url | game id]
const { app, BrowserWindow, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

// caches: next to the sources in development, %LOCALAPPDATA%\cdreplay when packaged (the app folder is read-only)
const CACHE = app.isPackaged ? path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "cdreplay") : path.join(__dirname, "cache");
process.env.CDREPLAY_CACHE = CACHE;
fs.mkdirSync(CACHE, { recursive: true });
// the offline build carries a snapshot of the client and the maps seen so far: seed an empty cache from it
if (app.isPackaged) {
	const snapshot = path.join(process.resourcesPath, "snapshot");
	for (const d of ["client", "cdn"]) {
		if (fs.existsSync(path.join(snapshot, d)) && !fs.existsSync(path.join(CACHE, d))) fs.cpSync(path.join(snapshot, d), path.join(CACHE, d), { recursive: true });
	}
}
const { start, pageUrl } = require("./serve");

// keeps the imported game files (origin storage) next to the other caches
app.setPath("userData", path.join(CACHE, "electron"));
// the client otherwise asks for permission before playing audio
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// cdreplay://open/<encoded replay url> comes from the browser extension; otherwise a file, link or game id
const replayArgOf = argv => {
	const a = argv.slice(app.isPackaged ? 1 : 2).find(a => !a.startsWith("-"));
	return a?.startsWith("cdreplay://") ? decodeURIComponent(a.replace(/^cdreplay:\/\/open\/?/, "")) : a;
};
const replayArg = () => replayArgOf(process.argv);
// the packaged exe handles cdreplay:// links (not a dev run); the portable build runs from a temp copy, so register the
// file the user actually has
if (app.isPackaged) app.setAsDefaultProtocolClient("cdreplay", process.env.PORTABLE_EXECUTABLE_FILE || process.execPath);

let win, base;

async function openReplay(arg) {
	const url = pageUrl(base, arg);
	if (!win) {
		win = new BrowserWindow({ width: 1600, height: 1000, title: "cdreplay", autoHideMenuBar: true, backgroundColor: "#000",
			webPreferences: { backgroundThrottling: false } });
		win.on("closed", () => { win = null; });
		// the replay screen's beforeunload guard would otherwise cancel the close silently
		win.webContents.on("will-prevent-unload", e => e.preventDefault());
		win.webContents.on("before-input-event", (e, input) => { if (input.key === "F12" && input.type === "keyDown") win.webContents.toggleDevTools(); });
		// external links (patch notes, discord) go to the system browser
		win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(base)) shell.openExternal(url); return { action: "deny" }; });
	}
	await win.loadURL(url);
}

app.whenReady().then(async () => {
	// fixed port: the imported game files live in the origin's storage, so the origin must not change between runs
	try { base = await start(8790); }
	catch (e) { dialog.showErrorBox("cdreplay", `Cannot start the local server on port 8790 (${e.code || e.message}). Is another cdreplay running?`); return app.quit(); }
	await openReplay(replayArg()).catch(e => dialog.showErrorBox("cdreplay", "Could not open the replay: " + e.message));
	// debugging aid: touching cache/screenshot.flag writes cache/screenshot.png
	const flag = path.join(CACHE, "screenshot.flag");
	setInterval(async () => {
		if (!win || !fs.existsSync(flag)) return;
		fs.unlinkSync(flag);
		try { fs.writeFileSync(path.join(CACHE, "screenshot.png"), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.error("screenshot failed", e); }
	}, 500);
});

// a second launch (file association, command line) reuses the running window
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (e, argv) => {
	const arg = replayArgOf(argv);
	if (base) openReplay(arg).then(() => win?.focus()).catch(e => dialog.showErrorBox("cdreplay", "Could not open the replay: " + e.message));
});
app.on("window-all-closed", () => app.quit());
