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

### 6) Higgsfield-Login mit dem Helfer `hf-login.mjs` (empfohlen)

Die CLI kann nur **OAuth-Browser-Login** (kein Device-/Token-Modus, kein Env-Key —
am Binary verifiziert), und Clerks Consent leitet nicht zuverlässig auf den
127.0.0.1-Loopback zurück. Der mitgelieferte Helfer macht den OAuth-PKCE-Flow
**von Hand**: er zeigt die Login-URL, du bestätigst im Browser, gibst den `code`
zurück — er tauscht ihn (Public-Client-PKCE, ohne Secret — verifiziert) gegen
`access_token`+`refresh_token` und schreibt genau die Datei, die die CLI/der
Worker liest. Kein Listener, kein curl-auf-localhost, keine Datei-Kopie.

**Vorher (empfohlen): CLI aktuell halten** (1.1.0):
```bash
sudo npm install -g @higgsfield/cli@latest
```

**Auf dem SERVER (als User `ubuntu`, kein sudo):**
```bash
cd ~/worker && node hf-login.mjs
```
1. Der Helfer druckt eine **Login-URL**. Öffne sie auf **deinem Laptop** im Browser,
   in dem du bei **higgsfield.ai eingeloggt** bist, und bestätige den Zugriff.
2. Danach springt der Browser auf `http://127.0.0.1:8765/callback?code=…&state=…`
   und zeigt **„Seite nicht erreichbar" — das ist ok**. Kopiere die **komplette
   Adresse** aus der Adresszeile.
   - *Falls der Browser gar nicht navigiert:* F12 → Tab **Network**, nochmal
     „Erlauben", und in der letzten Anfrage die `code=`-URL kopieren.
3. Füge die Adresse (oder nur den `code`) im Helfer ein → Enter. Er schreibt
   `~/.config/higgsfield/credentials.json` und prüft sich selbst
   (`higgsfield account status`).

> **Fallback A (Login am Mac, Datei kopieren):** Auf einem Mac
> `npm i -g @higgsfield/cli` + `node hf-login.mjs` (schreibt
> `~/Library/Application Support/higgsfield/credentials.json`), Inhalt kopieren, auf
> dem Server via `mkdir -p ~/.config/higgsfield && cat > ~/.config/higgsfield/credentials.json`
> (einfügen, Strg+D), `chmod 600`.
> **Fallback B (CLI schreibt die Datei selbst):** `higgsfield auth login --port 8765 &`
> auf dem Server, URL am Laptop bestätigen, die zurückgegebene `127.0.0.1:8765/...`-URL
> auf dem Server `curl`en → die CLI schließt den Login ab.

### 6b) Kein Workspace-Setzen nötig (Worker ist CLI-frei)
Der Worker ruft die Higgsfield-HTTP-API **direkt** auf (kein `higgsfield generate`,
kein `account status`, kein `workspace set`). Der Workspace steckt fest im Header
`X-Fnf-Workspace-Id` (Default `0b923f57-…`, überschreibbar via `HF_WORKSPACE_ID`),
und der Token wird vor jedem Lauf über `hf-token.mjs` (refresh_token) erneuert.
→ Die zickigen CLI-Befehle (`account status`/`workspace list` mit „no response
received") spielen **keine Rolle mehr**. Es genügt der Login aus Schritt 6
(`~/.config/higgsfield/credentials.json` mit gültigem `refresh_token`).

Optionaler Netz-/Token-Check (nicht erforderlich):
```bash
TOKEN=$(node ~/worker/hf-token.mjs)
curl -sS -H "Authorization: Bearer $TOKEN" -H "x-fnf-workspace-id: 0b923f57-d0c1-479a-962d-859ae429e37a" \
  https://fnf-api-gw.higgsfield.ai/fnf/developer/v2alpha/account/balance
```

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
