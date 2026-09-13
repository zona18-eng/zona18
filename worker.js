// =====================================================================
// DONASI RELAY - Cloudflare Workers + D1
// ---------------------------------------------------------------------
// Pengganti Google Apps Script. Kontrak JSON-nya sengaja dibuat sama:
//   GET  /            -> [{id, donator, amount, message, source, seq}, ...]
//   POST /?source=... -> {status:"success", source:"...", saved:N}
//
// Tambahan yang tidak ada di versi GAS:
//   GET /?cursor=1        -> {seq: N}  (posisi terakhir, dipakai saat start)
//   GET /?after=N         -> hanya donasi dengan seq > N (anti-berat)
//   GET /?limit=50        -> maksimal 200
//   Dedup otomatis lewat UNIQUE(id), jadi webhook yang di-retry
//   oleh platform tidak akan masuk dua kali.
//
// Lihat README.md untuk langkah deploy.
// =====================================================================

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		try {
			if (request.method === "POST") return await handlePost(request, env, url, ctx);
			if (request.method === "GET") return await handleGet(request, env, url);
			return json({ status: "failed", error: "method_not_allowed" }, 405);
		} catch (err) {
			ctx.waitUntil(logRaw(env, "error", String((err && err.stack) || err)));
			return json({ status: "failed", error: String(err) }, 500);
		}
	},
};

// ---------------------------------------------------------------------
// SISI PLATFORM DONASI (webhook masuk)
// ---------------------------------------------------------------------

async function handlePost(request, env, url, ctx) {
	// Aksi dari halaman admin (dilindungi ADMIN_KEY, bukan SECRET webhook).
	const action = url.searchParams.get("action");
	if (action) {
		if (!isAdmin(request, env, url)) {
			return json({ status: "failed", error: "unauthorized" }, 401);
		}
		if (action === "manual") return await handleManual(request, env);
		if (action === "delete") return await handleDelete(request, env, url);
		return json({ status: "failed", error: "unknown_action" }, 400);
	}

	const secret = (env.SECRET || "").trim();
	if (secret && readKey(request, url) !== secret) {
		return json({ status: "failed", error: "unauthorized" }, 401);
	}

	const raw = await request.text();
	const body = parseBody(raw, request.headers.get("content-type") || "");
	const source = detectSource(url, body);

	const items = extractDonations(body);
	const records = [];
	for (const item of items) {
		const rec = normalize(item, source);
		if (rec) records.push(rec);
	}

	const saved = await saveRecords(env, records);

	// Logging mentah itu 1 write tambahan per webhook. Nyalakan hanya saat
	// debugging (LOG_RAW = "1" di wrangler.toml), matikan lagi setelahnya.
	if (String(env.LOG_RAW || "") === "1") {
		ctx.waitUntil(logRaw(env, source, raw));
	}

	return json({ status: "success", source, saved });
}

// Dipakai oleh webhook maupun pencatatan manual dari halaman admin.
async function saveRecords(env, records) {
	if (records.length === 0) return 0;

	const now = new Date().toISOString();
	const insert = env.DB.prepare(
		"INSERT OR IGNORE INTO donations (id, donator, amount, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?)"
	);
	const results = await env.DB.batch(
		records.map((r) => insert.bind(r.id, r.donator, r.amount, r.message, r.source, now))
	);

	// Hanya donasi yang benar-benar masuk (bukan duplikat) yang menambah total.
	const upsert = env.DB.prepare(
		"INSERT INTO totals (donator_key, donator, amount, last_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(donator_key) DO UPDATE SET amount = amount + excluded.amount, donator = excluded.donator, last_at = excluded.last_at"
	);

	let saved = 0;
	const bumps = [];
	results.forEach((res, i) => {
		const changes = (res.meta && res.meta.changes) || 0;
		if (changes > 0) {
			saved += changes;
			const rec = records[i];
			bumps.push(upsert.bind(donatorKey(rec.donator), rec.donator, rec.amount, now));
		}
	});
	if (bumps.length > 0) await env.DB.batch(bumps);

	return saved;
}

async function handleManual(request, env) {
	let body;
	try {
		body = JSON.parse(await request.text());
	} catch {
		body = {};
	}

	const amount = toNumber(body.amount);
	if (amount <= 0) {
		return json({ status: "failed", error: "Nominal harus lebih dari 0." }, 400);
	}

	const rec = {
		id: "manual-" + crypto.randomUUID(),
		donator: String(body.donator || "Anonim").trim().slice(0, 100) || "Anonim",
		amount,
		message: String(body.message || "").slice(0, 500),
		source: String(body.source || "manual").toLowerCase().slice(0, 30),
	};

	const saved = await saveRecords(env, [rec]);
	return json({ status: "success", saved, donator: rec.donator, amount: rec.amount });
}

async function handleDelete(request, env, url) {
	const id = url.searchParams.get("id");
	if (!id) return json({ status: "failed", error: "id_required" }, 400);

	const row = await env.DB.prepare("SELECT donator, amount FROM donations WHERE id = ?").bind(id).first();
	if (!row) return json({ status: "failed", error: "not_found" }, 404);

	await env.DB.batch([
		env.DB.prepare("DELETE FROM donations WHERE id = ?").bind(id),
		env.DB.prepare("UPDATE totals SET amount = amount - ? WHERE donator_key = ?").bind(
			row.amount,
			donatorKey(row.donator)
		),
		env.DB.prepare("DELETE FROM totals WHERE amount <= 0"),
	]);

	return json({ status: "success", deleted: id });
}

// ---------------------------------------------------------------------
// SISI ROBLOX (polling keluar)
// ---------------------------------------------------------------------

async function handleGet(request, env, url) {
	// Halaman admin. Halamannya sendiri tidak berisi data — semua pengambilan
	// data di dalamnya tetap butuh kunci.
	if (url.searchParams.get("admin") !== null) {
		return new Response(ADMIN_PAGE, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	// Data untuk halaman admin: riwayat + total, dalam satu panggilan.
	if (url.searchParams.get("list") !== null) {
		if (!isAdmin(request, env, url)) {
			return json({ status: "failed", error: "unauthorized" }, 401);
		}
		const limit = Math.min(toInt(url.searchParams.get("limit"), 100), MAX_LIMIT);
		const donations = await env.DB.prepare(
			"SELECT seq, id, donator, amount, message, source, created_at FROM donations ORDER BY seq DESC LIMIT ?"
		)
			.bind(limit)
			.all();
		const totals = await env.DB.prepare(
			"SELECT donator, amount FROM totals ORDER BY amount DESC LIMIT 100"
		).all();

		return json({
			donations: donations.results || [],
			totals: totals.results || [],
		});
	}

	const key = (env.ROBLOX_KEY || "").trim();
	if (key && readKey(request, url) !== key) {
		return json({ status: "failed", error: "unauthorized" }, 401);
	}

	// Mode leaderboard: total per donatur, sudah dijumlahkan & diurutkan oleh
	// database. Hanya membaca sebanyak limit baris, bukan seluruh riwayat.
	const topParam = url.searchParams.get("top");
	if (topParam !== null) {
		const n = Math.min(toInt(topParam, 50) || 50, MAX_LIMIT);
		const { results } = await env.DB.prepare(
			"SELECT donator, amount FROM totals ORDER BY amount DESC LIMIT ?"
		)
			.bind(n)
			.all();
		return json(results || []);
	}

	// Mode cursor: dipanggil sekali saat server Roblox baru menyala, supaya
	// donasi lama tidak diputar ulang sebagai notifikasi.
	if (url.searchParams.get("cursor")) {
		const row = await env.DB.prepare("SELECT MAX(seq) AS seq FROM donations").first();
		return json({ seq: (row && row.seq) || 0 });
	}

	const afterParam = url.searchParams.get("after");
	const limit = Math.min(toInt(url.searchParams.get("limit"), DEFAULT_LIMIT), MAX_LIMIT);

	// Mode kompatibel GAS: tanpa ?after=, kirim N donasi TERBARU (urut lama->baru).
	// Dipakai oleh poller yang menyaring donasi baru sendiri berdasarkan id.
	if (afterParam === null) {
		const { results } = await env.DB.prepare(
			"SELECT * FROM (SELECT seq, id, donator, amount, message, source FROM donations ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
		)
			.bind(limit)
			.all();
		return json(results || []);
	}

	const after = toInt(afterParam, 0);

	const { results } = await env.DB.prepare(
		"SELECT d.seq, d.id, d.donator, d.amount, d.message, d.source, d.created_at, IFNULL(t.amount, 0) AS total " +
			"FROM donations d LEFT JOIN totals t ON t.donator_key = LOWER(TRIM(d.donator)) " +
			"WHERE d.seq > ? ORDER BY d.seq ASC LIMIT ?"
	)
		.bind(after, limit)
		.all();

	return json(results || []);
}

// ---------------------------------------------------------------------
// PARSING & NORMALISASI (port dari versi GAS)
// ---------------------------------------------------------------------

function parseBody(raw, contentType) {
	if (!raw) return {};
	if (contentType.includes("application/x-www-form-urlencoded")) {
		const out = {};
		for (const [k, v] of new URLSearchParams(raw)) {
			// Sebagian platform mengirim field JSON di dalam form field.
			try {
				out[k] = JSON.parse(v);
			} catch {
				out[k] = v;
			}
		}
		return out;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function detectSource(url, body) {
	const query = (url.searchParams.get("source") || "").toLowerCase();
	const path = url.pathname.toLowerCase();
	const hint = query || path;

	if (hint.includes("saweria")) return "saweria";
	if (hint.includes("bagibagi")) return "bagibagi";
	if (hint.includes("sociabuzz") || hint.includes("socialbuzz")) return "sociabuzz";
	if (hint.includes("tako")) return "tako";

	return autoDetect(body);
}

function autoDetect(body) {
	const f = flatten(body);
	if (has(f, "donator_name") || has(f, "amount_raw")) return "saweria";

	const tid = String(pick(f, ["transaction_id"]) || "").toLowerCase();
	if (tid.includes("bagibagi")) return "bagibagi";
	if (tid.includes("tako")) return "tako";
	if (tid.includes("sociabuzz")) return "sociabuzz";

	if (has(f, "supporter_name") || has(f, "supporter") || has(f, "supporter_message")) {
		return "sociabuzz";
	}
	return "unknown";
}

function extractDonations(body) {
	if (Array.isArray(body)) return body;
	if (body && Array.isArray(body.data)) return body.data;
	return [body];
}

function normalize(d, source) {
	const f = flatten(d);

	const donator =
		pick(f, [
			"donator_name", "name", "supporter_name", "supporter", "from_name",
			"donor_name", "donatur", "donor", "nama", "username", "display_name",
		]) || "Anonim";

	const amount = toNumber(
		pick(f, [
			"amount_raw", "amount", "gross_amount", "nominal", "price",
			"quantity", "total", "jumlah", "value",
		])
	);

	const message =
		pick(f, [
			"message", "pesan", "supporter_message", "note", "comment",
			"description", "msg", "support_message",
		]) || "";

	let id = pick(f, [
		"id", "transaction_id", "trx_id", "order_id", "reference", "ref",
		"invoice", "invoice_id", "payment_id",
	]);
	if (!id) id = source + "-" + crypto.randomUUID();

	return {
		id: String(id).slice(0, 200),
		donator: String(donator).slice(0, 100),
		amount,
		message: String(message).slice(0, 500),
		source,
	};
}

function flatten(b) {
	if (!b || typeof b !== "object") return {};
	const out = {};
	const wrappers = ["data", "donation", "payload", "result", "tribe", "detail", "transaction", "donate"];

	for (const w of wrappers) {
		const inner = b[w];
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			for (const k of Object.keys(inner)) out[k] = inner[k];
		}
	}
	for (const key of Object.keys(b)) {
		if (typeof b[key] !== "object" || b[key] === null) out[key] = b[key];
	}
	return out;
}

function pick(obj, keys) {
	const map = {};
	for (const k of Object.keys(obj)) map[k.toLowerCase()] = obj[k];
	for (const key of keys) {
		const v = map[key.toLowerCase()];
		if (v !== undefined && v !== null && String(v).length > 0) return v;
	}
	return null;
}

function has(obj, key) {
	return pick(obj, [key]) !== null;
}

// Lebih pintar dari versi GAS: "Rp10.000" -> 10000, bukan 10000 juga tapi
// "10.500,50" -> 10501 dan bukan 1050050.
function toNumber(v) {
	if (v === null || v === undefined) return 0;
	if (typeof v === "number") return Math.round(v);

	let s = String(v).replace(/[^\d.,-]/g, "");
	if (!s) return 0;

	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");

	if (lastDot >= 0 && lastComma >= 0) {
		// Pemisah desimal = simbol yang muncul paling belakang.
		if (lastDot > lastComma) s = s.split(",").join("");
		else s = s.split(".").join("").replace(",", ".");
	} else if (lastComma >= 0) {
		s = /,\d{3}$/.test(s) ? s.split(",").join("") : s.replace(",", ".");
	} else if (lastDot >= 0) {
		if (/\.\d{3}$/.test(s)) s = s.split(".").join("");
	}

	const n = parseFloat(s);
	return isNaN(n) ? 0 : Math.round(n);
}

// ---------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------

function readKey(request, url) {
	// Header lebih aman daripada query string (tidak nyangkut di log/riwayat).
	return request.headers.get("x-auth-key") || url.searchParams.get("key") || "";
}

// Halaman admin pakai ADMIN_KEY. Kalau belum diisi, jatuh ke SECRET supaya
// tetap terkunci — jangan sampai terbuka untuk siapa saja.
function isAdmin(request, env, url) {
	const want = String(env.ADMIN_KEY || env.SECRET || "").trim();
	if (!want) return false;
	return readKey(request, url) === want;
}

function donatorKey(name) {
	return String(name || "").trim().toLowerCase();
}

function toInt(v, fallback) {
	const n = parseInt(v, 10);
	return isNaN(n) || n < 0 ? fallback : n;
}

async function logRaw(env, source, raw) {
	try {
		await env.DB.prepare("INSERT INTO logs (created_at, source, raw) VALUES (?, ?, ?)")
			.bind(new Date().toISOString(), String(source), String(raw).slice(0, 5000))
			.run();
	} catch {
		// logging gagal tidak boleh menjatuhkan webhook
	}
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

// ---------------------------------------------------------------------
// HALAMAN ADMIN
// Dibuka di /?admin — pengganti tampilan Google Sheet.
// ---------------------------------------------------------------------

const ADMIN_PAGE = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BebeqDonare Relay</title>
<style>
  :root {
    --ink: #101320; --panel: #191d2e; --line: #2a3048; --raise: #212741;
    --text: #e8eaf4; --muted: #8890ad; --amber: #f0b64a; --accent: #7b8cff;
    --danger: #e4696a; --ok: #5fc99a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ink); color: var(--text); padding: 28px 20px 64px;
    font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.09em;
       color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  .top span { color: var(--muted); font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: 12px; padding: 18px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
  @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  input, select {
    width: 100%; background: var(--ink); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
    font: inherit; outline: none;
  }
  input:focus, select:focus { border-color: var(--accent); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1 1 150px; }
  button {
    background: var(--accent); color: #0d1020; border: 0; border-radius: 8px;
    padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); font-weight: 500; }
  button.del { background: transparent; color: var(--danger); border: 1px solid var(--line);
               padding: 4px 9px; font-size: 12px; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
       color: var(--muted); font-weight: 600; padding: 0 10px 8px 0; }
  td { padding: 9px 10px 9px 0; border-top: 1px solid var(--line); vertical-align: top; }
  .num { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
         color: var(--amber); white-space: nowrap; }
  .seq { font-family: ui-monospace, Menlo, monospace; color: var(--muted); font-size: 12px; }
  .msg { color: var(--muted); font-size: 13px; }
  .src { display: inline-block; background: var(--raise); color: var(--muted);
         border-radius: 5px; padding: 1px 7px; font-size: 11px; }
  .rank { color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
  .empty { color: var(--muted); font-size: 14px; padding: 18px 0; }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  #status { font-size: 13px; min-height: 20px; margin-top: 10px; }
  .ok { color: var(--ok); } .bad { color: var(--danger); }
  .hide { display: none; }
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <h1>BebeqDonare Relay</h1>
    <span id="meta"></span>
  </div>

  <div class="card" id="gate">
    <h2>Masuk</h2>
    <div class="row">
      <div><label for="key">Kunci admin</label>
        <input id="key" type="password" placeholder="ADMIN_KEY" autocomplete="off"></div>
      <button id="open">Buka</button>
    </div>
    <div class="note">Kunci disimpan di tab ini saja dan hilang saat tab ditutup.</div>
    <div id="gateErr" class="bad" style="font-size:13px;margin-top:10px"></div>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <h2>Catat donasi manual</h2>
      <div class="row">
        <div><label for="donator">Nama donatur</label><input id="donator" placeholder="Anonim"></div>
        <div><label for="amount">Nominal</label><input id="amount" placeholder="10000" inputmode="numeric"></div>
        <div style="flex:2 1 240px"><label for="message">Pesan</label><input id="message" placeholder="opsional"></div>
        <div><label for="source">Sumber</label>
          <select id="source">
            <option value="manual">Manual</option>
            <option value="saweria">Saweria</option>
            <option value="bagibagi">BagiBagi</option>
            <option value="sociabuzz">SociaBuzz</option>
            <option value="tako">Tako</option>
          </select></div>
        <button id="add">Catat donasi</button>
      </div>
      <div id="status"></div>
      <div class="note">Donasi manual masuk seperti donasi asli: menambah total dan memicu efek di Roblox.</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Riwayat terbaru</h2>
        <div id="hist"></div>
      </div>
      <div class="card">
        <h2>Total per donatur</h2>
        <div id="tops"></div>
      </div>
    </div>

    <button class="ghost" id="reload">Muat ulang</button>
  </div>

</div>
<script>
(function () {
  var KEY = "";
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function rupiah(n) {
    return "Rp" + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  function waktu(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function api(path, opts) {
    opts = opts || {};
    opts.headers = { "x-auth-key": KEY, "content-type": "application/json" };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (b) {
        if (!r.ok) throw new Error(b && b.error ? b.error : "HTTP " + r.status);
        return b;
      });
    });
  }
  function say(msg, bad) {
    $("status").textContent = msg;
    $("status").className = bad ? "bad" : "ok";
  }

  function render(data) {
    var d = data.donations || [], t = data.totals || [];

    if (!d.length) {
      $("hist").innerHTML = '<div class="empty">Belum ada donasi. Catat satu di atas untuk menguji efek di Roblox.</div>';
    } else {
      var h = "<table><tr><th>#</th><th>Donatur</th><th>Nominal</th><th>Waktu</th><th></th></tr>";
      d.forEach(function (r) {
        h += "<tr><td class='seq'>" + r.seq + "</td><td>" + esc(r.donator) +
             (r.message ? "<div class='msg'>" + esc(r.message) + "</div>" : "") +
             " <span class='src'>" + esc(r.source) + "</span></td>" +
             "<td class='num'>" + rupiah(r.amount) + "</td>" +
             "<td class='msg'>" + waktu(r.created_at) + "</td>" +
             "<td><button class='del' data-id='" + esc(r.id) + "'>Hapus</button></td></tr>";
      });
      $("hist").innerHTML = h + "</table>";
    }

    if (!t.length) {
      $("tops").innerHTML = '<div class="empty">Papan masih kosong.</div>';
    } else {
      var p = "<table><tr><th>#</th><th>Donatur</th><th>Total</th></tr>";
      t.forEach(function (r, i) {
        p += "<tr><td class='rank'>" + (i + 1) + "</td><td>" + esc(r.donator) +
             "</td><td class='num'>" + rupiah(r.amount) + "</td></tr>";
      });
      $("tops").innerHTML = p + "</table>";
    }

    $("meta").textContent = d.length + " donasi terbaru \u00b7 " + t.length + " donatur";

    Array.prototype.forEach.call(document.querySelectorAll("button.del"), function (b) {
      b.onclick = function () {
        if (!confirm("Hapus donasi ini? Totalnya ikut dikurangi.")) return;
        api("?action=delete&id=" + encodeURIComponent(b.dataset.id), { method: "POST" })
          .then(load)
          .catch(function (e) { say("Gagal menghapus: " + e.message, true); });
      };
    });
  }

  function load() {
    return api("?list=1&limit=100").then(render);
  }

  $("open").onclick = function () {
    KEY = $("key").value.trim();
    if (!KEY) { $("gateErr").textContent = "Isi kunci admin dulu."; return; }
    load().then(function () {
      sessionStorage.setItem("dr_key", KEY);
      $("gate").className = "card hide";
      $("app").className = "";
    }).catch(function (e) {
      $("gateErr").textContent = e.message === "unauthorized"
        ? "Kunci tidak cocok dengan ADMIN_KEY di Cloudflare."
        : "Tidak bisa memuat data: " + e.message;
    });
  };
  $("key").onkeydown = function (e) { if (e.key === "Enter") $("open").click(); };

  $("add").onclick = function () {
    var body = {
      donator: $("donator").value,
      amount: $("amount").value,
      message: $("message").value,
      source: $("source").value
    };
    api("?action=manual", { method: "POST", body: JSON.stringify(body) })
      .then(function (res) {
        say("Tercatat: " + res.donator + " " + rupiah(res.amount));
        $("donator").value = ""; $("amount").value = ""; $("message").value = "";
        return load();
      })
      .catch(function (e) { say(e.message, true); });
  };

  $("reload").onclick = load;

  var saved = sessionStorage.getItem("dr_key");
  if (saved) { $("key").value = saved; $("open").click(); }
})();
</script>
</body>
</html>`;