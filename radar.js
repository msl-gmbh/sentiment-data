#!/usr/bin/env node
/*
  MSL Global Market Radar — MVP v0.1  (dependency-frei, Node 18+)
  Beobachtungs-/Fruehwarnsystem. Loest NIE Portfolioaktionen aus.

  Ablauf:  News (GDELT/RSS) + Kalender  ->  Score (Keywords)  ->  FRED-Gate (Markt-Bestaetigung)
           ->  Level 0-5  ->  Dedup  ->  oeffentliche JSON  +  interne Telegram-Alerts

  Secrets via Umgebungsvariablen (GitHub Secrets):
    FRED_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = __dirname;
const CFG = DIR;                       // Configs liegen flach neben radar.js (Repo-Wurzel)
const OUT = path.join(DIR, "output");  // wird automatisch angelegt
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const CONFIG = {
  FRED_KEY: process.env.FRED_KEY || "DEIN_FRED_KEY",
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT:  process.env.TELEGRAM_CHAT_ID || "",
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || "DEIN_ANTHROPIC_KEY"
};

const RULES   = readJson(path.join(CFG, "radar_rules.json"));
const SOURCES = readJson(path.join(CFG, "sources.json"));
const CAL_CFG = readJson(path.join(CFG, "calendar_events.json"));

if (!RULES.levels || !RULES.score_max) {
  console.error("FEHLER: radar_rules.json fehlt oder ist unvollstaendig.");
  console.error("Erwartet: " + path.join(CFG, "radar_rules.json"));
  console.error("Pruefe, ob der Ordner radar/config/ mit allen drei JSONs im Repo liegt.");
  process.exit(1);
}

/* ----------------------------------------------------------- Helfer */
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.warn("  ! Konnte " + path.basename(p) + " nicht lesen: " + e.message); return fallback || {}; }
}
function lower(s) { return String(s || "").toLowerCase(); }
function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16); }
function fmtDate(d) { return new Date(d).toISOString().slice(0, 10); }
function daysFromNow(d, now) { return Math.round((new Date(d) - now) / 86400000); }

async function getJSON(url, opts = {}) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    const r = await fetch(url, { signal: ctrl.signal, headers: opts.headers || {} });
    clearTimeout(to);
    if (!r.ok) { console.warn("  ! HTTP " + r.status + " bei " + url.slice(0, 70)); return null; }
    return await r.json();
  } catch (e) { console.warn("  ! Fetch-Fehler (" + e.message + ") bei " + url.slice(0, 70)); return null; }
}
async function getText(url, opts = {}) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { console.warn("  ! RSS-Fehler (" + e.message + ") bei " + url.slice(0, 70)); return null; }
}

/* ----------------------------------------------------------- Harte Daten (FRED) = Markt-Bestaetigung */
async function fredLast(series) {
  if (!CONFIG.FRED_KEY || /DEIN_/.test(CONFIG.FRED_KEY)) return null;
  const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" + series +
              "&api_key=" + CONFIG.FRED_KEY + "&file_type=json&sort_order=desc&limit=1";
  const j = await getJSON(url);
  const v = j && j.observations && j.observations[0] && j.observations[0].value;
  const n = v === "." || v == null ? null : Number(v);
  return isNaN(n) ? null : n;
}
async function fetchHardData() {
  const s = SOURCES.fred_series || {};
  const [vix, vix3m, hyoas, dgs10, dgs2] = await Promise.all([
    fredLast(s.vix), fredLast(s.vix3m), fredLast(s.hyoas), fredLast(s.dgs10), fredLast(s.dgs2)
  ]);
  const h = { vix, vix3m, hyoas, dgs10, dgs2 };
  h.mc = marketConfirmation(h);
  console.log("  Harte Daten:", JSON.stringify(h));
  return h;
}
// Markt-Bestaetigung 0-5: VIX-Niveau + VIX-Backwardation + HY-Spreads
function marketConfirmation(h) {
  let mc = 0;
  if (h.vix != null) { if (h.vix >= 30) mc += 2; else if (h.vix >= 25) mc += 1; else if (h.vix >= 20) mc += 0.5; }
  if (h.vix != null && h.vix3m != null && h.vix3m > 0 && (h.vix / h.vix3m) >= 1.0) mc += 1.5; // Backwardation = Stress
  if (h.hyoas != null) { if (h.hyoas >= 5.0) mc += 1.5; else if (h.hyoas >= 4.0) mc += 0.5; }
  return Math.min(RULES.score_max.market_confirmation, Math.round(mc * 2) / 2);
}

/* ----------------------------------------------------------- News */
async function fetchGdelt() {
  const g = SOURCES.gdelt || {};
  if (!g.enabled) return [];
  const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(g.query) +
              "&mode=ArtList&format=json&maxrecords=" + (g.maxrecords || 50) + "&timespan=" + (g.timespan || "1d");
  const j = await getJSON(url);
  const arts = (j && j.articles) || [];
  return arts.map(a => ({ title: a.title, url: a.url, source: a.domain || "", date: a.seendate || "" }))
             .filter(a => a.title);
}
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const t = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || "";
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const date = (b.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/(pubDate|updated|published)>/i) || [])[2] || "";
    const title = t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    if (title) items.push({ title, url: link.trim(), source: hostOf(link), date: date.trim() });
  }
  return items;
}
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return ""; } }
async function fetchRss() {
  const r = SOURCES.rss || {};
  if (!r.enabled) return [];
  let out = [];
  for (const feed of (r.feeds || [])) {
    const xml = await getText(feed);
    if (xml) out = out.concat(parseRss(xml));
  }
  return out;
}

/* ----------------------------------------------------------- Dynamischer Kalender (FMP + FRED) */
// Zieht geplante Termine fuer die naechsten 30 Tage automatisch.
// Faellt graceful auf die statische calendar_events.json zurueck.
const FMP_EVENT_MAP = {
  "fomc": "fed_fomc", "federal reserve": "fed_fomc", "fed interest": "fed_fomc",
  "ecb": "ecb", "european central bank": "ecb",
  "cpi": "cpi", "consumer price index": "cpi",
  "pce": "pce", "personal consumption": "pce",
  "nonfarm": "nfp", "unemployment": "nfp",
  "gdp": "gdp",
  "msci": "index_rebal", "russell": "index_rebal", "s&p rebalancing": "index_rebal"
};
const FMP_ASSET_MAP = {
  "fed_fomc": ["Zinsen","Aktien","USD/FX","Krypto"],
  "ecb":      ["Zinsen","Aktien","USD/FX"],
  "cpi":      ["Zinsen","Aktien","USD/FX","Gold/Silber"],
  "pce":      ["Zinsen","Aktien","USD/FX"],
  "nfp":      ["Zinsen","Aktien","USD/FX"],
  "gdp":      ["Zinsen","Aktien"],
  "index_rebal": ["Aktien"]
};

async function fetchFmpCalendar(fromDate, toDate) {
  const key = process.env.FMP_KEY || "";
  if (!key || /DEIN_/.test(key)) return [];
  const url = "https://financialmodelingprep.com/api/v3/economic_calendar?from=" + fromDate + "&to=" + toDate + "&apikey=" + key;
  const j = await getJSON(url);
  if (!j || !Array.isArray(j)) { console.warn("  ! FMP Kalender: kein Array (ggf. Tier-Einschraenkung -> statische JSON)"); return []; }
  const events = [];
  for (const e of j) {
    if (e.importance !== "High" && e.impact !== "High") continue; // nur High-Impact
    const titleLow = lower(e.event || "");
    let type = null;
    for (const [kw, t] of Object.entries(FMP_EVENT_MAP)) if (titleLow.includes(kw)) { type = t; break; }
    if (!type) continue;
    const date = (e.date || "").slice(0, 10);
    if (!date) continue;
    events.push({ date, type, title: (e.event || type), assets: FMP_ASSET_MAP[type] || ["Aktien"], source: "fmp" });
  }
  console.log("  > FMP Kalender: " + events.length + " High-Impact-Termine geladen");
  return events;
}

async function fetchFredReleases(fromDate, toDate) {
  const key = CONFIG.FRED_KEY;
  if (!key || /DEIN_/.test(key)) return [];
  // FRED Release-Dates fuer wichtige Serien (CPI=Release 10, PCE=Release 17, NFP=Release 50)
  const releaseIds = [
    {id: 10, type: "cpi",  title: "US CPI-Daten"},
    {id: 50, type: "nfp",  title: "US Arbeitsmarktdaten (NFP)"},
    {id: 17, type: "pce",  title: "US PCE-Daten"}
  ];
  const events = [];
  for (const rel of releaseIds) {
    const url = "https://api.stlouisfed.org/fred/release/dates?release_id=" + rel.id +
                "&realtime_start=" + fromDate + "&realtime_end=" + toDate +
                "&include_release_dates_with_no_data=true" +
                "&api_key=" + key + "&file_type=json&limit=10&sort_order=asc";
    const j = await getJSON(url);
    const dates = (j && j.release_dates) || [];
    for (const d of dates) {
      const date = d.date;
      if (date >= fromDate && date <= toDate)
        events.push({ date, type: rel.type, title: rel.title, assets: FMP_ASSET_MAP[rel.type] || ["Zinsen","Aktien"], source: "fred" });
    }
  }
  if (events.length) console.log("  > FRED Release-Kalender: " + events.length + " Termine geladen");
  return events;
}

async function buildDynamicCalendar(now) {
  const fromDate = fmtDate(now);
  const toDate = fmtDate(new Date(now.getTime() + 30 * 86400000));

  // 1) Dynamische Quellen (parallel)
  const [fmpEvents, fredEvents] = await Promise.all([
    fetchFmpCalendar(fromDate, toDate),
    fetchFredReleases(fromDate, toDate)
  ]);

  // 2) Statische manuelle Events (Fallback + Ergaenzung)
  const manualEvents = (CAL_CFG.events || [])
    .map(e => ({ ...e, date: e.date, source: "manual" }))
    .filter(e => e.date >= fromDate && e.date <= toDate);

  // 3) Zusammenfuehren: dynamische Events haben Vorrang, manuelle ergaenzen
  const seen = new Set();
  const merged = [];
  for (const e of [...fmpEvents, ...fredEvents, ...manualEvents]) {
    const key = e.type + ":" + e.date;
    if (!seen.has(key)) { seen.add(key); merged.push(e); }
  }

  // 4) Auto-Kalender (Opex, Quartalsende, Monatsende) immer dazu
  const auto = autoCalendar(now);

  // 5) Fensterfiltert + sortiert (naechste 14T)
  const win = [], allEvents = [...merged, ...auto.map(e => ({...e, date: fmtDate(e.date), source: "auto"}))];
  let nearest = null, cashWindow = false;
  for (const e of allEvents) {
    const d = daysFromNow(new Date(e.date), now);
    if (d >= 0 && d <= 14) {
      win.push({ ...e, days: d });
      if (nearest === null || d < nearest) nearest = d;
      const cashType = ["quarter_end","month_end","opex","index_rebal"].includes(e.type);
      if (d <= 5 && cashType) cashWindow = true;
    }
  }
  win.sort((a, b) => a.days - b.days);

  const sourcesSummary = [...new Set(win.map(e => e.source))].join("+");
  console.log("  Kalender: " + win.length + " Termine in 14T (Quellen: " + sourcesSummary + "), naechster in " + nearest + "T, Cash-Fenster: " + cashWindow);
  return { events: win, nearest, cashWindow };
}

function thirdFriday(y, m) {
  let d = new Date(Date.UTC(y, m, 1)), cnt = 0;
  while (true) { if (d.getUTCDay() === 5) { cnt++; if (cnt === 3) break; } d.setUTCDate(d.getUTCDate() + 1); }
  return d;
}
function autoCalendar(now) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const cand = [];
  // Monatsende
  cand.push({ title: "Monatsende", type: "month_end", date: new Date(Date.UTC(y, m + 1, 0)), assets: ["Aktien"] });
  // Quartalsende (naechstes Quartalsende-Monat: Mar/Jun/Sep/Dec)
  let qm = [2, 5, 8, 11].find(x => x >= m);
  let qy = y; if (qm === undefined) { qm = 2; qy = y + 1; }
  cand.push({ title: "Quartalsende", type: "quarter_end", date: new Date(Date.UTC(qy, qm + 1, 0)), assets: ["Aktien"] });
  // Opex / Triple Witching (3. Freitag)
  let opex = thirdFriday(y, m);
  if (opex < now) { const nm = m + 1; opex = thirdFriday(nm > 11 ? y + 1 : y, nm % 12); }
  const witch = [2, 5, 8, 11].includes(opex.getUTCMonth());
  cand.push({ title: witch ? "Triple Witching (gr. Optionsverfall)" : "Optionsverfall (Opex)", type: "opex", date: opex, assets: ["Aktien"] });
  return cand;
}
function buildCalendar(now) {
  let all = autoCalendar(now);
  // manuelle Events (nur echte; Beispiel-Flag ignorieren wir NICHT automatisch — Hinweis im Log)
  const man = (CAL_CFG.events || []).map(e => ({ title: e.title, type: e.type, date: new Date(e.date), assets: e.assets || ["Aktien"] }));
  if (CAL_CFG._beispiel_bitte_durch_echte_termine_ersetzen) console.warn("  ! calendar_events.json enthaelt noch BEISPIEL-Termine — bitte durch echte ersetzen.");
  all = all.concat(man.filter(e => !isNaN(e.date)));
  // nur kommende 14 Tage
  const win = [];
  let nearest = null, cashWindow = false;
  for (const e of all) {
    const d = daysFromNow(e.date, now);
    if (d >= 0 && d <= 14) {
      win.push({ ...e, days: d });
      if (nearest === null || d < nearest) nearest = d;
      const cashType = ["quarter_end", "month_end", "opex", "index_rebal"].includes(e.type);
      if (d <= 5 && cashType) cashWindow = true;
    }
  }
  win.sort((a, b) => a.days - b.days);
  return { events: win, nearest, cashWindow };
}

/* ----------------------------------------------------------- Scoring */
function levelFor(total) {
  let chosen = RULES.levels[0];
  for (const l of RULES.levels) if (total >= l.min) chosen = l;
  return chosen;
}
function matchedAssets(text) {
  const t = lower(text), fams = [];
  for (const [fam, kws] of Object.entries(RULES.asset_keywords)) if (kws.some(k => t.includes(k))) fams.push(fam);
  return fams;
}
function countHits(text, kws) { const t = lower(text); return kws.filter(k => t.includes(k)).length; }

function scoreNews(item, hard, cal) {
  const t = lower(item.title);
  const fams = matchedAssets(item.title);
  const M = RULES.score_max;
  const f = {
    asset_relevance:     Math.min(M.asset_relevance, fams.length),
    institutional_flows: Math.min(M.institutional_flows, countHits(t, RULES.institutional_keywords) * 2),
    magnitude:           Math.min(M.magnitude, countHits(t, RULES.magnitude_keywords) * 2),
    time_window:         cal.nearest == null ? 0 : (cal.nearest <= 2 ? 3 : cal.nearest <= 5 ? 2 : cal.nearest <= 10 ? 1 : 0),
    source_quality:      RULES.source_whitelist.some(d => lower(item.source).includes(d)) ? M.source_quality : 1,
    market_confirmation: hard.mc,
    cash_deployment:     Math.min(M.cash_deployment, countHits(t, RULES.cash_deployment_keywords) * 2 + (cal.cashWindow ? 2 : 0))
  };
  let total = Object.values(f).reduce((a, b) => a + b, 0);
  const blacklisted = RULES.noise_blacklist.some(k => t.includes(k));
  if (blacklisted || f.asset_relevance === 0) total = 0; // harter Laerm-Filter
  const lvl = levelFor(Math.round(total));
  return { item, assets: fams, factors: f, total: Math.round(total), level: lvl.level, type: lvl.type, label: lvl.label };
}

// Kalender-Alert (deine erste Regel: institutionelle Marktmechanik / Rebalancing)
function scoreCalendarEvent(e, hard) {
  const M = RULES.score_max;
  const strong = ["quarter_end", "index_rebal"].includes(e.type);
  const witching = e.type === "opex" && /witching/i.test(e.title);
  const f = {
    asset_relevance:     strong ? 2 : Math.min(M.asset_relevance, (e.assets || []).length || 1),
    institutional_flows: strong ? 4 : witching ? 3 : 2,
    magnitude:           0,
    time_window:         e.days <= 2 ? 3 : e.days <= 5 ? 2 : 1,
    source_quality:      3,
    market_confirmation: hard.mc,
    cash_deployment:     4
  };
  const total = Object.values(f).reduce((a, b) => a + b, 0);
  let lvl = levelFor(total);
  // Bestimmte Kalender-Typen pushen immer mindestens Level 3 (Cash-Deployment-Watch Baseline)
  const alwaysPush = RULES.calendar_always_push || [];
  if (alwaysPush.includes(e.type) && lvl.level < 3) {
    lvl = levelFor(RULES.levels.find(l => l.level === 3).min);
  }
  return {
    item: { title: e.title, url: "", source: "Kalender", date: fmtDate(e.date) },
    assets: e.assets || ["Aktien"], factors: f, total, level: lvl.level, type: lvl.type, label: lvl.label,
    calendar: true, eventType: e.type, days: e.days, eventDate: fmtDate(e.date)
  };
}

/* ----------------------------------------------------------- Texte (Compliance: kein Rat, ruhig) */
function communityText(a) {
  return "Hinweis fuer Anleger: In den naechsten Tagen koennen technische Marktschwankungen auftreten "
    + "(" + a.item.title + "). Das ist relevant, aber kein automatisches Crash-Signal. Die Strategie bleibt "
    + "unveraendert. Fuer neues Kapital kann ein gestaffeltes Vorgehen sinnvoll sein.";
}
function socialText(a) {
  return "Viele machen aus solchen Meldungen sofort ein Crash-Narrativ.\n\n"
    + "Sauberer Blick: Ja, das kann kurzfristig Volatilitaet erzeugen. Nein, es ist kein automatisches "
    + "Verkaufssignal. Profis unterscheiden zwischen Marktmechanik, Risiko-Signal und echtem Strategie-Trigger.";
}
function notMeaning() { return "Kein Crash-Signal, kein Verkaufssignal, keine Ampelaenderung."; }
function investNote() { return "Bestehende Positionen unveraendert. Neues Kapital ggf. gestaffelt einsetzen."; }

/* ----------------------------------------------------------- LLM-Textstufe (Claude API, optional) */
// Erzeugt publikationsreife, compliance-konforme Community-/Social-Texte. Nur fuer gesendete Alerts.
// Faellt bei fehlendem Key/Fehler still auf die Templates zurueck.
async function llmDrafts(a, hard) {
  if (!RULES.llm || !RULES.llm.enabled) return null;
  if (!CONFIG.ANTHROPIC_KEY || /DEIN_/.test(CONFIG.ANTHROPIC_KEY)) return null;
  const sys =
    "Du bist Kommunikations-Assistent fuer MSL, eine Finanz-Coaching-Marke OHNE Anlageberatungslizenz. " +
    "Erzeuge zu einem Marktereignis zwei kurze deutsche Texte fuer Community und Social Media. " +
    "ZWINGENDE REGELN: keine Anlageberatung; keine Kauf-/Verkaufsempfehlung; keine Einzeltitel; keine Kurs-Prognose; " +
    "keine Garantien; keine Crash-Panik; kein Clickbait. Stil: ruhig, sachlich, kompetent, einordnend. " +
    "Erlaubt: Marktmechanik erklaeren, Hype/Panik sachlich entkraeften, und hoechstens der Hinweis, dass fuer NEUES " +
    "Kapital ein gestaffeltes Vorgehen sinnvoll sein kann (bestehende Positionen bleiben immer unberuehrt). " +
    "Antworte AUSSCHLIESSLICH mit JSON, ohne Code-Fences: " +
    "{\"community\":\"<3-4 Saetze sachliche Anlegerinfo>\",\"social\":\"<4-6 Saetze Experten-Einordnung, die Panikmache " +
    "sachlich kontert und Kompetenz zeigt>\"}.";
  const user =
    "Ereignis: " + a.title + "\nAssetklassen: " + a.assets.join(", ") + "\nRadar-Level: " + a.level + " (" + a.label + ")\n" +
    "Sachliche Einordnung: " + a.summary + "\n" +
    "Harte Marktlage: VIX " + hard.vix + ", HY-Spread " + hard.hyoas + ", Stress-Score " + hard.mc + "/5.";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CONFIG.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: (RULES.llm.model || "claude-sonnet-4-6"), max_tokens: 800, system: sys, messages: [{ role: "user", content: user }] })
    });
    if (!r.ok) { let b = ""; try { b = await r.text(); } catch (e) {} console.warn("  ! LLM HTTP " + r.status + " " + b.slice(0, 160)); return null; }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const obj = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (obj && obj.community && obj.social) { console.log("  > LLM-Texte erzeugt fuer: " + a.title); return obj; }
    return null;
  } catch (e) { console.warn("  ! LLM-Fehler: " + e.message); return null; }
}

function toAlert(s, now) {
  const id = sha1((s.calendar ? "cal:" + s.eventType + ":" + s.eventDate : "news:" + s.item.source + ":" + s.item.title));
  return {
    id, level: s.level, type: s.type, label: s.label,
    title: s.item.title, assets: s.assets,
    time_window: s.calendar ? (s.days + " Tage") : "1-5 Handelstage",
    summary: s.calendar
      ? ("Technisches Markt-/Liquiditaetsereignis (" + s.item.title + ") in " + s.days + " Tagen. Kann kurzfristig Volatilitaet erzeugen.")
      : ("Relevante Meldung zu " + s.assets.join(", ") + "."),
    what_it_does_not_mean: notMeaning(),
    investment_note: investNote(),
    sources: s.item.url ? [{ name: s.item.source || "Quelle", url: s.item.url }] : [],
    score: { total: s.total, ...s.factors },
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (RULES.alert_expiry_days || 7) * 86400000).toISOString(),
    _community_text: communityText(s),   // intern, NICHT in oeffentliche JSON
    _social_text: socialText(s)          // intern, NICHT in oeffentliche JSON
  };
}

/* ----------------------------------------------------------- Dedup / Archiv */
function loadSeen() { return readJson(path.join(OUT, "seen.json"), {}); }
function saveSeen(seen) { fs.writeFileSync(path.join(OUT, "seen.json"), JSON.stringify(seen, null, 2)); }
function pruneSeen(seen, now) {
  for (const id of Object.keys(seen)) if (new Date(seen[id].expires_at) < now) delete seen[id];
}

/* ----------------------------------------------------------- Telegram (nur intern) */
async function sendTelegram(text) {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) { console.warn("  ! Telegram-Secrets fehlen — Versand uebersprungen."); return false; }
  const url = "https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage";
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT, text, disable_web_page_preview: true })
    });
    if (!r.ok) {
      let body = "";
      try { body = await r.text(); } catch (e) {}
      console.warn("  ! Telegram HTTP " + r.status + (body ? " — " + body.replace(/\s+/g, " ").slice(0, 180) : ""));
      return false;
    }
    return true;
  } catch (e) { console.warn("  ! Telegram-Fehler: " + e.message); return false; }
}
function telegramMessage(a) {
  return "MSL Global Market Radar\n\n"
    + "Level " + a.level + ": " + a.label + "\n"
    + "Thema: " + a.title + "\n"
    + "Betrifft: " + a.assets.join(", ") + "\n"
    + "Zeitfenster: " + a.time_window + "\n\n"
    + "Bedeutung: " + a.summary + "\n"
    + "Was es NICHT bedeutet: " + a.what_it_does_not_mean + "\n"
    + "Strategie-Wirkung: keine automatische Aenderung.\n"
    + "Cash-Deployment: " + a.investment_note + "\n\n"
    + "— Community-Entwurf" + (a._llm ? " (KI)" : "") + " —\n" + a._community_text + "\n\n"
    + "— Social-Media-Entwurf" + (a._llm ? " (KI)" : "") + " —\n" + a._social_text + "\n\n"
    + "Score: " + a.score.total + " | Quelle: " + (a.sources[0] ? a.sources[0].url : "Kalender");
}

/* ----------------------------------------------------------- Hauptlauf */
(async () => {
  const now = new Date();
  console.log("MSL Global Market Radar — Lauf " + now.toISOString());

  const hard = await fetchHardData();
  const cal = await buildDynamicCalendar(now);

  const [gdelt, rss] = await Promise.all([fetchGdelt(), fetchRss()]);
  const news = gdelt.concat(rss);
  console.log("  News geladen: " + news.length + " (GDELT " + gdelt.length + ", RSS " + rss.length + ")");

  // Scoren
  const scored = news.map(n => scoreNews(n, hard, cal));
  const calScored = cal.events.map(e => scoreCalendarEvent(e, hard));
  const all = scored.concat(calScored).sort((a, b) => b.total - a.total);

  // Alerts ab Level 1; Laerm separat zaehlen
  const alerts = all.filter(s => s.level >= 1).map(s => toAlert(s, now));
  const noise = all.filter(s => s.level === 0).length;

  // Dedup + Telegram (nur neue, ab telegram_min_level)
  const seen = loadSeen(); pruneSeen(seen, now);
  let sent = 0;
  for (const a of alerts) {
    const known = seen[a.id] || {};
    const notified = (known.notified_level == null) ? -1 : known.notified_level; // alte Eintraege => -1 => Retry
    let notifiedLevel = notified;
    if (a.level >= (RULES.telegram_min_level || 3) && a.level > notified) {
      const drafts = await llmDrafts(a, hard);   // KI nur fuer tatsaechlich zu sendende Alerts (kostensparend)
      if (drafts) { a._community_text = drafts.community; a._social_text = drafts.social; a._llm = true; }
      const ok = await sendTelegram(telegramMessage(a));
      if (ok) { notifiedLevel = a.level; sent++; }   // nur bei echtem Versand als gemeldet markieren
    }
    seen[a.id] = {
      max_level: Math.max(a.level, known.max_level || 0),
      notified_level: notifiedLevel,
      expires_at: a.expires_at
    };
  }
  saveSeen(seen);

  // Oeffentliche JSON (OHNE interne Entwurfstexte)
  const highest = alerts.reduce((m, a) => Math.max(m, a.level), 0);
  const top = alerts.slice(0, 8).map(a => {
    const { _community_text, _social_text, ...pub } = a; return pub;
  });
  const output = {
    generated_at: now.toISOString(),
    highest_level: highest,
    cash_deployment: cal.cashWindow ? "gestaffelt" : "normal",
    existing_positions: "keine_aenderung",
    market_confirmation: hard.mc,
    hard_data: { vix: hard.vix, vix3m: hard.vix3m, hyoas: hard.hyoas },
    alerts: top,
    noise_filtered: noise,
    notifications: { telegram_sent: sent }
  };
  fs.writeFileSync(path.join(OUT, "global_market_radar.json"), JSON.stringify(output, null, 2));

  // Archiv (JSONL, nur neue Alerts dieser Runde)
  const arch = alerts.map(a => JSON.stringify({ t: now.toISOString(), id: a.id, level: a.level, title: a.title })).join("\n");
  if (arch) fs.appendFileSync(path.join(OUT, "archive.jsonl"), arch + "\n");

  console.log("Fertig. Alerts: " + alerts.length + " | hoechstes Level: " + highest + " | Telegram gesendet: " + sent + " | Laerm gefiltert: " + noise);
})().catch(e => { console.error("Radar-Lauf fehlgeschlagen:", (e && e.stack) || e); process.exit(1); });
