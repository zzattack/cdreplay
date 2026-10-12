/* cdreplay: replay controller injected into the Chrono Divide client. index.html calls window.cdrHook() right before
   SystemJS.import("main"). Hooks the client's ReplayScreen by module name, adds a seekable trackbar and overlays.
   Console access: window.cdr */
(() => {
"use strict";
const MODS = {
	Application: "Application",
	ReplayScreen: "gui/screen/replay/ReplayScreen",
	Game: "game/Game",
	BoxedVar: "util/BoxedVar",
	TargetLines: "engine/renderable/entity/TargetLines",
	ProductionQueue: "game/player/production/ProductionQueue",
	ImageUtils: "engine/gfx/ImageUtils",
	Pointer: "gui/Pointer",
	MapScrollHandler: "gui/screen/game/worldInteraction/MapScrollHandler",
	Engine: "engine/Engine",
	PcxFile: "data/PcxFile",
	SelectionModel: "game/gameobject/selection/SelectionModel",
	UnitSelection: "game/gameobject/selection/UnitSelection",
	OrderActionContext: "game/action/OrderActionContext",
	ReplayTurnManager: "network/gamestate/ReplayTurnManager",
	GameStatus: "game/Game",
	MapFile: "data/MapFile",
	ActionFactory: "game/action/ActionFactory",
	ActionFactoryReg: "game/action/ActionFactoryReg",
};
// lobby flag images per ladder country id (America, Korea, France, Germany, Great Britain, Libya, Iraq, Cuba, Russia)
const FLAGS = ["usai", "japi", "frai", "geri", "gbri", "djbi", "arbi", "lati", "rusi"];
const SPEEDS = [1, 2, 4, 8, 16];
const QUEUE_NAMES = ["Structures", "Armory", "Infantry", "Vehicles", "Aircraft", "Ships"];
const QUEUE_STATUS = ["", "", "on hold", "ready"];
const TOGGLES = { lines: "Target lines", health: "Health bars" };
// counter rows: [allied type, soviet type] pairs shown first, then whatever else the players own, by count
const COUNTER_GROUPS = [["CMIN", "HARV"], ["GAWEAP", "NAWEAP"], ["MTNK", "HTNK"], ["FV", "HTK"], ["MGTK", "APOC"], ["SREF", "V3"], ["ADOG", "DOG"]];
const UNIT_TYPES = [7, 3, 1]; // ObjectType Vehicle, Infantry, Aircraft
const BUILDING = 2;
const cdr = window.cdr = { mods: {}, screen: null, seeking: false, log: [] };
const report = msg => { try { fetch("/log", { method: "POST", body: msg, keepalive: true }); } catch {} };
const log = (...a) => { const m = a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log("[cdreplay]", m); cdr.log.push(m); report(m); };
window.addEventListener("error", e => report("window error: " + (e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", e => report("unhandled rejection: " + (e.reason?.stack || e.reason)));

/* ---------- client hooks ---------- */
async function hook() {
	const sys = window.System || window.SystemJS;
	for (const [k, id] of Object.entries(MODS)) {
		const m = await sys.import(id);
		cdr.mods[k] = m[k] ?? m;
	}
	const RS = cdr.mods.ReplayScreen.prototype;
	const onEnter = RS.onEnter, onLeave = RS.onLeave;
	RS.onEnter = async function (params) {
		cdr.screen = this;
		const t0 = performance.now();
		await onEnter.call(this, params);
		cdr.loadMillis = performance.now() - t0;
		log(`replay screen entered in ${cdr.loadMillis.toFixed(0)} ms, end tick ${params.replay.endTick}, game ${params.replay.gameId}, map ${params.replay.gameOpts?.mapName}${this.game ? "" : " (NO GAME: load failed)"}`);
		if (this.game) mountUi(this);
		if (this.game && !pool.swapping) {
			poolStart(this);
			cdr.econ = { gameId: this.game.id, series: {}, army: {} };
			cdr.apm = apmIndex(this.game, params.replay);
			try { cdr.gameInfo = JSON.parse(localStorage.getItem("cdreplay.game." + params.replay.gameId) || "null"); } catch { cdr.gameInfo = null; }
			if (!cdr.gameInfo) fetchGameInfo(params.replay).catch(() => {});
		}
		// the client's error dialog does not render here: back to the browser with the message instead of a black window
		if (!this.game) { cdr.lastError ||= "Replay could not be loaded"; showBrowser(); browserFrame.contentWindow?.postMessage({ error: cdr.lastError }, "*"); }
		// dev aid (cache/spike.flag): jump to the end of the replay after loading
		if (window.CDR_SPIKE && this.game && !cdr.spikeDone) { cdr.spikeDone = true; setTimeout(() => seek(endTick()), 6000); }
		exportFlags().catch(e => log("flag export failed: " + (e.stack || e)));
	};
	RS.onLeave = async function () {
		unmountUi();
		if (!pool.swapping) poolDispose();
		await onLeave.call(this);
	};
	// the client's own error path (map missing, digest mismatch, crash): record what it showed
	const handleError = RS.handleError;
	RS.handleError = function (e, msg, ...rest) {
		log(`client error dialog: ${msg} :: ${e?.stack || e}`);
		cdr.lastError = msg;
		return handleError.call(this, e, msg, ...rest);
	};
	const consoleError = console.error;
	console.error = (...a) => { consoleError(...a); report("console.error: " + a.map(x => x?.stack || (typeof x === "string" ? x : JSON.stringify(x))).join(" ").slice(0, 2000)); };
	// a turn manager over a parked game must skip the replay events it already applied
	const RTM = cdr.mods.ReplayTurnManager.prototype, rtmInit = RTM.init;
	RTM.init = function () {
		rtmInit.call(this);
		while (this.nextReplayEvent && this.nextReplayEvent.tickNo < this.game.currentTick) this.nextReplayEvent = this.replayIterator.next().value;
	};
	// money spent: credits only fall through spending (cancel refunds and sells count as income here)
	const update = cdr.mods.Game.prototype.update;
	cdr.mods.Game.prototype.update = function () {
		const players = this.getCombatants();
		const before = players.map(p => p.credits);
		update.call(this);
		const spent = this.__spent ??= new Map();
		players.forEach((p, i) => spent.set(p, (spent.get(p) ?? 0) + Math.max(0, before[i] - p.credits)));
		// credits earned per second for the end screen; every instance (live, keyframe copies) contributes the ticks it runs
		if (this.currentTick % 60 === 0 && cdr.econ?.gameId === this.id)
			for (const p of realPlayers(this)) {
				(cdr.econ.series[p.name] ??= new Map()).set(this.currentTick, p.creditsGained);
				(cdr.econ.army[p.name] ??= new Map()).set(this.currentTick, armyValue(p));
			}
	};
	// the window is the whole app: always size the viewport like the client does in full screen (no fixed 1024x768 box)
	const AP = cdr.mods.Application.prototype, updateViewportSize = AP.updateViewportSize;
	AP.updateViewportSize = function () { return updateViewportSize.call(this, true); };
	// no pointer lock: the OS cursor stays usable on the overlay bar (the client's sprite cursor only shows while locked)
	const PP = cdr.mods.Pointer.prototype;
	PP.lock = function () { this.userLockMode = false; };
	PP.listenForFirstCanvasClick = function () {};
	// no edge scrolling; right-drag panning and the arrow keys are separate handlers
	cdr.mods.MapScrollHandler.prototype.update = function () {};
	// health bars for everything and the white selection box for units their owner has selected: the pip overlay shows
	// the bar from selection level Hover and the box from Selected, so the level a unit's model reports is raised
	const damaged = new WeakMap();
	const US = cdr.mods.UnitSelection.prototype, getModel = US.getOrCreateSelectionModel;
	US.getOrCreateSelectionModel = function (unit) { const m = getModel.call(this, unit); m.__unit = unit; return m; };
	cdr.mods.SelectionModel.prototype.getSelectionLevel = function () {
		const u = this.__unit;
		if (!u || !toggles.health || !u.owner || u.owner.isNeutral) return this.selectionLevel;
		if (u.owner.__selection?.isSelected(u)) return this.selectionLevel | (3 & this.maxSelectionLevel); // Selected | Hover: bar and box
		if (!u.isBuilding()) return this.selectionLevel | (1 & this.maxSelectionLevel); // Hover: the engine's bar, no box
		// buildings: the client's bar while below half health or within 5 s of taking damage
		if (u.healthTrait) {
			const h = u.healthTrait.health, now = u.owner?.__game?.currentTick ?? tick(), rec = damaged.get(u) ?? { h, t: -1e9 };
			if (h < rec.h) rec.t = now;
			rec.h = h; damaged.set(u, rec);
			if (h < 50 || now - rec.t < 300) return this.selectionLevel | (1 & this.maxSelectionLevel);
		}
		return this.selectionLevel;
	};
	// each player's current selection, as the engine applies it from the replay's SelectUnits actions
	const OAC = cdr.mods.OrderActionContext.prototype, getSel = OAC.getOrCreateSelection;
	OAC.getOrCreateSelection = function (player) { const sel = getSel.call(this, player); player.__selection = sel; return sel; };
	// quitting a replay opened by url makes the client close the window; go back to the game browser instead
	window.close = showBrowser;
	log("hooks installed");
}

/* detect-gpu 5.0.42 knows no card newer than its benchmark list and reports tier 1 ("unsupported graphics card") for
   those; SystemJS seals module exports, so the vendor bundle's registration of the module is wrapped instead.
   Runs at script load, before dist/vendor.bundle.min.js. */
function patchDetectGpu() {
	const sys = window.System || window.SystemJS, registerDynamic = sys.registerDynamic;
	sys.registerDynamic = function (name, deps, executingRequire, factory) {
		if (name === "detect-gpu") {
			const orig = factory;
			factory = (req, exp, mod) => {
				const m = { exports: {} };
				orig(req, m.exports, m);
				const getGPUTier = m.exports.getGPUTier;
				mod.exports = { ...m.exports, getGPUTier: async (...a) => {
					const r = await getGPUTier(...a);
					if (r.type === "FALLBACK" && /nvidia|radeon rx|intel\(r\) arc/i.test(r.gpu ?? "")) { r.tier = 3; r.type = "CDREPLAY"; }
					return r;
				} };
			};
		}
		return registerDynamic.call(this, name, deps, executingRequire, factory);
	};
}

/* ---------- playback control ---------- */
const game = () => cdr.screen?.game;
const tick = () => game()?.currentTick ?? 0;
const endTick = () => cdr.screen?.params?.replay?.endTick ?? 0;

function setSpeed(mult) {
	const g = game(); if (!g) return;
	const s = cdr.screen;
	const wasPaused = g.speed.value === Number.EPSILON;
	g.desiredSpeed.value = mult * s.baseSpeed;
	if (wasPaused && mult > 0) s.gameTurnMgr.doGameTurn(performance.now());
}
const pause = () => { const g = game(); if (g) g.desiredSpeed.value = Number.EPSILON; };
const isPaused = () => game()?.speed.value === Number.EPSILON;
let lastSpeed = 1;

const yieldTask = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

/* run the simulation to `target` without rendering; renderer.update every few hundred ticks lets it dispose renderables */
async function fastForward(target) {
	const s = cdr.screen, g = s.game;
	target = Math.min(target, endTick());
	if (tick() >= target) return;
	const loop = s.gameAnimationLoop;
	const resumeSpeed = isPaused() ? 0 : g.desiredSpeed.value / s.baseSpeed;
	loop.stop();
	g.desiredSpeed.value = s.baseSpeed; g.speed.value = s.baseSpeed; // turn manager refuses to tick at EPSILON speed
	const t0 = performance.now(), from = tick();
	let sinceRender = 0;
	while (tick() < target && g.status !== 2) {
		const burstEnd = performance.now() + 40;
		while (tick() < target && performance.now() < burstEnd) { s.gameTurnMgr.doGameTurn(performance.now()); sinceRender++; }
		if (sinceRender >= 300) { s.renderer.update(performance.now(), 0); sinceRender = 0; }
		ui.progress(tick());
		await yieldTask();
	}
	cdr.lastRate = (tick() - from) / ((performance.now() - t0) / 1000);
	log(`fast-forward ${from} --> ${tick()} at ${cdr.lastRate.toFixed(0)} ticks/s`);
	loop.start();
	resumeSpeed ? setSpeed(resumeSpeed) : pause();
}

async function seek(target) {
	if (!cdr.screen?.game || cdr.seeking) return;
	cdr.seeking = true;
	try {
		target = Math.max(0, Math.min(Math.round(target), endTick()));
		const paused = isPaused();
		const shadow = poolPick(target);
		if (shadow) await poolSwap(shadow);
		else if (target < tick()) {
			const s = cdr.screen, params = s.params;
			await s.onLeave();
			await s.onEnter(params);
		}
		if (paused) pause();
		await fastForward(target);
		if (paused) pause();
	} finally { cdr.seeking = false; ui.progress(null); }
}

/* ---------- overlays ---------- */
const toggles = Object.fromEntries(Object.keys(TOGGLES).map(k => [k, true]));
try { Object.assign(toggles, JSON.parse(localStorage.getItem("cdreplay.toggles") || "{}")); } catch {}
const saveToggles = () => { try { localStorage.setItem("cdreplay.toggles", JSON.stringify(toggles)); } catch {} };

/* the client's own TargetLines renderable, fed every unit on the map instead of the selection, and never auto-hidden */
function mountTargetLines(screen) {
	const g = screen.game, scene = screen.worldView.worldScene;
	const units = () => g.world.getAllObjects().filter(o => o.isSpawned && o.isUnit());
	const selection = { getSelectedUnits: units, getHash: () => units().reduce((h, u) => h + u.id * 2654435761 % 4294967296, 0) };
	const enabled = new cdr.mods.BoxedVar(toggles.lines);
	const tl = new cdr.mods.TargetLines(undefined, selection, scene.camera, screen.runtimeVars.debugPaths, enabled);
	tl.hideAllLines = () => {};
	tl.disposeUnitLines = () => {
		tl.unitLines.forEach(l => { tl.obj?.remove(l.root); tl.disposeLineObjects(l); });
		tl.unitLines.clear();
	};
	const flashMats = {}, updateLines = tl.updateLines.bind(tl), update = tl.update.bind(tl), dispose = tl.disposeUnitLines;
	tl.disposeUnitLines = () => { tl.__rebuild = true; dispose(); };
	tl.update = now => { tl.__rebuild = false; update(now); };
	tl.updateLines = unit => {
		updateLines(unit);
		const l = tl.unitLines.get(unit);
		if (!l || tl.__rebuild) return;
		const attack = !!unit.unitOrderTrait.targetLinesConfig?.isAttack, mat = l.line.material;
		l.line.material = flashMats[attack] ??= new THREE.LineBasicMaterial({ color: attack ? 0xff8080 : 0xc0ffc0, transparent: true, depthTest: false, depthWrite: false });
		setTimeout(() => { if (tl.unitLines.get(unit) === l) l.line.material = mat; }, 600);
	};
	tl.create3DObject();
	scene.add(tl);
	ui.lines = { enabled, dispose: () => { scene.remove(tl); tl.dispose(); } };
}

const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function uiName(screen, rules) {
	try { const s = screen.strings.get(rules.uiName); if (s) return s; } catch {}
	return rules.name;
}

/* power and production queues per player: player 1 bottom-left, player 2 bottom-right, any others stacked on the left;
   each non-empty queue shows its items as cameos, the first one with progress */
function renderStats(screen) {
	const g = screen.game, ts = teams(g), players = ts.flat();
	const cw = parseInt(ui.root.style.getPropertyValue("--cw")) || 60;
	const panel = p => {
		const pw = p.powerTrait;
		let html = `<div class="pl"><span class="name" style="background:${p.color.asHexString()}">${esc(p.name)}</span>` +
			`<span class="${pw.power - pw.drain < 0 ? "low" : "ok"}">⚡ ${pw.power - pw.drain >= 0 ? "+" : ""}${pw.power - pw.drain}</span>` +
			`<span class="dim">APM ${apmAt(p.name, tick())}</span></div><div class="qs">`;
		for (const q of p.production.getAllQueues()) {
			if (!q.items.length) continue;
			html += `<div class="q"><div class="qt">${QUEUE_NAMES[q.type] ?? q.type}</div><div class="qr">`;
			q.items.forEach((it, i) => {
				const id = ui.cameoId?.(it.rules.name) ?? 0, pct = Math.round(it.progress * 100);
				html += `<div class="qi${i ? " next" : ""}" title="${esc(uiName(screen, it.rules))}"><span class="cameo" style="background-position:${-id * cw}px 0"></span>` +
					(it.quantity > 1 ? `<span class="qty">${it.quantity}</span>` : "") +
					(i ? "" : `<span class="bar"><span style="width:${pct}%"></span></span><span class="st">${QUEUE_STATUS[q.status] || pct + "%"}</span>`) + "</div>";
			});
			html += "</div></div>";
		}
		return `<div class="player">${html}</div></div>`;
	};
	const left = ts.length === 2 ? ts[0] : players.filter((p, i) => i % 2 === 0);
	const right = ts.length === 2 ? ts[1] : players.filter((p, i) => i % 2 === 1);
	ui.statsLeft.innerHTML = left.map(panel).join("");
	ui.statsRight.innerHTML = right.map(panel).join("");
}

const typeOfName = (g, name) => [...UNIT_TYPES, BUILDING].find(t => g.rules.hasObject(name, t));

/* ladder record for a replay opened without the browser (command line, file): looked up in a player's game list */
async function fetchGameInfo(replay) {
	const name = replay.gameOpts.humanPlayers?.[0]?.name;
	if (!name) return;
	for (const server of ["eu", "sea"]) {
		const r = await fetch(`/api/ladder/${server}/api/v1/games?gameSku=16640&player=${encodeURIComponent(name)}&limit=50`);
		if (!r.ok) continue;
		const g = (await r.json()).games?.find(g => g.id === replay.gameId);
		if (g) { cdr.gameInfo = { ...g, server }; try { localStorage.setItem("cdreplay.game." + g.id, JSON.stringify(cdr.gameInfo)); } catch {} return; }
	}
}

const moneyColor = v => v < 500 ? "#f64c4c" : v < 2000 ? "#f0c030" : "#5dca50"; // broke / tight / comfortable
/* match header, top centre: players with flag, mmr and power, credits in the middle, map / region / date below */
function renderHeader(screen) {
	const g = screen.game, ts = teams(g), info = cdr.gameInfo, r = screen.params.replay;
	const part = name => info?.participants?.find(p => p.name.toLowerCase() === name.toLowerCase());
	const side = (t, right) => t.map(p => {
		const q = part(p.name), pw = p.powerTrait, ok = pw.power - pw.drain >= 0;
		const name = `<span class="hn" style="color:${p.color.asHexString()}">${esc(p.name)}</span>`;
		const flag = `<img class="hf" src="/flags/${p.country?.id ?? 0}.png" onerror="this.remove()">`;
		const meta = q?.mmr ? `<span class="hm">${q.mmr.value} MMR</span>` : "";
		const power = `<span class="hp ${ok ? "ok" : "low"}" title="power">⚡●</span>`;
		return right ? `<span class="hs">${power}${meta}${flag}${name}</span>` : `<span class="hs">${name}${flag}${meta}${power}</span>`;
	}).join("");
	const credits = t => t.map(p => `<span class="hc" style="color:${moneyColor(p.credits)}">$${p.credits.toLocaleString()}</span>`).join(" ");
	const left = ts[0] ?? [], rightTeam = ts[1] ?? [];
	const when = new Date(info?.startedAt ?? r.gameTimestamp * (r.gameTimestamp < 1e12 ? 1000 : 1));
	const mapTitle = info?.map?.title ?? r.gameOpts.mapTitle ?? r.gameOpts.mapName;
	const region = info ? { eu: "Europe", sea: "South-East Asia" }[info.server] ?? info.server.toUpperCase() : "";
	ui.header.innerHTML = `<div class="hrow">${side(left)}<span class="hmid">${credits(left)}<span class="hvs">vs</span>${credits(rightTeam)}</span>${side(rightTeam, true)}</div>
		<div class="hrow2"><span>${esc(mapTitle).toUpperCase()}</span>${region ? `<span class="hsep">|</span><span>${esc(region).toUpperCase()}</span>` : ""}<span class="hsep">|</span>` +
		`<span class="hbadge">● REPLAY</span><span>${when.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }).toUpperCase()} ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span></div>`;
}

/* unit counters drawn over the sidebar's cameo slots: one column per combatant, one unit type (or allied/soviet pair) per row */
function mountCounters(screen) {
	const card = screen.hud.sidebarCard, props = card.props;
	const atlas = cdr.mods.ImageUtils.convertShpToCanvas(props.cameoImages, props.cameoPalette);
	const cw = props.cameoImages.width, ch = props.cameoImages.height;
	ui.root.style.cssText += `--cw:${cw}px;--ch:${ch}px;--atlas:url(${atlas.toDataURL()})`;
	ui.counterRows = Math.floor(props.slots / 2);
	const g = screen.game;
	const typeOf = name => typeOfName(g, name);
	ui.cameoId = name => {
		const t = typeOf(name);
		return t === undefined ? undefined : props.cameoNameToIdMap.get(g.art.getObject(name, t).cameo + ".shp");
	};
	const buildable = new Map();
	ui.canBuild = (p, name) => {
		const key = p.name + "/" + name;
		if (!buildable.has(key)) {
			const t = typeOf(name);
			buildable.set(key, t !== undefined && (g.rules.getObject(name, t).owner ?? []).includes(p.country?.name));
		}
		return buildable.get(key);
	};
	ui.counterOrigin = { x: props.x, y: props.y, cw, header: 52 }; // money box 50 px + 2 px gap, so row 1 lands on slot 1
}

function renderCounters(screen) {
	const g = screen.game, players = teamOrder(g), spent = g.__spent ?? new Map();
	const counts = players.map(p => {
		const m = new Map();
		for (const t of [...UNIT_TYPES, BUILDING]) for (const o of p.objectsByType.get(t) ?? []) if (o.isSpawned && !o.isDestroyed) m.set(o.name, (m.get(o.name) ?? 0) + 1);
		return m;
	});
	const grouped = new Set(COUNTER_GROUPS.flat());
	const rows = COUNTER_GROUPS.map(g => ({ names: g }));
	const extra = new Map();
	// transient spawns (paradrop plane, rockets, hornets) are unbuildable: tech level -1
	const countable = name => { const t = UNIT_TYPES.find(t => g.rules.hasObject(name, t)); return t !== undefined && (g.rules.getObject(name, t).techLevel ?? -1) >= 0; };
	counts.forEach(m => m.forEach((n, name) => { if (!grouped.has(name) && countable(name)) extra.set(name, Math.max(extra.get(name) ?? 0, n)); }));
	rows.push(...[...extra].sort((a, b) => b[1] - a[1]).map(([name]) => ({ names: [name] })));
	const total = row => counts.reduce((s, m) => s + row.names.reduce((t, n) => t + (m.get(n) ?? 0), 0), 0);
	// more than two players: blocks of two stacked in the sidebar, each with its own money box taking one slot row
	const blocks = [];
	for (const t of players.length > 2 ? teams(g) : [players]) for (let i = 0; i < t.length; i += 2) blocks.push(t.slice(i, i + 2));
	const rowsPer = blocks.length > 1 ? Math.floor((ui.counterRows - 1) / 2) : ui.counterRows;
	const shown = rows.filter(row => total(row) > 0).slice(0, rowsPer);
	const cameoOf = (p, i, names) => {
		const owned = names.map(n => [n, counts[i].get(n) ?? 0]).sort((a, b) => b[1] - a[1]);
		return owned[0][1] > 0 ? owned[0][0] : names[Math.min(p.country?.side ?? 0, names.length - 1)];
	};
	const cw = parseInt(ui.root.style.getPropertyValue("--cw"));
	const col = p => {
		const i = players.indexOf(p), color = p.color.asHexString();
		let html = `<div class="col" style="--pc:${color}"><div class="money"><div style="color:${moneyColor(p.credits)}">$${p.credits}</div><div class="dim">$${spent.get(p) ?? 0}</div></div>`;
		for (const row of shown) {
			const n = row.names.reduce((s, name) => s + (counts[i].get(name) ?? 0), 0);
			// a type the player's country cannot build and does not own leaves the slot empty instead of showing 0
			if (!n && !row.names.some(name => ui.canBuild(p, name))) { html += '<div class="row"></div>'; continue; }
			const name = cameoOf(p, i, row.names), id = ui.cameoId(name);
			if (id === undefined && !ui.noCameo?.has(name)) { (ui.noCameo ??= new Set()).add(name); log(`counters: no cameo for ${name}`); }
			const cameo = id === undefined ? `<span class="cameo text">${esc(uiName(screen, g.rules.getObject(name, typeOfName(g, name))))}</span>`
				: `<span class="cameo" style="background-position:${-id * cw}px 0"></span>`;
			html += `<div class="row${n ? "" : " none"}">${cameo}<span class="n">${n}</span></div>`;
		}
		return html + "</div>";
	};
	ui.counters.innerHTML = blocks.map(b => `<div class="blk">${b.map(col).join("")}</div>`).join("");
}

/* ---------- game browser overlay: the client stays loaded, replays are switched by hash change (~1 s) ---------- */
let browserFrame;
function showBrowser() {
	pause();
	try { cdr.screen?.sound?.audioSystem.setMuted(true); } catch {}
	// kept in the page and only hidden: re-attaching an iframe reloads it and loses the browser's view
	if (!browserFrame) {
		browserFrame = document.createElement("iframe");
		browserFrame.src = "/browse";
		browserFrame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:20000;background:#0b0e13";
		document.body.appendChild(browserFrame);
	}
	browserFrame.style.display = "";
}
function openReplay(id) {
	if (browserFrame) browserFrame.style.display = "none";
	try { cdr.screen?.sound?.audioSystem.setMuted(false); } catch {}
	location.hash = "#/replay/" + encodeURIComponent(`${location.origin}/replay/${id}.rpl`);
}

/* cost of a player's living units (vehicles, infantry, aircraft) */
function armyValue(p) {
	let v = 0;
	for (const t of UNIT_TYPES) for (const o of p.objectsByType.get(t) ?? []) if (o.isSpawned && !o.isDestroyed) v += o.rules.cost ?? 0;
	return v;
}
/* actions per player from the replay file: sorted action ticks with a running count, for APM over any window */
function apmIndex(g, replay) {
	const ticks = {};
	for (const ev of replay.getEvents?.() ?? replay.events ?? []) {
		if (!Array.isArray(ev.payload)) continue;
		for (const [pid, actions] of ev.payload) {
			const name = g.getPlayer(pid)?.name;
			// NoAction (id 0) is the lockstep keep-alive, not something the player did
			const n = actions.filter(a => a.id !== 0).length;
			if (name && n) (ticks[name] ??= []).push([ev.tickNo, n]);
		}
	}
	const index = {};
	for (const [name, list] of Object.entries(ticks)) {
		let sum = 0;
		index[name] = { t: list.map(x => x[0]), c: list.map(x => sum += x[1]) };
	}
	return index;
}
/* actions in the minute before `tick` (3600 ticks at 60 ticks/s), from the start if the game is younger */
function apmAt(name, tick) {
	const ix = cdr.apm?.[name];
	if (!ix) return 0;
	const countBefore = t => { let lo = 0, hi = ix.t.length; while (lo < hi) { const m = (lo + hi) >> 1; ix.t[m] < t ? lo = m + 1 : hi = m; } return lo ? ix.c[lo - 1] : 0; };
	const from = Math.max(0, tick - 3600), n = countBefore(tick + 1) - countBefore(from);
	return Math.round(n * 3600 / Math.max(600, tick - from));
}

/* ---------- end screen: result, players, credits-earned graph drawn over 5 s ---------- */
const END_ANIM_MS = 5000;
const COUNTRY_NAMES = ["America", "Korea", "France", "Germany", "Great Britain", "Libya", "Iraq", "Cuba", "Russia"];
const money = v => v >= 1000 ? "$" + (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : "$" + Math.round(v);
const realPlayers = g => g.getNonNeutralPlayers().filter(p => !p.isObserver);
/* players grouped by alliance (teammates adjacent), as formed at the start of the replay: a player who surrenders
   is dropped from the engine's alliances, which must not turn a 2v2 into a 2v1. Kept by name, keyframe copies have
   their own player objects. */
function teams(g) {
	const players = realPlayers(g);
	if (cdr.teamNames?.gameId !== g.id) {
		const out = [];
		for (const p of players) {
			const t = out.find(t => t.some(q => q === p || g.alliances.areAllied(p, q)));
			t ? t.push(p) : out.push([p]);
		}
		cdr.teamNames = { gameId: g.id, names: out.map(t => t.map(p => p.name)) };
	}
	const byName = new Map(players.map(p => [p.name, p]));
	return cdr.teamNames.names.map(t => t.map(n => byName.get(n)).filter(Boolean)).filter(t => t.length);
}
const teamOrder = g => teams(g).flat();
function showEndScreen(screen) {
	const g = screen.game, ts = teams(g), players = ts.flat(), info = cdr.gameInfo;
	const alive = p => !p.defeated && !p.resigned;
	const winners = ts.find(t => t.some(alive)) ?? [players[0]];
	const winner = winners.find(alive) ?? winners[0];
	const part = name => info?.participants?.find(p => p.name.toLowerCase() === name.toLowerCase());
	const country = p => COUNTRY_NAMES[p.country?.id] ?? p.country?.name ?? "";
	const mapTitle = info?.map?.title ?? screen.params.replay.gameOpts.mapTitle ?? screen.params.replay.gameOpts.mapName;
	const mode = info ? `${info.participants?.every(p => p.ranked) ? "ranked" : "unranked"} ${info.participants?.filter(p => p.type === "player").length === 2 ? "1v1" : "team"}` : "";
	const mmr = p => { const q = part(p.name); if (!q?.mmr) return ""; const c = q.mmr.change ?? 0;
		return `<span class="mmr">${q.mmr.value}</span>${c ? `<span class="chg ${c > 0 ? "up" : "down"}">${c > 0 ? "▲" : "▼"}${Math.abs(c)}</span>` : ""}`; };
	const el = ui.end = document.createElement("div");
	el.className = "end";
	el.innerHTML = `<div class="box">
		<div class="result" style="color:${winner.color.asHexString()}">${alive(winner) ? (winners.length > 1 ? "TEAM VICTORY" : "VICTORY") : "DRAW"}</div>
		<div class="winner">${winners.map(p => `<span style="color:${p.color.asHexString()}">${esc(p.name)}</span>`).join('<span class="amp"> &amp; </span>')}</div>
		<div class="line">${[country(winner), mapTitle, clock(endTick()), mode].filter(Boolean).map(t => esc(t).toUpperCase()).join(" / ")}</div>
		<div class="players">${ts.map(t => t.map(p => `<span class="pn" style="color:${p.color.asHexString()}">${esc(p.name)}</span>${mmr(p)}`).join('<span class="amp">&amp;</span>')).join('<span class="sep">vs</span>')}
			<span class="right">${info ? esc(info.server.toUpperCase()) + " · " + mode.toUpperCase() : ""}</span></div>
		<div class="totals">${players.map(p => `<span style="color:${p.color.asHexString()}">${esc(p.name)}</span> built ${sumMap(p.unitsBuiltByType)} · lost ${sumMap(p.unitsLostByType)} · killed ${sumMap(p.unitsKilledByType)}`).join('<span class="sep">/</span>')}</div>
		<div class="graphs">
			<div><div class="line2">CREDITS EARNED</div><canvas data-g="credits"></canvas></div>
			<div><div class="line2">ARMY VALUE</div><canvas data-g="army"></canvas></div>
			<div><div class="line2">APM</div><canvas data-g="apm"></canvas></div>
		</div>
		<div class="actions"><button data-act="close">Close</button><button data-act="browse">Ladder</button></div>
	</div>`;
	ui.root.appendChild(el);
	el.querySelector("[data-act=close]").onclick = () => { ui.endDismissed = true; hideEndScreen(); };
	el.querySelector("[data-act=browse]").onclick = () => { hideEndScreen(); showBrowser(); };
	const start = performance.now(), end = endTick() || 1;
	const sorted = m => [...(m ?? new Map())].sort((a, b) => a[0] - b[0]);
	const apmSeries = p => { const pts = []; for (let t = 0; t <= end; t += 600) pts.push([t, apmAt(p.name, t)]); return pts; };
	const graphs = [
		{ canvas: el.querySelector("[data-g=credits]"), fmt: money, series: players.map(p => ({ color: p.color.asHexString(), pts: sorted(cdr.econ?.series[p.name]) })) },
		{ canvas: el.querySelector("[data-g=army]"), fmt: money, series: players.map(p => ({ color: p.color.asHexString(), pts: sorted(cdr.econ?.army[p.name]) })) },
		{ canvas: el.querySelector("[data-g=apm]"), fmt: v => String(Math.round(v)), series: players.map(p => ({ color: p.color.asHexString(), pts: apmSeries(p) })) },
	];
	const draw = () => {
		if (!ui.end) return;
		const prog = Math.min(1, (performance.now() - start) / END_ANIM_MS);
		for (const g of graphs) drawGraph(g, prog, end);
		if (prog < 1) ui.endRaf = requestAnimationFrame(draw);
	};
	ui.endRaf = requestAnimationFrame(draw);
}
const sumMap = m => { let n = 0; for (const v of m?.values?.() ?? []) n += v; return n; };
function drawGraph({ canvas, fmt, series }, p, end) {
	{
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
		const ctx = canvas.getContext("2d");
		ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const L = 56, R = 70, T = 14, B = 26;
		const maxV = Math.max(fmt === money ? 1000 : 10, ...series.flatMap(s => s.pts.map(p => p[1])));
		const step = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 25000, 50000, 100000, 200000].find(st => maxV / st <= 5) ?? 500000;
		const top = Math.ceil(maxV / step) * step;
		const x = t => L + (w - L - R) * t / end, y = v => T + (h - T - B) * (1 - v / top);
		ctx.font = "11px ui-monospace, monospace"; ctx.fillStyle = "#8e9bb0"; ctx.strokeStyle = "#263043"; ctx.lineWidth = 1;
		for (let v = 0; v <= top; v += step) { ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(w - R, y(v)); ctx.stroke(); ctx.textAlign = "right"; ctx.fillText(fmt(v), L - 6, y(v) + 4); }
		ctx.textAlign = "center";
		for (let i = 0; i <= 2; i++) ctx.fillText(clock(end * i / 2), x(end * i / 2), h - 8);
		const limit = end * p;
		for (const s of series) {
			const pts = s.pts.filter(q => q[0] <= limit);
			if (!pts.length) continue;
			ctx.beginPath(); ctx.moveTo(x(pts[0][0]), y(pts[0][1]));
			for (const q of pts) ctx.lineTo(x(q[0]), y(q[1]));
			ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
			ctx.lineTo(x(pts[pts.length - 1][0]), y(0)); ctx.lineTo(x(pts[0][0]), y(0)); ctx.closePath();
			ctx.fillStyle = s.color + "22"; ctx.fill();
		}
		for (const s of series) {
			const last = s.pts.filter(q => q[0] <= limit).pop();
			if (!last) continue;
			ctx.beginPath(); ctx.arc(x(last[0]), y(last[1]), 4, 0, 7); ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.fillStyle = "#0b0e13"; ctx.fill(); ctx.stroke();
			ctx.font = "bold 15px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = s.color; ctx.fillText(fmt(last[1]), x(last[0]) + 9, y(last[1]) + 5);
			ctx.font = "11px ui-monospace, monospace";
		}
	}
}
function hideEndScreen() {
	cancelAnimationFrame(ui.endRaf);
	ui.end?.remove();
	ui.end = null;
}

/* ---------- ui ---------- */
const ui = { root: null, statsLeft: null, statsRight: null, counters: null, bar: null, raf: 0, lines: null, progress() {} };
const clock = t => { const s = Math.floor(t / 60); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/* width of the HUD's timer lines (same text and font as SuperWeaponTimers draws, 4 px padding each side) */
function timersWidth(screen) {
	const g = screen.game, lines = [];
	for (const p of g.getCombatants()) {
		if (p.defeated) continue;
		for (const sw of p.superWeaponsTrait?.getAll() ?? []) if (sw.rules.showTimer) lines.push(screen.strings.get(sw.rules.uiName) + "   00:00");
		if (p.powerTrait?.getBlackoutDuration()) lines.push(screen.strings.get("MSG:BlackoutTimer") + "   00:00");
	}
	if (g.countdownTimer?.isRunning()) lines.push((g.countdownTimer.text ? screen.strings.get(g.countdownTimer.text) + "   " : "") + "00:00");
	const ctx = ui.measure ??= document.createElement("canvas").getContext("2d");
	ctx.font = "500 12px 'Fira Sans Condensed', Arial, sans-serif";
	return Math.ceil(Math.max(0, ...lines.map(t => ctx.measureText(t).width))) + 8;
}

/* overlay geometry follows the game canvas: the trackbar sits over the world view above the action bar, the counters
   over the sidebar's cameo slots */
function layout(screen) {
	const r = screen.renderer.getCanvas().getBoundingClientRect(), vp = screen.viewport.value, hud = screen.hud;
	const sx = r.width / vp.width, sy = r.height / vp.height;
	// inside the client's action bar, to the right of its rewind/play/pause/speed buttons
	const barBottom = (innerHeight - r.bottom) + hud.actionBarHeight * sy;
	ui.bar.style.left = r.left + 250 * sx + "px";
	ui.bar.style.width = (vp.width - hud.sidebarWidth - 250 - 36) * sx + "px";
	ui.bar.style.bottom = innerHeight - r.bottom + "px";
	ui.bar.style.height = hud.actionBarHeight * sy + "px";
	ui.stop.style.right = (innerWidth - r.right) + hud.sidebarWidth * sx + 6 + "px";
	ui.stop.style.top = r.top + 6 + "px";
	ui.header.style.left = r.left + (vp.width - hud.sidebarWidth) * sx / 2 + "px";
	ui.header.style.top = r.top + "px";
	ui.statsLeft.style.left = r.left + 6 + "px";
	// the client's super weapon timers sit in the bottom right corner of the world view: leave them room while shown
	const timers = hud.superWeaponTimers?.lastHasTimers ? timersWidth(screen) + 6 : 6;
	ui.statsRight.style.right = (innerWidth - r.right) + (hud.sidebarWidth + timers) * sx + "px";
	ui.statsLeft.style.bottom = ui.statsRight.style.bottom = barBottom + 4 + "px";
	if (ui.counterOrigin) {
		// slot offsets are relative to the sidebar; the money box takes the row above the first slot
		// the sidebar has two slot columns (cameo width + 3 px gap); one player per column, more players squeeze in
		const o = ui.counterOrigin, left = vp.width - hud.sidebarWidth + o.x, width = 2 * o.cw + 3;
		ui.counters.style.left = r.left + left * sx + "px";
		ui.counters.style.top = r.top + (o.y - o.header) * sy + "px";
		ui.counters.style.width = width + "px";
		ui.counters.style.transform = `scale(${sx}, ${sy})`;
		ui.counters.style.transformOrigin = "0 0";
		ui.counters.style.setProperty("--cs", "1"); // at most two columns per block, each exactly one slot wide
	}
}

function mountUi(screen) {
	unmountUi();
	const root = ui.root = document.createElement("div");
	root.id = "cdreplay";
	root.innerHTML = `
	<style>
	#cdreplay { color: #eee; font: 12px system-ui, sans-serif; }
	#cdreplay .bar { position: fixed; z-index: 10000; display: flex; gap: 12px; align-items: center; padding: 0 8px; }
	#cdreplay input[type=range] { -webkit-appearance: none; flex: 1; height: 14px; margin: 0; background: transparent; }
	/* the client styles every range input (red bordered 24 px track, red image thumb): reset those explicitly */
	#cdreplay input[type=range]::-webkit-slider-runnable-track { height: 6px; border: none; border-radius: 3px; box-sizing: border-box;
		background-image: none; background: linear-gradient(to right, #5aa0ff var(--p, 0%), #2a3a50 var(--p, 0%)); }
	#cdreplay input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -4px; border-radius: 50%;
		background-image: none; background-color: #fff; border: 1px solid #5aa0ff; box-sizing: border-box; box-shadow: 0 0 3px #000; }
	#cdreplay *:focus { outline: none; }
	#cdreplay button { background: #1c2536; color: #eee; border: 1px solid #3a4a66; border-radius: 4px; padding: 1px 8px; font: 11px system-ui, sans-serif; cursor: pointer; }
	#cdreplay button:hover { border-color: #5aa0ff; }
	#cdreplay .stop { position: fixed; z-index: 10000; padding: 3px 10px; font-size: 12px; background: rgba(0,0,0,.6); }
	#cdreplay.menu .stats, #cdreplay.menu .counters, #cdreplay.menu .bar, #cdreplay.menu .stop, #cdreplay.menu .header { display: none; }
	#cdreplay .header { position: fixed; z-index: 10000; transform: translateX(-50%); pointer-events: none; text-align: center; font: 12px system-ui, sans-serif; }
	#cdreplay .hrow { display: inline-flex; align-items: center; gap: 14px; padding: 4px 16px; background: rgba(6,10,18,.3); text-shadow: 0 1px 3px #000; border: 1px solid #263043; border-top: 0; border-radius: 0 0 6px 6px; }
	#cdreplay .hs { display: inline-flex; align-items: center; gap: 8px; }
	#cdreplay .hn { font: bold 17px system-ui, sans-serif; letter-spacing: .02em; }
	#cdreplay .hf { height: 14px; }
	#cdreplay .hm { color: #aab; font-variant-numeric: tabular-nums; }
	#cdreplay .hp { font-size: 10px; letter-spacing: -2px; } #cdreplay .hp.ok { color: #5dca50; } #cdreplay .hp.low { color: #f64c4c; }
	#cdreplay .hmid { display: inline-flex; align-items: center; gap: 12px; margin: 0 10px; }
	#cdreplay .hc { font: bold 20px system-ui, sans-serif; font-variant-numeric: tabular-nums; text-shadow: 0 0 6px rgba(0,0,0,.8); }
	#cdreplay .hvs { color: #667; font: bold 12px system-ui, sans-serif; }
	#cdreplay .hrow2 { display: inline-flex; align-items: center; gap: 10px; margin-top: -1px; padding: 2px 14px; background: rgba(6,10,18,.3); text-shadow: 0 1px 3px #000; border: 1px solid #263043; border-top: 0; border-radius: 0 0 6px 6px;
		font: 11px ui-monospace, monospace; letter-spacing: .12em; color: #bcc; }
	#cdreplay .hsep { color: #556; }
	#cdreplay .hbadge { background: #5a1a1a; color: #f99; padding: 0 6px; border-radius: 3px; letter-spacing: .08em; }
	#cdreplay .end { position: fixed; inset: 0; z-index: 15000; background: rgba(5,8,12,.94); display: flex; align-items: center; justify-content: center; }
	#cdreplay .end .box { width: min(1200px, 92vw); height: min(760px, 90vh); display: flex; flex-direction: column; padding: 28px 40px; box-sizing: border-box;
		border: 1px solid #263043; background: #0b0e13; font-family: ui-monospace, monospace; letter-spacing: .15em; color: #8e9bb0; }
	#cdreplay .end .result { font-size: 14px; letter-spacing: .4em; opacity: .85; }
	#cdreplay .end .winner { font: bold 56px system-ui, sans-serif; letter-spacing: .02em; line-height: 1.1; }
	#cdreplay .end .line { font-size: 14px; margin: 6px 0 16px; }
	#cdreplay .end .players { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid #263043; font-size: 14px; }
	#cdreplay .end .pn { font: bold 24px system-ui, sans-serif; letter-spacing: .02em; }
	#cdreplay .end .mmr { color: #ccd; }
	#cdreplay .end .chg { padding: 1px 7px; font: bold 18px system-ui, sans-serif; color: #000; letter-spacing: 0; }
	#cdreplay .end .chg.up { background: #f0b429; } #cdreplay .end .chg.down { background: #e2574c; }
	#cdreplay .end .sep { color: #556; margin: 0 6px; }
	#cdreplay .end .amp { color: #667; margin: 0 4px; font: bold 18px system-ui, sans-serif; }
	#cdreplay .end .winner .amp { font-size: 32px; }
	#cdreplay .end .right { margin-left: auto; font-size: 13px; }
	#cdreplay .end .line2 { margin: 18px 0 4px; font-size: 14px; color: #e8b84a; }
	#cdreplay .end .totals { margin-top: 10px; font-size: 13px; }
	#cdreplay .end .totals span[style] { font: bold 14px system-ui, sans-serif; letter-spacing: 0; }
	#cdreplay .end .graphs { flex: 1; min-height: 0; display: flex; gap: 20px; }
	#cdreplay .end .graphs > div { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	#cdreplay .end canvas { flex: 1; width: 100%; min-height: 0; }
	#cdreplay .end .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
	#cdreplay .end button { font-size: 12px; padding: 4px 12px; }
	#cdreplay .clock { font-family: ui-monospace, monospace; min-width: 84px; text-align: center; }
	#cdreplay .busy { color: #fc6; min-width: 60px; }
	#cdreplay label { display: inline-flex; gap: 3px; align-items: center; cursor: pointer; white-space: nowrap; }
	#cdreplay .stats { position: fixed; z-index: 10000; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
	#cdreplay .player { background: rgba(0,0,0,.65); border-radius: 4px; padding: 4px 6px; }
	#cdreplay .pl { display: flex; gap: 10px; align-items: center; font-variant-numeric: tabular-nums; margin-bottom: 3px; }
	#cdreplay .name { color: #000; font-weight: 600; padding: 0 6px; border-radius: 3px; }
	#cdreplay .dim { color: #aaa; }
	#cdreplay .low { color: #f66; font-weight: 600; }
	#cdreplay .ok { color: #5dca50; font-weight: 600; }
	#cdreplay .qs { display: flex; gap: 8px; align-items: flex-end; }
	#cdreplay .qt { color: #999; font-size: 10px; text-transform: uppercase; margin-bottom: 1px; }
	#cdreplay .qr { display: flex; gap: 2px; align-items: flex-end; }
	/* progress strip below the cameo so the unit name printed on the cameo stays readable */
	#cdreplay .qi { position: relative; width: var(--cw); height: calc(var(--ch) + 14px); flex: none; }
	#cdreplay .qi.next { width: calc(var(--cw) * .5); height: calc(var(--ch) * .5); }
	#cdreplay .qi.next .cameo { transform: scale(.5); transform-origin: 0 0; }
	#cdreplay .qi .qty { position: absolute; right: 0; top: 0; padding: 0 3px; background: rgba(0,0,0,.75); font-weight: bold; font-size: 11px; border-radius: 0 0 0 3px; }
	#cdreplay .qi .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.15); }
	#cdreplay .qi .bar span { display: block; height: 100%; background: #3c3; }
	#cdreplay .qi .st { position: absolute; left: 0; right: 0; bottom: 3px; height: 11px; line-height: 11px; text-align: center; font-size: 10px; }
	#cdreplay .counters { position: fixed; z-index: 10000; display: flex; flex-direction: column; gap: 2px; pointer-events: none; }
	#cdreplay .blk { display: flex; gap: 3px; }
	#cdreplay .blk .col { width: var(--cw); flex: none; }
	#cdreplay .col { flex: 1; min-width: 0; box-shadow: 0 0 0 2px var(--pc); border-radius: 2px; background: rgba(0,0,0,.7); }
	#cdreplay .money { height: 50px; box-sizing: border-box; text-align: center; margin-bottom: 2px; padding: 6px 0 0; overflow: hidden;
		border-radius: 2px; border: 1px solid color-mix(in srgb, var(--pc) 60%, black);
		background: radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--pc) 45%, black) 0%, #000 100%);
		font: bold 16px/18px system-ui, sans-serif; color: #fff; text-shadow: 0 1px 2px #000; font-variant-numeric: tabular-nums; }
	#cdreplay .money .dim { font-size: 10px; line-height: 14px; font-weight: 600; color: #ddd; letter-spacing: .2px; }
	#cdreplay .row { position: relative; height: calc(var(--ch) + 2px); }
	#cdreplay .row.none .cameo { opacity: .4; }
	#cdreplay .n { position: absolute; left: 0; top: 0; min-width: 20px; height: 20px; padding: 0 3px; box-sizing: border-box; border-radius: 0 0 4px 0;
		text-align: center; font: bold 14px/20px system-ui, sans-serif; color: #fff; text-shadow: 0 0 2px #000;
		background: radial-gradient(circle at 50% 50%, var(--pc) 0%, #000 100%); }
	#cdreplay .cameo { display: block; width: var(--cw); height: var(--ch); background-image: var(--atlas); background-repeat: no-repeat;
		transform: scale(var(--cs, 1)); transform-origin: 0 0; }
	#cdreplay .cameo.text { background: #222; display: flex; align-items: center; justify-content: center; text-align: center;
		font: bold 10px/11px system-ui, sans-serif; color: #ddd; box-sizing: border-box; padding: 2px; overflow: hidden; }
	</style>
	<div class="header"></div>
	<div class="stats left"></div>
	<div class="stats right"></div>
	<div class="counters"></div>
	<div class="bar">
		<input type="range" min="0" max="${endTick()}" value="0">
		<span class="clock"></span><span class="busy"></span>
		${Object.entries(TOGGLES).map(([k, v]) => `<label><input type="checkbox" data-toggle="${k}" ${toggles[k] ? "checked" : ""}>${v}</label>`).join("")}
	</div>
	<button class="stop" data-act="browse" title="Stop the replay and return to the ladder">&#9632; Stop</button>`;
	document.body.appendChild(root);
	ui.statsLeft = root.querySelector(".stats.left");
	ui.statsRight = root.querySelector(".stats.right");
	ui.counters = root.querySelector(".counters");
	ui.bar = root.querySelector(".bar");
	ui.stop = root.querySelector(".stop");
	ui.header = root.querySelector(".header");
	// nothing of ours over the game menu
	ui.menuOpen = () => root.classList.add("menu");
	ui.menuClosed = () => root.classList.remove("menu");
	screen.menu?.onOpen.subscribe(ui.menuOpen);
	screen.menu?.onCancel.subscribe(ui.menuClosed);
	const range = root.querySelector("input[type=range]"), clockEl = root.querySelector(".clock"), busy = root.querySelector(".busy");
	let dragging = false;
	const fill = () => range.style.setProperty("--p", (100 * range.value / (endTick() || 1)).toFixed(2) + "%");
	range.oninput = () => { dragging = true; fill(); clockEl.textContent = clock(+range.value) + " / " + clock(endTick()); };
	range.onchange = () => { dragging = false; range.blur(); seek(+range.value); }; // no focus ring, arrow keys stay with the game
	root.querySelectorAll("[data-toggle]").forEach(cb => cb.onchange = () => {
		toggles[cb.dataset.toggle] = cb.checked;
		saveToggles();
		if (ui.lines) ui.lines.enabled.value = toggles.lines;
	});
	// the client's document-level pointer handlers must not see events meant for the bar (window capture runs first)
	// stopping propagation at window capture also keeps the event from our own listeners, so act on the stop button here
	ui.stopper = e => {
		if (!ui.bar?.contains(e.target) && !ui.stop?.contains(e.target)) return;
		e.stopPropagation();
		if (e.type === "click" && ui.stop.contains(e.target)) showBrowser();
	};
	for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) window.addEventListener(t, ui.stopper, true);
	ui.progress = t => { busy.textContent = t === null ? "" : "seeking " + clock(t); };
	document.addEventListener("keydown", ui.onKey = e => {
		if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
		const step = { ",": -600, ".": 600, "<": -3600, ">": 3600 }[e.key];
		if (e.key === " ") {
			const g = game();
			if (isPaused()) setSpeed(ui.resumeSpeed || 1);
			else { ui.resumeSpeed = g.desiredSpeed.value / screen.baseSpeed; pause(); }
		} else if (step) seek(tick() + step);
		else return;
		e.preventDefault(); e.stopPropagation();
	}, true);
	try { mountTargetLines(screen); } catch (e) { log("target lines failed: " + (e.stack || e)); }
	try { mountCounters(screen); } catch (e) { log("counters failed: " + (e.stack || e)); }
	let lastPanel = 0;
	const frame = now => {
		if (!dragging && !cdr.seeking) { range.value = tick(); fill(); }
		if (!dragging) clockEl.textContent = clock(tick()) + " / " + clock(endTick());
		const ended = game().status === cdr.mods.GameStatus.Ended || tick() >= endTick();
		if (ended && !ui.end && !ui.endDismissed && !cdr.seeking) showEndScreen(screen);
		if (!ended) { if (ui.end) hideEndScreen(); ui.endDismissed = false; }
		if (now - lastPanel > 150) {
			lastPanel = now;
			try { layout(screen); renderStats(screen); renderHeader(screen); if (ui.counterOrigin) renderCounters(screen); }
			catch (e) { if (!ui.panelError) { ui.panelError = true; log("panel failed: " + (e.stack || e)); } }
		}
		ui.raf = requestAnimationFrame(frame);
	};
	ui.raf = requestAnimationFrame(frame);
}

function unmountUi() {
	cancelAnimationFrame(ui.raf);
	if (ui.onKey) document.removeEventListener("keydown", ui.onKey, true);
	if (ui.stopper) for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) window.removeEventListener(t, ui.stopper, true);
	try { ui.lines?.dispose(); } catch {}
	ui.lines = null;
	ui.root?.remove();
	try { cdr.screen?.menu?.onOpen.unsubscribe(ui.menuOpen); cdr.screen?.menu?.onCancel.unsubscribe(ui.menuClosed); } catch {}
	hideEndScreen();
	ui.endDismissed = false;
	ui.root = ui.statsLeft = ui.statsRight = ui.counters = ui.bar = ui.stop = ui.header = null;
	ui.counterOrigin = null;
}

/* the game browser has no access to the game files: hand it the country flags once, as png */
async function exportFlags() {
	if ((await fetch("/flags/ok")).ok) return;
	const vfs = cdr.mods.Engine.vfs, out = {};
	FLAGS.forEach((name, id) => { if (vfs.fileExists(name + ".pcx")) out[id] = new cdr.mods.PcxFile(vfs.openFile(name + ".pcx")).toDataUrl(); });
	await fetch("/flags", { method: "POST", body: JSON.stringify(out) });
	log(`exported ${Object.keys(out).length} flags`);
}

/* ---------- keyframes: parked shadow games ----------
   The engine cannot snapshot (its task callbacks are closures over live objects), so keyframes are extra Game instances
   built with the loader's createGame, advanced with idle time to k * interval ticks and parked. A backward seek hands the
   best parked game to the replay screen in place of a freshly built one, then fast-forwards the rest. */
const POOL_MAX = 6, POOL_MIN_INTERVAL = 3600, SWAP_COST = 7000; // ticks; a swap costs about as much as 7000 ticks of simulation
const pool = { shadows: [], queue: [], building: null, screen: null, swapping: false, idle: 0 };

function poolStart(screen) {
	poolDispose();
	const end = endTick(), n = Math.min(POOL_MAX, Math.floor(end / POOL_MIN_INTERVAL));
	if (n < 1) return;
	pool.screen = screen;
	pool.interval = Math.ceil(end / (n + 1) / 60) * 60;
	pool.queue = Array.from({ length: n }, (_, i) => (i + 1) * pool.interval);
	pool.createGame = Object.getPrototypeOf(screen.gameLoader).createGame;
	pool.idle = requestIdleCallback(poolWork, { timeout: 500 });
}

function poolDispose() {
	cancelIdleCallback(pool.idle);
	for (const sh of [...pool.shadows, pool.building].filter(Boolean)) { try { sh.mgr.dispose(); sh.game.dispose(); } catch {} }
	pool.shadows = []; pool.queue = []; pool.building = null; pool.screen = null;
}

async function poolBuild(target) {
	const s = pool.screen, r = s.params.replay, opts = r.gameOpts, loader = s.gameLoader;
	const mapFile = new cdr.mods.MapFile(await s.mapFileLoader.load(opts.mapName));
	const bots = await loader.loadBotsLib();
	const t0 = performance.now();
	const { game } = await pool.createGame.call(loader, r.gameId, r.gameTimestamp, opts, mapFile, opts.humanPlayers.length === 1, bots);
	game.init(undefined);
	game.start();
	game.desiredSpeed.value = game.speed.value = s.baseSpeed;
	const factory = new cdr.mods.ActionFactory();
	new cdr.mods.ActionFactoryReg().register(factory, game, undefined);
	const mgr = new cdr.mods.ReplayTurnManager(game, r, factory, undefined);
	mgr.init();
	log(`pool: built game for keyframe ${target} in ${(performance.now() - t0).toFixed(0)} ms`);
	return { game, mgr, target, mapFile };
}

/* idle-time worker: advances the game under construction, parks it at its keyframe, starts the next one */
async function poolWork(deadline) {
	pool.idle = 0;
	if (!pool.screen) return;
	try {
		if (!pool.building && pool.queue.length && !cdr.seeking) pool.building = await poolBuild(pool.queue.shift());
		const b = pool.building;
		if (b && !cdr.seeking) {
			while (b.game.currentTick < b.target && b.game.status !== cdr.mods.GameStatus.Ended && deadline.timeRemaining() > 1) b.mgr.doGameTurn(performance.now());
			if (b.game.currentTick >= b.target || b.game.status === cdr.mods.GameStatus.Ended) {
				pool.shadows.push(b);
				pool.building = null;
				log(`pool: keyframe ${b.target} ready (${pool.shadows.length} parked), heap ${heap()}`);
			}
		}
	} catch (e) { log("pool failed: " + (e.stack || e)); pool.queue = []; pool.building = null; }
	if (pool.screen && (pool.building || pool.queue.length)) pool.idle = requestIdleCallback(poolWork, { timeout: 500 });
}

/* cheapest source for `target`: the live game (ticks ahead), a parked game (swap + ticks ahead), else a restart */
function poolPick(target) {
	let best = null, bestCost = tick() <= target ? target - tick() : Infinity;
	for (const sh of pool.shadows) {
		const t = sh.game.currentTick, cost = SWAP_COST + target - t;
		if (t <= target && cost < bestCost) { best = sh; bestCost = cost; }
	}
	return best;
}

/* re-run the replay screen with a parked game in place of a freshly built one */
async function poolSwap(shadow) {
	const s = pool.screen, loader = s.gameLoader, g = shadow.game;
	pool.shadows.splice(pool.shadows.indexOf(shadow), 1);
	pool.queue.push(shadow.target); pool.queue.sort((a, b) => a - b);
	shadow.mgr.dispose();
	g.init = () => {}; // the screen's loader would re-create the starting units
	g.start = () => { g.status = cdr.mods.GameStatus.Started; }; // and reset the tick to 0
	loader.createGame = async () => {
		delete loader.createGame;
		return { game: g, theater: await cdr.mods.Engine.loadTheater(shadow.mapFile.theaterType) };
	};
	pool.swapping = true;
	try {
		const params = s.params;
		await s.onLeave();
		await s.onEnter(params);
	} finally { pool.swapping = false; delete loader.createGame; }
	log(`pool: swapped in keyframe ${shadow.target} at tick ${tick()}`);
	if (!pool.idle && pool.queue.length) pool.idle = requestIdleCallback(poolWork, { timeout: 500 });
}

const heap = () => performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + " MB" : "n/a";

Object.assign(cdr, { seek, fastForward, setSpeed, pause, isPaused, tick, endTick, game, pool, toggles, ui, openReplay, showBrowser });
try { patchDetectGpu(); } catch (e) { log("detect-gpu patch failed: " + (e.stack || e)); }
// a hook failure must not stop the game from booting
window.cdrHook = () => hook().catch(e => log("hook failed: " + (e.stack || e)));
})();
