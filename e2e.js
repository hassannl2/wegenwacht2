"use strict";
// Volledige test met een nagebootste Discord-server: login, toegang, rechten, klokken, promoties.
const http = require("http");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FAKE = 4100, APP = 4101;
const base = `http://localhost:${APP}`;
const dbFile = path.join(os.tmpdir(), "ww-test-" + process.pid + ".sqlite");

// --- nagebootste Discord ---
const users = {
  tok_mgr: { id: "111", username: "chef", global_name: "Chef", roles: ["ROLE_MGR"] },
  tok_player: { id: "222", username: "pieter", global_name: "Pieter", roles: ["ROLE_MEMBER"] },
  tok_outsider: { id: "333", username: "gast", roles: null },
  tok_norole: { id: "444", username: "zonderrol", roles: [] },
};
const fake = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/oauth2/token") {
    let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
      const p = new URLSearchParams(b); send(200, { access_token: "tok_" + p.get("code") });
    }); return;
  }
  const u = users[(req.headers.authorization || "").replace("Bearer ", "")];
  if (!u) return send(401, {});
  if (req.url === "/users/@me") return send(200, { id: u.id, username: u.username, global_name: u.global_name });
  if (req.url === "/users/@me/guilds/GUILD1/member") return u.roles ? send(200, { roles: u.roles, nick: null }) : send(404, {});
  send(404, {});
});

async function call(method, url, o = {}) {
  const r = await fetch(base + url, {
    method, redirect: "manual",
    headers: { ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.body ? { "Content-Type": "application/json" } : {}), ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  let j = null; try { j = await r.clone().json(); } catch {}
  return { status: r.status, json: j, loc: r.headers.get("location"), cookies: r.headers.getSetCookie().map((c) => c.split(";")[0]) };
}
async function login(code) {
  const a = await call("GET", "/auth/login");
  assert.strictEqual(a.status, 302);
  const state = new URL(a.loc).searchParams.get("state");
  const b = await call("GET", `/auth/callback?code=${code}&state=${state}`, { cookie: a.cookies.join("; ") });
  assert.strictEqual(b.status, 302);
  return { loc: b.loc, cookie: b.cookies.filter((c) => c.startsWith("ww=") && c.length > 4).join("; ") };
}
const post = (url, cookie, body = {}) => call("POST", url, { cookie, body, headers: { Origin: base } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  const srv = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "server.js"], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BASE_URL: base, PORT: String(APP), DB_FILE: dbFile, SESSION_SECRET: "x".repeat(40),
      DISCORD_CLIENT_ID: "cid", DISCORD_CLIENT_SECRET: "sec", DISCORD_GUILD_ID: "GUILD1", MEMBER_ROLE_ID: "ROLE_MEMBER",
      MANAGER_ROLE_IDS: "ROLE_MGR", DISCORD_API: `http://localhost:${FAKE}`, AUTO_CHECK_MS: "300", TZ: "Europe/Amsterdam" },
  });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(base + "/"); break; } catch { await sleep(100); } }
    const ok = (m) => console.log("  ✓ " + m);

    assert.strictEqual((await call("GET", "/api/state")).status, 401); ok("zonder login geen toegang tot data");
    assert.strictEqual((await call("GET", "/api/state", { cookie: "ww=nep.nep" })).status, 401); ok("vervalste cookie wordt geweigerd");
    const page = await call("GET", "/"); assert.strictEqual(page.status, 200); ok("loginpagina is bereikbaar");

    const bad = await call("GET", "/auth/callback?code=player&state=verzonnen");
    assert.strictEqual(bad.loc, "/?e=state"); ok("verkeerde state wordt geweigerd");
    assert.strictEqual((await login("outsider")).loc, "/?e=noaccess"); ok("geen lid van de server -> geen toegang");
    assert.strictEqual((await login("norole")).loc, "/?e=noaccess"); ok("lid zonder juiste rol -> geen toegang");

    const mgr = await login("mgr"), ply = await login("player");
    assert.strictEqual(mgr.loc, "/"); assert.strictEqual(ply.loc, "/"); ok("management en speler kunnen inloggen");

    const ps = (await call("GET", "/api/state", { cookie: ply.cookie })).json;
    assert.strictEqual(ps.mgr, false); assert.strictEqual(ps.priv, null);
    assert.ok(ps.config.ranks.every((r) => !("h" in r)));
    assert.ok(!JSON.stringify(ps).includes('"hours"')); ok("speler ziet de vereiste uren NIET");
    const ms = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.deepStrictEqual(ms.priv.hours, [0, 10, 25, 50, 100]); ok("management ziet de vereiste uren wel");
    assert.strictEqual(ms.members["222"].name, "Pieter"); ok("account wordt automatisch aangemaakt met Discord-naam");

    assert.strictEqual((await post("/api/clock/in", ply.cookie)).status, 200);
    assert.ok((await call("GET", "/api/state", { cookie: ply.cookie })).json.members["222"].since); ok("inklokken werkt");

    for (const [u, b] of [["/api/mgr/config", { siteName: "Hack" }], ["/api/mgr/member/222", { hours: 999 }], ["/api/mgr/promote-all", {}], ["/api/mgr/clockout/222", {}]])
      assert.strictEqual((await post(u, ply.cookie, b)).status, 403);
    ok("speler kan geen beheeracties doen (ook niet zijn eigen uren aanpassen)");
    assert.strictEqual((await call("POST", "/api/mgr/config", { cookie: mgr.cookie, body: { siteName: "X" }, headers: { Origin: "https://evil.example" } })).status, 403);
    ok("verzoeken van een andere website worden geweigerd (CSRF)");

    assert.strictEqual((await post("/api/mgr/clockout/222", mgr.cookie)).status, 200);
    let st = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.strictEqual(st.members["222"].since, null); ok("management kan iemand uitklokken");

    await post("/api/mgr/member/222", mgr.cookie, { hours: 11, specs: ["Berging", "Bestaatniet"], name: "Piet" });
    st = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.strictEqual(st.members["222"].total, 11 * 3600); assert.deepStrictEqual(st.members["222"].specs, ["Berging"]);
    assert.strictEqual(st.members["222"].name, "Piet"); ok("uren, naam en specialisaties aanpassen werkt");

    assert.strictEqual((await post("/api/mgr/promote-all", mgr.cookie)).json.promoted, 1);
    st = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.strictEqual(st.members["222"].rank, 1); ok("promoveer iedereen: 11 uur -> Wegenwacht");

    assert.strictEqual((await post("/api/mgr/config", mgr.cookie, { ranks: [{ n: "A", h: 0 }, { n: "B", h: 5 }], specs: ["X"], accent: "rood" })).status, 400); ok("ongeldige instellingen worden geweigerd");
    assert.strictEqual((await post("/api/mgr/config", mgr.cookie, { ranks: [{ n: "A", h: 0 }, { n: "B", h: 5 }, { n: "C", h: 20 }], siteName: "Wegenwacht Test", auto: true })).status, 200);
    st = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.strictEqual(st.config.siteName, "Wegenwacht Test"); assert.strictEqual(st.members["222"].rank, 1);
    assert.deepStrictEqual(st.priv.hours, [0, 5, 20]); ok("rangen en instellingen opslaan werkt");

    // maandag-promotie: zet de laatste uitvoering op een oude week en geef Piet 21 uur
    await post("/api/mgr/member/222", mgr.cookie, { hours: 21 });
    const d = new DatabaseSync(dbFile);
    d.prepare("UPDATE config SET value=? WHERE key='lastRun'").run(JSON.stringify("2000-01-03"));
    d.close();
    await sleep(900);
    st = (await call("GET", "/api/state", { cookie: mgr.cookie })).json;
    assert.strictEqual(st.members["222"].rank, 2); assert.notStrictEqual(st.priv.lastRun, "2000-01-03");
    ok("nieuwe week -> automatische promotie draait vanzelf op de server");

    await post("/auth/logout", mgr.cookie);
    console.log("\nAlle tests geslaagd.");
  } catch (e) {
    console.error("\nTEST MISLUKT:", e); process.exitCode = 1;
  } finally {
    srv.kill(); fake.close(); for (const s of ["", "-wal", "-shm"]) fs.rmSync(dbFile + s, { force: true });
  }
})();
