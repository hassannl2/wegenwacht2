"use strict";
// Wegenwacht klok-website met Discord-login. Geen npm-pakketten nodig (alleen Node 22.13+).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./db");

const env = process.env;
const required = (k) => {
  if (!env[k]) { console.error("Ontbrekende instelling in .env: " + k); process.exit(1); }
  return env[k];
};
const CLIENT_ID = required("1558950530154500106");
const CLIENT_SECRET = required("1558950530154500106");
const GUILD_ID = required("DISCORD_GUILD_ID");
const SECRET = required("SESSION_SECRET");
const BASE_URL = required("BASE_URL").replace(/\/+$/, "");
const MEMBER_ROLE = (env.MEMBER_ROLE_ID || "").trim();
const MANAGER_ROLES = (env.MANAGER_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (SECRET.length < 32) { console.error("SESSION_SECRET moet minimaal 32 tekens zijn."); process.exit(1); }
if (!MANAGER_ROLES.length) { console.error("Vul minstens één rol in bij MANAGER_ROLE_IDS."); process.exit(1); }

const API = (env.DISCORD_API || "https://discord.com/api").replace(/\/+$/, "");
const PORT = Number(env.PORT) || 3000;
const SECURE = BASE_URL.startsWith("https://");
const ORIGIN = new URL(BASE_URL).origin;
const REDIRECT = BASE_URL + "/auth/callback";
const SESSION_MS = 12 * 3600 * 1000; // na 12 uur opnieuw inloggen (rollen worden dan opnieuw gecontroleerd)
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

/* ---------- ondertekende cookies ---------- */
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return p + "." + hmac(p);
}
function verify(tok) {
  if (!tok || typeof tok !== "string") return null;
  const [p, s] = tok.split(".");
  if (!p || !s) return null;
  const e = hmac(p);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, "base64url").toString());
    return o && o.exp > Date.now() ? o : null;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const c = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", [].concat(res.getHeader("Set-Cookie") || [], c));
}
const getSession = (req) => verify(cookies(req).ww);

/* ---------- hulpfuncties ---------- */
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function redirect(res, to) { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 100_000) { reject("te groot"); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject("ongeldige JSON"); } });
    req.on("error", () => reject("fout"));
  });
}

function publicConfig(cfg) {
  return {
    siteName: cfg.siteName, icon: cfg.icon, accent: cfg.accent, accent2: cfg.accent2, theme: cfg.theme,
    welcome: cfg.welcome, discord: cfg.discord, specs: cfg.specs,
    ranks: cfg.ranks.map((r) => ({ n: r.n })), // de vereiste uren gaan NIET naar spelers
  };
}

// Controleert en schoont een wijziging van de instellingen. Gooit een tekst bij een fout.
function cleanConfig(b, cur) {
  const o = {};
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : null);
  if ("siteName" in b) { const v = str(b.siteName, 40); if (!v) throw "Naam ontbreekt"; o.siteName = v; }
  if ("icon" in b) o.icon = str(b.icon, 8) || "🚗";
  for (const k of ["accent", "accent2"])
    if (k in b) { if (typeof b[k] !== "string" || !/^#[0-9a-f]{6}$/i.test(b[k])) throw "Ongeldige kleur"; o[k] = b[k].toLowerCase(); }
  if ("theme" in b) { if (!["auto", "light", "dark"].includes(b.theme)) throw "Ongeldig thema"; o.theme = b.theme; }
  if ("welcome" in b) { const v = str(b.welcome, 500); if (v === null) throw "Ongeldige tekst"; o.welcome = v; }
  if ("discord" in b) {
    const v = str(b.discord, 200);
    if (v === null || (v && !/^https:\/\/\S+$/.test(v))) throw "Discord-link moet met https:// beginnen";
    o.discord = v;
  }
  if ("specs" in b) {
    if (!Array.isArray(b.specs) || b.specs.length > 40) throw "Ongeldige specialisaties";
    o.specs = [...new Set(b.specs.map((x) => str(x, 40)).filter(Boolean))];
  }
  if ("ranks" in b) {
    if (!Array.isArray(b.ranks) || b.ranks.length > 30) throw "Ongeldige rangen";
    const r = b.ranks
      .map((x) => ({ n: str(x && x.n, 40), h: Number(x && x.h) }))
      .filter((x) => x.n && Number.isFinite(x.h) && x.h >= 0)
      .sort((a, c) => a.h - c.h);
    if (!r.length) throw "Minstens één rang nodig";
    o.ranks = r;
  }
  if ("auto" in b) { o.auto = !!b.auto; if (o.auto && !cur.auto) o.lastRun = store.mondayKey(); }
  return o;
}

/* ---------- Discord-login ---------- */
async function discordGet(url, token) {
  return fetch(API + url, { headers: { Authorization: "Bearer " + token } });
}
async function callback(req, res, url) {
  if (url.searchParams.get("error")) return redirect(res, "/?e=denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = verify(cookies(req).wws);
  setCookie(res, "wws", "", 0);
  if (!code || !state || !saved || saved.state !== state) return redirect(res, "/?e=state");

  const tr = await fetch(API + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT,
    }),
  });
  if (!tr.ok) { console.error("Discord token fout", tr.status); return redirect(res, "/?e=error"); }
  const { access_token } = await tr.json();

  const ur = await discordGet("/users/@me", access_token);
  if (!ur.ok) return redirect(res, "/?e=error");
  const user = await ur.json();

  const gr = await discordGet(`/users/@me/guilds/${encodeURIComponent(GUILD_ID)}/member`, access_token);
  if (gr.status === 404 || gr.status === 403) return redirect(res, "/?e=noaccess");
  if (!gr.ok) return redirect(res, "/?e=error");
  const member = await gr.json();

  const roles = Array.isArray(member.roles) ? member.roles : [];
  const mgr = MANAGER_ROLES.some((r) => roles.includes(r));
  if (!mgr && MEMBER_ROLE && !roles.includes(MEMBER_ROLE)) return redirect(res, "/?e=noaccess");

  const name = String(member.nick || user.global_name || user.username || "Onbekend").slice(0, 40);
  store.upsertMember(String(user.id), name);
  setCookie(res, "ww", sign({ uid: String(user.id), name, mgr, exp: Date.now() + SESSION_MS }), SESSION_MS / 1000);
  redirect(res, "/");
}

/* ---------- API ---------- */
async function api(req, res, url, s) {
  const p = url.pathname;
  const m = req.method;

  if (m === "GET" && p === "/api/state") {
    store.upsertMember(s.uid, s.name); // account weer aanmaken als het verwijderd was
    const cfg = store.getCfg();
    const members = {};
    for (const x of store.allMembers()) members[x.id] = { name: x.name, rank: x.rank, total: x.total, since: x.since, specs: x.specs };
    return json(res, 200, {
      me: s.uid, mgr: s.mgr, now: Date.now(), config: publicConfig(cfg), members,
      priv: s.mgr ? { hours: cfg.ranks.map((r) => r.h), auto: cfg.auto, lastRun: cfg.lastRun, lastCount: cfg.lastCount } : null,
    });
  }
  if (m !== "POST") return json(res, 404, { error: "niet gevonden" });

  // Alleen veranderen mag via POST met JSON van onze eigen site (tegen CSRF).
  if (!String(req.headers["content-type"] || "").includes("application/json")) return json(res, 415, { error: "JSON verwacht" });
  if (req.headers.origin && req.headers.origin !== ORIGIN) return json(res, 403, { error: "verkeerde herkomst" });
  const body = await readJson(req).catch((e) => { json(res, 400, { error: String(e) }); return null; });
  if (body === null) return;

  if (p === "/api/clock/in") { store.clockIn(s.uid); return json(res, 200, { ok: true }); }
  if (p === "/api/clock/out") { store.clockOut(s.uid); return json(res, 200, { ok: true }); }

  if (!p.startsWith("/api/mgr/")) return json(res, 404, { error: "niet gevonden" });
  if (!s.mgr) return json(res, 403, { error: "Alleen voor management" });

  let r;
  if ((r = p.match(/^\/api\/mgr\/clockout\/(\d+)$/))) { store.clockOut(r[1]); return json(res, 200, { ok: true }); }
  if ((r = p.match(/^\/api\/mgr\/member\/(\d+)\/delete$/))) { store.deleteMember(r[1]); return json(res, 200, { ok: true }); }
  if ((r = p.match(/^\/api\/mgr\/member\/(\d+)$/))) {
    const cfg = store.getCfg();
    const u = {};
    if ("name" in body) {
      const n = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
      if (n) u.name = n;
    }
    if ("rank" in body) {
      const k = Number(body.rank);
      if (!Number.isInteger(k) || k < 0 || k >= cfg.ranks.length) return json(res, 400, { error: "Ongeldige rang" });
      u.rank = k;
    }
    if ("specs" in body) {
      if (!Array.isArray(body.specs)) return json(res, 400, { error: "Ongeldige specialisaties" });
      u.specs = [...new Set(body.specs.filter((x) => typeof x === "string" && cfg.specs.includes(x)))];
    }
    if ("hours" in body) {
      const h = Number(body.hours);
      if (!Number.isFinite(h) || h < 0 || h > 100000) return json(res, 400, { error: "Ongeldige uren" });
      u.hours = h;
    }
    return store.updateMember(r[1], u) ? json(res, 200, { ok: true }) : json(res, 404, { error: "Lid niet gevonden" });
  }
  if (p === "/api/mgr/promote-all") return json(res, 200, { promoted: store.promoteEligible() });
  if (p === "/api/mgr/run-auto") return json(res, 200, { promoted: store.runAuto() });
  if (p === "/api/mgr/config") {
    let patch;
    try { patch = cleanConfig(body, store.getCfg()); } catch (e) { return json(res, 400, { error: String(e) }); }
    store.setCfg(patch);
    if (patch.ranks) store.clampRanks(patch.ranks.length);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "niet gevonden" });
}

/* ---------- server ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(INDEX);
  }
  if (req.method === "GET" && p === "/auth/login") {
    const state = crypto.randomBytes(16).toString("hex");
    setCookie(res, "wws", sign({ state, exp: Date.now() + 10 * 60 * 1000 }), 600);
    const q = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: "identify guilds.members.read", state,
    });
    return redirect(res, "https://discord.com/oauth2/authorize?" + q);
  }
  if (req.method === "GET" && p === "/auth/callback") return callback(req, res, url);
  if (req.method === "POST" && p === "/auth/logout") {
    if (req.headers.origin && req.headers.origin !== ORIGIN) return json(res, 403, { error: "verkeerde herkomst" });
    setCookie(res, "ww", "", 0);
    return json(res, 200, { ok: true });
  }
  if (p.startsWith("/api/")) {
    const s = getSession(req);
    if (!s) return json(res, 401, { error: "login" });
    return api(req, res, url, s);
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Niet gevonden");
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "serverfout" }); else res.end();
  });
}).listen(PORT, env.HOST || "0.0.0.0", () => console.log(`Wegenwacht draait op ${BASE_URL} (poort ${PORT})`));

// Wekelijkse automatische promotie: controleert elke 10 minuten of er een nieuwe week is begonnen.
const tick = () => {
  try {
    const n = store.maybeAuto();
    if (n !== null) console.log(`Automatische promotie uitgevoerd: ${n} promoties`);
  } catch (e) { console.error(e); }
};
tick();
setInterval(tick, Number(env.AUTO_CHECK_MS) || 10 * 60 * 1000);
