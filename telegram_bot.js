#!/usr/bin/env node
/*
  MSL Telegram Bot — Command Handler  v1.0  (Node 18+, dependency-frei)

  Empfängt Befehle vom Handy per Telegram getUpdates-Polling (kein Webhook nötig).
  Läuft alle paar Minuten via GitHub Actions.

  Befehle:
    /putcall 0.55     → trägt Put/Call-Wert ein
    /naaim 84.02      → trägt NAAIM-Wert ein
    /mag7 31.5        → trägt Mag-7-Konzentration ein
    /status           → zeigt alle 12 aktuellen Dashboard-Werte
    /help             → zeigt verfügbare Befehle

  Ablauf:
    1. Holt neue Nachrichten via getUpdates (offset = letzte verarbeitete update_id + 1)
    2. Parst Befehle, schreibt Werte in manual_values.json
    3. Bestätigt jede Aktion per Telegram-Antwort
    4. Speichert offset in bot_state.json (verhindert Doppelverarbeitung)

  Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
*/

const fs = require("fs");
const path = require("path");

const CONFIG = {
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TG_CHAT:  process.env.TELEGRAM_CHAT_ID || ""
};

const VALUES_FILE = path.join(__dirname, "manual_values.json");
const STATE_FILE  = path.join(__dirname, "bot_state.json");
const LIVE_FILE   = path.join(__dirname, "live-data.json");

/* ----------------------------------------------------------- Wertdefinitionen */
const SETTABLE = {
  putcall:  { name: "Put/Call Equity Ratio", min: 0.2, max: 3.0,  hint: "z.B. 0.55" },
  naaim:    { name: "NAAIM Exposure Index",  min: 0,   max: 200,  hint: "z.B. 84.02" },
  mag7:     { name: "Mag-7 Konzentration",   min: 15,  max: 65,   hint: "z.B. 31.5", storeKey: "concentration_mag7" }
};

/* ----------------------------------------------------------- Helfer */
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function saveJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function today() { return new Date().toISOString().slice(0, 10); }

/* ----------------------------------------------------------- Telegram API */
async function tgSend(text) {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) { console.warn("Telegram-Secrets fehlen."); return; }
  try {
    await fetch("https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT, text, disable_web_page_preview: true })
    });
  } catch (e) { console.warn("tgSend-Fehler: " + e.message); }
}

async function tgGetUpdates(offset) {
  const url = "https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/getUpdates"
            + "?limit=100"
            + (offset ? "&offset=" + offset : "");
  const r = await fetch(url);
  if (!r.ok) { console.warn("getUpdates HTTP " + r.status); return []; }
  const data = await r.json();
  if (!data.ok) { console.warn("getUpdates API-Fehler: " + JSON.stringify(data).slice(0,200)); return []; }
  console.log("getUpdates lieferte " + data.result.length + " Update(s) (offset-Anfrage: " + (offset||"keiner") + ")");
  return data.result;
}

/* Registriert das Befehlsmenü bei Telegram (erscheint beim Tippen von "/") */
async function tgSetCommands() {
  const commands = [
    { command: "putcall", description: "Put/Call Ratio setzen (z.B. /putcall 0.55)" },
    { command: "naaim",   description: "NAAIM Index setzen (z.B. /naaim 84.02)" },
    { command: "mag7",    description: "Mag-7 Konzentration setzen (z.B. /mag7 31.5)" },
    { command: "status",  description: "Alle 12 Dashboard-Werte anzeigen" },
    { command: "wann",    description: "Bot-Takt: wann war der letzte Lauf?" },
    { command: "help",    description: "Befehlsuebersicht" }
  ];
  try {
    await fetch("https://api.telegram.org/bot" + CONFIG.TG_TOKEN + "/setMyCommands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands })
    });
  } catch (e) { console.warn("setMyCommands-Fehler: " + e.message); }
}

/* ----------------------------------------------------------- Wert setzen */
function setValue(key, rawVal) {
  const def = SETTABLE[key];
  const v = Number(rawVal);
  if (isNaN(v)) return { ok: false, msg: "Kein g\u00fcltiger Wert: \"" + rawVal + "\" (" + def.hint + ")" };
  if (v < def.min || v > def.max) return { ok: false, msg: def.name + ": " + v + " au\u00dferhalb Bereich " + def.min + "\u2013" + def.max };

  const values = loadJson(VALUES_FILE, {});
  const storeKey = def.storeKey || key;
  values[storeKey] = {
    value: v,
    source_url: "telegram",
    value_date: today(),
    fetched_date: today(),
    fetched_at: new Date().toISOString(),
    method: "manual",
    needs_manual: false
  };
  saveJson(VALUES_FILE, values);
  return { ok: true, msg: "\u2705 " + def.name + " = " + v + " eingetragen (" + today() + ").\n\ud83d\udd04 Wird beim n\u00e4chsten Datenpipeline-Lauf ins Dashboard \u00fcbernommen." };
}

/* ----------------------------------------------------------- /status */
function buildStatus() {
  const live = loadJson(LIVE_FILE, null);
  if (!live) return "Live-Daten (live-data.json) noch nicht verf\u00fcgbar.";
  const ALL = [
    ["naaim","NAAIM Exposure"], ["putcall","Put/Call Equity"],
    ["cnnfg","CNN Fear & Greed"], ["cryptofg","Crypto Fear & Greed"],
    ["vixterm","VIX-Term"], ["mvrv","MVRV Z-Score"],
    ["puell","Puell Multiple"], ["funding","BTC Funding"],
    ["breakeven","Inflation 10Y"], ["wti","\u00d6lpreis WTI"],
    ["breadth","Marktbreite RSP/SPY"], ["concentration","Mag-7 Konzentr."]
  ];
  const emoji = { live: "\u2705", lag: "\ud83d\udfe1", alt: "\ud83d\udd34", pend: "\u26ab", est: "\ud83d\udfe0", "sch\u00e4tz": "\ud83d\udfe0" };
  const lines = ["\ud83d\udcca MSL Dashboard \u2014 alle Werte\n"];
  for (const [k, label] of ALL) {
    const val = (live[k] !== null && live[k] !== undefined) ? String(live[k]) : "n/a";
    const conf = live[k + "_conf"] || "pend";
    lines.push((emoji[conf] || "\u2753") + " " + label + ": " + val + " (" + conf + ")");
  }
  lines.push("\nStand: " + (live.updated ? new Date(live.updated).toLocaleString("de-DE") : "?"));
  return lines.join("\n");
}

/* ----------------------------------------------------------- Befehl verarbeiten */
async function handleCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, ""); // /putcall@BotName → /putcall

  if (cmd === "/status") { await tgSend(buildStatus()); return; }

  if (cmd === "/wann" || cmd === "/timer") {
    const st = loadJson(STATE_FILE, {});
    if (!st.last_run) { await tgSend("\u23f1 Noch kein Lauf registriert."); return; }
    const last = new Date(st.last_run);
    const agoMin = Math.round((Date.now() - last.getTime()) / 60000);
    const hist = st.run_intervals || [];
    const avgMin = hist.length ? Math.round(hist.reduce((a,b)=>a+b,0)/hist.length) : 5;
    await tgSend(
      "\u23f1 Bot-Takt\n\n"
      + "Letzter Lauf: vor " + agoMin + " Min\n"
      + "\u00d8 Abstand: ~" + avgMin + " Min (GitHub schwankt)\n\n"
      + "Deine Nachricht wird beim n\u00e4chsten Lauf verarbeitet \u2014 meist innerhalb weniger Minuten."
    );
    return;
  }

  if (cmd === "/help" || cmd === "/start") {
    await tgSend(
      "\ud83e\udd16 MSL Bot \u2014 Befehle\n\n"
      + "WERTE SETZEN (Beispielwert einfach ersetzen):\n\n"
      + "/putcall 0.55\n"
      + "  \u2192 Put/Call Equity Ratio (0.2\u20133.0)\n\n"
      + "/naaim 84.02\n"
      + "  \u2192 NAAIM Exposure Index (0\u2013200)\n\n"
      + "/mag7 31.5\n"
      + "  \u2192 Mag-7 Konzentration % (15\u201365)\n\n"
      + "ABFRAGEN:\n\n"
      + "/status  \u2192 alle 12 Dashboard-Werte\n"
      + "/wann    \u2192 Bot-Takt (letzter Lauf)\n"
      + "/help    \u2192 diese \u00dcbersicht\n\n"
      + "Tipp: Befehl ohne Zahl schicken (z.B. nur /putcall) zeigt den aktuellen Wert."
    );
    return;
  }

  const key = cmd.replace("/", "");
  if (SETTABLE[key]) {
    const def = SETTABLE[key];
    const storeKey = def.storeKey || key;
    if (parts.length < 2) {
      // Kein Wert mitgegeben → aktuellen Wert + Beispiel zeigen
      const values = loadJson(VALUES_FILE, {});
      const cur = values[storeKey];
      const curTxt = cur && cur.value !== null && cur.value !== undefined
        ? "Aktuell: " + cur.value + " (" + (cur.value_date || "?") + ", " + (cur.method || "?") + ")"
        : "Aktuell: kein Wert gesetzt";
      await tgSend(
        def.name + "\n" + curTxt + "\n\n"
        + "Neuen Wert setzen:  " + cmd + " " + def.hint + "\n"
        + "Bereich: " + def.min + "\u2013" + def.max
      );
      return;
    }
    const result = setValue(key, parts[1]);
    await tgSend(result.msg);
    return;
  }

  // Unbekannter Befehl — nur reagieren wenn es wie ein Befehl aussieht
  if (cmd.startsWith("/")) await tgSend("Unbekannter Befehl. /help zeigt alle Befehle.");
}

/* ----------------------------------------------------------- Hauptlauf */
(async () => {
  if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT) { console.error("Secrets fehlen."); process.exit(0); }

  const state = loadJson(STATE_FILE, { offset: 0 });

  // Befehlsmenü registrieren (bei neuer Befehlsversion neu setzen)
  const CMD_VERSION = 2;
  if (state.commands_version !== CMD_VERSION) {
    await tgSetCommands();
    state.commands_version = CMD_VERSION;
    console.log("Telegram-Befehlsmen\u00fc registriert (v" + CMD_VERSION + ").");
  }

  // Tatsächlichen Abstand zum letzten Lauf tracken (für /wann-Schätzung)
  const nowMs = Date.now();
  if (state.last_run) {
    const gap = Math.round((nowMs - new Date(state.last_run).getTime()) / 60000);
    if (gap > 0 && gap < 120) { // Ausreißer >2h ignorieren
      state.run_intervals = (state.run_intervals || []).concat(gap).slice(-10); // letzte 10
    }
  }

  const updates = await tgGetUpdates(state.offset ? state.offset + 1 : 0);

  if (updates.length === 0) {
    state.last_run = new Date().toISOString();
    saveJson(STATE_FILE, state);
    console.log("Keine neuen Nachrichten. (offset bleibt " + (state.offset||0) + ")");
    return;
  }

  let processed = 0, maxUpdateId = state.offset || 0;
  for (const u of updates) {
    maxUpdateId = Math.max(maxUpdateId, u.update_id);
    const msg = u.message;
    if (!msg || !msg.text) continue;

    // Sicherheit: nur auf autorisierten Chat reagieren
    if (String(msg.chat.id) !== String(CONFIG.TG_CHAT)) {
      console.warn("Nachricht von fremdem Chat " + msg.chat.id + " ignoriert.");
      continue;
    }
    if (!msg.text.startsWith("/")) continue; // nur Befehle

    console.log("Befehl: " + msg.text);
    await handleCommand(msg.text);
    processed++;
  }

  state.offset = maxUpdateId;
  state.last_run = new Date().toISOString();
  saveJson(STATE_FILE, state);
  console.log("Fertig. " + processed + " Befehl(e) verarbeitet, offset=" + maxUpdateId);
})().catch(e => { console.error("Bot-Fehler:", e.message); process.exit(1); });
