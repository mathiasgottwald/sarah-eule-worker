# SARAH Eulen-Video-Worker (Stufe 2b)

Ein kleiner, unbeaufsichtigter Dauer-Prozess, der Eulen-Video-Aufträge aus SARAHs
Datenbank abholt und über die **bewährte Higgsfield-Kette** produziert
(`text2speech_v2` mit „SARAH Stimme" → `wan2_7` mit der GOTT-WALD-Eule, 9:16).

Er läuft **nicht auf Vercel** (Zeitlimit + die guten Modelle brauchen einen
Konto-Login, keinen API-Key). Empfohlen: kleiner Dauer-Server.

---

## Wie der Handshake läuft (kein Secret im SARAH-Client)

```
SARAH (Vercel)                         Worker (diese Box)
  │  „Video anfordern" (Text)              │
  ▼                                        │
video_jobs: status = queued  ──────────►  holt ältesten queued-Job
                                           beansprucht ihn (status = in_arbeit)
                                           produziert über higgsfield-CLI
  ◄──────────  video_url + status = fertig │   (bzw. status = fehler + fehler_text)
```

- **Status:** `queued` → `in_arbeit` → `fertig` (oder `fehler`).
- Der Worker nutzt den **Supabase Service-Role-Key** (umgeht RLS) — der liegt
  **nur hier** auf der Box, niemals im Browser/SARAH-Client.
- **Login abgelaufen?** Der Job wird **nicht verworfen**, sondern zurück auf
  `queued` gesetzt; der Worker wartet. Nach erneutem `higgsfield auth login`
  wird er automatisch fertig produziert. → **selbstheilend, kein Datenverlust.**

---

## Ehrlich: der wunde Punkt (Login)

Die Modelle `text2speech_v2` + `wan2_7` sind **nur per Konto-Login** erreichbar
(kein headless-API-Key). Die offizielle CLI sagt selbst: *„tokens are short-lived
— re-run `higgsfield auth login`."* Access-Tokens erneuern sich intern, aber
**wie lange die gespeicherte Sitzung hält, ist nicht dokumentiert** (realistisch
Tage–Wochen). Dann bricht die Produktion ab, bis **jemand einmal neu einloggt**.

Das ist die **einzige wiederkehrende Wartung**. Der Worker macht sie so schmerzlos
wie möglich: Jobs warten in der Schlange, statt zu scheitern; im Log erscheint eine
klare `!!! LOGIN ABGELAUFEN`-Zeile.

> Eine wirklich 100 % wartungsfreie Vollautomatik ist mit diesen Modellen aktuell
> **nicht** möglich — das ist eine Higgsfield-Beschränkung, keine unserer Kette.

---

## Einrichtung (einmalig, auf der Box)

Empfehlung: **Hetzner CAX11 (ARM), ~3,79 €/Monat**, Ubuntu 24.04. Persistente
Platte ist wichtig — sie hält den Login-Token über Neustarts.

```bash
# 1) Node 20+ installieren
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) Higgsfield-CLI installieren
npm install -g @higgsfield/cli
higgsfield --version

# 3) Worker-Dateien ablegen (dieser Ordner) und Abhängigkeiten installieren
sudo mkdir -p /opt/sarah-eule-worker && sudo chown "$USER" /opt/sarah-eule-worker
cp worker.mjs produziere-eule.mjs package.json /opt/sarah-eule-worker/
cd /opt/sarah-eule-worker && npm install --omit=dev

# 4) Env anlegen (Service-Role-Key eintragen)
cp /pfad/zu/.env.example .env && nano .env    # SUPABASE_SERVICE_ROLE_KEY setzen

# 5) EINMAL bei Higgsfield einloggen (interaktiv — das ist Mathias' Schritt).
#    Auf headless Servern zeigt die CLI i.d.R. eine URL + Code (Device-Flow),
#    die man am eigenen Laptop-Browser bestätigt. Als GENAU der User ausführen,
#    unter dem später der Dienst läuft (Token liegt in dessen HOME).
higgsfield auth login

# 6) Erst manuell testen: eine Anforderung in SARAH stellen, dann:
node worker.mjs --einmal      # verarbeitet genau einen Job und beendet sich

# 7) Wenn der Testlauf ein Video liefert -> als Dauerdienst einrichten:
sudo cp higgsfield-eule-worker.service /etc/systemd/system/
#   (User/WorkingDirectory in der Unit anpassen!)
sudo systemctl daemon-reload
sudo systemctl enable --now higgsfield-eule-worker
journalctl -u higgsfield-eule-worker -f
```

### Bei „Login abgelaufen"
```bash
higgsfield auth login           # als derselbe User; Dienst muss nicht neu starten
```
Wartende Jobs werden danach automatisch fertig produziert.

---

## Was Mathias einrichten/entscheiden muss

1. **Hosting bestätigen** (Empfehlung Hetzner CAX11 ~3,79 €/mo) — oder Alternative.
2. **Server bereitstellen** + SSH-Zugang.
3. **Einmal `higgsfield auth login`** ausführen (Browser-OAuth — nur er kann das).
4. **Service-Role-Key** in `.env` eintragen (aus dem Supabase-Dashboard).
5. Gelegentlich (bei der `LOGIN ABGELAUFEN`-Meldung) **erneut einloggen**.

## Bekannte offene Punkte (ehrlich)

- **CLI-Ausgabeformat:** Das Parsen der Video-/Audio-Kennung aus der CLI-Ausgabe
  ist defensiv (JSON → UUID/URL-Regex, gekapselt in `parseErgebnis`), aber der
  exakte stdout-Aufbau ist nicht öffentlich dokumentiert. **Beim ersten echten,
  eingeloggten Lauf einmal prüfen** und — falls nötig — nur `parseErgebnis`
  nachziehen. (Ohne Login konnte das hier nicht end-to-end getestet werden.)
- **Clip-Länge:** ein Clip ≤ 15 s (Text bis ~800 Zeichen). Längere Texte
  (33-s-Version per Segment-Zusammenschnitt) sind der nächste Schritt, nicht Teil
  von 2b.
- **Posten:** bewusst NICHT enthalten (kommt separat, freigabe-gesichert).
