#!/usr/bin/env node
/* ===========================================================================
   MSL Dashboard Live-Updater  —  Variante 2 (Skript schreibt direkt ins HTML)
   ---------------------------------------------------------------------------
   Aufruf:   node update-data.js
   Wirkung:  holt alle Live-Werte und schreibt sie in den LIVE-DATA-Block
             beider Dashboards. Danach Dashboards per Doppelklick oeffnen.

   Voraussetzung: Node 18+ (eingebautes fetch). Pruefen: node -v

   >>> NUR HIER deine Keys eintragen (oder als Umgebungsvariablen setzen) <<<
   =========================================================================== */
const CONFIG = {
  BGEO_KEY: process.env.BGEO_KEY || "DEIN_BGEOMETRICS_ADVANCED_KEY",
  FRED_KEY: process.env.FRED_KEY || "DEIN_FRED_KEY",      // kostenlos: fred.stlouisfed.org
  FMP_KEY:  process.env.FMP_KEY  || "DEIN_FMP_KEY",       // habt ihr bereits (aktuell ungenutzt)
  NDL_KEY:  process.env.NDL_KEY  || "DEIN_NDL_KEY",       // Nasdaq Data Link (kostenlos) -> NAAIM-Auto-Quelle
  // NAAIM ist ab 01.08.2026 kostenpflichtig -> keine freie Auto-Quelle mehr.
  // Wochenwert hier eintragen (naaim.org, mittwochs) ODER naaim.csv in den Ordner legen.
  NAAIM_WEEKLY: process.env.NAAIM_WEEKLY || 79.27,
  // Put/Call (Equity) hat keine freie Live-API mehr (CBOE-Archiv eingefroren).
  // Optional Wert eintragen (z.B. von stockcharts.com $CPCE), sonst bleibt es n/a:
  PUTCALL_MANUAL: process.env.PUTCALL_MANUAL || null,
  // Konzentrations-Niveau (Mag-7-Gewicht im S&P 500) — keine freie Auto-Quelle, aendert sich langsam.
  // Monatlich grob aktualisieren (z.B. slickcharts.com/sp500 Top-7 summieren). Aktuell ~33,8%.
  CONCENTRATION_MAG7: process.env.CONCENTRATION_MAG7 || 33.8,
  // Weg A: zentrale JSON, die GitHub Actions committet und die HTMLs per raw-URL holen.
  JSON_OUT: process.env.JSON_OUT || "live-data.json",
  FILES: [
    "sentiment_dashboard_v3_cockpit.html",
    "PRIVAT_Cockpit_Marcel_v1.html"
  ]
};

const fs = require("fs");
const UA = { headers: { "User-Agent": "Mozilla/5.0 (MSL-Dashboard-Updater)" } };

// kleiner Helfer: fetch mit Timeout, gibt null statt zu werfen
async function get(url, opts = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { ...UA, ...opts, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { console.warn("  ! HTTP " + r.status + " bei " + url.slice(0, 70)); return null; }
    return r;
  } catch (e) { console.warn("  ! Fehler bei " + url.slice(0, 70) + " :: " + e.message); return null; }
}
async function getJSON(url, opts) { const r = await get(url, opts); return r ? r.json().catch(() => null) : null; }
async function getText(url, opts) { const r = await get(url, opts); return r ? r.text().catch(() => null) : null; }
const num = (x) => (x === null || x === undefined || isNaN(Number(x))) ? null : Number(x);

/* ------------------------------------------------------------------ QUELLEN
   Hinweis: Endpunkte mit [VERIFY] bitte einmalig gegen die Provider-Doku
   pruefen — Pfade koennen je nach Tier/Version abweichen. Jede Quelle ist
   isoliert: schlaegt eine fehl, laufen die anderen weiter.
   ------------------------------------------------------------------------- */

// FRED — Inflation (T10YIE), WTI (DCOILWTICO), VIX (VIXCLS), VIX3M (VXVCLS). Kostenlos, zuverlaessig.
async function fred(series) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}`
    + `&api_key=${CONFIG.FRED_KEY}&file_type=json&sort_order=desc&limit=15`;
  const j = await getJSON(url);
  if (!j || !j.observations) return null;
  for (const o of j.observations) { if (o.value !== "." && o.value != null) return num(o.value); }
  return null;
}

// alternative.me — Crypto Fear & Greed. Zuverlaessig, kostenlos, kein Key.
async function cryptoFG() {
  const j = await getJSON("https://api.alternative.me/fng/?limit=1");
  return j && j.data && j.data[0] ? num(j.data[0].value) : null;
}

// CNN Fear & Greed — oeffentlicher Endpoint, braucht User-Agent.
async function cnnFG() {
  const j = await getJSON("https://production.dataviz.cnn.io/index/fearandgreed/graphdata");
  return j && j.fear_and_greed ? num(j.fear_and_greed.score) : null;
}

// FMP — VIX & VIX3M (fuer Term-Ratio).
async function fmpQuote(sym) {
  const j = await getJSON(`https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(sym)}?apikey=${CONFIG.FMP_KEY}`);
  return Array.isArray(j) && j[0] ? num(j[0].price) : null;
}

// BGeometrics (Advanced) — MVRV-Z, Puell, Funding via bitcoin-data.com.
// Key in BEIDE gaengige Header (x-api-key UND Authorization: Bearer) -> wird sicher erkannt.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function bgeoOne(slug) {
  const url = `https://api.bitcoin-data.com/v1/${slug}/last`;
  const headers = {
    ...UA.headers,
    "x-api-key": CONFIG.BGEO_KEY,
    "Authorization": "Bearer " + CONFIG.BGEO_KEY
  };
  const j = await getJSON(url, { headers });
  if (!j) return null;
  const rec = Array.isArray(j) ? j[j.length - 1] : j;
  if (!rec || typeof rec !== "object") return null;
  for (const k of Object.keys(rec)) {
    if (["d", "date", "unixTs", "theDay", "time", "timestamp"].includes(k)) continue;
    const v = num(rec[k]);
    if (v !== null) { console.log("  > " + slug + " ok (" + k + " = " + v + ")"); return v; }
  }
  return null;
}

// NAAIM Exposure Index. Quellen-Reihenfolge (jede mit Fallback auf die naechste):
//   1) Nasdaq Data Link (kostenlos, Dataset NAAIM/NAAIM) -> 2-Wochen-MA aus den letzten 2 Prints
//   2) naaim.csv im Ordner (neueste Zeile)
//   3) CONFIG.NAAIM_WEEKLY (manueller Wert)
// Wird NAAIM bei Nasdaq Data Link nicht mehr angeboten/aktualisiert, greifen automatisch 2)/3),
// und das Flag wechselt von "live" auf "lag".
let naaimConf = "pend";

async function naaimFromNDL() {
  if (!CONFIG.NDL_KEY || /DEIN_/.test(String(CONFIG.NDL_KEY))) return null;
  const url = "https://data.nasdaq.com/api/v3/datasets/NAAIM/NAAIM.json?rows=2&api_key=" + CONFIG.NDL_KEY;
  const j = await getJSON(url);
  const ds = j && j.dataset;
  if (!ds || !Array.isArray(ds.data) || ds.data.length < 1) return null;
  // Exposure-Spalte finden (Standard: erste Datenspalte nach dem Datum)
  const cols = (ds.column_names || []).map(c => String(c).toLowerCase());
  let idx = cols.findIndex(c => /number|exposure|naaim|mean|average/.test(c));
  if (idx < 0) idx = 1;
  const vals = ds.data.map(r => num(r[idx])).filter(v => v !== null);
  if (vals.length >= 2) {
    const ma2 = +(((vals[0] + vals[1]) / 2)).toFixed(2);
    console.log("  > NAAIM via Nasdaq Data Link: " + vals[0] + " & " + vals[1] + " -> 2W-MA " + ma2);
    return ma2;
  }
  if (vals.length === 1) { console.log("  > NAAIM via Nasdaq Data Link (nur 1 Wert): " + vals[0]); return +vals[0].toFixed(2); }
  return null;
}

async function naaim() {
  // 1) Nasdaq Data Link
  try {
    const v = await naaimFromNDL();
    if (v !== null) { naaimConf = "live"; return v; }
    console.warn("  ! NAAIM bei Nasdaq Data Link nicht verfuegbar/leer -> Fallback");
  } catch (e) { console.warn("  ! NAAIM (Nasdaq Data Link) Fehler: " + e.message + " -> Fallback"); }
  // 2) naaim.csv
  try {
    if (fs.existsSync("naaim.csv")) {
      const lines = fs.readFileSync("naaim.csv", "utf8").trim().split(/\r?\n/);
      if (lines.length > 1) {
        const head = lines[0].split(/[,;]/).map(s => s.trim().toLowerCase());
        let idx = head.findIndex(h => /naaim\s*number/.test(h));
        if (idx < 0) idx = head.findIndex(h => /mean|average/.test(h));
        if (idx < 0) idx = 1;
        for (let r = 1; r < lines.length; r++) {
          const v = num(lines[r].split(/[,;]/)[idx]);
          if (v !== null) { naaimConf = "lag"; console.log("  > NAAIM aus naaim.csv (" + v + ")"); return v; }
        }
      }
    }
  } catch (e) { console.warn("  ! naaim.csv Lesefehler: " + e.message); }
  // 3) CONFIG-Wochenwert (manueller Fallback — immer vorhanden, wenn gesetzt)
  const w = num(CONFIG.NAAIM_WEEKLY);
  if (w !== null) { naaimConf = "lag"; console.log("  > NAAIM Fallback CONFIG-Wochenwert (" + w + ")"); return w; }
  naaimConf = "pend";
  return null;
}

// Put/Call (Equity) — keine freie Live-API mehr: CBOE-Feed seit 2019 eingestellt,
// Nasdaq/YCharts/MacroMicro nur kostenpflichtig. Daher manueller Wert wie bei NAAIM.
async function putcall() {
  const m = num(CONFIG.PUTCALL_MANUAL);
  if (m !== null) { console.log("  > Put/Call aus CONFIG-Wert (" + m + ")"); return m; }
  console.warn("  ! Put/Call: keine freie Auto-Quelle -> optional CONFIG.PUTCALL_MANUAL setzen (sonst n/a)");
  return null;
}

// Marktbreite-Proxy — RSP/SPY (Gleichgewichtung vs. Index), 1-Monats-Relativstaerke.
// Primaer Yahoo Finance (zuverlaessig, kein Key), Fallback Stooq.
async function yahooCloses(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=3mo&interval=1d`;
  const j = await getJSON(url);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
  if (!q || !q.close) return null;
  const closes = q.close.filter(v => v !== null && v !== undefined);
  return closes.length ? closes : null;
}
async function stooqCloses(sym) {
  const txt = await getText(`https://stooq.com/q/d/l/?s=${sym}&i=d`);
  if (!txt || !/Date,Open/i.test(txt)) return null;
  const closes = [];
  for (const ln of txt.trim().split(/\r?\n/).slice(1)) {
    const close = num(ln.split(",")[4]);
    if (close !== null) closes.push(close);
  }
  return closes.length ? closes : null;
}
async function breadth() {
  let rsp = await yahooCloses("RSP"), spy = await yahooCloses("SPY");
  if (!rsp || !spy) {
    console.warn("  ! Breite: Yahoo leer, versuche Stooq ...");
    rsp = await stooqCloses("rsp.us"); spy = await stooqCloses("spy.us");
  }
  if (!rsp || !spy) { console.warn("  ! Breite: keine Kursdaten (Yahoo+Stooq)"); return null; }
  const n = Math.min(rsp.length, spy.length);
  if (n < 25) { console.warn("  ! Breite: zu wenige Datenpunkte (" + n + ")"); return null; }
  const r = rsp.slice(rsp.length - n), s = spy.slice(spy.length - n);
  const ratioNow = r[n - 1] / s[n - 1];
  const ratioPast = r[n - 1 - 21] / s[n - 1 - 21]; // ~21 Handelstage = 1 Monat
  const pct = ((ratioNow / ratioPast) - 1) * 100;
  console.log("  > Breite RSP/SPY 1M = " + pct.toFixed(2) + "%");
  return +pct.toFixed(2);
}

/* --------------------------------------------------------------- ASSEMBLY */
function flag(v, live = "live") { return v === null ? "pend" : live; }

async function collect() {
  console.log("Hole Live-Werte ...");
  // Quellen ausserhalb BGeometrics parallel (verschiedene Hosts, kein gemeinsames Limit)
  const [breakeven, wti, cfg, cnn, vix, vix3m, na, pc, br] = await Promise.all([
    fred("T10YIE"), fred("DCOILWTICO"), cryptoFG(), cnnFG(),
    fred("VIXCLS"), fred("VXVCLS"),
    naaim(), putcall(), breadth()
  ]);

  // BGeometrics einzeln nacheinander mit Pause (schont das Rate-Limit -> kein 429)
  console.log("Hole BGeometrics (einzeln, mit Pause) ...");
  const mvrv  = await bgeoOne("mvrv-zscore");    await sleep(2500);
  const puell = await bgeoOne("puell-multiple"); await sleep(2500);
  // Funding Rate liegt unter "Derivatives" — Slug-Schreibweise variiert, daher mehrere Varianten:
  let fund = null;
  for (const slug of ["funding-rate", "funding", "btc-funding-rate", "derivatives-funding-rate", "open-interest-funding-rate"]) {
    fund = await bgeoOne(slug);
    if (fund !== null) break;
    await sleep(1800);
  }
  // BGeometrics liefert Funding als Dezimalbruch (z.B. -0.00002582) -> in Prozent umrechnen
  if (fund !== null) fund = +(fund * 100).toFixed(4);

  const vixterm = (vix !== null && vix3m !== null && vix3m !== 0) ? +(vix / vix3m).toFixed(3) : null;

  const LIVE = {
    naaim: na,            naaim_conf: naaimConf,
    putcall: pc,          putcall_conf: flag(pc),
    cnnfg: cnn,           cnnfg_conf: flag(cnn),
    vixterm: vixterm,     vixterm_conf: flag(vixterm),
    mvrv: mvrv,           mvrv_conf: flag(mvrv),
    cryptofg: cfg,        cryptofg_conf: flag(cfg),
    funding: fund,        funding_conf: flag(fund),
    puell: puell,         puell_conf: flag(puell),
    vix: vix,
    breakeven: breakeven, breakeven_conf: flag(breakeven),
    wti: wti,             wti_conf: flag(wti),
    breadth: br,          breadth_conf: flag(br, "est"),
    rotation: null,       rotation_conf: "pend", // kommt aus eurer Engine (§7.2), nicht per API
    concentration: num(CONFIG.CONCENTRATION_MAG7), concentration_conf: "lag", // manuell, langsam veraenderlich
    updated: new Date().toISOString()
  };
  return LIVE;
}

/* -------------------------------------------------- JSON OUTPUT (Weg A) */
// Schreibt live-data.json mit derselben Merge-Logik: eine fehlgeschlagene (null)
// Quelle behaelt ihren letzten guten Wert aus der vorherigen JSON.
function writeJson(LIVE) {
  const out = CONFIG.JSON_OUT;
  const merged = Object.assign({}, LIVE);
  if (fs.existsSync(out)) {
    try {
      const old = JSON.parse(fs.readFileSync(out, "utf8"));
      for (const k in old) {
        if (k.endsWith("_conf") || k === "updated") continue;
        if (merged[k] === null || merged[k] === undefined) {
          if (old[k] !== null && old[k] !== undefined) {
            merged[k] = old[k];
            if (old[k + "_conf"] !== undefined) merged[k + "_conf"] = old[k + "_conf"];
            console.log("  (JSON: behalte letzten Wert fuer " + k + " = " + old[k] + ")");
          }
        }
      }
    } catch (e) { console.warn("  ! alte JSON nicht lesbar (" + e.message + ")"); }
  }
  fs.writeFileSync(out, JSON.stringify(merged, null, 2), "utf8");
  console.log("  > geschrieben: " + out);
}

/* ---------------------------------------------------------------- INJECT */
function inject(file, LIVE) {
  if (!fs.existsSync(file)) { console.warn("  ! Datei fehlt: " + file); return; }
  let html = fs.readFileSync(file, "utf8");
  const re = /\/\* LIVE-DATA-START[\s\S]*?LIVE-DATA-END \*\//;
  if (!re.test(html)) { console.warn("  ! Kein LIVE-DATA-Block in " + file); return; }
  // Merge: neue null-Werte (fehlgeschlagene Quelle) NICHT schreiben -> letzter guter Wert bleibt erhalten
  const merged = Object.assign({}, LIVE);
  const m = html.match(/var LIVE\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m) {
    try {
      const old = (0, eval)("(" + m[1] + ")");
      for (const k in old) {
        if (k.endsWith("_conf") || k === "updated") continue;
        if (merged[k] === null || merged[k] === undefined) {
          if (old[k] !== null && old[k] !== undefined) {
            merged[k] = old[k];
            if (old[k + "_conf"] !== undefined) merged[k + "_conf"] = old[k + "_conf"];
            console.log("  (behalte letzten Wert fuer " + k + " = " + old[k] + ")");
          }
        }
      }
    } catch (e) { console.warn("  ! alte LIVE-Werte nicht lesbar (" + e.message + ")"); }
  }
  const block = "/* LIVE-DATA-START (von update-data.js automatisch ueberschrieben) */\n"
    + "var LIVE = " + JSON.stringify(merged, null, 2) + ";\n"
    + "/* LIVE-DATA-END */";
  html = html.replace(re, block);
  fs.writeFileSync(file, html, "utf8");
  console.log("  > geschrieben: " + file);
}

/* ------------------------------------------------------------------ MAIN */
(async () => {
  const LIVE = await collect();
  console.log("\nErgebnis:");
  Object.keys(LIVE).forEach(k => { if (!k.endsWith("_conf") && k !== "updated")
    console.log("  " + k.padEnd(10) + " = " + (LIVE[k] === null ? "n/a (Quelle pruefen)" : LIVE[k])); });
  console.log("");
  writeJson(LIVE);
  // HTML-Seed nur lokal aktualisieren; im CI (GitHub Actions) bleibt das HTML unberuehrt.
  if (!process.env.CI) CONFIG.FILES.forEach(f => inject(f, LIVE));
  console.log("\nFertig. " + (process.env.CI ? "live-data.json geschrieben (CI)." : "Dashboards neu im Browser oeffnen/neu laden."));
})();
