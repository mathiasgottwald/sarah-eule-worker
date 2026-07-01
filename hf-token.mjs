/**
 * Gültigen Higgsfield-access_token liefern — refresht bei Bedarf selbst.
 *
 * Warum: Die CLI-Auto-Erneuerung ist unzuverlässig (`higgsfield auth token` gibt
 * teils einen abgelaufenen/leeren Token zurück). Dieser Helfer liest
 * credentials.json direkt, erneuert über den `refresh_token`-Grant am Clerk-
 * Token-Endpoint (Public-Client-PKCE, ohne Secret — verifiziert) und schreibt die
 * Datei zurück, sodass auch die CLI den frischen Token nutzt.
 *
 * Als Bibliothek:  import { frischerToken } from "./hf-token.mjs"
 * Als Befehl:      node hf-token.mjs            → druckt einen frischen Token
 *                  node hf-token.mjs --if-needed → refresht nur, wenn bald ablaufend
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const TOKEN_URL = process.env.HIGGSFIELD_OAUTH_TOKEN_URL || "https://clerk.higgsfield.ai/oauth/token";
const CLIENT_ID = process.env.HIGGSFIELD_OAUTH_CLIENT_ID || "sRGCQJvvJkPrrtRj";

export function credFile() {
  if (process.env.HIGGSFIELD_CREDENTIALS_PATH) return process.env.HIGGSFIELD_CREDENTIALS_PATH;
  const base = process.env.HIGGSFIELD_CONFIG_PATH
    ? process.env.HIGGSFIELD_CONFIG_PATH
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "higgsfield")
      : path.join(os.homedir(), ".config", "higgsfield");
  return path.join(base, "credentials.json");
}

/**
 * Gibt einen gültigen access_token zurück. Erneuert per refresh_token, wenn er
 * fehlt/bald abläuft (oder immer, bei force=true). Schreibt credentials.json
 * zurück. Wirft bei fehlendem/abgelehntem refresh_token (→ neu einloggen).
 */
export async function frischerToken({ force = false } = {}) {
  const file = credFile();
  let cred;
  try {
    cred = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`credentials.json fehlt/ungültig (${file}) — erst einloggen (hf-login.mjs).`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = cred.expires_at ? Math.floor(Date.parse(cred.expires_at) / 1000) : 0;
  const nochGut = cred.access_token && expSec - nowSec > 120;
  if (nochGut && !force) return cred.access_token;

  if (!cred.refresh_token) throw new Error("kein refresh_token — neu einloggen (hf-login.mjs).");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: cred.refresh_token,
  });
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    throw new Error(`Token-Refresh fehlgeschlagen (HTTP ${res.status}) ${JSON.stringify(j)} — ggf. neu einloggen.`);
  }
  cred.access_token = j.access_token;
  if (j.refresh_token) cred.refresh_token = j.refresh_token; // Rotation berücksichtigen
  cred.token_type = j.token_type || cred.token_type || "Bearer";
  cred.expires_in = j.expires_in ?? cred.expires_in;
  cred.expires_at = new Date((nowSec + (j.expires_in ?? 3600)) * 1000).toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
  return cred.access_token;
}

// Standalone: Token auf stdout drucken (für `TOKEN=$(node hf-token.mjs)`).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  frischerToken({ force: !process.argv.includes("--if-needed") })
    .then((t) => { process.stdout.write(t); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
