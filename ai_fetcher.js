#!/usr/bin/env node
/*
  MSL AI Fetcher — v1.0  (dependency-frei, Node 18+)
  Zieht NAAIM, Put/Call und Mag-7-Konzentration automatisch via Claude + Web Search.

  Ablauf: Claude API mit Web Search → Validierung → manual_values.json
          → Telegram Report (Wert + Quelle zum kurzen Gegenchecken)
          → bei Fehler: needs_manual=true → reminders.js erinnert täglich

  Secrets: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
*/

const fs   = require("fs");
const path = require("path");

const OUT        = path.join(__dirname, "output");
const VALUES_FILE = path.join(__dirname, "manual_values.json");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const CONFIG = {
  ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY || "",
  TG_TOKEN:      process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT:       process.env.TELEGRAM_CHAT_ID || "",
  MODEL:         "claude-sonnet-4-6"
};

/* ----------------------------------------------------------- Fetch-Targets */
const TARGETS = [
  {
    id:       "naaim",
    name:     "NAAIM Exposure Index",
    schedule: "wednesday",
    maxAgeDays: 9,
    validate: v => typeof v === "number" && v >= 0 && v <= 200,
    hint:     "Normalbereich: 0–200, typisch 40–100",
    prompt:
      "Search the web for the latest NAAIM Exposure Index weekly reading. " +
      "The NAAIM Exposure Index is published every Wednesday by the National Association of Active Investment Managers. " +
      "Look on ycharts.com, naaim.org, isabelnet.com, or macromicro.me. " +
      "Find the most recent Wednesday value. " +
      "Reply with ONLY this JSON (no markdown, no explanation): " +
      '{"value": <number between 0 and 200>, "source": "<website domain>", "date": "<YYYY-MM-DD of the reading>"}' +
      " or if not found: " +
      '{"value": null, "error": "not found"}'
  },
  {
    id:       "putcall",
    name:     "Put/Call Equity Ratio (CBOE $CPCE)",
    schedule: "weekday",
    maxAgeDays: 3,
    validate: v => typeof v === "number" && v >= 0.2 && v <= 3.0,
    hint:     "Normalbereich: 0.4–1.2",
    prompt:
      "Search the web for the latest CBOE Equity Put/Call Ratio ($CPCE). " +
      "This is the equity-only (not total) put/call ratio published daily by the CBOE. " +
      "Check stockcharts.com, barchart.com, or cboe.com. " +
      "Reply with ONLY this JSON (no markdown, no explanation): " +
      '{"value": <number like 0.61>, "source": "<website domain>", "date": "<YYYY-MM-DD>"}' +
      " or if not found: " +
      '{"value": null, "error": "not found"}'
  },
  {
    id:       "concentration_mag7",
    name:     "Mag-7 Konzentration im S&P 500",
    schedule: "monthly",
    maxAgeDays: 35,
    validate: v => typeof v === "number" && v >= 15 && v <= 65,
    hint:     "Summe der 7 Gewichte in Prozent, z.B. 33.8",
    prompt:
      "Search the web for the current combined weight percentage of the Magnificent 7 stocks " +
      "(Apple AAPL, Microsoft MSFT, Nvidia NVDA, Amazon AMZN, Meta META, Alphabet GOOGL/GOOG, Tesla TSLA) " +
      "in the S&P 500 index. " +
      "Check slickcharts.com/sp500 — find all 7 and add their percentages. " +
      "Reply with ONLY this JSON (no markdown, no explanation): " +
      '{"value": <total percentage like 33.8>, "source": "<website domain>", "date": "<YYYY-MM-DD>"}' +
      " or if not found: " +
      '{"value": null, "error": "not found"}'
  }
];

/* ----------------------------------------------------------- Helfer */
function fmtDate(d) { return d.toISOString().slice(0, 10); }

function shouldRun(target, now, existing) {
  const dow = now.getUTCDay(); // 0=Sun,1=Mon,...,3=Wed,...,5=Fri
  if (target.schedule === "wednesday" && dow !== 3) return false;
  if (target.schedule === "weekday"   && (dow === 0 || dow === 6)) return false;
  if (target.schedule === "monthly"   && now.getUTCDate() !== 1) return false;
  // Nicht doppelt am selben Tag laufen
  const e = existing[target.id];
  if (e && e.fetched_date === fmtDate(now) && e.value !== null) {
    console.log("  skip (heute schon erfolgreich geholt): " + target.id);
    return false;
  }
  return true;
}

function loadValues() { try { return JSON.parse(fs.readFileSync(VALUES_FILE, "utf8")); } catch { return {}; } }
function saveValues(v) { fs.writeFileSync(VALUES_FILE, JSON.stringify(v, null, 2)); }

/* ----------------------------------------------------------- Claude API */
async function fetchWithClaude(target) {
  if (!CONFIG.ANTHROPIC_KEY) { console.warn("  ! ANTHROPIC_API_KEY fehlt."); return null; }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        max_tokens: 300,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: target.prompt }]
      })
    });
    if (!r.ok) { console.warn("  ! Claude API HTTP " + r.status); return null; }
    const data = await r.json();
    // Alle Text-Blöcke zusammensetzen
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    if (!text) { console.warn("  ! Kein Text in Claude-Antwort."); return null; }
    // JSON sauber extrahieren (Code-Fences entfernen)
    const clean = text.replace(/```json|```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) { console.warn("  ! Kein JSON gefunden in: " + text.slice(0, 120)); return null; }
    const obj = JSON.parse(match[0]);
    return obj;
  } catch (e) { console.warn("  ! Claude-Fehler (" + target.id + "): " + e.message); return null; }
}

/* ----------------------------------------------------------- Validierung */
function validate(target, result) {
  if (!result || result.value === null || result.value === undefined) {
    return { ok: false, reason: result && result.error ? result.error : "kein Wert" };
  }
  const v = Number(result.value);
  if (isNaN(v)) return { ok: false, reason: "kein numerischer Wert: " + result.value };
  if (!target.validate(v)) return { ok: false, reason: "Plausibilitätsfehler (" + target.hint + "): " + v };
  return { ok: true, value: v, source: String(result.source || ""), date: String(result.date || "") };
}

/* ----------------------------------------------------------- Telegram */
async function sendTelegram(text) {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) return;
  try {
    const r = await fetch("https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT, text, disable_web_page_preview: true })
    });
    if (!r.ok) { const b = await r.text(); console.warn("  ! Telegram " + r.status + ": " + b.slice(0, 100)); }
  } catch (e) { console.warn("  ! Telegram-Fehler: " + e.message); }
}

/* ----------------------------------------------------------- Hauptlauf */
(async () => {
  const now    = new Date();
  const today  = fmtDate(now);
  const values = loadValues();
  console.log("MSL AI Fetcher — " + now.toISOString());

  const successes = [], failures = [];

  for (const target of TARGETS) {
    if (!shouldRun(target, now, values)) continue;
    console.log("  > Hole: " + target.name);

    const raw    = await fetchWithClaude(target);
    const check  = validate(target, raw);

    if (check.ok) {
      values[target.id] = {
        value:        check.value,
        source_url:   check.source,
        value_date:   check.date || today,
        fetched_date: today,
        fetched_at:   now.toISOString(),
        method:       "ai",
        needs_manual: false
      };
      successes.push({ target, val: check.value, source: check.source, date: check.date });
      console.log("    ✅ " + target.name + " = " + check.value + " (Quelle: " + check.source + ", Datum: " + check.date + ")");
    } else {
      values[target.id] = Object.assign({}, values[target.id] || {}, {
        fetched_date: today, method: "ai_failed", needs_manual: true,
        last_fail_reason: check.reason, last_fail_at: now.toISOString()
      });
      failures.push({ target, reason: check.reason });
      console.warn("    ❌ " + target.name + ": " + check.reason);
    }

    // Kurze Pause zwischen Claude-Aufrufen
    await new Promise(r => setTimeout(r, 2000));
  }

  saveValues(values);

  // Telegram-Report: Erfolge
  if (successes.length > 0) {
    const lines = ["MSL Auto-Update — bitte kurz prüfen ✅\n"];
    for (const s of successes) {
      lines.push("• " + s.target.name + ": " + s.val);
      if (s.source) lines.push("  Quelle: " + s.source + (s.date ? " (" + s.date + ")" : ""));
    }
    lines.push("\nDiese Werte wurden automatisch in manual_values.json eingetragen.");
    lines.push("Wenn ein Wert nicht stimmt: Correct-Wert als Secret eintragen und Run Workflow starten.");
    await sendTelegram(lines.join("\n"));
  }

  // Telegram-Report: Fehler (Erinnerung kommt täglich via reminders.js)
  if (failures.length > 0) {
    const lines = ["MSL Auto-Update — Abruf fehlgeschlagen ⚠️\n"];
    for (const f of failures) lines.push("• " + f.target.name + ": " + f.reason);
    lines.push("\nDu erhältst täglich eine Erinnerung bis die Werte manuell eingetragen sind.");
    await sendTelegram(lines.join("\n"));
  }

  if (successes.length === 0 && failures.length === 0) {
    console.log("Heute kein Abruf geplant (Zeitplan passt nicht).");
  } else {
    console.log("Fertig. ✅ " + successes.length + " erfolgreich, ❌ " + failures.length + " fehlgeschlagen.");
  }
})().catch(e => { console.error("AI-Fetcher-Fehler:", e.message); process.exit(1); });
