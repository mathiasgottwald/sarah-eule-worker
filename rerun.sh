#!/usr/bin/env bash
# SARAH Eulen-Worker — Ein-Befehl-Neustart auf server-2.
#   cd ~/worker && git pull && bash rerun.sh
# Holt den neuen Code, reiht fehlgeschlagene Video-Jobs neu ein und arbeitet
# ALLE offenen Jobs ab (bis die Warteschlange leer ist), dann Ende.
# Der Worker stellt vor jeder Produktion selbst sicher, dass der Higgsfield-
# Workspace selektiert ist (CLI-Select + HTTP-Fallback). Keine Handarbeit nötig.
set -uo pipefail
cd "$(dirname "$0")"

# Evtl. laufenden Dauer-Dienst stoppen, damit er nicht mit ALTER Logik dazwischenfunkt
# (bester Aufwand, ohne Passwort-Hänger). Danach ggf. wieder starten mit:
#   sudo systemctl start higgsfield-eule-worker
for svc in higgsfield-eule-worker eule-worker; do
  sudo -n systemctl stop "$svc" 2>/dev/null && echo "→ Dienst $svc gestoppt." || true
done

# .env laden (SUPABASE_URL / SERVICE_ROLE_KEY liegen NUR auf der Box).
if [ -f .env ]; then set -a; . ./.env; set +a; fi
SB="${SUPABASE_URL:-${NEXT_PUBLIC_SUPABASE_URL:-}}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
if [ -z "$SB" ] || [ -z "$KEY" ]; then
  echo "FEHLT: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in ~/worker/.env"; exit 1
fi

echo "→ fehlgeschlagene Video-Jobs neu einreihen…"
curl -s -X PATCH "$SB/rest/v1/video_jobs?status=eq.fehler" \
  -H "apikey: $KEY" -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" -H "Prefer: return=minimal" \
  -d '{"status":"queued","fehler_text":null,"verarbeitung_gestartet_am":null}' >/dev/null \
  && echo "  ok." || echo "  (Requeue-Aufruf meldete einen Fehler — Worker läuft trotzdem)"

echo "→ Worker arbeitet alle offenen Jobs ab…"
node worker.mjs --alle
echo "→ fertig. Ergebnisse stehen in der DB (video_jobs)."
