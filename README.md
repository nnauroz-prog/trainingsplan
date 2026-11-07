# Trainingsplan

Trainings-App als Web-App (PWA) für Hammer-Strength-Geräte. Läuft unter https://trainingsplan-tawny.vercel.app und wird bei jedem Merge nach `main` automatisch von Vercel veröffentlicht.

## Auf dem iPhone installieren

Link in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Die App startet dann im Vollbild und funktioniert auch offline.

## Funktionen

- **Plan-Assistent:** Ziel, Trainingstage, Zeit pro Training und Erfahrung ergeben einen fertigen Plan
- **Heute:** nächstes Training mit Start-Button, Wochenziel und Serie, Muskel-Erholung
- **Training:** kg und Wiederholungen pro Satz (vorbelegt vom letzten Mal), Pausen-Ring mit Ton, Vorschlag ±2,5 kg, Ausführungstipps, Geräte-Einstellung merken, Gerät tauschen oder Übung vorziehen, Sätze korrigieren
- **Verlauf:** Volumen pro Woche, Kalender, Bestwerte mit Kurve pro Gerät
- **Datensicherung** per Code (Plan → „Daten sichern“)

Alle Daten liegen lokal im Browser des Geräts.

## Entwicklung

- Quelle: `src/app.html` (wird auch als claude.ai-Artifact veröffentlicht)
- `./build.sh` erzeugt daraus `index.html`
- `sw.js`: Offline-Speicher (App-Seite zuerst aus dem Netz, damit Updates sofort ankommen)
- Symbole: `icon.svg`, daraus gerenderte PNGs für iOS und Android
