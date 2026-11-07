# Trainingsplan

Trainings-App als Web-App (PWA) für Hammer-Strength-Geräte. Läuft unter https://trainingsplan-tawny.vercel.app und wird bei jedem Merge nach `main` automatisch von Vercel veröffentlicht.

## Auf dem iPhone installieren

Link in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Die App startet dann im Vollbild und funktioniert auch offline.

## Funktionen

- **Plan-Assistent:** Ziel, Trainingstage, Zeit pro Training, Erfahrung und die Geräte deines Studios ergeben einen fertigen Plan
- **Heute:** „Das trainierst du heute“ mit Begründung (Ablauf, Erholung, letzte Einheit), großer Start-Button, Wochenziel, Muskel-Erholung; pausiertes Training fortsetzen
- **Training:** nur Übung, Satz, kg, Wiederholungen und „Satz fertig“; Werte vom letzten Mal übernommen; Pause mit Countdown und „Leicht / Passt / Schwer“; Sätze korrigieren, Übung später machen oder beenden, Gerät tauschen, pausieren
- **Progression:** lokale, nachvollziehbare Regeln mit Begründung, z. B. „Letztes Mal alle 3 Sätze mit 12 Wdh. geschafft. Heute +2,5 kg pro Seite.“
- **Geräte:** Hammer-Strength-Bibliothek mit Scheiben/Steckgewicht, Gewicht pro Seite oder gesamt, Schritte je Gerät, Einstellungen, Technik-Tipps, Verfügbarkeit im Studio, eigene Geräte
- **Verlauf:** Körpergewicht, Sätze pro Muskel, Volumen, Kalender mit Trainingshäufigkeit, Bestwerte mit Kurve und 1RM pro Gerät
- **Datensicherung** per Code (Plan → „Daten sichern“)

Alle Daten liegen lokal im Browser des Geräts.

## Entwicklung

- Quelle: `src/app.html` (wird auch als claude.ai-Artifact veröffentlicht)
- `./build.sh` erzeugt daraus `index.html`
- `sw.js`: Offline-Speicher (App-Seite zuerst aus dem Netz, damit Updates sofort ankommen)
- Symbole: `icon.svg`, daraus gerenderte PNGs für iOS und Android
