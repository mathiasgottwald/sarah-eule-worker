/**
 * Higgsfield-Eulen-Kette — HTTP gegen fnf-api-gw mit Bearer-Token
 * (aus hf-token.mjs, vor jedem Lauf erneuert).
 *
 * KNOTEN GELÖST (02.07.2026): Generierungen brauchen einen server-seitig
 * SELEKTIERTEN (Billing-)Workspace. /account/workspaces zeigte is_selected=FALSE
 * → der Gateway spritzt dann KEINEN X-Fnf-Workspace-Id-Header ein → Backend
 * meldet „missing header". Kein Client-Header behebt das; nur die Selektion.
 *
 * `stelleWorkspaceSicher()` stellt vor jeder Produktion sicher, dass der
 * Workspace selektiert ist:
 *   1) Status je Surface prüfen (is_selected?).
 *   2) Wenn nicht: CLI `higgsfield workspace select <id>` (bzw. `set`) —
 *      die CLL kennt den exakten Select-Endpunkt; läuft mit hartem Timeout.
 *   3) Zusätzlich HTTP-Selbst-Select (Kandidaten-Endpunkte, mit Token).
 *   4) Erneut prüfen; die Surface mit is_selected=true wird zum Generieren genutzt.
 * Scheitert alles, landet eine glasklare Diagnose im Fehlertext.
 */
import { execFile } from "node:child_process";
import { frischerToken } from "./hf-token.mjs";

const API_BASE = (process.env.HF_API_BASE || "https://fnf-api-gw.higgsfield.ai/fnf").trim().replace(/\/+$/, "");
const WORKSPACE_ID = (process.env.HF_WORKSPACE_ID || "0b923f57-d0c1-479a-962d-859ae429e37a").trim();
const CLI_BIN = (process.env.HF_CLI_BIN || "/usr/local/bin/higgsfield").trim();
// Surfaces, für die wir Selektion versuchen/nutzen (Reihenfolge = Priorität).
const SURFACES = (process.env.HF_SURFACES || "cli,developer,mcp,app,web").split(",").map((s) => s.trim()).filter(Boolean);

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

function headersFuer(token, surface) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "x-fnf-workspace-id": WORKSPACE_ID,
    "x-fnf-surface": surface,
  };
}

/* ---------- Workspace-Selektion sicherstellen ----------------------------- */

/** /account/workspaces je Surface → welche Surface hat WORKSPACE_ID is_selected=true. */
async function workspaceStatus(token) {
  const alle = {};
  let raw = "";
  let selektiert = null;
  for (const surface of SURFACES) {
    try {
      const res = await fetch(`${API_BASE}/developer/v2alpha/account/workspaces`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "x-fnf-surface": surface },
      });
      if (res.status === 401) throw new LoginAbgelaufenError("401 /account/workspaces");
      const t = await res.text();
      if (!raw) raw = t.slice(0, 600);
      // Ist GENAU unser Workspace selektiert? (Objekt-genau, nicht irgendeiner.)
      let sel = false;
      try {
        const j = JSON.parse(t);
        const items = Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
        sel = items.some((w) => w && w.id === WORKSPACE_ID && w.is_selected === true);
      } catch { sel = new RegExp(`"id":"${WORKSPACE_ID}"[^{]*"is_selected":true`).test(t); }
      alle[surface] = sel;
      if (sel && !selektiert) selektiert = surface;
    } catch (e) {
      if (e instanceof LoginAbgelaufenError) throw e;
      alle[surface] = `err:${e.message?.slice(0, 40)}`;
    }
  }
  return { selektierteSurface: selektiert, alle, raw };
}

/** CLI-Select (kennt den exakten Endpunkt). Hartes Timeout, kein Hängen. */
function cliSelect() {
  const run = (args) => new Promise((resolve) => {
    execFile(CLI_BIN, args, { timeout: 25_000, killSignal: "SIGKILL", env: { ...process.env, HOME: process.env.HOME || "/home/ubuntu", PATH: `${process.env.PATH || ""}:/usr/local/bin:/usr/bin:/bin` } },
      (err, stdout, stderr) => resolve({ code: err?.code, killed: err?.killed, out: `${stdout || ""}${stderr || ""}`.trim().slice(0, 200) }));
  });
  return (async () => {
    const versuche = [["workspace", "select", WORKSPACE_ID], ["workspace", "set", WORKSPACE_ID]];
    const log = [];
    for (const args of versuche) {
      const r = await run(args);
      log.push(`${args.join(" ")} → ${r.killed ? "TIMEOUT" : (r.code ?? "ok")}${r.out ? " · " + r.out : ""}`);
      if (!r.code && !r.killed) break; // Erfolg
    }
    return log.join(" | ");
  })();
}

/** HTTP-Selbst-Select: Kandidaten-Endpunkte mit Token+Surface. true bei 2xx. */
async function httpSelect(token, surface) {
  const kandidaten = [
    ["POST", `/developer/v2alpha/account/workspaces/${WORKSPACE_ID}/select`, {}],
    ["POST", `/developer/v2alpha/account/workspaces/select`, { workspace_id: WORKSPACE_ID }],
    ["PATCH", `/developer/v2alpha/account/workspaces/${WORKSPACE_ID}`, { is_selected: true }],
    ["POST", `/developer/v2alpha/account/select-workspace`, { workspace_id: WORKSPACE_ID }],
    ["PUT", `/developer/v2alpha/account/selected-workspace`, { workspace_id: WORKSPACE_ID }],
  ];
  const notizen = [];
  for (const [method, pfad, body] of kandidaten) {
    try {
      const res = await fetch(`${API_BASE}${pfad}`, { method, headers: headersFuer(token, surface), body: JSON.stringify(body) });
      if (res.status === 401) throw new LoginAbgelaufenError("401 select");
      if (res.ok) { notizen.push(`${method} ${pfad} → ${res.status} OK`); return { ok: true, notiz: notizen.join(" | ") }; }
      notizen.push(`${method.split("")[0]}${pfad.split("/").pop()}:${res.status}`);
    } catch (e) { if (e instanceof LoginAbgelaufenError) throw e; }
  }
  return { ok: false, notiz: notizen.join(" ") };
}

/**
 * Stellt sicher, dass WORKSPACE_ID selektiert ist, und gibt die Surface zurück,
 * mit der generiert werden soll. Wirft mit Diagnose, wenn nichts greift.
 */
async function stelleWorkspaceSicher(token) {
  let st = await workspaceStatus(token);
  if (st.selektierteSurface) return st.selektierteSurface;

  const cliLog = await cliSelect().catch((e) => `cli-fehler:${e.message?.slice(0, 80)}`);
  st = await workspaceStatus(token);
  if (st.selektierteSurface) { console.log(`[eule] Workspace via CLI selektiert (surface=${st.selektierteSurface}).`); return st.selektierteSurface; }

  const httpNotizen = [];
  for (const surface of SURFACES) {
    const r = await httpSelect(token, surface);
    httpNotizen.push(`${surface}:[${r.notiz}]`);
    if (r.ok) {
      st = await workspaceStatus(token);
      if (st.selektierteSurface) { console.log(`[eule] Workspace via HTTP selektiert (surface=${st.selektierteSurface}).`); return st.selektierteSurface; }
    }
  }

  const e = new Error(
    `Workspace ${WORKSPACE_ID} ließ sich NICHT selektieren. ` +
    `CLI: ${cliLog}. HTTP: ${httpNotizen.join(" ")}. ` +
    `Status je Surface: ${JSON.stringify(st.alle)}. /account/workspaces: ${st.raw}`,
  );
  e._keineSelektion = true;
  throw e;
}

/* ---------- Generierung ---------------------------------------------------- */

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

/** Generieren mit fester Surface (Workspace ist selektiert). Query-Fallback bei Workspace-Meckern. */
async function generiere(kind, model, params, token, surface) {
  const url = `${API_BASE}/developer/v2alpha/${kind}/${model}/generations`;
  const varianten = [
    { u: url, extra: {} },
    { u: `${url}?workspace_id=${encodeURIComponent(WORKSPACE_ID)}`, extra: {} }, // Query-Fallback
  ];
  let letzter = "";
  for (const v of varianten) {
    const res = await fetch(v.u, { method: "POST", headers: headersFuer(token, surface), body: JSON.stringify({ params: { ...params } }) });
    const txt = await res.text();
    if (res.status === 401) throw new LoginAbgelaufenError(`401 ${kind}/${model}`);
    if (res.ok) { console.log(`[eule] ${kind}/${model} OK (surface=${surface}).`); return jobIdAus(JSON.parse(txt)); }
    if (istCreditFehler(txt)) throw new Error(`${kind}/${model}: Credits fehlen — ${txt.slice(0, 200)}`);
    letzter = `${res.status}: ${txt.slice(0, 200)}`;
    if (!istWorkspaceFehler(txt)) throw new Error(`${kind}/${model} -> ${letzter}`);
  }
  throw new Error(`${kind}/${model}: Workspace weiterhin abgelehnt (surface=${surface}) -> ${letzter}`);
}

async function warteAufJob(jobId, token, surface, { maxMs = 600_000, intervallMs = 6000, label = "job" } = {}) {
  const start = Date.now();
  let letzter = "";
  const h = headersFuer(token, surface);
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
      const u = ergebnisUrl(job);
      if (!u) throw new Error(`${label} fertig, keine URL: ${JSON.stringify(job).slice(0, 250)}`);
      return u;
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

  const surface = await stelleWorkspaceSicher(token);
  console.log(`[eule] generiere mit surface=${surface}`);
  const dauer = schaetzeDauer(text);

  // 1) TTS
  const ttsJobId = await generiere("audios", REZEPTUR.ttsModel, {
    prompt: text, variant: REZEPTUR.ttsVariant, voice_type: "element", voice_id: REZEPTUR.sarahVoiceId,
  }, token, surface);
  const audioUrl = await warteAufJob(ttsJobId, token, surface, { label: "TTS", maxMs: 300_000 });

  // 2) wan2_7 (gleiche Surface)
  const vidJobId = await generiere("videos", REZEPTUR.videoModel, {
    prompt: REZEPTUR.eulePrompt, aspect_ratio: REZEPTUR.aspect, duration: dauer,
    start_image: { id: REZEPTUR.owlMediaId }, audio_references: [{ id: ttsJobId, type: REZEPTUR.ttsModel }],
  }, token, surface);
  const videoUrl = await warteAufJob(vidJobId, token, surface, { label: "wan2_7", maxMs: 600_000 });

  return { videoUrl, audioRef: audioUrl, dauer };
}
