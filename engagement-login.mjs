#!/usr/bin/env node
/**
 * SARAH — LOGIN-CAPTURE für den X/TikTok-Engagement-Worker.
 * ===========================================================================
 * EINMALIG auf einem Rechner MIT Bildschirm ausführen (z. B. Mathias' Mac).
 * Öffnet ein sichtbares Chromium, in dem du dich ganz normal bei X und TikTok
 * einloggst. Danach werden die Sitzungen (Cookies + localStorage) als
 *     state/x-state.json   und   state/tiktok-state.json
 * gespeichert. Diese zwei Dateien lädst du auf server-2 in den State-Ordner —
 * ab dann läuft der Worker unbeaufsichtigt ohne erneutes Login.
 *
 * Diese Dateien sind SENSIBEL (voller Kontozugang) → niemals ins Repo, nur auf
 * die Box. Sie stehen in .gitignore.
 *
 * Aufruf:   node engagement-login.mjs [x|tiktok|beide]     (Default: beide)
 * Bei abgelaufenem Login später einfach erneut ausführen und neu hochladen.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.ENGAGEMENT_STATE_DIR || path.join(HIER, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const ZIELE = {
  x: { url: "https://x.com/login", datei: path.join(STATE_DIR, "x-state.json"), name: "X (@GOTT_WALD)" },
  tiktok: { url: "https://www.tiktok.com/login", datei: path.join(STATE_DIR, "tiktok-state.json"), name: "TikTok (@gott_wald)" },
};

function frage(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(text, (a) => { rl.close(); res(a); }));
}

async function capture(schluessel) {
  const z = ZIELE[schluessel];
  console.log(`\n▸ Öffne ${z.name} …`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "de-DE", timezoneId: "Europe/Zurich", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(z.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await frage(`   Logge dich im Fenster bei ${z.name} ein. Wenn du DRIN bist, hier ENTER drücken … `);
  await context.storageState({ path: z.datei });
  await browser.close();
  console.log(`   ✓ Gespeichert: ${z.datei}`);
}

const arg = (process.argv[2] || "beide").toLowerCase();
const keys = arg === "beide" ? ["x", "tiktok"] : [arg];
for (const k of keys) {
  if (!ZIELE[k]) { console.error(`Unbekannt: ${k} (x|tiktok|beide)`); process.exit(1); }
  await capture(k);
}
console.log(`\n✓ Fertig. Lade jetzt den Ordner "${STATE_DIR}" auf server-2 nach ~/worker/state/ hoch:`);
console.log(`   scp ${path.join(STATE_DIR, "*.json")} ubuntu@<server-2>:~/worker/state/`);
process.exit(0);
