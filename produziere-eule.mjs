/**
 * Higgsfield-Eulen-Kette — CLI-FREI, direkte HTTP-API gegen fnf-api-gw mit
 * Bearer-Token (aus hf-token.mjs, vor jedem Lauf erneuert).
 *
 * WORKSPACE-SELBSTFINDUNG: Der generations-Endpunkt akzeptiert die Workspace-ID
 * nicht als simplen x-fnf-workspace-id-Header (empirisch: 422 „missing" trotz
 * gesendetem Header). Die genaue Form (surface-Wert / Query-Param / Body-Feld)
 * ließ sich ohne gültigen Token nicht lokal testen — daher probiert der Worker
 * (der den Token hat) beim ersten Aufruf ALLE Formen durch, bis eine den
 * Workspace akzeptiert (credit-frei: Formen, die am Workspace scheitern, kosten
 * nichts; erst die passende Form generiert). Die gefundene Form wird für die
 * ganze Kette (TTS + wan2_7) genutzt und geloggt.
 */
import { frischerToken } from "./hf-token.mjs";

const API_BASE = (process.env.HF_API_BASE || "https://fnf-api-gw.higgsfield.ai/fnf").trim().replace(/\/+$/, "");
const WORKSPACE_ID = (process.env.HF_WORKSPACE_ID || "0b923f57-d0c1-479a-962d-859ae429e37a").trim();
// optionale User-ID: nur senden, wenn explizit gesetzt (Gateway leitet sie sonst
// selbst aus dem Token ab; ein falscher Wert könnte abgelehnt werden).
const FNF_USER_ID = (process.env.HF_FNF_USER_ID || "").trim();

export const REZEPTUR = {
  owlMediaId: "1cf0ed3e-3730-4145-9e47-4b414655fe22",
  sarahVoiceId: "88dfb1f0-978d-48d0-aa89-9d5835e93e62",
  ttsModel: "text2speech_v2",
  ttsVariant: "elevenlabs",
  videoModel: "wan2_7",
  aspect: "9:16",
  maxClipSek: 15,
  eulePrompt:
    "The GOTT-WALD owl speaks the words of the audio, beak opening and closing naturally in sync with the speech, warm trustworthy gaze, gentle glow. Calm, dignified. Subtle head movement.",
};

/** Signalisiert, dass der Token nicht erneuerbar ist (Job NICHT verwerfen). */
export class LoginAbgelaufenError extends Error {
  constructor(msg) { super(msg); this.name = "LoginAbgelaufenError"; }
}

/** Grobe Dauer-Schätzung aus deutschem Text (~2,3 Wörter/s), 2..15 s. */
export function schaetzeDauer(text) {
  const woerter = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.min(REZEPTUR.maxClipSek, Math.ceil(woerter / 2.3) || 2));
}

// Kandidaten-Formen für die Workspace-Übergabe (cli-Surface zuerst = wahrscheinlichste).
const WS_FORMEN = [
  { surface: "cli", ort: "header" },
  { surface: "cli", ort: "query" },
  { surface: "cli", ort: "body" },
  { surface: "cli", ort: "params" },
  { surface: "developer", ort: "query" },
  { surface: "developer", ort: "body" },
];

function baseHeaders(token, surface) {
  const h = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "x-fnf-workspace-id": WORKSPACE_ID, // immer mitschicken (schadet nie)
    "x-fnf-surface": surface,
  };
  if (FNF_USER_ID) h["x-fnf-user-id"] = FNF_USER_ID;
  return h;
}

function jobIdAus(resp) {
  const j = resp || {};
  const id = j.job_id || (Array.isArray(j.jobs) && j.jobs[0] && (j.jobs[0].job_id || j.jobs[0].id)) || j.job_set_id || j.id;
  if (!id) throw new Error(`keine job-id in Antwort: ${JSON.stringify(j).slice(0, 300)}`);
  return String(id);
}

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

const istWorkspaceFehler = (txt) => /workspace/i.test(txt) && /(missing|required|not found|no workspace|select)/i.test(txt);
const istCreditFehler = (txt) => /credit|not enough|insufficient|balance/i.test(txt);

/**
 * Generierung mit Workspace-Selbstfindung. Gibt { jobId, form }.
 * Wenn `nurForm` gesetzt ist, wird nur diese Form benutzt (für Folge-Calls).
 */
async function generiere(kind, model, params, token, nurForm = null) {
  const formen = nurForm ? [nurForm] : WS_FORMEN;
  let letzter = "";
  for (const form of formen) {
    let url = `${API_BASE}/developer/v2alpha/${kind}/${model}/generations`;
    const body = { params: { ...params } };
    if (form.ort === "query") url += `?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`;
    else if (form.ort === "body") body.workspace_id = WORKSPACE_ID;
    else if (form.ort === "params") body.params.workspace_id = WORKSPACE_ID;

    const res = await fetch(url, { method: "POST", headers: baseHeaders(token, form.surface), body: JSON.stringify(body) });
    const txt = await res.text();
    if (res.status === 401) throw new LoginAbgelaufenError(`401 (${kind}/${model}): ${txt.slice(0, 150)}`);
    if (res.ok) {
      const j = JSON.parse(txt);
      console.log(`[eule] Workspace-Form OK: surface=${form.surface} ort=${form.ort} (${kind}/${model})`);
      return { jobId: jobIdAus(j), form };
    }
    if (istWorkspaceFehler(txt) && !nurForm) { letzter = `[${form.surface}/${form.ort}] ${txt.slice(0, 100)}`; continue; }
    if (istCreditFehler(txt)) throw new Error(`Workspace-Form [${form.surface}/${form.ort}] akzeptiert, ABER Credits fehlen: ${txt.slice(0, 200)}`);
    // Form kam am Workspace vorbei, aber anderer Fehler → melden (mit Detail).
    throw new Error(`Form [${form.surface}/${form.ort}] ${kind}/${model} -> ${res.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error(`Keine Workspace-Form akzeptiert (${kind}/${model}). Letzter: ${letzter}`);
}

async function warteAufJob(jobId, token, { maxMs = 600_000, intervallMs = 6000, label = "job" } = {}) {
  const start = Date.now();
  let letzter = "";
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervallMs));
    let job = null;
    try {
      const res = await fetch(`${API_BASE}/developer/v2alpha/jobs/${encodeURIComponent(jobId)}`, { headers: baseHeaders(token, "cli") });
      if (res.status === 401) throw new LoginAbgelaufenError("401 beim Job-Poll");
      if (res.ok) job = await res.json();
    } catch (e) { if (e instanceof LoginAbgelaufenError) throw e; }
    if (!job) continue;
    const status = String(job.job_status ?? job.status ?? "").toLowerCase();
    letzter = status;
    if (["completed", "complete", "succeeded", "success"].includes(status)) {
      const url = ergebnisUrl(job);
      if (!url) throw new Error(`${label} fertig, aber keine Ergebnis-URL: ${JSON.stringify(job).slice(0, 300)}`);
      return url;
    }
    if (["failed", "error", "nsfw", "canceled", "cancelled"].includes(status)) {
      throw new Error(`${label} Status '${status}': ${JSON.stringify(job).slice(0, 300)}`);
    }
  }
  throw new Error(`${label} Timeout nach ${Math.round(maxMs / 1000)}s (letzter Status '${letzter}')`);
}

/**
 * Produziert EIN Eulen-Video aus deutschem Text. Gibt { videoUrl, audioRef, dauer }.
 */
export async function produziereEule(text) {
  console.log(`[eule] API ${API_BASE} · workspace ${WORKSPACE_ID}`);
  let token;
  try { token = await frischerToken({ force: true }); }
  catch (e) { throw new LoginAbgelaufenError(e instanceof Error ? e.message : String(e)); }

  const dauer = schaetzeDauer(text);

  // 1) TTS (mit Workspace-Selbstfindung)
  const tts = await generiere("audios", REZEPTUR.ttsModel, {
    prompt: text,
    variant: REZEPTUR.ttsVariant,
    voice_type: "element",
    voice_id: REZEPTUR.sarahVoiceId,
  }, token);
  const audioUrl = await warteAufJob(tts.jobId, token, { label: "TTS", maxMs: 300_000 });

  // 2) VIDEO wan2_7 — dieselbe (bereits gefundene) Workspace-Form.
  const vid = await generiere("videos", REZEPTUR.videoModel, {
    prompt: REZEPTUR.eulePrompt,
    aspect_ratio: REZEPTUR.aspect,
    duration: dauer,
    start_image: { id: REZEPTUR.owlMediaId },
    audio_references: [{ id: tts.jobId, type: REZEPTUR.ttsModel }],
  }, token, tts.form);
  const videoUrl = await warteAufJob(vid.jobId, token, { label: "wan2_7", maxMs: 600_000 });

  return { videoUrl, audioRef: audioUrl, dauer };
}
