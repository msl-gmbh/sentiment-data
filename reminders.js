#!/usr/bin/env node
/*
  MSL Reminder Engine — v1.0  (dependency-frei, Node 18+)
  Schickt Telegram-(und optional Email-)Erinnerungen fuer manuelle Pflege-Aufgaben.
  Laeuft taeglich via GitHub Actions. Dedup ueber output/reminder_state.json.

  Secrets (GitHub):
    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   (Pflicht)
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_TO  (optional, fuer Email)
*/

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUT        = path.join(__dirname, "output");
const STATE_FILE = path.join(OUT, "reminder_state.json");
const LIVE_FILE  = path.join(__dirname, "live-data.json");

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ----------------------------------------------------------- Helfer */
function fmtDate(d) { return d.toISOString().slice(0, 10); }

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
}

function periodKey(rule, now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (rule.period) {
    case "year":    return "year:" + y;
    case "month":   return "month:" + y + "-" + String(m + 1).padStart(2, "0");
    case "quarter": return "quarter:" + y + "-Q" + (Math.floor(m / 3) + 1);
    case "week":    return "week:" + y + "-W" + String(isoWeek(now)).padStart(2, "0");
    default:        return "once:" + rule.period; // z.B. "once:naaim_2026"
  }
}

function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadLive() {
  try { return JSON.parse(fs.readFileSync(LIVE_FILE, "utf8")); } catch { return null; }
}

function loadManualValues() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "manual_values.json"), "utf8")); } catch { return {}; } }

/* ----------------------------------------------------------- Regeln */
const RULES = [
  {
    id: "annual_calendar",
    period: "year",
    title: "📅 JÄHRLICH: Kalendertermine aktualisieren",
    body: [
      "Die Kalenderdatei calendar_events.json muss mit den neuen Fed/EZB/MSCI-Terminen befüllt werden.",
      "",
      "📌 Quellen:",
      "  • Fed FOMC: federalreserve.gov/monetarypolicy/fomccalendars.htm",
      "  • EZB: ecb.europa.eu/press/calendars",
      "  • MSCI Rebalancing: msci.com (Quartalsende Feb/Mai/Aug/Nov)",
      "",
      "💡 Tipp: Schreib mir einfach 'Kalendertermine für 2027 aufbereiten' — ich mache das in 2 Minuten."
    ].join("\n"),
    check: (now) => now.getUTCMonth() === 0 && now.getUTCDate() >= 1 && now.getUTCDate() <= 7
  },
  {
    id: "monthly_concentration",
    period: "month",
    title: "📊 MONATLICH: Mag-7 Konzentration aktualisieren",
    body: [
      "Bitte CONCENTRATION_MAG7 Secret prüfen und ggf. aktualisieren.",
      "",
      "📌 Quelle: slickcharts.com/sp500 → Top-7 Gewichte (Apple, Microsoft, Nvidia, Amazon, Meta, Alphabet, Tesla) summieren.",
      "⏱ Ändert sich langsam — 5 Minuten Aufwand.",
      "🔧 GitHub: Settings → Secrets → CONCENTRATION_MAG7"
    ].join("\n"),
    check: (now) => now.getUTCDate() === 1
  },
  {
    id: "quarterly_putcall",
    period: "quarter",
    title: "📉 QUARTALSWEISE: Put/Call Ratio prüfen",
    body: [
      "Optional: PUTCALL_MANUAL Secret mit aktuellem Wert aktualisieren.",
      "",
      "📌 Quelle: stockcharts.com → Symbol $CPCE (Equity Put/Call Ratio) ODER barchart.com.",
      "ℹ️ Dieser Wert ist optional — bei n/a im Dashboard kein Problem.",
      "🔧 GitHub: Settings → Secrets → PUTCALL_MANUAL"
    ].join("\n"),
    check: (now) => now.getUTCDate() === 1 && [0, 3, 6, 9].includes(now.getUTCMonth())
  },
  {
    id: "naaim_paid_warning",
    period: "naaim_paid_2026",  // einmalig
    title: "⚠️ ACHTUNG: NAAIM wird kostenpflichtig ab 01.08.2026",
    body: [
      "naaim.org stellt ab 01.08.2026 auf kostenpflichtigen Zugang um.",
      "",
      "📌 Was zu prüfen ist:",
      "  1. Läuft Nasdaq Data Link (NDL) noch kostenlos? → Im nächsten Radar-Log prüfen: steht 'LIVE' oder 'LAG' beim NAAIM-Wert?",
      "  2. Falls LAG/PEND: Manuell mittwochs aktualisieren (NAAIM_WEEKLY Secret) ODER NDL-Paid-Plan prüfen (~$29/Monat).",
      "",
      "💡 Schreib mir wenn der Badge auf LAG fällt — ich helfe dir mit dem Setup."
    ].join("\n"),
    check: (now) => {
      const d = fmtDate(now);
      return d >= "2026-07-15" && d <= "2026-07-31";
    }
  },
  {
    id: "naaim_health",
    period: "week",
    title: "⚠️ NAAIM: Automatischer Abruf fehlgeschlagen",
    body: [
      "Der NAAIM-Wert wird nicht automatisch gezogen (Badge ist LAG, ALT oder PEND).",
      "",
      "📌 Bitte manuell aktualisieren:",
      "  1. naaim.org → Mittwochs-Wert ablesen",
      "  2. GitHub: Settings → Secrets → NAAIM_WEEKLY → neuen Wert eintragen",
      "",
      "🔍 Oder: Nasdaq-Data-Link-Key (NDL_KEY Secret) prüfen — möglicherweise abgelaufen."
    ].join("\n"),
    check: (now, live) => {
      const isWed = now.getUTCDay() === 3;
      const naaimBad = live && ["lag", "alt", "pend"].includes(String(live.naaim_conf));
      return isWed && naaimBad;
    }
  },
  {
    id: "btcdata_api_health",
    period: "week",
    title: "🔴 bitcoin-data.com API ausgefallen",
    body: [
      "MVRV, Puell Multiple UND Funding Rate zeigen alle ALT oder PEND.",
      "Das deutet auf einen Ausfall des bitcoin-data.com API-Keys hin.",
      "",
      "📌 Bitte prüfen:",
      "  1. api.bitcoin-data.com → Key noch aktiv? Abo verlängert?",
      "  2. GitHub Secret BGEO_KEY aktuell?",
      "  3. Ggf. Key rotieren und als Secret neu eintragen.",
      "",
      "Solange der Key nicht funktioniert, fehlen alle On-Chain-Indikatoren im Dashboard."
    ].join("\n"),
    check: (now, live) => {
      if (!live) return false;
      const bad = v => ["alt","pend"].includes(String(v));
      return bad(live.mvrv_conf) && bad(live.puell_conf) && bad(live.funding_conf);
    }
  },
  {
    id: "weekly_status",
    period: "week",
    title: "📋 WÖCHENTLICH: Status manuelle Werte",
    body: null, // wird dynamisch gebaut
    check: (now) => now.getUTCDay() === 1, // Montags
    dynamic: true
  }
];

/* ----------------------------------------------------------- Status-Report (dynamisch) */
function buildStatusReport(live) {
  if (!live) return "Live-Daten nicht verfügbar (live-data.json fehlt).";
  const ALL = [
    { key: "naaim",         label: "NAAIM Exposure Index" },
    { key: "putcall",       label: "Put/Call Equity" },
    { key: "cnnfg",         label: "CNN Fear & Greed" },
    { key: "cryptofg",      label: "Crypto Fear & Greed" },
    { key: "vixterm",       label: "VIX-Term (VIX/VIX3M)" },
    { key: "mvrv",          label: "MVRV Z-Score" },
    { key: "puell",         label: "Puell Multiple" },
    { key: "funding",       label: "BTC Funding Rate" },
    { key: "breakeven",     label: "Inflation (10Y Break-even)" },
    { key: "wti",           label: "Ölpreis WTI" },
    { key: "breadth",       label: "Marktbreite (RSP/SPY)" },
    { key: "concentration", label: "Mag-7 Konzentration" }
  ];
  const emoji = { live: "✅", lag: "🟡", alt: "🔴", pend: "⚫", schätz: "🟠", est: "🟠", demo: "⚪" };
  const lines = ["📊 Wöchentlicher Datenstatus — " + new Date().toISOString().slice(0,10) + "\n"];
  let problems = 0;
  for (const f of ALL) {
    const conf = live[f.key + "_conf"] || "pend";
    const val  = live[f.key] !== null && live[f.key] !== undefined ? String(live[f.key]) : "n/a";
    const ts   = live[f.key + "_ts"];
    const age  = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 86400000) + "T" : "?";
    const e    = emoji[conf] || "❓";
    if (["alt","pend"].includes(conf)) problems++;
    lines.push(e + " " + f.label + ": " + val + " (" + conf + ", " + age + " alt)");
  }
  lines.push("\nLegende: ✅ LIVE  🟡 Manuell  🔴 Veraltet  ⚫ Fehlt  🟠 Schätz");
  if (problems > 0) lines.push("\n⚠️ " + problems + " Wert(e) veraltet/fehlend — bitte prüfen.");
  else lines.push("\n✅ Alle Werte aktuell.");
  return lines.join("\n");
}

/* ----------------------------------------------------------- Telegram */
async function sendTelegram(title, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.warn("  ! Telegram-Secrets fehlen."); return false; }
  const text = "MSL Erinnerung\n\n" + title + "\n\n" + body;
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
    });
    if (!r.ok) { const b = await r.text(); console.warn("  ! Telegram HTTP " + r.status + " — " + b.slice(0, 120)); return false; }
    return true;
  } catch (e) { console.warn("  ! Telegram-Fehler: " + e.message); return false; }
}

/* ----------------------------------------------------------- Email (optional, via curl SMTP) */
function sendEmail(title, body) {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || "587";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to   = process.env.SMTP_TO || user;
  if (!host || !user || !pass) return false;
  try {
    const msg = [
      "From: " + user,
      "To: " + to,
      "Subject: MSL Erinnerung: " + title,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "MSL Erinnerung\n\n" + title + "\n\n" + body
    ].join("\r\n");
    const tmpFile = "/tmp/msl_reminder_mail.txt";
    fs.writeFileSync(tmpFile, msg);
    execSync(
      "curl -s --ssl-reqd --url 'smtp://" + host + ":" + port +
      "' --user '" + user + ":" + pass +
      "' --mail-from '" + user +
      "' --mail-rcpt '" + to +
      "' --upload-file " + tmpFile,
      { timeout: 15000 }
    );
    console.log("  > Email gesendet an " + to);
    return true;
  } catch (e) { console.warn("  ! Email-Fehler: " + e.message); return false; }
}

/* ----------------------------------------------------------- Hauptlauf */
(async () => {
  const now  = new Date();
  const live = loadLive();
  const state = loadState();
  console.log("MSL Reminder Engine — " + now.toISOString());

  let sent = 0;
  for (const rule of RULES) {
    const pk    = periodKey(rule, now);
    const key   = rule.id + ":" + pk;
    const fired = state[key] && state[key].sent;

    if (fired) { console.log("  skip (bereits gesendet): " + rule.id + " [" + pk + "]"); continue; }

    const active = rule.check(now, live);
    if (!active) continue;

    // dynamischer Body fuer Status-Report
    const body = rule.dynamic ? buildStatusReport(live) : rule.body;

    console.log("  > Sende: " + rule.id + " [" + pk + "]");
    const tgOk    = await sendTelegram(rule.title, body);
    const mailOk  = sendEmail(rule.title, body);

    // Nur als gesendet markieren wenn Telegram geklappt (Pflichtkanal)
    if (tgOk) {
      state[key] = { sent: true, sent_at: now.toISOString(), telegram: tgOk, email: mailOk };
      sent++;
    } else {
      console.warn("  ! Nicht als gesendet markiert (Telegram fehlgeschlagen) — Retry beim naechsten Lauf.");
    }
  }

  saveState(state);

  /* --- Tägliche Erinnerungen für needs_manual=true (Wert fehlt nach KI-Abruf) --- */
  const manual = loadManualValues();
  const PENDING_TARGETS = [
    { id: "naaim",             name: "NAAIM Exposure Index",
      tip: "naaim.org (Mittwochs-Wert) → Secret NAAIM_WEEKLY oder manual_values.json" },
    { id: "putcall",           name: "Put/Call Ratio ($CPCE)",
      tip: "stockcharts.com → Symbol $CPCE → Secret PUTCALL_MANUAL oder manual_values.json" },
    { id: "concentration_mag7",name: "Mag-7 Konzentration",
      tip: "slickcharts.com/sp500 → Top-7 summieren → Secret CONCENTRATION_MAG7 oder manual_values.json" }
  ];
  const pending = PENDING_TARGETS.filter(t => manual[t.id] && manual[t.id].needs_manual === true);
  if (pending.length > 0) {
    const today  = fmtDate(now);
    const pKey   = "daily_pending:" + today;
    const alreadySent = state[pKey] && state[pKey].sent;
    if (!alreadySent) {
      const lines = ["⚠️ MANUELLE EINGABE ERFORDERLICH\n"];
      lines.push("Der automatische Abruf ist fehlgeschlagen. Bitte heute eintragen:\n");
      for (const t of pending) { lines.push("• " + t.name); lines.push("  " + t.tip); }
      lines.push("\nIch erinnere täglich bis alle Werte aktuell sind.");
      const ok = await sendTelegram("⚠️ Manuelle Werte fehlen", lines.join("\n"));
      if (ok) { state[pKey] = { sent: true, sent_at: now.toISOString() }; sent++; }
    }
  }

  saveState(state);
  console.log("Fertig. " + sent + " Erinnerung(en) gesendet.");
})().catch(e => { console.error("Reminder-Fehler:", e.message); process.exit(1); });
