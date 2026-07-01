/**
 * SARAH — Eulen-Video-Worker (Stufe 2b).
 *
 * Dauer-Prozess auf einer kleinen, EINGELOGGTEN Box (higgsfield auth login).
 * Handshake rein über die DB (video_jobs):
 *   queued --(claim)--> in_arbeit --(produziert)--> fertig  (bzw. fehler)
 * Login abgelaufen -> Job zurück auf 'queued' (kein Verlust), Worker wartet.
 *
 * Secrets NUR aus der Umgebung, werden NIE geloggt. Nutzt den Service-Role-Key
 * (umgeht RLS bewusst) — dieser liegt AUSSCHLIESSLICH hier auf der Worker-Box,
 * nie in SARAHs Client.
 */
import { createClient } from "@supabase/supabase-js";
import { produziereEule, LoginAbgelaufenError, sicherePersoenlichenKontext } from "./produziere-eule.mjs";

const URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const LOGIN_WARTE_MS = Number(process.env.LOGIN_WARTE_MS || 300_000); // nach Login-Ablauf länger warten
const EINMAL = process.argv.includes("--einmal");

if (!URL || !KEY) {
  console.error("[worker] FEHLT: SUPABASE_URL und/oder SUPABASE_SERVICE_ROLE_KEY (siehe .env.example).");
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });
let laeuftWeiter = true;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { laeuftWeiter = false; });

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
const jetzt = () => new Date().toISOString();
const log = (...a) => console.log(`[worker ${jetzt()}]`, ...a);

/** Nächsten offenen Job atomar übernehmen. Gibt den Job oder null. */
async function holeUndUebernimm() {
  const { data: offen, error } = await db
    .from("video_jobs")
    .select("id, text")
    .eq("status", "queued")
    .order("erstellt_am", { ascending: true })
    .limit(1);
  if (error) { log("DB-Lesefehler:", error.message); return null; }
  const job = offen?.[0];
  if (!job) return null;
  // Atomar beanspruchen: nur wenn noch 'queued' (verhindert Doppelverarbeitung).
  const { data: claimed, error: claimErr } = await db
    .from("video_jobs")
    .update({ status: "in_arbeit", verarbeitung_gestartet_am: jetzt(), fehler_text: null })
    .eq("id", job.id)
    .eq("status", "queued")
    .select("id, text");
  if (claimErr) { log("Claim-Fehler:", claimErr.message); return null; }
  return claimed?.[0] ?? null; // leer = anderer Worker war schneller
}

async function verarbeite(job) {
  log(`Job ${job.id}: produziere…`);
  try {
    const { videoUrl, audioRef, dauer } = await produziereEule(job.text || "");
    await db.from("video_jobs").update({
      video_url: videoUrl,
      audio_url: audioRef,
      dauer_sek: dauer,
      status: "fertig",
      fehler_text: null,
    }).eq("id", job.id);
    log(`Job ${job.id}: FERTIG (${dauer}s).`);
    return "fertig";
  } catch (e) {
    if (e instanceof LoginAbgelaufenError) {
      // Job NICHT verwerfen — zurück in die Warteschlange, Worker wartet auf Re-Login.
      await db.from("video_jobs").update({
        status: "queued",
        verarbeitung_gestartet_am: null,
        fehler_text: "Higgsfield-Login abgelaufen – auf dem Worker `higgsfield auth login` erneut ausführen. Job wartet.",
      }).eq("id", job.id);
      log("!!! LOGIN ABGELAUFEN — bitte `higgsfield auth login` auf dem Worker ausführen. Job bleibt in der Warteschlange.");
      return "login";
    }
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("video_jobs").update({ status: "fehler", fehler_text: msg.slice(0, 500) }).eq("id", job.id);
    log(`Job ${job.id}: FEHLER — ${msg.slice(0, 200)}`);
    return "fehler";
  }
}

async function main() {
  log(`gestartet. Poll alle ${POLL_MS / 1000}s.${EINMAL ? " (Einmal-Modus)" : ""}`);
  sicherePersoenlichenKontext(); // persönlicher Account-Kontext (verhindert "No workspace selected")
  while (laeuftWeiter) {
    const job = await holeUndUebernimm().catch((e) => { log("Schleifenfehler:", e?.message); return null; });
    if (!job) {
      if (EINMAL) { log("keine offenen Jobs — Ende (Einmal-Modus)."); break; }
      await schlaf(POLL_MS);
      continue;
    }
    const ergebnis = await verarbeite(job);
    if (EINMAL) break;
    if (ergebnis === "login") await schlaf(LOGIN_WARTE_MS); // nicht heißdrehen, bis Re-Login da ist
  }
  log("beendet.");
}

main().catch((e) => { console.error("[worker] Abbruch:", e?.message); process.exit(1); });
