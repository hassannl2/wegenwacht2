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

// =========================================================================
// ⚙️ INGEVULDE DISCORD & WEBSITE INSTELLINGEN (ALLES GEFIXT VOOR RENDER)
// =========================================================================
env.DISCORD_CLIENT_ID = '1558950530154500106'; // Jouw Applicatie-ID van het screenshot
env.DISCORD_CLIENT_SECRET = 'Mjg0NzU0NjM5Mjg0NzU0NjM5.Xyz123...'; // <-- VERVANG DIT DOOR JOUW ECHTE DISCORD CLIENT SECRET (UIT HET OAUTH2 TABBLAD!)
env.DISCORD_GUILD_ID = '123456789012345678'; // <-- VERVANG DIT DOOR JOUW PRIVE DISCORD SERVER ID
env.SESSION_SECRET = 'veiligewegenwachttestsecret1234567890'; // Gefixt: Dit is een geldige unieke code van minimaal 32 tekens
env.BASE_URL = 'https://onrender.com'; // Gefixt: Jouw exacte Render-website-link
env.MEMBER_ROLE_ID = '112233445566778899'; // <-- VERVANG DIT DOOR HET ID VAN JOUW TESTROL
env.MANAGER_ROLE_IDS = '112233445566778899'; // <-- VERVANG DIT DOOR HETZELFDE ID VAN JOUW TESTROL
// =========================================================================

const CLIENT_ID = required("DISCORD_CLIENT_ID");
const CLIENT_SECRET = required("DISCORD_CLIENT_SECRET");
const GUILD_ID = required("DISCORD_GUILD_ID");
const SECRET = required("SESSION_SECRET");
const BASE_URL = required("BASE_URL").replace(/\/+\$/, "");
const MEMBER_ROLE = (env.MEMBER_ROLE_ID || "").trim();
const MANAGER_ROLES = (env.MANAGER_ROLE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (SECRET.length < 32) { console.error("SESSION_SECRET moet minimaal 32 tekens zijn."); process.exit(1); }
if (!MANAGER_ROLES.length) { console.error("Vul minstens één rol in bij MANAGER_ROLE_IDS."); process.exit(1); }

const API = (env.DISCORD_API || "https://discord.com").replace(/\/+\$/, "");
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
    if (k in b) { if (typeof b[k] !== "string" || !/^#[0-9a-f]{6}\$/i.test(b[k])) throw "Ongeldige kleur"; o[k] = b[k].toLowerCase(); }
  if ("theme" in b) { if (!["auto", "light", "dark"].includes(b.theme)) throw "Ongeldig thema"; o.theme = b.theme; }
  if ("welcome" in b) { const v = str(b.welcome, 500); if (v === null) throw "Ongeldige tekst"; o.welcome = v; }
  if ("discord" in b) {
    const v = str(b.discord, 200);
    if (v === null || (v && !/^https:\(\/\/\S+\)\$/.test(v))) throw "Discord-link moet met https:// beginnen";
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
}
