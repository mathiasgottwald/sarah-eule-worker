#!/usr/bin/env bash
# =============================================================================
# SARAH — X/TIKTOK-ENGAGEMENT-WORKER als DAUERDIENST auf server-2 (einmalig).
#
# Installiert Playwright+Chromium, richtet einen systemd-TIMER ein, der den
# Engagement-Worker 2x täglich unbeaufsichtigt laufen lässt (Not-Aus & Modus
# steuert Mathias in SARAH, nicht hier). Idempotent — beliebig oft ausführbar.
#
# Voraussetzungen in ~/worker/.env:
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
# Voraussetzung Login-Sitzungen (einmalig, sensibel, NUR auf der Box):
#   ~/worker/state/x-state.json   und   ~/worker/state/tiktok-state.json
#   (erzeugt mit engagement-login.mjs auf einem Rechner mit Bildschirm)
#
# Update später:   cd ~/worker && git pull && bash setup-engagement.sh
# =============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC="sarah-engagement"
ENVFILE="$REPO/.env"
STATE_DIR="$REPO/state"

echo "▸ Repo: $REPO"
[ -f "$ENVFILE" ] || { echo "✗ $ENVFILE fehlt — dort müssen SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY stehen."; exit 1; }
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY; do
  grep -q "^$k=" "$ENVFILE" || { echo "✗ In $ENVFILE fehlt $k."; exit 1; }
done
mkdir -p "$STATE_DIR"
command -v node >/dev/null 2>&1 || { echo "✗ Node ≥18 fehlt (nvm)."; exit 1; }

# --- Node-Abhängigkeiten (playwright) --------------------------------------
echo "▸ Installiere Node-Pakete (playwright) …"
cd "$REPO"
if [ -f package-lock.json ]; then npm ci --omit=dev || npm install --omit=dev; else npm install --omit=dev; fi

# --- Chromium + Systemabhängigkeiten ---------------------------------------
echo "▸ Installiere Chromium für Playwright (einmalig, ~150 MB) …"
if npx playwright install --with-deps chromium; then :; else
  echo "  (--with-deps brauchte evtl. sudo; versuche System-Deps separat)"
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO npx playwright install-deps chromium || true
  npx playwright install chromium
fi

# --- Login-State prüfen (nur warnen, nicht abbrechen) -----------------------
for p in x tiktok; do
  [ -f "$STATE_DIR/$p-state.json" ] && echo "▸ Login-State $p: vorhanden" \
    || echo "⚠ Login-State $p FEHLT ($STATE_DIR/$p-state.json) — engagement-login.mjs ausführen und hochladen. Der Worker überspringt $p bis dahin."
done

NODE_BIN="$(command -v node)"

# --- systemd Service + Timer (2x täglich) ----------------------------------
command -v systemctl >/dev/null 2>&1 || { echo "✗ Kein systemd — dieser Worker braucht den Timer. Bitte manuell cron einrichten: '$NODE_BIN $REPO/engagement-worker.mjs beide'"; exit 1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "▸ Schreibe systemd-Service + Timer"
$SUDO tee "/etc/systemd/system/$SVC.service" >/dev/null <<UNITEOF
[Unit]
Description=SARAH X/TikTok Engagement-Worker (eine Runde)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO
EnvironmentFile=$ENVFILE
Environment=ENGAGEMENT_STATE_DIR=$STATE_DIR
ExecStart=$NODE_BIN $REPO/engagement-worker.mjs beide
StandardOutput=append:/var/log/$SVC.log
StandardError=append:/var/log/$SVC.log
UNITEOF

# Zwei feste Zeiten (Europe/Zurich): 09:40 und 18:40, +/- Jitter gegen Muster.
$SUDO tee "/etc/systemd/system/$SVC.timer" >/dev/null <<TIMEREOF
[Unit]
Description=SARAH Engagement 2x täglich

[Timer]
OnCalendar=*-*-* 09:40:00 Europe/Zurich
OnCalendar=*-*-* 18:40:00 Europe/Zurich
RandomizedDelaySec=1200
Persistent=true

[Install]
WantedBy=timers.target
TIMEREOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SVC.timer"
$SUDO systemctl restart "$SVC.timer"
echo ""
echo "✓ FERTIG. Der Engagement-Worker läuft ab jetzt 2x täglich unbeaufsichtigt."
echo "  Steuerung (Not-Aus / Probe↔Scharf): in SARAH unter /engagement — NICHT hier."
echo "  Timer:      systemctl list-timers $SVC.timer"
echo "  Sofort-Test:$SUDO systemctl start $SVC.service   (dann Log ansehen)"
echo "  Log:        tail -f /var/log/$SVC.log"
echo "  Aus:        systemctl disable --now $SVC.timer   (oder Not-Aus in SARAH)"