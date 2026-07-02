/**
 * SARAH — Eulen-Video-Worker (Stufe 2b).
 *
 * Dauer-Prozess auf server-2. Handshake rein über die DB (video_jobs):
 *   queued --(claim)--> in_arbeit --(produziert)--> fertig  (bzw. fehler)
 * Token nicht erneuerbar -> Job zurück auf 'queued' (kein Verlust), Worker wartet.
 *
 * DB-Zugriff über Supabase PostgREST DIREKT per fetch (KEIN @supabase/supabase-js
 * → kein Realtime/WebSocket, das Node 20 nicht nativ hat; kein ws-Paket nötig).
 * Der Service-Role-Key (umgeht RLS) liegt NUR hier auf der Box, nie im Client.
 */
import "./load-env.mjs"; // MUSS zuerst stehen: lädt ~/worker/.env (abs. Pfad) in process.env
import { produziereEule, LoginAbgelaufenError } from "./produziere-eule.mjs";

const BASE = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const LOGIN_WARTE_MS = Number(process.env.LOGIN_WARTE_MS || 300_000);
const EINMAL = process.argv.includes("--einmal");
const ALLE = process.argv.includes("--alle"); // alle offenen Jobs abarbeiten, dann beenden

if (!BASE || !KEY) {
  console.error("[worker] FEHLT: SUPABASE_URL und/oder SUPABASE_SERVICE_ROLE_KEY (siehe .env.example / ~/worker/.env).");
  process.exit(1);
}

const REST = `${BASE}/rest/v1/video_jobs`;
const dbHeaders = (extra = {}) => ({ apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", ...extra });

let laeuftWeiter = true;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { laeuftWeiter = false; });

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const jetzt = () => new Date().toISOString();
const log = (...a) => console.log(`[worker ${jetzt()}]`, ...a);

/** Nächsten offenen Job atomar übernehmen. Gibt den Job {id,text} oder null. */
async function holeUndUebernimm() {
  // 1) ältesten queued-Job lesen
  const sel = await fetch(`${REST}?status=eq.queued&order=erstellt_am.asc&limit=1&select=id,text`, { headers: dbHeaders() });
  if (!sel.ok) { log("DB-Lesefehler:", sel.status, (await sel.text().catch(() => "")).slice(0, 200)); return null; }
  const offen = await sel.json();
  const job = Array.isArray(offen) ? offen[0] : null;
  if (!job) return null;
  // 2) atomar beanspruchen: PATCH nur solange status noch 'queued' (verhindert Doppelverarbeitung)
  const claim = await fetch(`${REST}?id=eq.${encodeURIComponent(job.id)}&status=eq.queued`, {
    method: "PATCH",
    headers: dbHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({ status: "in_arbeit", verarbeitung_gestartet_am: jetzt(), fehler_text: null }),
  });
  if (!claim.ok) { log("Claim-Fehler:", claim.status, (await claim.text().catch(() => "")).slice(0, 200)); return null; }
  const claimed = await claim.json();
  return (Array.isArray(claimed) && claimed[0]) || null; // leer = anderer Worker war schneller
}

/** Felder eines Jobs setzen (PATCH nach id). */
async function dbUpdate(id, patch) {
  const res = await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: dbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) log("DB-Update-Fehler:", res.status, (await res.text().catch(() => "")).slice(0, 200));
}

async function verarbeite(job) {
  log(`Job ${job.id}: produziere…`);
  try {
    const { videoUrl, audioRef, dauer } = await produziereEule(job.text || "");
    await dbUpdate(job.id, { video_url: videoUrl, audio_url: audioRef, dauer_sek: dauer, status: "fertig", fehler_text: null });
    log(`Job ${job.id}: FERTIG (${dauer}s) → ${videoUrl}`);
    return "fertig";
  } catch (e) {
    if (e instanceof LoginAbgelaufenError) {
      // Job NICHT verwerfen — zurück in die Warteschlange, Worker wartet auf frischen Token.
      await dbUpdate(job.id, {
        status: "queued",
        verarbeitung_gestartet_am: null,
        fehler_text: "Higgsfield-Token nicht erneuerbar – auf dem Worker neu einloggen (hf-login.mjs). Job wartet.",
      });
      log(`!!! TOKEN/LOGIN-Problem — ${e.message}. Job bleibt in der Warteschlange.`);
      return "login";
    }
    const msg = e instanceof Error ? e.message : String(e);
    await dbUpdate(job.id, { status: "fehler", fehler_text: msg.slice(0, 500) });
    log(`Job ${job.id}: FEHLER — ${msg.slice(0, 300)}`);
    return "fehler";
  }
}

async function main() {
  log(`gestartet. Poll alle ${POLL_MS / 1000}s.${EINMAL ? " (Einmal-Modus)" : ALLE ? " (Alle-Modus: bis Warteschlange leer)" : ""}`);
  while (laeuftWeiter) {
    const job = await holeUndUebernimm().catch((e) => { log("Schleifenfehler:", e?.message); return null; });
    if (!job) {
      if (EINMAL || ALLE) { log(`keine offenen Jobs — Ende (${EINMAL ? "Einmal" : "Alle"}-Modus).`); break; }
      await schlaf(POLL_MS);
      continue;
    }
    const ergebnis = await verarbeite(job);
    if (EINMAL) break;
    if (ergebnis === "login") { if (ALLE) { log("Login-Problem — Alle-Modus endet."); break; } await schlaf(LOGIN_WARTE_MS); }
  }
  log("beendet.");
}

main().catch((e) => { console.error("[worker] Abbruch:", e?.message); process.exit(1); });
