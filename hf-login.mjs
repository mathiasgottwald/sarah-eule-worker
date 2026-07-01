/**
 * Higgsfield-Login OHNE lokalen Browser/Listener (manueller OAuth-2.0-PKCE-Flow).
 *
 * Warum: Die offizielle CLI kann nur einen Browser-Loopback-Login
 * (127.0.0.1:8765) — auf einem headless Server unpraktisch, und Clerks
 * Consent-Schritt leitet nicht zuverlässig auf den Loopback zurück. Dieser
 * Helfer macht dieselbe Anmeldung von Hand: er erzeugt die Login-URL, du
 * bestätigst im Browser (irgendwo, eingeloggt bei higgsfield.ai), gibst den
 * zurückgegebenen `code` hier ein — der Helfer tauscht ihn gegen access_token +
 * refresh_token und schreibt exakt die Datei, die die CLI/der Worker nutzt.
 *
 * Verifiziert: der Clerk-Token-Endpoint akzeptiert Public-Client-PKCE OHNE
 * Secret; der refresh_token-Grant funktioniert (→ Worker läuft dauerhaft, die
 * CLI erneuert selbst). Nur Node-Bordmittel, keine Abhängigkeiten.
 *
 * Aufruf:  node hf-login.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const CLIENT_ID = process.env.HIGGSFIELD_OAUTH_CLIENT_ID || "sRGCQJvvJkPrrtRj";
const AUTH_URL = process.env.HIGGSFIELD_OAUTH_AUTHORIZATION_URL || "https://clerk.higgsfield.ai/oauth/authorize";
const TOKEN_URL = process.env.HIGGSFIELD_OAUTH_TOKEN_URL || "https://clerk.higgsfield.ai/oauth/token";
const REDIRECT_URI = process.env.HIGGSFIELD_OAUTH_REDIRECT_URI || "http://127.0.0.1:8765/callback";
const SCOPE = process.env.HIGGSFIELD_OAUTH_SCOPES || "email profile offline_access user:org:read";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authorize =
  `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}&state=${state}`;

function credFile() {
  if (process.env.HIGGSFIELD_CREDENTIALS_PATH) return process.env.HIGGSFIELD_CREDENTIALS_PATH;
  const base = process.env.HIGGSFIELD_CONFIG_PATH
    ? process.env.HIGGSFIELD_CONFIG_PATH
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "higgsfield")
      : path.join(os.homedir(), ".config", "higgsfield");
  return path.join(base, "credentials.json");
}

console.log("\n=== Higgsfield-Login (manuell) ===\n");
console.log("1) Öffne diese URL im Browser (eingeloggt bei higgsfield.ai) und bestätige den Zugriff:\n");
console.log(authorize + "\n");
console.log("2) Danach springt der Browser auf eine Seite 'http://127.0.0.1:8765/callback?...',");
console.log("   die NICHT LÄDT ('Seite nicht erreichbar') — das ist ok. Kopiere die KOMPLETTE");
console.log("   Adresse aus der Adresszeile.");
console.log("   Falls der Browser NICHT navigiert: öffne die Entwicklertools (F12) → Tab 'Network',");
console.log("   klick nochmal 'Erlauben', und kopiere aus der letzten Anfrage die 'code='-URL.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Callback-URL (oder nur der code-Wert): ", async (answer) => {
  rl.close();
  const raw = answer.trim();
  let code = raw;
  const m = raw.match(/[?&]code=([^&\s]+)/);
  if (m) code = decodeURIComponent(m[1]);
  const sm = raw.match(/[?&]state=([^&\s]+)/);
  if (sm && decodeURIComponent(sm[1]) !== state) {
    console.error("\n⚠ state passt nicht (evtl. alte URL). Starte den Login neu, wenn der Austausch scheitert.\n");
  }
  if (!code) { console.error("Kein code erkannt."); process.exit(1); }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  let res, j;
  try {
    res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    j = await res.json().catch(() => null);
  } catch (e) {
    console.error("Netzwerkfehler beim Token-Austausch:", e?.message); process.exit(1);
  }
  if (!res.ok || !j?.access_token) {
    console.error(`\n❌ Token-Austausch fehlgeschlagen (HTTP ${res.status}):`, JSON.stringify(j));
    console.error("Tipp: code ist einmalig + kurzlebig — Login neu starten und zügig einlösen.");
    process.exit(1);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cred = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? null,
    token_type: j.token_type ?? "Bearer",
    expires_in: j.expires_in ?? 3600,
    expires_at: new Date((nowSec + (j.expires_in ?? 3600)) * 1000).toISOString(),
  };
  const file = credFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
  console.log(`\n✅ Gespeichert: ${file}`);
  console.log(`   refresh_token vorhanden: ${cred.refresh_token ? "ja (dauerhaft)" : "NEIN — offline_access-Scope fehlte?"}`);

  // Selbstprüfung: liest die CLI die Datei und funktioniert der Token wirklich?
  const bin = process.env.HIGGSFIELD_BIN || "higgsfield";
  const check = spawnSync(bin, ["account", "status"], { encoding: "utf8", timeout: 30000 });
  if (check.error && check.error.code === "ENOENT") {
    console.log("\n(CLI nicht im PATH — Prüfung übersprungen. Manuell: higgsfield account status)");
  } else if (check.status === 0) {
    console.log("\n✅ CLI akzeptiert den Login:");
    console.log((check.stdout || "").trim().split("\n").slice(0, 6).join("\n"));
  } else {
    console.log("\n⚠ CLI meldet noch nicht eingeloggt — Ausgabe:");
    console.log(((check.stdout || "") + (check.stderr || "")).trim().slice(0, 300));
    console.log("Falls das so bleibt: den Fallback (CLI-Listener) in DEPLOY-EC2.md nutzen.");
  }
  console.log("");
});
