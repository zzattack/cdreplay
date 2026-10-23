// cdreplay: serves a locally cached copy of the Chrono Divide client with cdreplay.js injected, plus replay files.
// node serve.js [file.rpl | ladder url | game id]
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = 8787;
const UPSTREAM = "https://game.chronodivide.com";
const GAMERES = "https://gameres.chronodivide.com";
const REPLAY_HOSTS =["https://replays-eu.chronodivide.com", "https://replays-sea.chronodivide.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CACHE = process.env.CDREPLAY_CACHE || path.join(__dirname, "cache"); // the packaged app sets this before requiring
const CLIENT_CACHE = path.join(CACHE, "client");
const REPLAY_CACHE = path.join(CACHE, "replays");
// never served stale: the upstream updates these without changing their url
const ALWAYS_REFRESH = new Set(["index.html", "config.ini", "versions.json"]);
const MIME = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", ini: "text/plain",
	png: "image/png", jpg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
	woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", wasm: "application/wasm", mp3: "audio/mpeg", ogg: "audio/ogg",
	mp4: "video/mp4", webm: "video/webm", rpl: "text/plain", txt: "text/plain", mix: "application/octet-stream" };

const mime = p => MIME[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";

async function fetchUpstream(url) {
	const r = await fetch(url, { headers: { "User-Agent": UA } });
	if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status });
	return Buffer.from(await r.arrayBuffer());
}

/* client file by url path (no query); fetched from the official site once and kept on disk */
async function clientFile(urlPath, query) {
	const rel = urlPath.replace(/^\/+/, "") || "index.html";
	// versioned assets (dist/ra2web.min.js?v=0.84.0) are cached per version so a client update is picked up
	const file = path.join(CLIENT_CACHE, (rel.endsWith("/") ? rel + "index.html" : rel) + (query ? "@" + query.replace(/[^\w.=-]/g, "_") : ""));
	if (!path.resolve(file).startsWith(CLIENT_CACHE)) throw Object.assign(new Error("bad path"), { status: 400 });
	const refresh = ALWAYS_REFRESH.has(path.basename(file));
	if (!refresh && fs.existsSync(file)) return fs.readFileSync(file);
	try {
		const body = await fetchUpstream(UPSTREAM + "/" + rel + (query ? "?" + query : ""));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, body);
		return body;
	} catch (e) {
		if (fs.existsSync(file)) return fs.readFileSync(file);
		throw e;
	}
}

function patchIndex(html) {
	return html
		.replace(/<script>\(function\(\)\{function c\(\)\{var b=a\.contentDocument.*?<\/script>/s, "") // cloudflare probe
		.replace(/<script async src="https:\/\/www\.googletagmanager\.com[^>]*><\/script>/, "")
		.replace(/(<script[^>]*src="lib\/system\.js"><\/script>)/, '$1\n  <script type="text/javascript" src="/cdreplay.js"></script>')
		// hook after the bundles registered their modules and the inline "three" shim exists, before the app boots
		.replace('SystemJS.import("main");', 'Promise.resolve(window.cdrHook && window.cdrHook()).then(() => SystemJS.import("main"));')
		.replace("<head>", fs.existsSync(path.join(CACHE, "spike.flag")) ? "<head><script>window.CDR_SPIKE = true;</script>" : "<head>");
}

// maps and mods go through this server: the resource CDN sends no CORS headers for other origins
function patchConfig(ini) {
	return ini.replace(/^replaysUrlWhitelist=.*$/m, 'replaysUrlWhitelist=".chronodivide.com",localhost')
		.replace(/^mapsBaseUrl=.*$/m, "mapsBaseUrl=/cdn/map/")
		.replace(/^modsBaseUrl=.*$/m, "modsBaseUrl=/cdn/mod/");
}

async function cdnFile(rel) {
	const file = path.join(CACHE, "cdn", rel);
	if (!path.resolve(file).startsWith(path.join(CACHE, "cdn"))) throw Object.assign(new Error("bad path"), { status: 400 });
	if (fs.existsSync(file)) return fs.readFileSync(file);
	const body = await fetchUpstream(GAMERES + "/" + rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	return body;
}

const OFFICIAL_MAPS = new Set(fs.readFileSync(path.join(__dirname, "official-maps.txt"), "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean));
const MAPCHECK_FILE = path.join(CACHE, "mapcheck.json");
let mapChecks;
async function mapAvailable(name) {
	if (OFFICIAL_MAPS.has(name.toLowerCase())) return true;
	mapChecks ??= fs.existsSync(MAPCHECK_FILE) ? JSON.parse(fs.readFileSync(MAPCHECK_FILE, "utf8")) : {};
	if (name in mapChecks) return mapChecks[name];
	if (fs.existsSync(path.join(CACHE, "cdn", "map", name))) return (mapChecks[name] = true);
	const r = await fetch(`${GAMERES}/map/${encodeURIComponent(name)}`, { method: "HEAD", headers: { "User-Agent": UA } });
	mapChecks[name] = r.ok;
	fs.writeFileSync(MAPCHECK_FILE, JSON.stringify(mapChecks));
	return r.ok;
}

async function replayFile(id) {
	const file = path.join(REPLAY_CACHE, id + ".rpl");
	if (fs.existsSync(file)) return fs.readFileSync(file);
	let err;
	for (const host of REPLAY_HOSTS) {
		try {
			const body = await fetchUpstream(`${host}/${id}.rpl`);
			fs.mkdirSync(REPLAY_CACHE, { recursive: true });
			fs.writeFileSync(file, body);
			return body;
		} catch (e) { err = e; }
	}
	throw err;
}

/* the ladder service allows about one request per 10 s per ip (429 with Retry-After beyond that): responses are
   cached for a minute, identical requests share one fetch, requests go out one at a time with a gap, and a 429 is
   retried a few times after the wait the server asks for */
const LADDER_GAP = 2000, LADDER_TTL = 60000;
const ladderCache = new Map(); // method + url + body -> { at, body } or { pending }
let ladderQueue = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ladderFetch(url, method, reqBody) {
	const key = method + url + (reqBody || "");
	const c = ladderCache.get(key);
	if (c?.pending) return c.pending;
	if (c && Date.now() - c.at < LADDER_TTL) return c.body;
	const pending = ladderQueue.then(async () => {
		for (let tries = 0; ; tries++) {
			const r = await fetch(url, { method, body: reqBody,
				headers: { "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json" } });
			// a rejected attempt counts against the window too, so wait a little longer than asked
			if (r.status === 429 && tries < 3) { await sleep(1000 * (+r.headers.get("retry-after") || 10) + LADDER_GAP); continue; }
			const body = Buffer.from(await r.arrayBuffer());
			if (!r.ok) throw Object.assign(new Error(`ladder ${r.status}`), { status: r.status });
			return body;
		}
	});
	ladderQueue = pending.then(() => sleep(LADDER_GAP), () => sleep(LADDER_GAP));
	ladderCache.set(key, { pending });
	pending.then(body => ladderCache.set(key, { at: Date.now(), body }), () => ladderCache.delete(key));
	return pending;
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	try {
		let body, type;
		if (req.method === "POST" && url.pathname === "/dbgdump") { // the client's crash-report tunnel; not forwarded
			for await (const c of req) {}
			res.writeHead(204); return res.end();
		}
		if (req.method === "POST" && url.pathname === "/log") {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			fs.appendFileSync(path.join(CACHE, "client.log"), `${new Date().toISOString()} ${Buffer.concat(chunks)}
`);
			res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
			return res.end();
		}
		if (url.pathname === "/api/mapcheck") {
			// can the client get this map? official maps come from the game files, others from the resource CDN
			body = Buffer.from(JSON.stringify({ ok: await mapAvailable(url.searchParams.get("name") || "") }));
			type = "application/json";
		} else if (url.pathname === "/browse") {
			body = fs.readFileSync(path.join(__dirname, "browser.html"));
			type = "text/html";
		} else if (url.pathname.startsWith("/api/ladder/")) {
			// same-origin proxy for the ladder service (wol-<region>.chronodivide.com has no CORS headers)
			const [, , , region, ...rest] = url.pathname.split("/");
			if (!/^[a-z]+$/.test(region)) throw Object.assign(new Error("bad region"), { status: 400 });
			const chunks = [];
			for await (const c of req) chunks.push(c);
			body = await ladderFetch(`https://wol-${region}.chronodivide.com/${rest.join("/")}${url.search}`, req.method,
				req.method === "POST" ? Buffer.concat(chunks) : undefined);
			type = "application/json";
		} else if (req.method === "POST" && url.pathname === "/upload") {
			// a replay dropped on the browser page; served back as /replay/<id>.rpl
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const id = decodeURIComponent(req.headers["x-filename"] || "upload").replace(/\.rpl$/i, "").replace(/[^\w.-]/g, "_");
			fs.mkdirSync(REPLAY_CACHE, { recursive: true });
			fs.writeFileSync(path.join(REPLAY_CACHE, id + ".rpl"), Buffer.concat(chunks));
			body = Buffer.from(JSON.stringify({ id }));
			type = "application/json";
		} else if (req.method === "POST" && url.pathname === "/flags") {
			// country flags exported by the client page from the game files (png data urls keyed by country id)
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const dir = path.join(CACHE, "flags");
			fs.mkdirSync(dir, { recursive: true });
			for (const [id, dataUrl] of Object.entries(JSON.parse(Buffer.concat(chunks))))
				if (/^\d+$/.test(id)) fs.writeFileSync(path.join(dir, id + ".png"), Buffer.from(dataUrl.split(",")[1], "base64"));
			fs.writeFileSync(path.join(dir, "ok"), "");
			body = Buffer.alloc(0); type = "text/plain";
		} else if (url.pathname.startsWith("/flags/")) {
			const file = path.join(CACHE, "flags", path.basename(url.pathname));
			if (!fs.existsSync(file)) throw Object.assign(new Error("no flag"), { status: 404 });
			body = fs.readFileSync(file); type = mime(file);
		} else if (url.pathname === "/cdreplay.js") {
			body = fs.readFileSync(path.join(__dirname, "cdreplay.js"));
			type = "text/javascript";
		} else if (url.pathname.startsWith("/cdn/")) {
			body = await cdnFile(decodeURIComponent(url.pathname.slice(5)));
			type = mime(url.pathname);
		} else if (url.pathname.startsWith("/replay/")) {
			const id = decodeURIComponent(url.pathname.slice(8)).replace(/\.rpl$/, "");
			if (!/^[\w.-]+$/.test(id)) throw Object.assign(new Error("bad id"), { status: 400 });
			body = await replayFile(id);
			type = "text/plain";
		} else {
			body = await clientFile(url.pathname, url.search.slice(1));
			const base = path.basename(url.pathname) || "index.html";
			type = mime(url.pathname === "/" ? "index.html" : url.pathname);
			if (base === "index.html" || url.pathname.endsWith("/")) body = Buffer.from(patchIndex(body.toString("utf8")));
			else if (base === "ra2web.min.js") body = Buffer.from(body.toString("utf8").replace("sleep(this.config.devMode?0:5e3)", "sleep(0)")); // 5 s minimum splash
			else if (base === "config.ini") body = Buffer.from(patchConfig(body.toString("utf8")));
		}
		res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-cache",
			"Access-Control-Allow-Origin": "*" });
		res.end(body);
	} catch (e) {
		const status = e.status || 500;
		if (status !== 404 || /^\/(cdn|replay)\//.test(url.pathname)) console.error(req.url, e.message);
		res.writeHead(status, { "Content-Type": "text/plain" });
		res.end(e.message);
	}
});

function replayIdFromArg(arg) {
	if (!arg) return null;
	if (/\.rpl$/i.test(arg) && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
		const id = path.basename(arg, ".rpl").replace(/[^\w.-]/g, "_");
		fs.mkdirSync(REPLAY_CACHE, { recursive: true });
		fs.copyFileSync(arg, path.join(REPLAY_CACHE, id + ".rpl"));
		return id;
	}
	const m = decodeURIComponent(arg).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return m ? m[1] : null; // anything else (".", stray flags) is not a replay
}

/* page url for a replay argument (file, ladder url or game id); the bare client when there is none */
function pageUrl(base, arg) {
	const id = replayIdFromArg(arg);
	return id ? base + "#/replay/" + encodeURIComponent(`${base}replay/${id}.rpl`) : base + "browse";
}

function start(port = PORT) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(`http://localhost:${server.address().port}/`));
	});
}

module.exports = { start, pageUrl };

if (require.main === module) {
	start().then(base => {
		const url = pageUrl(base, process.argv[2]);
		console.log(url);
		if (process.platform === "win32" && !process.env.CDREPLAY_NO_OPEN) execFile("cmd", ["/c", "start", "", url]);
	});
}
