# Trainingsplan

Trainings-App als Web-App (PWA) für Hammer-Strength-Geräte. Läuft unter https://trainingsplan-tawny.vercel.app und wird bei jedem Merge nach `main` automatisch von Vercel veröffentlicht.

## Auf dem iPhone installieren

Link in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Die App startet dann im Vollbild und funktioniert auch offline.

## Funktionen

- **Plan-Assistent:** Ziel, Trainingstage, Zeit pro Training, Erfahrung und die Geräte deines Studios ergeben einen fertigen Plan
- **Heute:** „Das trainierst du heute“ mit Begründung (Ablauf, Erholung, letzte Einheit), großer Start-Button, Wochenziel, Muskel-Erholung; pausiertes Training fortsetzen
- **Training:** nur Übung, Satz, kg, Wiederholungen und „Satz fertig“; Werte vom letzten Mal übernommen; Pause mit Countdown und „Leicht / Passt / Schwer“; Sätze korrigieren, Übung später machen oder beenden, Gerät tauschen, pausieren
- **Zeit für heute:** Dauer auf „Heute“ antippen (30/45/60/90 Min. oder Original) oder im Training unter „Übungen → Zeit anpassen“; die App priorisiert Grundübungen und Muskelabdeckung, kürzt nie Pausen und ändert den Plan nicht
- **Progression:** nachvollziehbare Regeln mit Begründung aus den echten Sätzen: nur vergleichbare Einheiten (gleiches Gerät, gleiche Gewichtsangabe), unvollständige Einheiten und unterschiedliche Satzgewichte werden konservativ behandelt, Reduktion erst nach zwei Einheiten unter dem Ziel; optional RIR (Wiederholungen in Reserve) pro Satz
- **Geräte:** Hammer-Strength-Bibliothek mit Bewegungsmustern, Scheiben/Steckgewicht, Gewicht pro Seite oder insgesamt, Schritte je Gerät, Einstellungen, Technik-Tipps, „im Studio“ und „Bevorzugt“ unabhängig, eigene Geräte
- **Gerät tauschen:** direkte Alternativen (gleiches Bewegungsmuster) vor anderen Übungen für denselben Muskel, mit Begründung; keine Gewichtsübertragung zwischen Maschinen
- **Verlauf:** Körpergewicht, Sätze pro Muskel, Volumen, Kalender mit Trainingshäufigkeit, Bestwerte mit Kurve und 1RM pro Gerät
- **Datensicherung** per Code (Plan → „Daten sichern“)

Alle Daten liegen lokal im Browser des Geräts.

## Design

Designsystem „Instrument“ (CSS-Tokens in `src/app.html`): Inhalte direkt auf Graphit statt in Karten, Hierarchie über Typografie (Barlow Condensed für Titel und Zahlen, Barlow für Text) und Weißraum. Orange nur für die Hauptaktion je Ansicht, Grün für erledigt/erholt. Gruppierte Listen nur für echte Listen, Details in Bottom-Sheets oder aufklappbaren Bereichen. Im Training sitzt „Satz fertig“ fest im Daumenbereich und folgt der Tastatur.

## Entwicklung

- Quelle: `src/app.html` (wird auch als claude.ai-Artifact veröffentlicht)
- `./build.sh` erzeugt daraus `index.html`
- `node tests/run.js` startet die automatisierten Tests (Playwright + Chromium, python3 für den lokalen Server)
- `sw.js`: Offline-Speicher (App-Seite zuerst aus dem Netz, damit Updates sofort ankommen)
- Symbole: `icon.svg`, daraus gerenderte PNGs für iOS und Android
