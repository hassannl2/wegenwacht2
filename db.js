"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "data.sqlite"));
db.exec("PRAGMA journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS members(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,      -- seconden
  since INTEGER,                      -- ms-timestamp van inklokken, NULL = niet in dienst
  specs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const tx = (fn) => {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};

const DEFAULTS = {
  siteName: "Wegenwacht", icon: "🚗", accent: "#ffb400", accent2: "#ff7a00", theme: "auto",
  welcome: "", discord: "",
  specs: ["Pechhulp", "Berging", "Verkeersregelaar", "Eerste hulp"],
  ranks: [
    { n: "Rekruut", h: 0 }, { n: "Wegenwacht", h: 10 }, { n: "Senior Wegenwacht", h: 25 },
    { n: "Teamleider", h: 50 }, { n: "Manager", h: 100 },
  ],
  auto: true, lastRun: "", lastCount: 0,
};

// Maandag van de huidige week (lokale tijd, zie TZ in .env) als "JJJJ-MM-DD".
function mondayKey(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

function getCfg() {
  const o = structuredClone(DEFAULTS);
  for (const r of db.prepare("SELECT key,value FROM config").all()) o[r.key] = JSON.parse(r.value);
  return o;
}
function setCfg(patch) {
  const st = db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  tx(() => { for (const [k, v] of Object.entries(patch)) st.run(k, JSON.stringify(v)); });
}
// Bij de allereerste start begint de automatische promotie pas op de eerstvolgende maandag.
if (!db.prepare("SELECT 1 AS x FROM config WHERE key='lastRun'").get()) setCfg({ lastRun: mondayKey() });

const parse = (m) => m && { id: m.id, name: m.name, rank: m.rank, total: m.total, since: m.since, specs: JSON.parse(m.specs) };
const allMembers = () => db.prepare("SELECT * FROM members").all().map(parse);
const getMember = (id) => parse(db.prepare("SELECT * FROM members WHERE id=?").get(id));
const upsertMember = (id, name) =>
  db.prepare("INSERT OR IGNORE INTO members(id,name) VALUES(?,?)").run(id, String(name || "Onbekend").slice(0, 40));
const deleteMember = (id) => db.prepare("DELETE FROM members WHERE id=?").run(id);

const clockIn = (id) => db.prepare("UPDATE members SET since=? WHERE id=? AND since IS NULL").run(Date.now(), id);
function clockOut(id) {
  const m = getMember(id);
  if (!m || !m.since) return false;
  db.prepare("UPDATE members SET total=total+?, since=NULL WHERE id=?").run(Math.max(0, (Date.now() - m.since) / 1000), id);
  return true;
}

function updateMember(id, p) {
  if (!getMember(id)) return false;
  tx(() => {
    if (p.name !== undefined) db.prepare("UPDATE members SET name=? WHERE id=?").run(p.name, id);
    if (p.rank !== undefined) db.prepare("UPDATE members SET rank=? WHERE id=?").run(p.rank, id);
    if (p.specs !== undefined) db.prepare("UPDATE members SET specs=? WHERE id=?").run(JSON.stringify(p.specs), id);
    if (p.hours !== undefined)
      db.prepare("UPDATE members SET total=?, since=CASE WHEN since IS NULL THEN NULL ELSE ? END WHERE id=?")
        .run(p.hours * 3600, Date.now(), id);
  });
  return true;
}
const clampRanks = (count) => db.prepare("UPDATE members SET rank=? WHERE rank>?").run(count - 1, count - 1);

// Iedereen met genoeg uren krijgt de hoogste rang waarvoor hij genoeg uren heeft. Nooit degraderen.
function promoteEligible() {
  const hs = getCfg().ranks.map((r) => r.h);
  const now = Date.now();
  const upd = db.prepare("UPDATE members SET rank=? WHERE id=?");
  let count = 0;
  tx(() => {
    for (const m of allMembers()) {
      const t = (m.total + (m.since ? Math.max(0, (now - m.since) / 1000) : 0)) / 3600;
      let best = 0;
      hs.forEach((h, i) => { if (t >= h) best = i; });
      if (best > m.rank) { upd.run(best, m.id); count++; }
    }
  });
  return count;
}
function runAuto() {
  const count = promoteEligible();
  setCfg({ lastRun: mondayKey(), lastCount: count });
  return count;
}
// Voert de wekelijkse promotie uit als die deze week nog niet is gedaan.
function maybeAuto() {
  const cfg = getCfg();
  return cfg.auto && cfg.lastRun !== mondayKey() ? runAuto() : null;
}

module.exports = {
  getCfg, setCfg, mondayKey, allMembers, getMember, upsertMember, deleteMember,
  clockIn, clockOut, updateMember, clampRanks, promoteEligible, runAuto, maybeAuto,
};
