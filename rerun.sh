#!/usr/bin/env bash
# SARAH Eulen-Worker — Ein-Befehl-Neustart auf server-2.
#   cd ~/worker && git pull && bash rerun.sh
# 1) findet das higgsfield-Binary (which) und übergibt den ABSOLUTEN Pfad an den
#    Worker (HF_CLI_BIN) — behebt das ENOENT aus dem Worker-Kontext.
# 2) selektiert den Workspace direkt in dieser Shell (bewiesener Befehl von gestern).
# 3) reiht fehlgeschlagene Video-Jobs neu ein und arbeitet ALLE ab.
set -uo pipefail
cd "$(dirname "$0")"

WS="${HF_WORKSPACE_ID:-0b923f57-d0c1-479a-962d-859ae429e37a}"

# Evtl. laufenden Dauer-Dienst best-effort stoppen (kein Passwort-Hänger).
for svc in higgsfield-eule-worker eule-worker; do
  sudo -n systemctl stop "$svc" 2>/dev/null && echo "→ Dienst $svc gestoppt." || true
done

# higgsfield-Binary auflösen (npm-global-bin, nicht /usr/local/bin).
HF_CLI_BIN="$(command -v higgsfield 2>/dev/null || command -v higgs 2>/dev/null || true)"
if [ -z "$HF_CLI_BIN" ]; then
  for c in "$(npm bin -g 2>/dev/null)/higgsfield" "$(npm prefix -g 2>/dev/null)/bin/higgsfield" \
           /usr/local/bin/higgsfield /usr/bin/higgsfield "$HOME/.npm-global/bin/higgsfield"; do
    [ -x "$c" ] && HF_CLI_BIN="$c" && break
  done
fi
if [ -n "$HF_CLI_BIN" ]; then
  echo "→ higgsfield-CLI: $HF_CLI_BIN"
  export HF_CLI_BIN
  # Bewiesener Befehl direkt in der Shell (schreibt config.json + serverseitige Auswahl).
  echo "→ Workspace setzen…"
  "$HF_CLI_BIN" workspace set "$WS" 2>&1 | head -3 || "$HF_CLI_BIN" workspace select "$WS" 2>&1 | head -3 || true
else
  echo "⚠ higgsfield-CLI nicht gefunden (which higgsfield leer). Bitte prüfen: 'which higgsfield'."
fi

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
  && echo "  ok." || echo "  (Requeue meldete einen Fehler — Worker läuft trotzdem)"

echo "→ Worker arbeitet alle offenen Jobs ab…"
HF_CLI_BIN="${HF_CLI_BIN:-}" node worker.mjs --alle
echo "→ fertig. Ergebnisse stehen in der DB (video_jobs)."
