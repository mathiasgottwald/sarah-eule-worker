# X/TikTok-Engagement-Worker (unbeaufsichtigt)

Der Browser-Teil des Engagements für **X (@GOTT_WALD)** und **TikTok (@gott_wald)** —
die zwei Kanäle, die Zernios Inbox-API nicht abdeckt. Läuft auf server-2 per
systemd-Timer 2x täglich, steuert einen headless Chromium (Playwright) mit
dauerhaft gespeicherter Login-Sitzung. Gesteuert wird in SARAH unter `/engagement`
(Not-Aus + Probe/Scharf), beobachtet über das Audit-Log dort.

## Einmal-Einrichtung

**1) Login-Sitzungen erzeugen** (auf einem Rechner MIT Bildschirm, z. B. Mac):
```bash
npm install && npx playwright install chromium
node engagement-login.mjs beide      # loggt dich bei X + TikTok ein, speichert state/*.json
```
Das erzeugt `state/x-state.json` und `state/tiktok-state.json` (SENSIBEL, nie ins Repo).

**2) Sitzungen auf server-2 laden:**
```bash
ssh ubuntu@<server-2> 'mkdir -p ~/worker/state'
scp state/*.json ubuntu@<server-2>:~/worker/state/
```

**3) Auf server-2 den Dauerdienst einrichten:**
```bash
cd ~/worker && git pull && bash setup-engagement.sh
```
Voraussetzung in `~/worker/.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`ANTHROPIC_API_KEY`.

## Betrieb
- **Not-Aus / Modus** stellt Mathias in SARAH unter `/engagement` — nicht auf dem Server.
  - `probe`  → Worker liest + entwirft + protokolliert, klickt **nichts** (sicherer Start).
  - `scharf` → Aktionen gehen automatisch raus (Full-Auto).
- **Sofort-Test einer Runde:** `sudo systemctl start sarah-engagement.service` → `tail -f /var/log/sarah-engagement.log`
- **Aus:** Not-Aus in SARAH **oder** `systemctl disable --now sarah-engagement.timer`

## Login abgelaufen?
Der Worker prüft bei jeder Runde den Login und schreibt bei Ablauf eine **Warnung**
in SARAH (kein stilles Scheitern). Dann Schritt 1 + 2 wiederholen (neu einloggen,
`state/*.json` neu hochladen). Fertig.

## Grenzen & Sicherheit
- Limits/Runde: Likes ≤15, Antworten ≤8, Kommentare ≤5, Follows ≤5; menschliche
  Pausen 15–60 s; max. 2 Runden/Tag/Plattform.
- Bei CAPTCHA / Verifizierung / "unusual activity" stoppt der Worker die Plattform
  **sofort** und warnt — nichts wird umgangen.
- Browser-Automation auf X/TikTok ist ToS-Graubereich; diese Limits sind der
  Konto-Schutz. TikTok-Selektoren sind schwächer als die von X und brauchen beim
  ersten Scharf-Lauf evtl. Feinschliff (im Probe-Modus am Audit-Log ablesbar).
