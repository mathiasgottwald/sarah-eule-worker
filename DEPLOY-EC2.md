# Worker-Deployment auf server-2 (AWS EC2, Ubuntu 24.04, via Instance Connect)

Einrichtung über die **EC2-Instance-Connect-Browser-Shell** (kein SSH-Key, kein
Datei-Upload — nur Copy-Paste-Befehle). Ubuntu-Standarduser `ubuntu` hat
passwortloses `sudo`. RAM ist knapp (~0,5 GB frei) → zuerst Swap.

Die Worker-Dateien werden aus dem **öffentlichen Mirror-Repo** geklont
(`github.com/mathiasgottwald/sarah-eule-worker`, nur der Worker, keine Secrets) —
deshalb **kein GitHub-Token** nötig.

## Werte, die Mathias bereithalten muss (NICHT im Skript hardcoden)

| Wert | Woher | Wofür |
|------|-------|-------|
| **Supabase Service-Role-Key** | Supabase-Dashboard → Projekt `tatbddeqffquxltvpmbs` → Project Settings → API → `service_role` (secret) | Worker schreibt Video-URL in `video_jobs` (umgeht RLS) |
| **Higgsfield-Konto** | die normalen Login-Daten | interaktiver OAuth-Login (Browser auf dem Laptop) |

`SUPABASE_URL` ist nicht geheim (`https://tatbddeqffquxltvpmbs.supabase.co`).

---

## Befehle (in dieser Reihenfolge in die Instance-Connect-Shell einfügen)

### 1) System + Swap (RAM knapp → 2 GB Swap, persistent)
```bash
sudo apt-get update
sudo apt-get install -y curl git
sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

### 2) Node.js 20 (NodeSource)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

### 3) Higgsfield-CLI global
```bash
sudo npm install -g @higgsfield/cli
higgsfield --version
```

### 4) Worker holen (öffentliches Mirror-Repo — KEIN Token)
```bash
cd ~
git clone --depth 1 https://github.com/mathiasgottwald/sarah-eule-worker.git worker
cd worker
npm install --omit=dev
```

### 5) .env anlegen (Service-Role-Key eintragen)
```bash
cat > ~/worker/.env <<'EOF'
SUPABASE_URL=https://tatbddeqffquxltvpmbs.supabase.co
SUPABASE_SERVICE_ROLE_KEY=HIER_SERVICE_ROLE_KEY_EINSETZEN
EOF
chmod 600 ~/worker/.env
nano ~/worker/.env    # Platzhalter ersetzen → Strg+O, Enter, Strg+X
```

### 6) Higgsfield-Login HEADLESS (bewiesen — Loopback-Callback nachspielen)

Die CLI kann nur **OAuth-Browser-Login** (kein Device-/Token-Modus). Auf einem
Server ohne Browser scheitert der `127.0.0.1:8765`-Callback — Lösung: die CLI
druckt die Login-URL und wartet; du machst den Browser-Teil am **Laptop** und
spielst die zurückgegebene Callback-URL **auf dem Server** gegen dessen eigenen
Listener ab. Kein SSH, keine Datei, nichts am Laptop zu installieren.

**① Login starten (ganzen Block einfügen):**
```bash
cd ~/worker
pkill -f 'auth login' 2>/dev/null; sleep 1
export BROWSER=echo
higgsfield auth login --port 8765 >/tmp/hflogin.txt 2>&1 &
sleep 5
echo; echo '>>> DIESE URL AUF DEINEM LAPTOP IM BROWSER OEFFNEN:'; echo
grep -Eo 'https://[^ ]*oauth/authorize[^ ]*' /tmp/hflogin.txt | head -1
echo; echo '(falls oben leer: Log unten)'; echo '----'; cat /tmp/hflogin.txt
```

**② Am Laptop:** die URL öffnen, mit dem **Higgsfield-Konto anmelden**. Der Browser
springt danach auf `http://127.0.0.1:8765/callback?code=…&state=…` und zeigt
**„Seite nicht erreichbar" — das ist normal.** Die **komplette Adresse** aus der
Adresszeile **kopieren**.

**③ Zurück in DERSELBEN Server-Shell** (URL einsetzen):
```bash
curl -s "HIER_DIE_KOMPLETTE_127.0.0.1-8765-URL_EINFUEGEN" >/dev/null
sleep 3; cat /tmp/hflogin.txt
higgsfield auth token >/dev/null 2>&1 && echo 'LOGIN OK' || echo 'nochmal Schritt 1 + 3'
```

> Zeigt ③ „invalid state"/Fehler (URL vertippt oder zu spät): einfach ① neu laufen
> lassen (neue URL/state) und ②–③ wiederholen. `code` ist einmalig + kurzlebig.
> Diesen Login als User `ubuntu` ausführen (kein `sudo`) — der Token landet in
> `~/.config/higgsfield/` und muss zum Dienst-User (Schritt 8) passen.

### 7) Erster echter Testlauf
Zuerst in SARAH (`/video`) einen kurzen Text **„In Warteschlange legen"**. Dann:
```bash
cd ~/worker
node worker.mjs --einmal
```
Verarbeitet genau **einen** Job und beendet sich. Danach in SARAH `/video` prüfen:
Karte sollte von „in Warteschlange" → „fertig" mit Video wechseln.

### 8) Dauerdienst (systemd) einrichten
```bash
sudo tee /etc/systemd/system/eule-worker.service >/dev/null <<'EOF'
[Unit]
Description=SARAH Eulen-Video-Worker (Higgsfield-Kette)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Environment=HOME=/home/ubuntu
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/ubuntu/worker
EnvironmentFile=/home/ubuntu/worker/.env
ExecStart=/usr/bin/node worker.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now eule-worker
sudo systemctl status eule-worker --no-pager
journalctl -u eule-worker -f
```
`Environment=HOME=/home/ubuntu` ist wichtig — sonst findet der Dienst den unter
`~/.config/higgsfield/` gespeicherten Login-Token nicht. Der Login (Schritt 6)
MUSS als User `ubuntu` gelaufen sein (kein `sudo`).

### Bei „Login abgelaufen" (später, wiederkehrend)
Schritt 6 (①–③) erneut ausführen; der Dienst muss nicht neu starten. Wartende
Jobs werden danach automatisch fertig produziert (selbstheilend).

### Worker-Update später (falls Code nachgezogen wird)
```bash
git -C ~/worker pull && sudo systemctl restart eule-worker
```

---

## Fallback / Stolpersteine im Browser-Shell (ehrlich)

- **Clone:** läuft ohne Token (öffentliches Mirror-Repo, keine Secrets).
- **Login-Methode ist empirisch bestätigt** (CLI druckt die Authorize-URL, Listener
  auf 127.0.0.1:8765 nimmt den nachgespielten Callback an; falscher `state` wird
  sauber abgewiesen). Falls die „Seite nicht erreichbar"-Seite verwirrt: sie ist
  erwartet — nur die Adresszeile zählt.
- **Fallback (nur wenn ① keine URL zeigt):** Login auf einem Rechner MIT Browser
  (CLI dort installieren, `higgsfield auth login`), dann den Inhalt von
  `~/.config/higgsfield/credentials.json` (Linux) bzw.
  `~/Library/Application Support/higgsfield/credentials.json` (macOS) auf dem Server
  in dieselbe Datei schreiben (`mkdir -p ~/.config/higgsfield && cat > … <<'EOF' …`).
  Enthält das Refresh-Token — nur in der eigenen Server-Shell einfügen.
- **Interaktive Schritte (6 + 7):** Browser-Tab offen lassen; Instance-Connect-
  Sitzungen laufen nach ~60 min ab — Login zügig abschließen.
- **`--einmal` braucht:** (a) Login erfolgreich, (b) ein `queued`-Job in SARAH.
- **Ungetestet bis Schritt 7:** das exakte CLI-Ausgabeformat (`parseErgebnis` in
  `produziere-eule.mjs`). Schritt 7 ist der Prüfpunkt; weicht es ab, nur diese eine
  Funktion nachziehen, in den Mirror pushen und `git -C ~/worker pull`.
