// A replay link (#/replay/<encoded url>) is handed to the cdreplay app through its cdreplay:// url scheme.
// Append "&web" to the hash to open the web client anyway.
(() => {
	const m = location.hash.match(/^#\/replay\/([^&]+)/);
	if (!m || location.hash.includes("&web")) return;
	window.stop();
	location.replace("cdreplay://open/" + m[1]);
})();
