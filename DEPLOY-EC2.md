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
| **Higgsfield-Konto** | die normalen Login-Daten | interaktiver Device-Login auf dem Laptop |

`SUPABASE_URL` ist nicht geheim (`https://tatbddeqffquxltvpmbs.supabase.co`).
Ein GitHub-Token wird **nicht** mehr gebraucht (öffentlicher Clone).

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

### 6) Bei Higgsfield einloggen (Device-Flow — der kritische Schritt)
```bash
higgsfield auth login
```
Die CLI zeigt **eine URL und einen Code** (Device-Flow). Dann:
1. Auf **deinem eigenen Laptop** die angezeigte URL im Browser öffnen.
2. Den angezeigten **Code** eingeben und mit deinem Higgsfield-Konto **bestätigen**.
3. Zurück in der Shell: der Befehl erkennt die Freigabe selbst und meldet Erfolg.

> Die Server-Shell braucht **keinen** eigenen Browser. Lass das Terminal offen,
> bis „logged in"/„success" erscheint. (Falls die CLI stattdessen nur eine
> `http://localhost:PORT`-URL zeigt statt einer higgsfield.ai-URL → siehe „Fallback"
> unten.) Diesen Schritt als User `ubuntu` ausführen (kein `sudo`) — der Token
> landet in `~/.config/higgsfield/` und muss zum Dienst-User passen.

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
```bash
higgsfield auth login        # als User ubuntu; Dienst muss nicht neu starten
```
Wartende Jobs werden danach automatisch fertig produziert (selbstheilend).

### Worker-Update später (falls Code nachgezogen wird)
```bash
git -C ~/worker pull && sudo systemctl restart eule-worker
```

---

## Fallback / Stolpersteine im Browser-Shell (ehrlich)

- **Clone:** läuft jetzt ohne Token (öffentliches Mirror-Repo). Der Mirror enthält
  ausschließlich den Worker-Code + Platzhalter-`.env.example` — **keine Secrets**.
- **Higgsfield-Login-Variante:** Sollte die CLI **keinen** Device-Code zeigen,
  sondern einen lokalen `http://localhost:PORT`-Callback erwarten, funktioniert das
  headless nicht direkt. Dann: `higgsfield auth login` gibt trotzdem eine URL aus —
  diese am Laptop öffnen; scheitert der localhost-Rückkanal, hilft nur eine
  SSH-Portweiterleitung (nicht via Instance-Connect-Browser-Shell). Erst am echten
  Lauf sichtbar; deshalb Schritt 6 vor Schritt 8 testen.
- **Interaktive Schritte (6 + 7):** laufen im Vordergrund — Browser-Tab offen
  lassen. Instance-Connect-Sitzungen laufen nach ~60 min ab; Login vorher abschließen.
- **`--einmal` braucht Voraussetzungen:** (a) Schritt 6 erfolgreich, (b) ein
  `queued`-Job in SARAH. Sonst „keine offenen Jobs".
- **Ungetestet bis Schritt 7:** das exakte CLI-Ausgabeformat (`parseErgebnis` in
  `produziere-eule.mjs`). Schritt 7 ist genau der Prüfpunkt; weicht es ab, nur diese
  eine Funktion nachziehen, in den Mirror pushen und `git -C ~/worker pull`.
