/**
 * Higgsfield-Kette (bewährte Rezeptur aus dem Beweisvideo) über die offizielle
 * CLI `higgsfield`. Reine Konto-Anmeldung (kein API-Key) — genau das Konto/die
 * Credits, in dem "SARAH Stimme" + die Eule liegen.
 *
 *   1) TTS   : higgsfield generate create text2speech_v2
 *              --model elevenlabs --voice_type element --voice_id <SARAH Stimme>
 *              --prompt "<deutscher Text>" --wait            -> Audio (UUID/URL)
 *   2) VIDEO : higgsfield generate create wan2_7
 *              --start-image <Eule-UUID> --audio <Audio-UUID/Datei>
 *              --duration <n> --aspect_ratio 9:16 --prompt "<Eule-Prompt>" --wait
 *                                                            -> Video-URL (mp4)
 *
 * WICHTIG (Ehrlichkeit): Der genaue stdout-Aufbau der CLI ist nicht öffentlich
 * dokumentiert. Das Parsen ist bewusst defensiv (JSON zuerst, dann UUID/URL-
 * Regex) und in EINER Funktion gekapselt (parseErgebnis) — beim ERSTEN echten
 * Lauf auf der eingeloggten Box einmal prüfen und ggf. nur dort nachziehen.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frischerToken } from "./hf-token.mjs";

const BIN = process.env.HIGGSFIELD_BIN || "higgsfield";

// Bewährte, live-bewiesene Konstanten (identisch zu lib/video/eule.ts EULE_REZEPTUR).
export const REZEPTUR = {
  owlMediaId: "1cf0ed3e-3730-4145-9e47-4b414655fe22", // Startbild: GOTT-WALD-Eule
  sarahVoiceId: "88dfb1f0-978d-48d0-aa89-9d5835e93e62", // Reference-Element "SARAH Stimme"
  ttsModel: "text2speech_v2",
  ttsVariant: "elevenlabs",
  videoModel: "wan2_7",
  aspect: "9:16",
  maxClipSek: 15,
  eulePrompt:
    "The GOTT-WALD owl speaks the words of the audio, beak opening and closing naturally in sync with the speech, warm trustworthy gaze, gentle glow. Calm, dignified. Subtle head movement.",
};

/** Signalisiert, dass der Higgsfield-Login abgelaufen ist (Job NICHT verwerfen). */
export class LoginAbgelaufenError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "LoginAbgelaufenError";
  }
}

function istLoginFehler(text) {
  return /not authenticated|session expired|unauthori|auth login|please log ?in|401/i.test(text || "");
}

/** Grobe Dauer-Schätzung aus deutschem Text (~2,3 Wörter/s), auf 2..15 s gekappt. */
export function schaetzeDauer(text) {
  const woerter = text.trim().split(/\s+/).filter(Boolean).length;
  const sek = Math.ceil(woerter / 2.3);
  return Math.max(2, Math.min(REZEPTUR.maxClipSek, sek || 2));
}

/** CLI aufrufen. Wirft LoginAbgelaufenError bei Auth-Problemen, sonst Error mit Detail. */
function cli(args, { timeoutMs = 600_000 } = {}) {
  const r = spawnSync(BIN, [...args, "--json"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  if (r.error && r.error.code === "ENOENT") {
    throw new Error(`Higgsfield-CLI nicht gefunden (BIN='${BIN}'). Installieren: npm i -g @higgsfield/cli`);
  }
  if (istLoginFehler(stdout + "\n" + stderr)) {
    throw new LoginAbgelaufenError("Higgsfield-Login abgelaufen – auf dem Worker `higgsfield auth login` erneut ausführen.");
  }
  if (r.status !== 0) {
    // --json evtl. nicht unterstützt? Einmal ohne --json versuchen, bevor wir aufgeben.
    if (/unknown option|unrecognized|--json/i.test(stderr)) {
      const r2 = spawnSync(BIN, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      if (istLoginFehler((r2.stdout || "") + (r2.stderr || ""))) {
        throw new LoginAbgelaufenError("Higgsfield-Login abgelaufen – `higgsfield auth login` erneut ausführen.");
      }
      if (r2.status === 0) return (r2.stdout || "") + "\n" + (r2.stderr || "");
      throw new Error(`CLI ${args[0]} ${args[1]} -> exit ${r2.status}: ${(r2.stderr || r2.stdout || "").slice(0, 300)}`);
    }
    throw new Error(`CLI ${args[0]} ${args[1]} -> exit ${r.status}: ${(stderr || stdout).slice(0, 300)}`);
  }
  return stdout + "\n" + stderr;
}

/** Zieht id (UUID) und/oder URL (mp3/mp4/…) aus der CLI-Ausgabe. Defensiv. */
export function parseErgebnis(ausgabe) {
  let id = null;
  let url = null;
  // 1) JSON bevorzugt (falls die CLI JSON liefert).
  const jsonKandidat = ausgabe.trim().match(/\{[\s\S]*\}/);
  if (jsonKandidat) {
    try {
      const j = JSON.parse(jsonKandidat[0]);
      const suche = (o) => {
        if (!o || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === "string") {
            if (!url && /^https?:\/\/\S+\.(mp4|mov|webm|mp3|wav|m4a)(\?\S*)?$/i.test(v)) url = v;
            if (!url && /^https?:\/\//i.test(v) && /url/i.test(k)) url = v;
            if (!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) && /(^id$|_id$)/i.test(k)) id = v;
          } else if (v && typeof v === "object") suche(v);
        }
      };
      suche(j);
    } catch {
      /* Fallback unten */
    }
  }
  // 2) Regex-Fallback über die gesamte Ausgabe. Bewusst eng begrenzt (stoppt an
  //    Whitespace/Anführungszeichen/Klammern), damit kein Folgetext mitwandert.
  if (!url) {
    const m = ausgabe.match(/https?:\/\/[^\s"'\\<>)]+\.(?:mp4|mov|webm|mp3|wav|m4a)(?:\?[^\s"'\\<>)]*)?/i);
    if (m) url = m[0];
  }
  if (!id) {
    const m = ausgabe.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    if (m) id = m[0];
  }
  return { id, url };
}

async function ladeDatei(url, suffix) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Audio-Download fehlgeschlagen (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const pfad = join(mkdtempSync(join(tmpdir(), "eule-")), `audio${suffix}`);
  writeFileSync(pfad, buf);
  return pfad;
}

/**
 * Produziert EIN Eulen-Video aus deutschem Text. Gibt { videoUrl, audioRef, dauer }.
 * Wirft LoginAbgelaufenError, wenn der Login erneuert werden muss.
 */
export async function produziereEule(text) {
  // Vor der CLI-Kette den access_token frisch halten (CLI-Auto-Refresh ist
  // unzuverlässig). Schlägt der Refresh fehl → Login abgelaufen (Job requeuen).
  try {
    await frischerToken();
  } catch (e) {
    throw new LoginAbgelaufenError(e instanceof Error ? e.message : String(e));
  }

  const dauer = schaetzeDauer(text);

  // 1) TTS: text2speech_v2 mit geklonter "SARAH Stimme".
  const ttsAus = cli([
    "generate", "create", REZEPTUR.ttsModel,
    "--model", REZEPTUR.ttsVariant,
    "--voice_type", "element",
    "--voice_id", REZEPTUR.sarahVoiceId,
    "--prompt", text,
    "--wait",
  ]);
  const tts = parseErgebnis(ttsAus);
  if (!tts.id && !tts.url) throw new Error(`TTS lieferte weder Audio-UUID noch -URL. Ausgabe: ${ttsAus.slice(0, 300)}`);
  // wan2_7 --audio akzeptiert "UUID oder Pfad": UUID bevorzugt, sonst Datei laden.
  const audioRef = tts.id || (await ladeDatei(tts.url, ".mp3"));

  // 2) VIDEO: wan2_7, Startbild = Eule, Audio = TTS-Ergebnis, 9:16.
  const vidAus = cli([
    "generate", "create", REZEPTUR.videoModel,
    "--start-image", REZEPTUR.owlMediaId,
    "--audio", String(audioRef),
    "--duration", String(dauer),
    "--aspect_ratio", REZEPTUR.aspect,
    "--prompt", REZEPTUR.eulePrompt,
    "--wait",
  ]);
  const vid = parseErgebnis(vidAus);
  if (!vid.url) throw new Error(`wan2_7 lieferte keine Video-URL. Ausgabe: ${vidAus.slice(0, 300)}`);

  return { videoUrl: vid.url, audioRef: tts.url || tts.id || null, dauer };
}
