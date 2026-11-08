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
- **Übungsbibliothek (Plan → Übungen & Wissen):** ausführliche Seite für jedes der 28 Geräte: beteiligte Muskeln mit Fachbegriffen, warum die Übung sinnvoll ist, Einstellen, Ausführung Schritt für Schritt, Atmung, häufige Fehler mit Korrektur, Sicherheit, Tipps. Dazu deine eigenen Werte (erste Einheit, Bestwert, Entwicklung), wo die Übung in deinem Plan steht und Alternativen aus deinem Studio. Auch aus Übungsauswahl, Plan, Training („Gerät & Technik“) und Verlauf erreichbar
- **Trainingswissen:** 8 kurze Artikel zu Progression, Volumen, Häufigkeit, Gewicht und Wiederholungen, RIR, Pausen, Training in Dehnung und Gesundheit; jeder mit verlinkter Studie. Auf „Heute“ steht täglich ein anderer Beitrag

### Inhalte und Quellen

Die Übungstexte stehen in `src/app.html` (`GUIDE`, `SOURCES`, `ARTICLES`). Regeln: Anatomie und Ausführung nach anerkanntem Fachwissen; Aussagen aus Studien nur mit Quelle (PubMed/DOI), inklusive Einschränkungen wie kleine Stichproben oder Beobachtungsstudien; keine Prozentangaben zur „Muskelaktivierung“, keine Erfolgsversprechen. Einstellhinweise sind als Grundprinzip formuliert, weil sich Hammer-Strength-Modelle je nach Generation unterscheiden – maßgeblich sind die Hinweise am Gerät.
- **Apple Health (optional, Plan → Einstellungen → Apple Health):** Web-Apps haben keinen Zugriff auf HealthKit. Die App übergibt deshalb Startzeit und Dauer eines Trainings per Link (`shortcuts://run-shortcut?name=Trainingsplan%20Workout&input=text&text={"start":"JJJJ-MM-TT HH:MM","minuten":N}`) an einen Kurzbefehl, der das Workout als „Traditionelles Krafttraining“ in Health einträgt. Anleitung zum Einrichten in der App. Nach dem Training und im Verlauf je Training; bereits übergebene Trainings sind markiert, erneutes Senden fragt nach. Körpergewicht des heutigen Tages über den Kurzbefehl `Trainingsplan Gewicht`, übergeben in ganzen Gramm (`82500`), damit Kurzbefehle Komma und Punkt nicht je nach Region verwechselt; der Kurzbefehl teilt durch 1000. Keine Kalorien, keine Server
- **Apple Watch (optional, Plan → Einstellungen → Apple Watch):** Web-Apps laufen nicht auf der Watch. Die Watch zeichnet das Training parallel in ihrer App „Training“ als „Traditionelles Krafttraining“ auf (Puls, Kalorien, Dauer in Health). Die App erinnert vor dem Start und nach dem Training ans Beenden und bietet dann keine Trainings-Übergabe per Kurzbefehl an, damit kein Workout doppelt in Health steht; das Körpergewicht bleibt übergebbar
- **Ernährung (Tab „Essen“):** Tagebuch mit Frühstück, Mittag, Abend und Snacks; Tage blättern und nachtragen. Kalorien übrig, Eiweiß, Kohlenhydrate, Fett und Ballaststoffe; Durchschnitt der letzten 7 Tage; „Essen heute“ auf der Startseite
  - **Ziele & Berechnung:** Grundumsatz nach Mifflin-St Jeor × Aktivitätsfaktor (Mitten der FAO/WHO/UNU-Bereiche), Startwert −15 % (Abnehmen) bzw. +10 % (Aufbau), Eiweiß 1,6 g/kg (bis 2,2 g/kg); eigenes Kalorienziel möglich; Rechenweg, Grenzen und Quellen im Formular
  - **Gewichtstrend:** Ausgleichsgerade über die letzten 28 Tage (mind. 3 Einträge über 14 Tage) im Vergleich mit der Zielrate (Abnehmen 0,5–1 %/Woche nach Helms 2014, Aufbau 0,25–0,5 %/Woche nach Iraki 2019)
  - **Lebensmittel:** 110 Grundnahrungsmittel mit Werten je 100 g aus USDA FoodData Central (SR Legacy, per Skript übernommen, FDC-ID als Quelle, Portionen aus USDA); Markenprodukte online über Open Food Facts (Suche auf in Deutschland verkaufte Produkte, Barcode-Eingabe), nur mit vollständigen Nährwerten; eigene Lebensmittel mit Plausibilitätsprüfung (4/4/9 kcal je g); „Nur kcal“ für Schnelleinträge
  - Online-Suche: `world.openfoodfacts.org/cgi/search.pl` (CORS erlaubt); bei Ausfall oder Überlastung verständliche Meldung. Grundnahrungsmittel und eigene Lebensmittel funktionieren offline
  - **Wasser:** Gläser zählen (+250/+500/−250 ml) je Tag; Trinkziel 1,6 L (Frauen) bzw. 2,0 L (Männer) = 80 % des EFSA-Referenzwerts für die Gesamtzufuhr (2,0/2,5 L, davon 20–30 % aus Lebensmitteln), mit Erklärung und Quellen
  - **„Wie am Vortag“:** leere Mahlzeit mit einem Tipp vom Vortag übernehmen
  - **Barcode-Scan mit der Kamera:** eigener Decoder ohne externe Bibliothek (Safari auf dem iPhone bietet keine eingebaute Barcode-Erkennung) für EAN-13, EAN-8 und UPC-A. Eine Lesung zählt nur mit Begrenzungszeichen, Ruhezonen, gültigem Paritätsmuster, Prüfziffer und zwei gleichen Treffern; Balkenverbreiterung wird aus den Begrenzungszeichen geschätzt und ausgeglichen. Das Kamerabild wird nur im Gerät ausgewertet; die Kamera stoppt beim Schließen und im Hintergrund. Eingetippte Nummern werden ebenfalls über die Prüfziffer geprüft
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
