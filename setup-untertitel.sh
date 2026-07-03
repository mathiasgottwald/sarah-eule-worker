#!/usr/bin/env bash
# =============================================================================
# SARAH — Untertitel-Worker als DAUERDIENST auf server-2 (einmalig ausführen).
#
# Der EINZIGE nicht-Vercel-Schritt der Video-Vollautomatik: ffmpeg läuft nicht
# auf Vercel, also rüstet dieser Dienst die Karaoke-Untertitel nach. Danach läuft
# Content-Ausarbeitung → fertiges, untertiteltes YIG-Video für immer ohne Session.
#
# Läuft neben dem bestehenden Eulen-Worker in DIESEM Repo (~/worker). Nutzt die
# GLEICHE .env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — KEINE neuen Secrets,
# KEIN Higgsfield, KEIN OAuth.
#
# Ausführen (idempotent, beliebig oft):
#     cd ~/worker && git pull && bash setup-untertitel.sh
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC="sarah-untertitel"
ENVFILE="$REPO/.env"

echo "▸ Repo: $REPO"
[ -f "$ENVFILE" ] || { echo "✗ $ENVFILE fehlt — dort müssen SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY stehen (wie beim Eulen-Worker)."; exit 1; }
grep -q '^SUPABASE_URL=' "$ENVFILE" && grep -q '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVFILE" \
  || { echo "✗ In $ENVFILE fehlen SUPABASE_URL und/oder SUPABASE_SERVICE_ROLE_KEY."; exit 1; }

# --- Abhängigkeiten (idempotent): NUR ffmpeg + python3 + Pillow + Schrift -----
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
need=0
command -v ffmpeg  >/dev/null 2>&1 || need=1
command -v python3 >/dev/null 2>&1 || need=1
python3 -c "import PIL" >/dev/null 2>&1 || need=1
if [ "$need" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  echo "▸ Installiere ffmpeg / python3 / Pillow / Schriften …"
  $SUDO apt-get update -y
  $SUDO apt-get install -y ffmpeg python3 python3-pil fonts-dejavu-core
fi
command -v node   >/dev/null 2>&1 || { echo "✗ Node ≥18 nicht gefunden."; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "✗ ffmpeg fehlt."; exit 1; }
python3 -c "import PIL" >/dev/null 2>&1 || { echo "✗ python3-Pillow fehlt."; exit 1; }

# --- Fette Schrift finden (Linux hat kein Arial) -----------------------------
FONT=""
for f in /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
         /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf \
         /usr/share/fonts/TTF/DejaVuSans-Bold.ttf ; do
  [ -f "$f" ] && FONT="$f" && break
done
[ -n "$FONT" ] || FONT="$(fc-match -f '%{file}' 'sans:bold' 2>/dev/null || true)"
[ -n "$FONT" ] && [ -f "$FONT" ] || { echo "✗ Keine fette TTF-Schrift gefunden (fonts-dejavu-core installieren)."; exit 1; }
echo "▸ Schrift: $FONT"

NODE_BIN="$(command -v node)"
RUN_USER="$(id -un)"

# --- systemd-Dienst (bevorzugt) ----------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  UNIT="/etc/systemd/system/$SVC.service"
  echo "▸ Schreibe $UNIT (User=$RUN_USER)"
  $SUDO tee "$UNIT" >/dev/null <<UNITEOF
[Unit]
Description=SARAH Eulen-Untertitel-Worker (Karaoke auf kling-Videos)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO
EnvironmentFile=$ENVFILE
Environment=EULE_FONT=$FONT
Environment=UNTERTITEL_POLL_SEK=30
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN $REPO/eule-untertitel-worker.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNITEOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SVC"
  $SUDO systemctl restart "$SVC"
  sleep 2
  $SUDO systemctl --no-pager --lines=6 status "$SVC" || true
  echo ""
  echo "✓ FERTIG. Untertitel-Worker läuft dauerhaft (Restart=always)."
  echo "  Log:    journalctl -u $SVC -f"
  echo "  Stop:   sudo systemctl stop $SVC   ·   Aus: sudo systemctl disable $SVC"
else
  echo "▸ Kein systemd — starte als nohup-Hintergrundprozess."
  pkill -f "eule-untertitel-worker.mjs" 2>/dev/null || true
  cd "$REPO"
  EULE_FONT="$FONT" UNTERTITEL_POLL_SEK=30 setsid nohup "$NODE_BIN" eule-untertitel-worker.mjs >"$REPO/untertitel.log" 2>&1 &
  echo "✓ FERTIG (nohup). Log: tail -f $REPO/untertitel.log · Stop: pkill -f eule-untertitel-worker.mjs"
fi
