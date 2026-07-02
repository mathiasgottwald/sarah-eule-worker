/**
 * Higgsfield-Eulen-Kette — HTTP gegen fnf-api-gw mit Bearer-Token
 * (aus hf-token.mjs, vor jedem Lauf erneuert).
 *
 * KNOTEN GELÖST (02.07.2026): Generierungen brauchen einen server-seitig
 * SELEKTIERTEN (Billing-)Workspace. /account/workspaces zeigte is_selected=FALSE
 * → der Gateway spritzt dann KEINEN X-Fnf-Workspace-Id-Header ein → Backend
 * meldet „missing header". Kein Client-Header behebt das; nur die Selektion.
 *
 * Vor jeder Produktion:
 *   1) CLI `higgsfield workspace set <id>` (ABSOLUTER Pfad via HF_CLI_BIN, von
 *      rerun.sh per `which higgsfield` aufgelöst — die CLI liegt im npm-Global-
 *      Bin, NICHT /usr/local/bin → gestern ENOENT). Das ist der gestern bewiesene
 *      Befehl („Selected workspace: …"). Hartes Timeout, kein Hängen.
 *   2) Diagnose: is_selected je Surface loggen (hat set server-seitig gewirkt?).
 *   3) Generieren über alle Surfaces durchprobieren (selektierte zuerst).
 * Lehnen ALLE Surfaces den Workspace ab → finaler Beweis, dass generations für
 * diesen Account nicht gehen (dann anderer Weg: MCP/Web). Sonst: Video-URL.
 */
import { execFile } from "node:child_process";
import { frischerToken } from "./hf-token.mjs";

const API_BASE = (process.env.HF_API_BASE || "https://fnf-api-gw.higgsfield.ai/fnf").trim().replace(/\/+$/, "");
const WORKSPACE_ID = (process.env.HF_WORKSPACE_ID || "0b923f57-d0c1-479a-962d-859ae429e37a").trim();
// Absoluter Pfad zur CLI. rerun.sh löst ihn per `which higgsfield` auf und
// übergibt HF_CLI_BIN (die CLI wurde per `npm i -g` installiert → NICHT
// /usr/local/bin, daher gestern ENOENT). Fallback: blanker Name via PATH.
const CLI_BIN = (process.env.HF_CLI_BIN || "higgsfield").trim();
// Surfaces, die wir zum Generieren durchprobieren (Reihenfolge = Priorität).
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

/**
 * CLI `higgsfield workspace set <id>` — der GESTERN bewiesene Befehl
 * („Selected workspace: …"). Absoluter Pfad (CLI_BIN), hartes Timeout, kein
 * Hängen. Versucht `set` (bewiesen) und `select` (neuere CLI). Gibt Log-String.
 */
function cliWorkspaceSetzen() {
  const run = (args) => new Promise((resolve) => {
    execFile(CLI_BIN, args, {
      timeout: 25_000, killSignal: "SIGKILL",
      env: { ...process.env, HOME: process.env.HOME || "/home/ubuntu", PATH: `${process.env.PATH || ""}:/usr/local/bin:/usr/bin:/bin` },
    }, (err, stdout, stderr) => resolve({
      code: err?.code, enoent: err?.code === "ENOENT", killed: err?.killed,
      out: `${stdout || ""}${stderr || ""}`.replace(/\s+/g, " ").trim().slice(0, 160),
    }));
  });
  return (async () => {
    const log = [];
    for (const sub of ["set", "select"]) {
      const r = await run(["workspace", sub, WORKSPACE_ID]);
      log.push(`${CLI_BIN} workspace ${sub} → ${r.enoent ? "ENOENT" : r.killed ? "TIMEOUT" : (r.code ?? "OK")}${r.out ? " · " + r.out : ""}`);
      if (!r.code && !r.killed) break; // Erfolg → zweiten nicht nötig
    }
    return log.join(" | ");
  })();
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

/** EIN Generierungs-Versuch mit fester Surface. Gibt {ok, jobId} oder {ok:false, workspace, txt, status}. */
async function generiereEinmal(kind, model, params, token, surface) {
  const res = await fetch(`${API_BASE}/developer/v2alpha/${kind}/${model}/generations`, {
    method: "POST", headers: headersFuer(token, surface), body: JSON.stringify({ params: { ...params } }),
  });
  const txt = await res.text();
  if (res.status === 401) throw new LoginAbgelaufenError(`401 ${kind}/${model}`);
  if (res.ok) return { ok: true, jobId: jobIdAus(JSON.parse(txt)) };
  if (istCreditFehler(txt)) throw new Error(`${kind}/${model}: Credits fehlen — ${txt.slice(0, 200)}`);
  return { ok: false, workspace: istWorkspaceFehler(txt), status: res.status, txt: txt.replace(/\s+/g, " ").slice(0, 160) };
}

/**
 * Generieren ROBUST: probiert die Surfaces durch (Workspace ist per `workspace
 * set` selektiert). Erster Erfolg → {jobId, surface}. Meckern ALLE über den
 * Workspace → finaler Beweis, dass generations für diesen Account nicht gehen.
 */
async function generiereRobust(kind, model, params, token, surfaces) {
  const versuche = [];
  for (const surface of surfaces) {
    const r = await generiereEinmal(kind, model, params, token, surface);
    if (r.ok) { console.log(`[eule] ${kind}/${model} OK (surface=${surface}).`); return { jobId: r.jobId, surface }; }
    versuche.push(`${surface}:${r.status}${r.workspace ? "(ws)" : ""}`);
    if (!r.workspace) throw new Error(`${kind}/${model} [${surface}] -> ${r.status}: ${r.txt}`); // echter anderer Fehler
  }
  const e = new Error(`${kind}/${model}: ALLE Surfaces lehnen den Workspace ab -> ${versuche.join(", ")}`);
  e._workspaceFinal = true;
  throw e;
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
  console.log(`[eule] API ${API_BASE} · workspace ${WORKSPACE_ID} · CLI ${CLI_BIN}`);
  let token;
  try { token = await frischerToken({ force: true }); }
  catch (e) { throw new LoginAbgelaufenError(e instanceof Error ? e.message : String(e)); }

  // Bewiesener Weg: CLI `workspace set <id>` (absoluter Pfad, kein ENOENT mehr).
  const cliLog = await cliWorkspaceSetzen().catch((e) => `cli-fehler:${(e?.message || "").slice(0, 80)}`);
  console.log(`[eule] ${cliLog}`);
  // Diagnose: hat der set-Befehl is_selected server-seitig gesetzt?
  const st = await workspaceStatus(token);
  console.log(`[eule] is_selected nach set: ${JSON.stringify(st.alle)} → selektiert=${st.selektierteSurface || "KEINE"}`);
  // Generieren: selektierte Surface zuerst, dann alle übrigen durchprobieren.
  const surfaces = [...new Set([st.selektierteSurface, ...SURFACES].filter(Boolean))];
  const dauer = schaetzeDauer(text);

  const macheFinal = (e) => {
    if (e && e._workspaceFinal) {
      e.message = `${e.message} || CLI: ${cliLog} || is_selected: ${JSON.stringify(st.alle)} || ` +
        `FINALER BEFUND: Auch nach 'workspace set' akzeptiert der fnf-api-gw den Workspace für generations NICHT (privater Plus-Account). Anderer Produktionsweg nötig (MCP/Web).`;
    }
    return e;
  };

  // 1) TTS
  let tts;
  try {
    tts = await generiereRobust("audios", REZEPTUR.ttsModel, {
      prompt: text, variant: REZEPTUR.ttsVariant, voice_type: "element", voice_id: REZEPTUR.sarahVoiceId,
    }, token, surfaces);
  } catch (e) { throw macheFinal(e); }
  const audioUrl = await warteAufJob(tts.jobId, token, tts.surface, { label: "TTS", maxMs: 300_000 });

  // 2) wan2_7 (gleiche Surface wie erfolgreiches TTS)
  const vid = await generiereRobust("videos", REZEPTUR.videoModel, {
    prompt: REZEPTUR.eulePrompt, aspect_ratio: REZEPTUR.aspect, duration: dauer,
    start_image: { id: REZEPTUR.owlMediaId }, audio_references: [{ id: tts.jobId, type: REZEPTUR.ttsModel }],
  }, token, [tts.surface]).catch((e) => { throw macheFinal(e); });
  const videoUrl = await warteAufJob(vid.jobId, token, tts.surface, { label: "wan2_7", maxMs: 600_000 });

  return { videoUrl, audioRef: audioUrl, dauer };
}
