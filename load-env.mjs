/**
 * Lädt ~/worker/.env (die Datei NEBEN diesem Script) in process.env — robust und
 * ohne Abhängigkeit. Muss als ERSTER Import in worker.mjs stehen (Seiteneffekt),
 * damit die Variablen vor allen anderen Modulen gesetzt sind.
 *
 * Warum: worker.mjs las bisher nur process.env. Beim manuellen `node worker.mjs`
 * wurde die .env NIE geladen (kein dotenv) → „SUPABASE_URL/…_KEY FEHLT". Unter
 * systemd griff nur EnvironmentFile. Dieser Loader macht beide Wege konsistent.
 *
 * Verhalten: setzt einen Key NUR, wenn er noch nicht in der echten Umgebung steht
 * (systemd/Shell gewinnt). Trimmt Werte (fängt CRLF/Leerzeichen), entfernt BOM,
 * stripped umschließende Anführungszeichen, ignoriert Kommentare/Leerzeilen.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.WORKER_ENV_FILE || path.join(here, ".env");

try {
  let txt = fs.readFileSync(file, "utf8");
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1); // BOM entfernen
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
  }
} catch {
  /* keine .env vorhanden → echte Umgebung (systemd/Shell) wird genutzt */
}
