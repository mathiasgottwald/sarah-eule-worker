#!/usr/bin/env node
/**
 * SARAH — LOGIN-CAPTURE für den X/TikTok-Engagement-Worker.
 * ===========================================================================
 * EINMALIG auf einem Rechner MIT Bildschirm ausführen (z. B. Mathias' Mac).
 * Öffnet ein sichtbares Chromium, in dem du dich ganz normal bei X und TikTok
 * einloggst. Der Login wird AUTOMATISCH erkannt — sobald du drin bist (auch nach
 * 2FA/Verifizierung), speichert das Script die Sitzung und macht mit der nächsten
 * Plattform weiter. Kein Tastendruck nötig (ENTER geht zusätzlich, um früher zu
 * speichern, falls die Auto-Erkennung mal danebenliegt).
 *
 * Ergebnis:  state/x-state.json  und  state/tiktok-state.json  (Cookies+Storage).
 * Diese Dateien sind SENSIBEL (voller Kontozugang) → nie ins Repo, nur auf die Box.
 *
 * Aufruf:   node engagement-login.mjs [x|tiktok|beide]     (Default: beide)
 * Bei abgelaufenem Login später einfach erneut ausführen und neu hochladen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.ENGAGEMENT_STATE_DIR || path.join(HIER, "state");
const TIMEOUT_SEK = Number(process.env.LOGIN_TIMEOUT_SEK || 300); // 5 Min pro Plattform
fs.mkdirSync(STATE_DIR, { recursive: true });

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

const ZIELE = {
  x: {
    url: "https://x.com/login",
    datei: path.join(STATE_DIR, "x-state.json"),
    name: "X (@GOTT_WALD)",
    async eingeloggt(page) {
      if (/\/login|\/i\/flow\/login|\/i\/flow\/signup/.test(page.url())) return false;
      return (await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]').count()) > 0;
    },
  },
  tiktok: {
    url: "https://www.tiktok.com/login",
    datei: path.join(STATE_DIR, "tiktok-state.json"),
    name: "TikTok (@gott_wald)",
    async eingeloggt(page) {
      const ein = await page.locator('[data-e2e="profile-icon"], [data-e2e="nav-profile"], [data-e2e="upload-icon"]').count();
      const login = await page.locator('[data-e2e="top-login-button"], [data-e2e="nav-login"]').count();
      return ein > 0 && login === 0;
    },
  },
};

// ENTER als optionaler Früh-Auslöser (nur wenn ein TTY vorhanden ist).
let enterGedrueckt = false;
try {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.on("data", () => { enterGedrueckt = true; });
  }
} catch { /* kein TTY — nur Auto-Erkennung */ }

async function capture(schluessel) {
  const z = ZIELE[schluessel];
  console.log(`\n▸ Öffne ${z.name} … logge dich im Fenster ein (2FA/Code ruhig durchführen).`);
  console.log(`  Ich erkenne automatisch, wenn du drin bist, und speichere dann (max ${TIMEOUT_SEK}s).`);
  // Echtes Google Chrome (channel:'chrome'), NICHT das gebündelte Chromium — dort
  // funktioniert die X/TikTok-Anmeldung normal. Eigenes Profil, stört dein Haupt-Chrome nicht.
  const browser = await chromium.launch({ headless: false, channel: process.env.LOGIN_CHANNEL || "chrome" });
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Zurich", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(z.url, { waitUntil: "domcontentloaded" }).catch(() => {});

  const bis = Date.now() + TIMEOUT_SEK * 1000;
  let drin = false;
  enterGedrueckt = false;
  while (Date.now() < bis) {
    await schlaf(2500);
    let ok = false;
    try { ok = await z.eingeloggt(page); } catch { /* Seite lädt gerade */ }
    if (ok || enterGedrueckt) { drin = true; break; }
    const rest = Math.round((bis - Date.now()) / 1000);
    process.stdout.write(`\r  … warte auf Login (${rest}s übrig)   `);
  }
  process.stdout.write("\n");

  if (!drin) {
    console.log(`  ✗ ${z.name}: kein Login erkannt (Zeit abgelaufen). Nichts gespeichert — bitte erneut versuchen.`);
    await browser.close();
    return false;
  }
  await schlaf(1500); // kurz setzen lassen, dann Cookies sichern
  await context.storageState({ path: z.datei });
  await browser.close();
  const bytes = fs.statSync(z.datei).size;
  console.log(`  ✓ ${z.name} gespeichert: ${z.datei} (${bytes} Bytes)`);
  return true;
}

const arg = (process.argv[2] || "beide").toLowerCase();
const keys = arg === "beide" ? ["x", "tiktok"] : [arg];
const ergebnis = {};
for (const k of keys) {
  if (!ZIELE[k]) { console.error(`Unbekannt: ${k} (x|tiktok|beide)`); process.exit(1); }
  ergebnis[k] = await capture(k);
}

console.log("\n──────────────────────────────────────────────");
for (const k of keys) console.log(`  ${ergebnis[k] ? "✓" : "✗"} ${ZIELE[k].name}`);
const alle = keys.every((k) => ergebnis[k]);
if (alle) {
  console.log(`\n✓ Fertig. Nächster Schritt — auf server-2 laden:`);
  console.log(`   scp ${path.join(STATE_DIR, "*.json")} ubuntu@<server-2>:~/worker/state/`);
} else {
  console.log(`\n⚠ Nicht alle Sitzungen gespeichert — die fehlende(n) noch mal einzeln: node engagement-login.mjs <x|tiktok>`);
}
process.exit(alle ? 0 : 2);
