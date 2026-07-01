/**
 * Higgsfield-Eulen-Kette — CLI-FREI, direkte HTTP-API gegen fnf-api-gw mit
 * Bearer-Token (aus hf-token.mjs, vor jedem Lauf erneuert).
 *
 * WORKSPACE-SELBSTFINDUNG v2: Surface/Placement allein reichten nicht (alle 6
 * Formen → 422 „X-Fnf-Workspace-Id missing"). Die CLI schickt IMMER das volle
 * X-Fnf-Trio (User-Id + Surface + Workspace-Id); der Gateway ehrt den Workspace-
 * Header offenbar nur mit passender User-Id. Diese holt der Worker aus
 * /account/workspaces (nur Bearer nötig) und probiert dann Kandidaten durch.
 * Scheitert weiterhin ALLES, wird die rohe /account/workspaces-Antwort in den
 * Fehlertext geschrieben (damit die echte Struktur sichtbar wird).
 */
import { frischerToken } from "./hf-token.mjs";

const API_BASE = (process.env.HF_API_BASE || "https://fnf-api-gw.higgsfield.ai/fnf").trim().replace(/\/+$/, "");
const WORKSPACE_ID = (process.env.HF_WORKSPACE_ID || "0b923f57-d0c1-479a-962d-859ae429e37a").trim();

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

export class LoginAbgelaufenError extends Error {
  constructor(msg) { super(msg); this.name = "LoginAbgelaufenError"; }
}

export function schaetzeDauer(text) {
  const woerter = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.min(REZEPTUR.maxClipSek, Math.ceil(woerter / 2.3) || 2));
}

const istWorkspaceFehler = (t) => /workspace/i.test(t) && /(missing|required|not found|no workspace|select)/i.test(t);
const istCreditFehler = (t) => /credit|not enough|insufficient|balance/i.test(t);

function headersFuer(token, surface, userId) {
  const h = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "x-fnf-workspace-id": WORKSPACE_ID,
    "x-fnf-surface": surface,
  };
  if (userId) h["x-fnf-user-id"] = userId;
  return h;
}

function jobIdAus(resp) {
  const j = resp || {};
  const id = j.job_id || (Array.isArray(j.jobs) && j.jobs[0] && (j.jobs[0].job_id || j.jobs[0].id)) || j.job_set_id || j.id;
  if (!id) throw new Error(`keine job-id: ${JSON.stringify(j).slice(0, 200)}`);
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

/**
 * /account/workspaces je Surface holen → welche Surface hat den Workspace
 * SELECTED (is_selected=true)? Die Workspace-Auswahl ist SURFACE-spezifisch;
 * per MCP wurde sie für surface 'mcp' gesetzt. Gibt {raw, selektierteSurface}.
 */
async function holeKontext(token) {
  let raw = "";
  let selektiert = null;
  for (const surface of ["mcp", "app", "web", "cli", "developer"]) {
    const res = await fetch(`${API_BASE}/developer/v2alpha/account/workspaces`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-fnf-surface": surface },
    });
    if (res.status === 401) throw new LoginAbgelaufenError("401 /account/workspaces");
    const t = await res.text();
    if (surface === "mcp") raw = t.slice(0, 500);
    if (new RegExp(`"id":"${WORKSPACE_ID}"[^}]*"is_selected":true`, "i").test(t) || /"is_selected":true/i.test(t)) {
      selektiert = surface;
      break;
    }
  }
  return { raw, selektierteSurface: selektiert };
}

/** Kandidaten-Formen. Die Surface mit selektiertem Workspace zuerst, dann übrige. */
function formenFuer(selektierteSurface) {
  const surfaces = [selektierteSurface, "mcp", "app", "web", "cli", "developer"].filter(Boolean);
  const uniq = [...new Set(surfaces)];
  const formen = uniq.map((surface) => ({ surface, uid: "", ort: "header" }));
  formen.push({ surface: uniq[0], uid: "", ort: "query" });
  return formen;
}

/** Generierung mit Formen-Durchlauf (oder fixer Form für Folge-Calls). Gibt {jobId, form}. */
async function generiere(kind, model, params, token, { formen, nurForm }) {
  const liste = nurForm ? [nurForm] : formen;
  const versucht = [];
  let letzter = "";
  for (const form of liste) {
    let url = `${API_BASE}/developer/v2alpha/${kind}/${model}/generations`;
    const body = { params: { ...params } };
    if (form.ort === "query") url += `?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`;
    else if (form.ort === "body") body.workspace_id = WORKSPACE_ID;
    else if (form.ort === "params") body.params.workspace_id = WORKSPACE_ID;

    const res = await fetch(url, { method: "POST", headers: headersFuer(token, form.surface, form.uid), body: JSON.stringify(body) });
    const txt = await res.text();
    if (res.status === 401) throw new LoginAbgelaufenError(`401 ${kind}/${model}`);
    if (res.ok) {
      console.log(`[eule] Workspace-Form OK: surface=${form.surface} uid=${form.uid || "-"} ort=${form.ort} (${kind}/${model})`);
      return { jobId: jobIdAus(JSON.parse(txt)), form };
    }
    versucht.push(`${form.surface}/${form.uid ? "uid" : "no-uid"}/${form.ort}`);
    if (istWorkspaceFehler(txt) && !nurForm) { letzter = txt.slice(0, 90); continue; }
    if (istCreditFehler(txt)) throw new Error(`Form [${form.surface}/${form.ort}] akzeptiert, ABER Credits fehlen: ${txt.slice(0, 200)}`);
    throw new Error(`Form [${form.surface}/${form.ort}] ${kind}/${model} -> ${res.status}: ${txt.slice(0, 250)}`);
  }
  const e = new Error(`Keine Workspace-Form akzeptiert (${kind}/${model}). Versucht: ${versucht.join(", ")}. Letzter: ${letzter}`);
  e._keineForm = true;
  throw e;
}

async function warteAufJob(jobId, token, form, { maxMs = 600_000, intervallMs = 6000, label = "job" } = {}) {
  const start = Date.now();
  let letzter = "";
  const h = headersFuer(token, form?.surface || "cli", form?.uid);
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, intervallMs));
    let job = null;
    try {
      const res = await fetch(`${API_BASE}/developer/v2alpha/jobs/${encodeURIComponent(jobId)}`, { headers: h });
      if (res.status === 401) throw new LoginAbgelaufenError("401 Job-Poll");
      if (res.ok) job = await res.json();
    } catch (e) { if (e instanceof LoginAbgelaufenError) throw e; }
    if (!job) continue;
    const status = String(job.job_status ?? job.status ?? "").toLowerCase();
    letzter = status;
    if (["completed", "complete", "succeeded", "success"].includes(status)) {
      const url = ergebnisUrl(job);
      if (!url) throw new Error(`${label} fertig, keine URL: ${JSON.stringify(job).slice(0, 250)}`);
      return url;
    }
    if (["failed", "error", "nsfw", "canceled", "cancelled"].includes(status)) {
      throw new Error(`${label} Status '${status}': ${JSON.stringify(job).slice(0, 250)}`);
    }
  }
  throw new Error(`${label} Timeout ${Math.round(maxMs / 1000)}s (Status '${letzter}')`);
}

export async function produziereEule(text) {
  console.log(`[eule] API ${API_BASE} · workspace ${WORKSPACE_ID}`);
  let token;
  try { token = await frischerToken({ force: true }); }
  catch (e) { throw new LoginAbgelaufenError(e instanceof Error ? e.message : String(e)); }

  const kontext = await holeKontext(token);
  console.log(`[eule] selektierte Surface: ${kontext.selektierteSurface || "(keine — Workspace nirgends selected!)"}`);
  const formen = formenFuer(kontext.selektierteSurface);
  const dauer = schaetzeDauer(text);

  // 1) TTS
  let tts;
  try {
    tts = await generiere("audios", REZEPTUR.ttsModel, {
      prompt: text, variant: REZEPTUR.ttsVariant, voice_type: "element", voice_id: REZEPTUR.sarahVoiceId,
    }, token, { formen });
  } catch (e) {
    if (e._keineForm) throw new Error(`${e.message} || /account/workspaces-Antwort: ${kontext.raw}`);
    throw e;
  }
  const audioUrl = await warteAufJob(tts.jobId, token, tts.form, { label: "TTS", maxMs: 300_000 });

  // 2) wan2_7 (gleiche Form)
  const vid = await generiere("videos", REZEPTUR.videoModel, {
    prompt: REZEPTUR.eulePrompt, aspect_ratio: REZEPTUR.aspect, duration: dauer,
    start_image: { id: REZEPTUR.owlMediaId }, audio_references: [{ id: tts.jobId, type: REZEPTUR.ttsModel }],
  }, token, { nurForm: tts.form });
  const videoUrl = await warteAufJob(vid.jobId, token, tts.form, { label: "wan2_7", maxMs: 600_000 });

  return { videoUrl, audioRef: audioUrl, dauer };
}
