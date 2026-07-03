#!/usr/bin/env node
/**
 * SARAH — X/TIKTOK ENGAGEMENT-WORKER (öffentlicher Mirror, KEINE Secrets).
 * ===========================================================================
 * Der unbeaufsichtigte Browser-Teil des Engagements für die zwei Kanäle, die
 * Zernios Inbox-API NICHT abdeckt: X (@GOTT_WALD) und TikTok (@gott_wald).
 * Läuft per systemd-Timer auf server-2 (2x täglich), steuert einen headless
 * Chromium (Playwright) mit dauerhaft gespeicherter Login-Sitzung.
 *
 * Was er tut (aus dem Slash-Command /x-tiktok-engagement abgeleitet):
 *   1) EINGEHEND: Mentions/Antworten an uns lesen → im Holding-Ton beantworten.
 *   2) AUSGEHEND: zu Kernthemen suchen → gezielt liken / kommentieren / folgen.
 * Ton + Grenzen kommen aus engagement_config (Supabase). Alles wandert ins
 * Audit-Log (engagement_aktionen); jede Runde nach engagement_runden.
 *
 * SICHERHEIT / GOVERNANCE:
 *   - NOT-AUS:  engagement_config.auto_aktiv=false  → Worker macht sofort nichts.
 *   - MODUS:    'probe'  → liest+entwirft+protokolliert, klickt NICHTS (Default,
 *                          für den sicheren ersten Lauf mit ungetesteten Selektoren).
 *               'scharf' → Aktionen gehen automatisch raus (Full-Auto).
 *   - LIMITS:   pro Runde Likes/Antworten/Kommentare/Follows gedeckelt;
 *               menschliche Pausen (15–60 s); max. Runden/Tag/Plattform.
 *   - STOPP:    Bei Login-Wall / CAPTCHA / "unusual activity" / Verifizierung wird
 *               die Plattform SOFORT gestoppt, eine Warnung geschrieben — NICHTS
 *               wird umgangen, kein Login, kein CAPTCHA-Lösen.
 *   - Session-Cookies liegen NUR auf der Box (ENGAGEMENT_STATE_DIR), nie im Repo.
 *
 * Aufruf:  node engagement-worker.mjs [x|tiktok|beide]
 *   Default: beide.  ENGAGEMENT_DRYRUN=1 erzwingt Probe-Modus unabhängig von DB.
 */
import "./load-env.mjs"; // MUSS zuerst stehen: lädt ~/worker/.env in process.env
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const MODELL = (process.env.ENGAGEMENT_MODELL || "claude-sonnet-4-6").trim();
const BESITZER = (process.env.ENGAGEMENT_BESITZER || "ffff7804-aacb-4bc2-8414-e254241ac98e").trim();
const STATE_DIR = process.env.ENGAGEMENT_STATE_DIR || path.join(HIER, "state");
const HEADFUL = process.env.ENGAGEMENT_HEADFUL === "1";
const DRYRUN_ENV = process.env.ENGAGEMENT_DRYRUN === "1";

if (!SB_URL || !SB_KEY) { console.error("[eng] FEHLT: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (siehe .env.example)."); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("[eng] FEHLT: ANTHROPIC_API_KEY (für die KI-Antwortentwürfe)."); process.exit(1); }

const H = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };
const log = (...a) => console.log("[eng]", ...a);

// --- Supabase REST -----------------------------------------------------------
async function sb(pfad, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pfad}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`REST ${pfad} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const txt = await r.text();           // 201/204 ohne Prefer=representation liefern leeren Body
  return txt ? JSON.parse(txt) : null;
}
async function ladeConfig() {
  const rows = await sb(`engagement_config?besitzer=eq.${BESITZER}&select=*&limit=1`);
  return rows?.[0] || null;
}
async function setzeConfig(patch) {
  await sb(`engagement_config?besitzer=eq.${BESITZER}`, {
    method: "PATCH", body: JSON.stringify({ ...patch, aktualisiert_am: new Date().toISOString() }),
  });
}
async function startRunde(plattform) {
  const rows = await sb(`engagement_runden`, {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ besitzer: BESITZER, plattform, status: "laeuft" }),
  });
  return rows[0];
}
async function endeRunde(id, patch) {
  await sb(`engagement_runden?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ beendet_am: new Date().toISOString(), ...patch }) });
}
async function audit(row) {
  try {
    await sb(`engagement_aktionen`, { method: "POST", body: JSON.stringify({ besitzer: BESITZER, ...row }) });
  } catch (e) { log("Audit-Schreibfehler:", e.message); }
}
async function laeufeHeute(plattform) {
  const seit = new Date(); seit.setHours(0, 0, 0, 0);
  const rows = await sb(`engagement_runden?besitzer=eq.${BESITZER}&plattform=eq.${plattform}&gestartet_am=gte.${seit.toISOString()}&status=in.(fertig,gestoppt)&select=id`);
  return rows?.length || 0;
}

// --- Anthropic: Antwort/Kommentar im Holding-Ton entwerfen -------------------
const TON = `Du schreibst für die GOTT WALD Holding (Gründer Mathias Gottwald), Gesicht ist die KI-Eule YIG.
Stimme: kraftvoll, werteorientiert, sehr persönlich, KURZE ruhige Sätze, souverän, hochwertig, menschlich — kein Marktgeschrei, keine Emoji-Flut.
Leitstern: PEACE · LOVE · HARMONY · FOR MORE HUMANITY; Werte Natur · Tier · Mensch.
Regeln: Substanz statt Spam (nie "Nice 🔥"). Nie Politik/Religion-Streit, keine Heilversprechen, keine Verkaufs-DMs, keine Links außer gefragt.
Antworte in der Sprache des Gegenübers (sonst Deutsch). Maximal 1–2 Sätze, passend für ${"${plattform}"}.`;

async function entwirf(plattform, aufgabe, kontext) {
  const body = {
    model: MODELL, max_tokens: 300,
    system: TON.replace("${plattform}", plattform === "x" ? "einen X-Post (≤280 Zeichen)" : "einen TikTok-Kommentar (kurz)"),
    messages: [{ role: "user", content: `${aufgabe}\n\nKontext (fremder Beitrag):\n"""${(kontext || "").slice(0, 1200)}"""\n\nGib NUR den fertigen Antworttext zurück, ohne Anführungszeichen, ohne Vorrede.` }],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  return (j.content?.map((c) => c.text).join("").trim() || "").replace(/^["'\s]+|["'\s]+$/g, "");
}

// --- Hilfen ------------------------------------------------------------------
const schlaf = (ms) => new Promise((res) => setTimeout(res, ms));
function menschPause(cfg) {
  const lo = Number(cfg.limits?.pause_min_sek ?? 15), hi = Number(cfg.limits?.pause_max_sek ?? 60);
  return schlaf((lo + Math.random() * Math.max(1, hi - lo)) * 1000);
}
function stateFile(plattform) { return path.join(STATE_DIR, `${plattform}-state.json`); }

/** Erkennt Sperr-/Sicherheits-Situationen im Seiteninhalt → sofort stoppen. */
function istSicherheitsWand(text = "") {
  const t = text.toLowerCase();
  return /captcha|verify|verification|unusual activity|suspicious|are you a robot|bestätige|sicherheitsüberprüfung|log in to|sign up|create account|einloggen|anmelden, um/.test(t);
}

// --- Plattform-Adapter (defensive, best-effort Selektoren) ------------------
// X nutzt stabile data-testid; TikTok data-e2e (schwächer). Alle Aktionen sind
// einzeln in try/catch — ein kaputter Selektor bricht NIE die ganze Runde.
const ADAPTER = {
  x: {
    home: "https://x.com/home",
    mentions: "https://x.com/notifications/mentions",
    suche: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
    async eingeloggt(page) {
      await page.goto(this.home, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await schlaf(3000);
      if (/\/login|\/i\/flow\/login/.test(page.url())) return false;
      return (await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]').count()) > 0;
    },
    async karten(page) { return page.locator('article[data-testid="tweet"]'); },
    async kartenText(karte) { return (await karte.locator('[data-testid="tweetText"]').first().innerText().catch(() => "")) || ""; },
    async kartenHandle(karte) {
      const t = await karte.locator('[data-testid="User-Name"]').first().innerText().catch(() => "");
      const m = t.match(/@[\w]+/); return m ? m[0] : "";
    },
    async like(karte) { const b = karte.locator('[data-testid="like"]').first(); if (!(await b.count())) return false; await b.click({ timeout: 8000 }); return true; },
    async antworte(page, karte, text) {
      await karte.locator('[data-testid="reply"]').first().click({ timeout: 8000 });
      const box = page.locator('[data-testid="tweetTextarea_0"]');
      await box.waitFor({ timeout: 8000 }); await box.fill(text);
      await page.locator('[data-testid="tweetButton"]').first().click({ timeout: 8000 });
      await schlaf(2500); return true;
    },
    async folge(karte) {
      const b = karte.locator('[data-testid$="-follow"]').first();
      if (!(await b.count())) return false; await b.click({ timeout: 8000 }); return true;
    },
  },
  tiktok: {
    home: "https://www.tiktok.com/foryou",
    mentions: "https://www.tiktok.com/notifications",
    suche: (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
    async eingeloggt(page) {
      // WICHTIG: /foryou prüfen (Root zeigt die Nav-Signale nicht zuverlässig).
      await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await schlaf(5000);
      const ein = await page.locator('[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="upload-icon"]').count();
      const loginBtn = await page.locator('[data-e2e="top-login-button"], [data-e2e="nav-login"]').count();
      return ein > 0 && loginBtn === 0;
    },
    async karten(page) { return page.locator('[data-e2e="search_top-item"], [data-e2e="search-card-video-caption"]'); },
    async kartenText(karte) { return (await karte.innerText().catch(() => "")) || ""; },
    async kartenHandle(karte) {
      const t = await karte.locator('[data-e2e="search-card-user-unique-id"]').first().innerText().catch(() => "");
      return t ? "@" + t.replace(/^@/, "") : "";
    },
    async like(karte) { const b = karte.locator('[data-e2e="like-icon"]').first(); if (!(await b.count())) return false; await b.click({ timeout: 8000 }); return true; },
    async antworte() { return false; }, // TikTok-Kommentieren nur im Video-Overlay (unten separat, best-effort)
    async folge(karte) { const b = karte.locator('[data-e2e="follow-button"]').first(); if (!(await b.count())) return false; await b.click({ timeout: 8000 }); return true; },
  },
};

// --- Eine Plattform-Runde ----------------------------------------------------
async function fuehreRunde(plattform, cfg, scharf) {
  const A = ADAPTER[plattform];
  const grenze = cfg.limits || {};
  const zaehler = { n_likes: 0, n_antworten: 0, n_kommentare: 0, n_follows: 0, n_uebersprungen: 0 };
  const spath = stateFile(plattform);

  if (!fs.existsSync(spath)) {
    log(`${plattform}: kein Login-State (${spath}) → übersprungen, Warnung gesetzt.`);
    const feld = plattform === "x" ? { login_x_ok: false, login_x_geprueft_am: new Date().toISOString() } : { login_tiktok_ok: false, login_tiktok_geprueft_am: new Date().toISOString() };
    await setzeConfig({ ...feld, warnung: `Login ${plattform.toUpperCase()} fehlt – bitte engagement-login ausführen und State auf die Box laden.` });
    return { status: "uebersprungen", zaehler, hinweis: "kein Login-State" };
  }

  const runde = await startRunde(plattform);
  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--js-flags=--max-old-space-size=384"],
  });
  let status = "fertig", fehler = null, hinweis = null;
  try {
    const context = await browser.newContext({
      storageState: spath, locale: "de-DE", timezoneId: "Europe/Zurich",
      viewport: { width: 1280, height: 900 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    // --- Login-Gesundheit ---
    const ok = await A.eingeloggt(page);
    const feld = plattform === "x"
      ? { login_x_ok: ok, login_x_geprueft_am: new Date().toISOString() }
      : { login_tiktok_ok: ok, login_tiktok_geprueft_am: new Date().toISOString() };
    await setzeConfig(feld);
    await audit({ runde_id: runde.id, plattform, richtung: "system", aktion: "login_check", status: ok ? "ausgefuehrt" : "gestoppt", begruendung: ok ? "Login gültig" : "Login abgelaufen/ungültig" });
    if (!ok) {
      await setzeConfig({ warnung: `Login ${plattform.toUpperCase()} abgelaufen – bitte neu einloggen (engagement-login) und State hochladen.` });
      hinweis = "Login abgelaufen"; status = "gestoppt";
      await browser.close(); await endeRunde(runde.id, { status, ...zaehler, hinweis });
      return { status, zaehler, hinweis };
    }

    // ================= 1) EINGEHEND: Mentions beantworten =================
    try {
      await page.goto(A.mentions, { waitUntil: "domcontentloaded", timeout: 45000 });
      await schlaf(4000);
      const body = await page.locator("body").innerText().catch(() => "");
      if (istSicherheitsWand(body) && !/notifications|mentions|benachrichtigung/i.test(page.url() + body.slice(0, 200))) {
        throw Object.assign(new Error("Sicherheits-/Loginwand bei Mentions"), { sicherheit: true });
      }
      const karten = await A.karten(page);
      const n = Math.min(await karten.count(), Number(grenze.antworten ?? 8));
      for (let i = 0; i < n && zaehler.n_antworten < Number(grenze.antworten ?? 8); i++) {
        const karte = karten.nth(i);
        const text = await A.kartenText(karte); const handle = await A.kartenHandle(karte);
        if (!text || text.length < 4) { zaehler.n_uebersprungen++; continue; }
        let entwurf = "";
        try { entwurf = await entwirf(plattform, "Formuliere eine kurze, echte, wertschätzende Antwort auf diese Erwähnung/Antwort an uns.", text); }
        catch (e) { await audit({ runde_id: runde.id, plattform, richtung: "eingehend", aktion: "mention_antwort", ziel_handle: handle, ziel_text: text.slice(0, 500), status: "fehler", fehler: e.message }); continue; }
        if (!scharf) {
          await audit({ runde_id: runde.id, plattform, richtung: "eingehend", aktion: "mention_antwort", ziel_handle: handle, ziel_text: text.slice(0, 500), unser_text: entwurf, status: "uebersprungen", begruendung: "Probe-Modus – Entwurf nicht gesendet" });
          zaehler.n_uebersprungen++; continue;
        }
        try {
          if (await A.antworte(page, karte, entwurf)) {
            zaehler.n_antworten++;
            await audit({ runde_id: runde.id, plattform, richtung: "eingehend", aktion: "mention_antwort", ziel_handle: handle, ziel_text: text.slice(0, 500), unser_text: entwurf, status: "ausgefuehrt" });
          }
        } catch (e) {
          await audit({ runde_id: runde.id, plattform, richtung: "eingehend", aktion: "mention_antwort", ziel_handle: handle, ziel_text: text.slice(0, 500), unser_text: entwurf, status: "fehler", fehler: e.message });
        }
        await menschPause(cfg);
      }
    } catch (e) {
      if (e.sicherheit) throw e;
      log(`${plattform}: Mentions-Schritt übersprungen:`, e.message);
      await audit({ runde_id: runde.id, plattform, richtung: "eingehend", aktion: "skip", status: "uebersprungen", begruendung: "Mentions nicht lesbar: " + e.message });
    }

    // ================= 2) AUSGEHEND: Kernthemen liken/kommentieren/folgen =====
    const themen = (cfg.kernthemen || []).slice(0, 4);
    for (const thema of themen) {
      if (zaehler.n_likes >= Number(grenze.likes ?? 15) && zaehler.n_kommentare >= Number(grenze.kommentare ?? 5) && zaehler.n_follows >= Number(grenze.follows ?? 5)) break;
      try {
        await page.goto(A.suche(thema), { waitUntil: "domcontentloaded", timeout: 45000 });
        await schlaf(4000);
        const body = await page.locator("body").innerText().catch(() => "");
        if (istSicherheitsWand(body) && !/search|suche|results|ergebnis/i.test(page.url() + body.slice(0, 200))) {
          throw Object.assign(new Error("Sicherheits-/Loginwand bei Suche"), { sicherheit: true });
        }
        const karten = await A.karten(page);
        const total = Math.min(await karten.count(), 8);
        for (let i = 0; i < total; i++) {
          const karte = karten.nth(i);
          const text = (await A.kartenText(karte)).slice(0, 500); const handle = await A.kartenHandle(karte);
          // LIKE
          if (zaehler.n_likes < Number(grenze.likes ?? 15)) {
            if (!scharf) { await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "like", ziel_handle: handle, ziel_text: text, status: "uebersprungen", begruendung: `Probe – Thema "${thema}"` }); }
            else { try { if (await A.like(karte)) { zaehler.n_likes++; await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "like", ziel_handle: handle, ziel_text: text, status: "ausgefuehrt", begruendung: `Thema "${thema}"` }); await menschPause(cfg); } } catch (e) { /* still */ } }
          }
          // KOMMENTAR (nur X umgesetzt; sparsam)
          if (plattform === "x" && zaehler.n_kommentare < Number(grenze.kommentare ?? 5) && i % 2 === 0 && text.length > 20) {
            let kentwurf = "";
            try { kentwurf = await entwirf(plattform, `Formuliere einen kurzen, substanziellen Kommentar zum Thema „${thema}" – ein echter Gedanke oder eine Frage, kein Lob-Spam.`, text); } catch { kentwurf = ""; }
            if (kentwurf) {
              if (!scharf) { await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "kommentar", ziel_handle: handle, ziel_text: text, unser_text: kentwurf, status: "uebersprungen", begruendung: `Probe – Thema "${thema}"` }); }
              else { try { if (await A.antworte(page, karte, kentwurf)) { zaehler.n_kommentare++; await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "kommentar", ziel_handle: handle, ziel_text: text, unser_text: kentwurf, status: "ausgefuehrt", begruendung: `Thema "${thema}"` }); await menschPause(cfg); } } catch (e) { /* still */ } }
            }
          }
          // FOLGEN (sparsam: erste Karte je Thema)
          if (zaehler.n_follows < Number(grenze.follows ?? 5) && i === 0 && handle) {
            if (!scharf) { await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "follow", ziel_handle: handle, ziel_text: text, status: "uebersprungen", begruendung: `Probe – Thema "${thema}"` }); }
            else { try { if (await A.folge(karte)) { zaehler.n_follows++; await audit({ runde_id: runde.id, plattform, richtung: "ausgehend", aktion: "follow", ziel_handle: handle, status: "ausgefuehrt", begruendung: `Thema "${thema}"` }); await menschPause(cfg); } } catch (e) { /* still */ } }
          }
        }
      } catch (e) {
        if (e.sicherheit) throw e;
        log(`${plattform}: Thema "${thema}" übersprungen:`, e.message);
      }
    }

    // Cookies auffrischen, damit die Sitzung lange gültig bleibt.
    try { await context.storageState({ path: spath }); } catch { /* egal */ }
    await browser.close();
  } catch (e) {
    try { await browser.close(); } catch { /* egal */ }
    if (e.sicherheit) {
      status = "gestoppt"; hinweis = e.message;
      await audit({ runde_id: runde.id, plattform, richtung: "system", aktion: "stopp", status: "gestoppt", begruendung: e.message });
      await setzeConfig({ warnung: `${plattform.toUpperCase()}: Sicherheits-/Loginwand erkannt – Runde gestoppt, nichts umgangen. Ggf. neu einloggen.` });
    } else {
      status = "fehler"; fehler = e.message;
      await audit({ runde_id: runde.id, plattform, richtung: "system", aktion: "warnung", status: "fehler", fehler: e.message });
    }
  }
  await endeRunde(runde.id, { status, fehler, hinweis, ...zaehler });
  return { status, zaehler, hinweis, fehler };
}

// --- Hauptlauf ---------------------------------------------------------------
async function main() {
  const arg = (process.argv[2] || "beide").toLowerCase();
  const cfg = await ladeConfig();
  if (!cfg) { log("Keine engagement_config-Zeile gefunden – Abbruch."); process.exit(1); }
  if (!cfg.auto_aktiv) { log("NOT-AUS aktiv (auto_aktiv=false) → nichts zu tun."); await setzeConfig({ letzter_lauf_am: new Date().toISOString(), letzter_status: "not-aus" }); return; }

  const scharf = cfg.modus === "scharf" && !DRYRUN_ENV;
  log(`Start. Modus=${scharf ? "SCHARF (Full-Auto)" : "PROBE (nur Entwürfe)"} · Plattform=${arg}`);
  const plattformen = arg === "beide" ? ["x", "tiktok"] : [arg];

  const ergebnisse = [];
  for (const p of plattformen) {
    if (!["x", "tiktok"].includes(p)) continue;
    const heute = await laeufeHeute(p);
    const max = Number(cfg.limits?.runden_pro_tag ?? 2);
    if (heute >= max) { log(`${p}: Tageslimit (${max} Runden) erreicht → übersprungen.`); ergebnisse.push(`${p}: Tageslimit`); continue; }
    try { const r = await fuehreRunde(p, cfg, scharf); ergebnisse.push(`${p}: ${r.status} (👍${r.zaehler.n_likes} 💬${r.zaehler.n_antworten + r.zaehler.n_kommentare} ➕${r.zaehler.n_follows})`); }
    catch (e) { log(`${p}: harter Fehler:`, e.message); ergebnisse.push(`${p}: FEHLER ${e.message}`); }
  }
  await setzeConfig({ letzter_lauf_am: new Date().toISOString(), letzter_status: ergebnisse.join(" · ") });
  log("Fertig:", ergebnisse.join(" · "));
}

main().then(() => process.exit(0)).catch((e) => { console.error("[eng] FATAL:", e); process.exit(1); });
