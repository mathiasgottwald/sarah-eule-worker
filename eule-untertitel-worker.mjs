#!/usr/bin/env node
/**
 * SARAH — EULEN-UNTERTITEL-WORKER (öffentlicher Mirror, KEINE Secrets).
 *
 * Der EINE nicht-Vercel-Schritt der Video-Vollautomatik: ffmpeg läuft nicht auf
 * Vercel, also rüstet dieser Worker die Karaoke-Untertitel nach. Braucht NUR
 * Supabase (URL + Service-Role-Key aus ~/worker/.env) + ffmpeg + python3/Pillow —
 * KEIN Higgsfield, KEIN OAuth, KEINE CLI-Sitzung.
 *
 * Das sprechende Video wird headless über den Vercel-Cron produziert
 * (ElevenLabs → speak/kling). Dieser Worker macht NUR die Untertitel und ist
 * damit unabhängig vom (kaputten) OAuth-/Higgsfield-Teil der Box.
 *
 * DRIFTFREI: nutzt das beim Submit gesicherte ElevenLabs-Alignment
 * (video_jobs.untertitel_align) — dieselbe Tonspur, die die kling-Lippensync
 * treibt. Das kling-Video behält SEINE Tonspur (kein zweiter TTS, kein Re-Mux).
 *
 * Aufruf:  node eule-untertitel-worker.mjs [--once]
 *   ohne --once: Dauerschleife (poll alle UNTERTITEL_POLL_SEK, Default 30) — für systemd.
 */
import "./load-env.mjs"; // MUSS zuerst stehen: lädt ~/worker/.env in process.env
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const YIG_LAUT = (process.env.ELEVENLABS_YIG_LAUT || "Yig").trim();
const FONT = process.env.EULE_FONT || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const POLL_SEK = Number(process.env.UNTERTITEL_POLL_SEK || 30);
if (!SB_URL || !SB_KEY) { console.error("[untertitel] FEHLT: SUPABASE_URL und/oder SUPABASE_SERVICE_ROLE_KEY (siehe .env.example / ~/worker/.env)."); process.exit(1); }
const H = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

async function rest(pfad, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${pfad}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`REST ${pfad} ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.status === 204 ? null : r.json();
}

/** Nächsten offenen Job atomar beanspruchen (offen → in_arbeit_untertitel). */
async function beanspruche() {
  const offen = await rest(`video_jobs?untertitel_status=eq.offen&roh_video_url=not.is.null&untertitel_align=not.is.null&select=id,text,roh_video_url,untertitel_align&limit=1`);
  if (!offen?.length) return null;
  const job = offen[0];
  const claimed = await rest(`video_jobs?id=eq.${job.id}&untertitel_status=eq.offen`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ untertitel_status: "in_arbeit_untertitel" }),
  });
  return claimed?.length ? job : null; // hat ein anderer Worker schon → null
}

async function verarbeite(job) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eule-ut-"));
  const p = (f) => path.join(tmp, f);
  try {
    // 1) Roh-Video (kling) laden.
    fs.writeFileSync(p("in.mp4"), Buffer.from(await (await fetch(job.roh_video_url)).arrayBuffer()));
    // 2) Echte Maße erkennen.
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.4", "-i", p("in.mp4"), "-frames:v", "1", p("probe.png")], { stdio: "inherit" });
    const [W, Hh] = execFileSync("python3", ["-c", `from PIL import Image;w,h=Image.open('${p("probe.png")}').size;print(w,h)`]).toString().trim().split(/\s+/).map(Number);
    // 3) Alignment → Karaoke-PNGs.
    const al = typeof job.untertitel_align === "string" ? JSON.parse(job.untertitel_align) : job.untertitel_align;
    if (!al?.characters?.length) throw new Error("kein gültiges Alignment");
    fs.writeFileSync(p("align.json"), JSON.stringify(al));
    fs.writeFileSync(p("cfg.json"), JSON.stringify({ W, H: Hh, laut: YIG_LAUT, align: p("align.json"), out: tmp, font: FONT }));
    fs.writeFileSync(p("k.py"), PYTHON);
    execFileSync("python3", [p("k.py"), p("cfg.json")], { stdio: "inherit" });
    const segs = JSON.parse(fs.readFileSync(p("segs.json"), "utf8"));
    if (!segs.length) throw new Error("keine Untertitel-Segmente");
    // 4) Overlay über das Video — Original-Tonspur (kling) behalten.
    const inputs = ["-i", p("in.mp4")];
    for (let i = 0; i < segs.length; i++) inputs.push("-i", p(`w${i}.png`));
    let prev = "0:v";
    const caps = segs.map((sg, i) => { const inp = prev; const out = i === segs.length - 1 ? "vout" : `c${i}`; prev = out; return `[${inp}][${i + 1}:v]overlay=0:0:enable='between(t,${sg[0]},${sg[1]})'[${out}]`; });
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", caps.join(";"), "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", p("out.mp4")], { stdio: "inherit" });
    // 5) Upload → Supabase (Bucket 'eulen').
    const name = `yig-untertitel-${job.id}.mp4`;
    const put = await fetch(`${SB_URL}/storage/v1/object/eulen/${name}`, {
      method: "POST", headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "video/mp4", "x-upsert": "true" }, body: fs.readFileSync(p("out.mp4")),
    });
    if (!put.ok) throw new Error(`Upload ${put.status}: ${(await put.text()).slice(0, 140)}`);
    const finalUrl = `${SB_URL}/storage/v1/object/public/eulen/${name}`;
    await rest(`video_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ video_url: finalUrl, untertitel_status: "fertig", fehler_text: null }) });
    console.log(`✓ ${job.id} → ${finalUrl}`);
  } catch (e) {
    console.error(`✗ ${job.id}: ${e.message}`);
    await rest(`video_jobs?id=eq.${job.id}`, { method: "PATCH", body: JSON.stringify({ untertitel_status: "fehler", fehler_text: `Untertitel: ${e.message}`.slice(0, 400) }) }).catch(() => {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// PIL-Karaoke: je Wort ein transparentes PNG (aktives Wort GOLD, Rest weiß), unten.
const PYTHON = `import sys, json, re
from PIL import Image, ImageDraw, ImageFont
cfg=json.load(open(sys.argv[1])); W,H,laut,outdir=cfg["W"],cfg["H"],cfg["laut"],cfg["out"]
al=json.load(open(cfg["align"])); chars=al["characters"]; st=al["character_start_times_seconds"]; et=al["character_end_times_seconds"]
words=[]; cur=None
for i,c in enumerate(chars):
    if c in (" ","\\n"):
        if cur: words.append(cur); cur=None
        continue
    if not cur: cur={"t":"","s":st[i],"e":et[i]}
    cur["t"]+=c; cur["e"]=et[i]
if cur: words.append(cur)
for w in words: w["t"]=re.sub(r"\\b"+re.escape(laut)+r"\\b","YIG",w["t"])
font=ImageFont.truetype(cfg["font"], round(H/21)); maxw=W-2*round(W*0.06); safe=round(H*0.07); stroke=max(4,round(font.size*0.10))
d0=ImageDraw.Draw(Image.new("RGBA",(W,H))); sw=d0.textlength(" ",font=font)
phrases=[]; cur=[]; curw=0
for idx,w in enumerate(words):
    ww=d0.textlength(w["t"],font=font); add=ww+(sw if cur else 0)
    if cur and curw+add>maxw: phrases.append(cur); cur=[]; curw=0; add=ww
    cur.append(idx); curw+=add
    if re.search(r"[.!?…]$",w["t"]) or len(cur)>=6: phrases.append(cur); cur=[]; curw=0
if cur: phrases.append(cur)
GOLD=(255,205,110,255); WHITE=(255,255,255,255); segs=[]; n=0
for ph in phrases:
    widths=[d0.textlength(words[i]["t"],font=font) for i in ph]; total=sum(widths)+sw*(len(ph)-1)
    for wi in ph:
        img=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(img); x=(W-total)/2; y=H-safe-int(font.size*1.25)
        for k,i in enumerate(ph):
            d.text((x,y),words[i]["t"],font=font,fill=(GOLD if i==wi else WHITE),stroke_width=stroke,stroke_fill=(0,0,0,235)); x+=widths[k]+sw
        img.save(f"{outdir}/w{n}.png")
        s=words[wi]["s"]; e=words[wi+1]["s"] if wi+1<len(words) else words[wi]["e"]+0.4
        segs.append([round(s,2),round(e,2)]); n+=1
json.dump(segs,open(f"{outdir}/segs.json","w")); print("Karaoke-Wörter:",n)
`;

async function durchlauf() {
  let n = 0;
  for (;;) { const job = await beanspruche(); if (!job) break; await verarbeite(job); n++; }
  return n;
}

if (process.argv.includes("--once")) {
  const n = await durchlauf();
  console.log(`Fertig: ${n} Video(s) untertitelt.`);
} else {
  console.log(`Untertitel-Worker läuft (poll alle ${POLL_SEK}s). Strg+C zum Beenden.`);
  for (;;) {
    try { const n = await durchlauf(); if (n) console.log(`(${n} verarbeitet)`); } catch (e) { console.error("Durchlauf-Fehler:", e.message); }
    await new Promise((r) => setTimeout(r, POLL_SEK * 1000));
  }
}
