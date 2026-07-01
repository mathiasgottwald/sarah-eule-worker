/**
 * Higgsfield-Eulen-Kette — CLI-FREI, nur direkte HTTP-API-Calls gegen den
 * fnf-api-gw mit Bearer-Token (aus hf-token.mjs, wird vor jedem Lauf erneuert).
 * KEINE Abhängigkeit von den zickenden CLI-Befehlen.
 *
 * Reverse-engineert aus dem CLI-Binary + öffentlichem job_types-Schema
 * (GET /fnf/developer/v2alpha/job_types/<model> = ohne Auth lesbar):
 *
 *   1) TTS   : POST /developer/v2alpha/audios/text2speech_v2/generations
 *              { params:{ prompt, variant:"elevenlabs", voice_type:"element",
 *                         voice_id:<SARAH Stimme> } }              -> job
 *   2) VIDEO : POST /developer/v2alpha/videos/wan2_7/generations
 *              { params:{ prompt, aspect_ratio:"9:16", duration,
 *                         start_image:{ id:<Eule> },
 *                         audio_references:[{ id:<TTS-job>, type:"text2speech_v2" }] } }
 *   Poll    : GET /developer/v2alpha/jobs/<id> -> job_status + result_url
 *
 * Request-Wrapper { params:{...} } und Job-Response (job_id/job_set_id,
 * job_status, result_url/min_result_url) stammen aus den json-Tags des Binaries.
 */
import { frischerToken } from "./hf-token.mjs";

const API_BASE = process.env.HF_API_BASE || "https://fnf-api-gw.higgsfield.ai/fnf";
const WORKSPACE_ID = process.env.HF_WORKSPACE_ID || "0b923f57-d0c1-479a-962d-859ae429e37a";

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

/** Signalisiert, dass der Login/Token nicht erneuerbar ist (Job NICHT verwerfen). */
export class LoginAbgelaufenError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "LoginAbgelaufenError";
  }
}

/** Grobe Dauer-Schätzung aus deutschem Text (~2,3 Wörter/s), auf 2..15 s gekappt. */
export function schaetzeDauer(text) {
  const woerter = text.trim().split(/\s+/).filter(Boolean).length;
  const sek = Math.ceil(woerter / 2.3);
  return Math.max(2, Math.min(REZEPTUR.maxClipSek, sek || 2));
}

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "x-fnf-workspace-id": WORKSPACE_ID,
    "x-fnf-surface": "developer",
  };
}

async function apiPost(pfad, body, token) {
  const res = await fetch(`${API_BASE}${pfad}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* nicht-JSON */ }
  if (res.status === 401) throw new LoginAbgelaufenError(`401 vom API (${pfad}): ${txt.slice(0, 200)}`);
  if (!res.ok) throw new Error(`POST ${pfad} -> ${res.status}: ${txt.slice(0, 400)}`);
  return j ?? {};
}

async function apiGet(pfad, token) {
  const res = await fetch(`${API_BASE}${pfad}`, { headers: headers(token) });
  const txt = await res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* nicht-JSON */ }
  if (res.status === 401) throw new LoginAbgelaufenError(`401 vom API (${pfad}): ${txt.slice(0, 200)}`);
  if (!res.ok) throw new Error(`GET ${pfad} -> ${res.status}: ${txt.slice(0, 400)}`);
  return j ?? {};
}

/** Job-Id aus einer Generate-Antwort ziehen (job_id bevorzugt, dann job_set_id/id). */
function jobIdAus(resp) {
  const j = resp || {};
  const kandidat =
    j.job_id ||
    (Array.isArray(j.jobs) && j.jobs[0] && (j.jobs[0].job_id || j.jobs[0].id)) ||
    j.job_set_id ||
    j.id;
  if (!kandidat) throw new Error(`keine job-id in Antwort: ${JSON.stringify(j).slice(0, 400)}`);
  return String(kandidat);
}

/** Ergebnis-URL aus einem Job ziehen (result_url/min_result_url/results[]). */
function ergebnisUrl(job) {
  const j = job || {};
  if (typeof j.result_url === "string" && j.result_url) return j.result_url;
  if (typeof j.min_result_url === "string" && j.min_result_url) return j.min_result_url;
  const arr = Array.isArray(j.results) ? j.results : Array.isArray(j.jobs) ? j.jobs : [];
  for (const r of arr) {
    const u = r?.result_url || r?.min_result_url || r?.url || r?.raw?.url || r?.min?.url;
    if (u) return u;
  }
  return null;
}

/** Job pollen bis fertig. Gibt die Ergebnis-URL. Wirft bei failed/nsfw/canceled. */
async function warteAufJob(jobId, token, { maxMs = 600_000, intervallMs = 6000, label = "job" } = {}) {
  const start = Date.now();
  let letzter = "";
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervallMs));
    const job = await apiGet(`/developer/v2alpha/jobs/${encodeURIComponent(jobId)}`, token).catch((e) => {
      if (e instanceof LoginAbgelaufenError) throw e;
      return null; // transient -> weiter pollen
    });
    if (!job) continue;
    const status = String(job.job_status ?? job.status ?? "").toLowerCase();
    letzter = status;
    if (["completed", "complete", "succeeded", "success"].includes(status)) {
      const url = ergebnisUrl(job);
      if (!url) throw new Error(`${label} fertig, aber keine Ergebnis-URL: ${JSON.stringify(job).slice(0, 400)}`);
      return url;
    }
    if (["failed", "error", "nsfw", "canceled", "cancelled"].includes(status)) {
      throw new Error(`${label} endete mit Status '${status}': ${JSON.stringify(job).slice(0, 400)}`);
    }
  }
  throw new Error(`${label} Timeout nach ${Math.round(maxMs / 1000)}s (letzter Status '${letzter}')`);
}

/**
 * Produziert EIN Eulen-Video aus deutschem Text. Gibt { videoUrl, audioRef, dauer }.
 * Wirft LoginAbgelaufenError, wenn der Token nicht erneuerbar ist.
 */
export async function produziereEule(text) {
  let token;
  try {
    token = await frischerToken({ force: true });
  } catch (e) {
    throw new LoginAbgelaufenError(e instanceof Error ? e.message : String(e));
  }

  const dauer = schaetzeDauer(text);

  // 1) TTS: text2speech_v2 mit geklonter "SARAH Stimme".
  const ttsResp = await apiPost(
    `/developer/v2alpha/audios/${REZEPTUR.ttsModel}/generations`,
    {
      params: {
        prompt: text,
        variant: REZEPTUR.ttsVariant,
        voice_type: "element",
        voice_id: REZEPTUR.sarahVoiceId,
      },
    },
    token,
  );
  const ttsJobId = jobIdAus(ttsResp);
  const audioUrl = await warteAufJob(ttsJobId, token, { label: "TTS", maxMs: 300_000 });

  // 2) VIDEO: wan2_7, Startbild = Eule, Audio = TTS-Job (chained), 9:16.
  const vidResp = await apiPost(
    `/developer/v2alpha/videos/${REZEPTUR.videoModel}/generations`,
    {
      params: {
        prompt: REZEPTUR.eulePrompt,
        aspect_ratio: REZEPTUR.aspect,
        duration: dauer,
        start_image: { id: REZEPTUR.owlMediaId },
        audio_references: [{ id: ttsJobId, type: REZEPTUR.ttsModel }],
      },
    },
    token,
  );
  const vidJobId = jobIdAus(vidResp);
  const videoUrl = await warteAufJob(vidJobId, token, { label: "wan2_7", maxMs: 600_000 });

  return { videoUrl, audioRef: audioUrl, dauer };
}
