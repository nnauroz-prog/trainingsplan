# Bestandsaufnahme und Risikoanalyse

Geprüft am 20. November 2026 am Stand von `main` nach Pull Request #75 (Commit `140a2ab`). Korrekturen: Pull Requests #76 und #77 (zusammengeführt) und Pull Request #78. Stand dieses Dokuments: 25. November 2026.

## 1. Vorgehen

- Vier Prüfer haben je einen Bereich untersucht: Progression und Verlauf · Planerstellung und automatische Planänderungen · Speichern, Sicherung, Offline · Erholung, abgeleitete Zahlen und Testabdeckung.
- Jeder Befund ist eingeordnet:
  - **bestätigt** – mit einem Versuch nachgestellt, das falsche Ergebnis wurde beobachtet
  - **Designschwäche** – der Code tut, was er soll, aber das Verhalten ist riskant oder irreführend
  - **vermutet** – nicht nachgewiesen
- Ergebnis: 32 Befunde, davon 24 bestätigt, 7 Designschwächen, 1 vermutet. Behoben sind 28, teilweise behoben 4, offen 0 (Pull Requests #76 bis #78). Bei den teilweise behobenen Punkten steht im Abschnitt, was bewusst so belassen wurde und warum.
- Grenzen der Prüfung:
  - Geprüft wurde im Chromium-Testbrowser, nicht auf einem echten iPhone.
  - Die Prüfer haben eigene Versuche gefahren, die ganze Testsuite lief dabei nicht. Aussagen zur Testabdeckung stammen aus dem Lesen von `tests/run.js`.
  - Die Zeilenangaben gelten für den geprüften Stand; durch die Korrekturen haben sie sich verschoben.
  - Die behobenen Punkte habe ich selbst nachgestellt und mit Tests abgesichert; die neuen Tests jeder Runde liefen zur Gegenprobe auch gegen die Fassung davor und schlagen dort fehl.
  - Die Nummern der Befunde bleiben seit dem 21. November 2026 unverändert.

## 2. Antworten auf die zehn Prüffragen

| Nr. | Frage | Antwort |
|---|---|---|
| 1 | Lassen sich Trainings unabhängig vom Live-Modus anlegen? | Vorher nein: Trainings entstanden nur beim Beenden einer Live-Sitzung. Jetzt ja – „Training nachtragen“ (Pull Request #76). |
| 2 | Nutzt die Progression nur bestätigte Leistungen? | Ja. Unbestätigte, übersprungene und ungültige Sätze zählen nicht. Im Live-Modus bestätigt der Tipp auf „Satz fertig“ den angezeigten Wert (bewusst so). Beim Nachtragen meldet die App für unverändert übernommene Vorschläge keinen Bestwert. Jeder Vorschlag nennt seine Datengrundlage. |
| 3 | Wird der Verlauf zeitlich richtig ausgewertet? | Vorher nicht sicher: maßgeblich war die Position in der Liste, nicht das Datum. Behoben. Ein Eintrag mit Datum in der Zukunft belastet die Erholung nicht und wird unter „Fortschritt“ gemeldet. |
| 4 | Behalten Gerätevarianten getrennte Leistungsdaten? | Ja. „Pro Seite“, „insgesamt“ und „am Block“ bleiben getrennt, beim Gerätetausch wird kein Gewicht übertragen. Der eine Fehler („Frühere Einträge umstellen“ während eines laufenden Trainings) ist behoben. |
| 5 | Täuschen die Erholungswerte Genauigkeit vor? | Ja: Anzeige auf 1 % genau, ein einzelner Satz zählte wie ein ganzes Training, die Begründung las sich wie eine Tatsache. Behoben: drei Stufen statt Prozent, erst ab 2 Sätzen, überall als Schätzung der App gekennzeichnet; ebenso die zwei Rechenfehler (gelöschte Geräte, Einträge ohne gültigen Satz). |
| 6 | Passen Zeitbudget und erzeugte Trainingsdauer zusammen? | Der Generator hält das Budget ein. Die Planprüfung sagte „jeder Tag passt“, bis ein Tag 12,5 Minuten darüber lag, und eine „Zeit für heute“ blieb nach dem Bearbeiten des Tages veraltet gültig – beides behoben. Bei knapper Zeit kürzt der Generator jetzt so, dass keine große Muskelgruppe aus dem Plan verschwindet. |
| 7 | Werden Entscheidungen des Nutzers überschrieben? | An mehreren Stellen ja. Behoben: neuer Plan ersetzt den alten ohne Sicherung; „Rückgängig“ verwarf spätere Handänderungen; Gerätetausch aus einem Hinweis erzeugte Doppelte; die Markierung „steht in meinem Studio“ wurde still gesetzt. |
| 8 | Sind Sicherung und Wiederherstellung vollständig und verlustfrei? | Die Rundreise ist vollständig: alle Felder kommen an. Risiken lagen beim Einspielen (laufendes Training, neuere Daten – behoben bzw. teilweise behoben) und beim Laden (unlesbarer Speicher – behoben). Zwei Fenster überschreiben sich nicht mehr. Wiederherstellen geht auch ohne Plan und lässt sich 14 Tage lang zurückholen. |
| 9 | Bleiben neue Funktionen mit der bestehenden App verträglich? | Nach den Tests ja. In die andere Richtung: Eine ältere, noch zwischengespeicherte Fassung überschreibt Daten einer höheren Fassung nicht mehr. Der Schutz greift, sobald die Fassungsnummer steigt – das gehört ab jetzt zu jedem neuen gespeicherten Feld. |
| 10 | Sichern die Tests die Übergänge zwischen Plan, Live-Training, Nachtrag und Verlauf? | Besser, aber nicht vollständig; die Lücken stehen unten. Neu: Tests für den Nachtrag, für ungeordneten Verlauf, für unlesbaren Speicher, fürs Wiederherstellen und Zurückholen, ein Raster über 144 Planvorschläge mit den harten Regeln; automatische Tests für jeden Pull Request. |

## 3. Behoben

**Pull Request #76 (zusammengeführt)**


1. **Training nachtragen** – eigener Ablauf ohne Live-Modus, mit denselben Vorschlägen und derselben Auswertung.
2. **Verlauf nach Datum** – beim Laden geordnet; nachgetragene und pausierte Trainings rücken an ihren Platz.
3. **Plan wird nie mehr ohne Sicherung ersetzt** – vorher automatische Kopie unter „Meine Pläne“.
4. **Unlesbare Daten gehen nicht mehr verloren** – Kopie auf dem Gerät, Hinweis, Datei-Sicherung, automatische Übernahme.
5. **Sicherung einspielen** – gesperrt bei laufendem Training; Rückfrage, wenn auf dem Gerät neuere Trainings liegen.
6. **Dauer** – ein Training ohne erfasste Dauer zeigt „ohne Dauer“ statt „1 Min.“.
7. **Automatische Tests** für jeden Pull Request.

**Pull Request #77**

1. **Gewichtsangabe im laufenden Training umstellen** – die heutigen Sätze werden mit der neuen Angabe gespeichert.
2. **„Rückgängig“ unter Hinweise** – nur, solange der Plan seitdem unverändert ist.
3. **Keine doppelten Geräte** – weder beim Tausch aus einem Hinweis noch bei „Gerät tauschen“ nach einer Zeitanpassung.
4. **„Zeit für heute“** – wird nach jeder Änderung am Tag neu berechnet.
5. **Erholung und Muskelbelastung** – nur gültige Sätze, nur bekannte Geräte.
6. **Zwei Fenster** – das zweite übernimmt den neueren Stand, statt ihn zu überschreiben.
7. **Planprüfung** – „passt ins Zeitbudget“ nur, wenn es nach der eigenen Schätzung stimmt.
8. **Vorschläge** – Pausenregel auch bei uneinheitlichen Sätzen; Begründungen nennen die tatsächlichen Ziele; keine Behauptung über unvollständige Einheiten ohne gespeicherte Satzzahl.
9. **Letzter Satz** – lässt sich in der Zusammenfassung als leicht, passend oder schwer bewerten.
10. **Erholung** – drei Stufen statt Prozent, erst ab 2 Sätzen in einem Training, als Schätzung der App gekennzeichnet.
11. **Stillstand** – nicht, wenn das Gewicht nach einer Reduktion wieder steigt.
12. **Sicherungszeile** – „aktuell“ nur, wenn sich seit der Sicherung nichts geändert hat; nachgetragene Trainings zählen mit.
13. **Kalorienbilanz** – alle Trainings des Tages; als Schätzung gerundet.

**Pull Request #78**

1. **Datengrundlage** – jeder Gewichtsvorschlag nennt, worauf er beruht, und wie belastbar das ist (Einschätzung der App).
2. **Nachtragen** – Satzgefühl „Leicht / Passt / Schwer“; kein gemeldeter Bestwert für unverändert übernommene Vorschläge.
3. **Planvorschlag bei knapper Zeit** – keine große Muskelgruppe verschwindet mehr aus dem Plan.
4. **„Steht in meinem Studio“** – nichts wird mehr still gesetzt; abgewählte Geräte im Plan sind gekennzeichnet.
5. **Wiederherstellen** – schon vor dem ersten Plan möglich; der Stand von vorher bleibt 14 Tage als Kopie.
6. **Neuere Daten** – eine ältere Fassung der App überschreibt sie nicht.
7. **Auffangnetz** – startet die App nicht, lassen sich die Daten trotzdem als Datei sichern.
8. **Wochenziel** – Termine pro Woche, sonst Tage mit Geräten.
9. **Speichern fehlgeschlagen** – die Zusammenfassung sagt es und bietet die Datei-Sicherung an.
10. **Tests** – die leeren und uhrzeitabhängigen Prüfungen sind ersetzt.

## 4. Übersicht aller Befunde

| Nr. | Art | Schwere | Stand | Befund |
|---|---|---|---|---|
| 1 | bestätigt | hoch | behoben | „Letztes Mal“ folgt der Reihenfolge im Speicher, nicht dem Datum |
| 2 | bestätigt | hoch | behoben | „Plan erstellen“ und „Lieber selbst zusammenstellen“ ersetzen den vorhandenen Plan ohne Rückfrage, ohne Rückgängig, ohne Sicherung |
| 3 | bestätigt | hoch | behoben | Sicherung wiederherstellen löscht ein laufendes Training ohne Hinweis |
| 4 | bestätigt | hoch | teilweise | Verlauf wird nach Listenposition ausgewertet; beim Laden weder sortiert noch auf Zukunfts- oder kaputte Daten geprüft |
| 5 | bestätigt | hoch | behoben | Scheitert das Laden, startet die App leer ohne Hinweis – die erste Aktion überschreibt alle Daten |
| 6 | bestätigt | mittel | behoben | Markierung „steht in meinem Studio“ ist nicht verlässlich: die Geräteauswahl setzt sie still, und abgewählte Geräte bleiben ohne Hinweis im Plan und im Training |
| 7 | bestätigt | mittel | behoben | Auf einem neuen Gerät ist „Sicherung wiederherstellen“ erst nach dem Anlegen eines Plans erreichbar |
| 8 | bestätigt | mittel | behoben | Letzter Satz der letzten Übung lässt sich nie bewerten |
| 9 | bestätigt | mittel | behoben | „Frühere Einträge umstellen“ im laufenden Training speichert die neuen Sätze mit der alten Einheit |
| 10 | bestätigt | mittel | behoben | Pausenregel greift nicht bei uneinheitlichen Sätzen |
| 11 | bestätigt | mittel | behoben | „Rückgängig“ unter Hinweise setzt den ganzen Plan auf einen alten Stand: spätere Handänderungen und sogar ein neu erstellter Plan gehen verloren |
| 12 | bestätigt | mittel | behoben | Gerätetausch aus dem Hinweis „Stillstand“ erzeugt ein doppeltes Gerät im Tag |
| 13 | bestätigt | mittel | behoben | „Zeit für heute“ bleibt nach dem Bearbeiten des Tages gültig: neu hinzugefügtes Gerät wird beim Start still ausgeblendet, erhöhte Sätze werden gekürzt |
| 14 | bestätigt | mittel | behoben | „Gerät tauschen“ bietet ein zeitbedingt ausgeblendetes Gerät des Tages an – danach steht es doppelt im Plan und im Training |
| 15 | bestätigt | mittel | behoben | Planprüfung sagt „jeder Tag passt in dein Zeitbudget“, obwohl ein Tag bis zu 12,5 Minuten darüber liegt (40 % bei 30 Min.) |
| 16 | bestätigt | mittel | behoben | Stillstand gemeldet, obwohl das Gewicht nach einer bewussten Reduktion viermal in Folge stieg |
| 17 | bestätigt | mittel | behoben | Erholung zählt gelöschte Geräte als Brust und Einträge ohne gültigen Satz als Belastung – der Tagesvorschlag kippt |
| 18 | bestätigt | mittel | behoben | Tests: eine Bestwert-Prüfung kann nie fehlschlagen, weitere sind leer oder uhrzeitabhängig; keine CI |
| 19 | bestätigt | mittel | behoben | Zwei Tabs: der ältere Tab überschreibt das Training aus dem neueren |
| 20 | bestätigt | mittel | behoben | Wiederherstellen ersetzt neuere Daten ohne Rückfrage, sobald die Sicherung gleich viele Trainings hat |
| 21 | bestätigt | mittel | behoben | Sicherungszeile sagt „aktuell“, obwohl seit der Sicherung Daten dazugekommen sind |
| 22 | bestätigt | niedrig | behoben | Begründung „Ziel je 1 Wdh. mehr“ stimmt nicht, wenn Sätze schon am oberen Ziel waren |
| 23 | bestätigt | niedrig | behoben | Ohne gespeicherte Planung behauptet die App „nur X von Y Sätzen absolviert“ |
| 24 | bestätigt | niedrig | behoben | Kalorienbilanz: zweites Training am selben Tag fehlt; Bilanz auf 1 kcal genau ohne ≈ |
| 25 | Designschwäche | mittel | teilweise | Ein Tipp macht den App-Vorschlag zur Leistung und zum Bestwert |
| 26 | Designschwäche | mittel | behoben | Generator kürzt bei knapper Zeit blind vom Ende: Pläne ohne große Muskelgruppe, die eigene Planprüfung beanstandet den frischen Vorschlag |
| 27 | Designschwäche | mittel | behoben | Wochenziel ist die Zahl der Plantage – auch leerer, auch bei weniger Terminen; Serie wird rückwirkend neu gerechnet |
| 28 | Designschwäche | mittel | teilweise | Ältere Fassung löscht Daten einer neueren: unbekannte Felder und Erweiterungsbereiche fallen beim ersten Speichern weg |
| 29 | Designschwäche | mittel | behoben | Erholungswert täuscht Genauigkeit vor: ein Satz zählt wie zwölf, Anzeige auf 1 %, Begründung als Tatsache |
| 30 | Designschwäche | niedrig | teilweise | Speicher voll: Warnung erscheint, aber die Zusammenfassung feiert ein nicht gespeichertes Training; Essen-Tagebuch wächst unbegrenzt |
| 31 | Designschwäche | niedrig | behoben | Kein Auffangnetz beim Start: wirft die erste Ansicht, bleibt die App leer und die Sicherung ist unerreichbar |
| 32 | vermutet | niedrig | behoben | Dasselbe Gerät zweimal in einem Training: nur der erste Eintrag zählt |

Die Nummern verweisen auf die Abschnitte unten.

## Bestätigte Fehler

Jeder dieser Punkte wurde mit einem Versuch nachgestellt; das falsche Ergebnis wurde beobachtet.

### 1. „Letztes Mal“ folgt der Reihenfolge im Speicher, nicht dem Datum

- **Schwere:** hoch · **Stand:** behoben – Verlauf wird beim Laden nach Datum geordnet; neue Einträge rücken an ihren Platz (`commitTraining`) (PR #76). Test: E-nachtrag.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5510 (compSessions), 2170 (lastPerf), 2397 (baseDay), 2423 (plateau), 2693 (personalStats), 7873 (exChart), 4956 (vHome), 7167 (Nachfrage), 5738 (finish: push ans Ende), 1849 (normalize sortiert nicht)
- **Was passiert:** Vorschlag, „Letztes Mal“, nächster Trainingstag, Stillstand, Kurve und die Liste „Letzte Trainings“ nehmen das letzte Array-Element als jüngstes Training. Sortiert wird nur in „Datum ändern“ (8566). Heute entsteht die Abweichung selten: ein pausiertes Training wird mit dem Pausen-Zeitpunkt ans Ende gehängt, nachdem ein älteres Training auf ein späteres Datum gelegt wurde; oder durch eine unsortierte Sicherung. Mit „nachträglich eintragen“ für ein früheres Datum wird es der Normalfall. Richtig wäre: überall nach Datum auswerten.
- **Beleg:** exp1-order.js, Verlauf [Y vor 2 Tagen: 45 × 8/8/7, X vor 20 Tagen: 40 × 12/12/12] normal geladen. Sortiert: Vorschlag 45x9 45x9 45x8, nächster Tag „Tag B“, Kurve „Aktuell 45 … Seit Beginn +5 kg“. Unsortiert: Vorschlag 42.5x8 mit „Letztes Mal alle 3 Sätze mit 12 Wdh. bei 40 kg pro Seite“, lastPerf 40x12, nächster Tag „Tag A“, „Aktuell 40 … Seit Beginn −5 kg seit 18.11.“. exp1c-home.js: zusätzlich Nachfrage „Was hält dich gerade vom Training ab?“ trotz Training vor 2 Tagen. exp1b-dateedit.js (b), nur über die …
- **Für den Nutzer:** Die App empfiehlt ein Gewicht aus einem älteren Training und begründet es mit „Letztes Mal …“, obwohl das letzte Training anders war. Sie schlägt den falschen Trainingstag vor und zeigt eine falsche Entwicklung.
- **Kleinste Korrektur:** Eine Funktion, die state.history stabil nach Datum sortiert; aufrufen in normalize(), in finish() nach dem push und in histMetaSave. Der künftige Nachtrag muss sie ebenfalls aufrufen.

### 2. „Plan erstellen“ und „Lieber selbst zusammenstellen“ ersetzen den vorhandenen Plan ohne Rückfrage, ohne Rückgängig, ohne Sicherung

- **Schwere:** hoch · **Stand:** behoben – Der bisherige Plan wird vorher unter „Meine Pläne“ gesichert; ohne freien Platz fragt die App nach. Test: E-plaene.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:7943-7949 (createPlan), 8002 (emptyPlan); Einstieg 5225 und 8003 (newPlan), Knöpfe 4931-4932
- **Was passiert:** Über Einstellungen → „Neuen Plan erstellen“ öffnet sich die Seite „Plan vorschlagen“. Ein Tipp auf „Plan erstellen“ setzt state.plan = generatePlan(…); ein Tipp auf „Lieber selbst zusammenstellen“ setzt einen leeren Plan „Tag 1“ (auch ohne Zeitbudget). Der bisherige Plan mit allen Tagen, Geräten, Sätzen, Wiederholungen, Pausen und Supersätzen ist danach nirgends mehr vorhanden. Es gibt keine Rückfrage, kein prevPlan und keine Kopie unter „Meine Pläne“. Erwartet: dieselbe Rückfrage wie beim Laden eines gesicherten Plans (9538-9546), mit dem Angebot, den aktuellen Plan vorher zu sichern.
- **Beleg:** exp2_overwrite.js S1: vorher „Mein Tag A, Mein Tag B“ (u. a. Brustpresse 5×6–8); nach „Neuen Plan erstellen“ → „Plan erstellen“: Fenster/Rückfrage = "", Tage jetzt „Drücken, Ziehen, Beine“, prevPlan null, gesicherte Pläne 0, „Mein Tag A“ im gesamten localStorage nicht mehr zu finden; Verlauf unverändert. S2: nach „Lieber selbst zusammenstellen“ Plan = ["Tag 1:0"], Rückfrage = "". Die Texte warnen nicht: Einstellungen „Ein neuer Plan lässt deinen Verlauf unverändert.“ (5229), Seite „Alles bleibt später änderbar.“ …
- **Für den Nutzer:** Wer den Vorschlag der App nur ansehen will oder den zweiten Knopf antippt, verliert seinen selbst gebauten Plan endgültig und muss ihn Gerät für Gerät neu eingeben. Der Verlauf bleibt erhalten.
- **Kleinste Korrektur:** In createPlan und emptyPlan: Hat state.plan mindestens einen Tag mit Geräten, zuerst ein actionSheet wie in plnLoadAsk zeigen („Dein aktueller Plan wird ersetzt“ mit „Vorher sichern und ersetzen“ über plnAdd(plnAuto(), plnCopy(state.plan)) und „Ohne Sichern ersetzen“). Beim Ersetzen zusätzlich state.prevPlan = null setzen (siehe Finding 2).

### 3. Sicherung wiederherstellen löscht ein laufendes Training ohne Hinweis

- **Schwere:** hoch · **Stand:** behoben – Einspielen ist gesperrt, solange ein Training läuft oder pausiert ist. Test: E-sicherheit.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:5264 (restoreBackup), 5249-5260 (tryRestore)
- **Was passiert:** restoreBackup setzt immer session: null. Enthält die Sicherung mindestens so viele Trainings wie das Gerät, gibt es gar keine Rückfrage; die Rückfrage bei weniger Trainings nennt das offene Training ebenfalls nicht. Richtig wäre: bestätigte Sätze eines offenen Trainings nie stillschweigend verwerfen.
- **Beleg:** exp4 Fall B: Training gestartet, 2 Sätze bestätigt, pausiert; dann Sicherungscode mit gleich vielen Trainings eingespielt. Ausgabe: erledigtVorher 2, hinweisImSheet „Ersetzt Plan und Verlauf auf diesem Gerät.“, rueckfrage false, sessionNachher null, meldung „Sicherung wiederhergestellt: 1 Training, 2 Trainingstage.“
- **Für den Nutzer:** Wer mitten im Training (oder mit pausiertem Training) eine Sicherung einspielt, verliert alle heute bestätigten Sätze, ohne es vorher zu erfahren.
- **Kleinste Korrektur:** In tryRestore vor dem Ersetzen prüfen, ob state.session existiert: dann wie bei „Meine Pläne → Laden“ sperren („Erst das laufende Training beenden“) oder dieselbe Rückfrage wie bei weniger Trainings zeigen und die Zahl der erledigten Sätze nennen. Test dazu ergänzen.

### 4. Verlauf wird nach Listenposition ausgewertet; beim Laden weder sortiert noch auf Zukunfts- oder kaputte Daten geprüft

- **Schwere:** hoch · **Stand:** teilweise – Reihenfolge behoben (siehe oben). Ein Training mit Datum in der Zukunft belastet die Erholung nicht mehr, und „Fortschritt“ weist mit dem Weg zur Korrektur darauf hin (PR #78, Test: E-runde3). Bewusst belassen: Bis zu seinem Datum gilt ein solcher Eintrag weiter als neuestes Training, und ein unlesbares Datum wird beim Laden zu „jetzt“ – beides entsteht nur durch eine von Hand veränderte Sicherung oder eine falsch gestellte Uhr.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:1849-1851 (normalize), 2169 (lastPerf), 2397 (baseDay), 4956 (vHome), 5508 (compSessions), 7207 (buddySays), 7718 (vHistory)
- **Was passiert:** „Letztes Training“ ist überall das letzte Element der Liste, nicht das jüngste Datum. Heute bleibt die Liste nur sortiert, weil finish() hinten anhängt und histMetaSave sortiert. normalize sortiert nicht, lässt Zukunftsdaten durch und ersetzt ein ungültiges Datum durch „jetzt“. Jeder neue Weg, der ein Training mit früherem Datum einfügt (nachträglich eintragen), trifft genau diese Annahme.
- **Beleg:** exp3 Fall R1, Verlauf [gestern 60 kg × 8, vor 20 Tagen 40 kg × 12] geladen: lastPerf liefert 40 × 12; makeEntry: recKg 42,5, „Letztes Mal alle 3 Sätze mit 12 Wdh. bei 40 kg pro Seite. Heute 42,5 kg“; Heute: „Seit 20 Tagen kein Training“; Kraft & Bestwerte: „60 kg pro Seite × 8 −20 kg“. exp1 Fall 7: Datum „kaputt“ → nach dem Laden 2026-11-20T12:31:32Z (jetzt), Brust 0 %. exp1 Fall 5: Datum +3 Tage → Brust/Schultern/Trizeps 0 %.
- **Für den Nutzer:** Falsche Gewichtsempfehlung (viel zu leicht), falscher nächster Tag, „seit 20 Tagen kein Training“ trotz Training gestern, Minus in der Kraftentwicklung. Ein Eintrag mit kaputtem Datum zählt als Training von heute, einer in der Zukunft hält Muskeln tagelang auf 0 %.
- **Kleinste Korrektur:** Am Ende von normalize den Verlauf nach Datum sortieren (dieselbe Zeile wie 8566) und das auch in jedem künftigen Schreibweg tun. Zukunftsdaten beim Laden auf „jetzt“ begrenzen. Ungültiges Datum nicht als „jetzt“ speichern, sondern den Eintrag als „Datum unbekannt“ aus zeitabhängigen Auswertungen heraushalten.

### 5. Scheitert das Laden, startet die App leer ohne Hinweis – die erste Aktion überschreibt alle Daten

- **Schwere:** hoch · **Stand:** behoben – Der unlesbare Rohtext bleibt als Kopie auf dem Gerät, Hinweis mit „Kopie als Datei sichern“, automatische Übernahme, sobald er wieder lesbar ist. Test: E-sicherheit. Offen: dasselbe Muster in `extClean` (ein Bereich einer Erweiterung wird bei einem Fehler still geleert).
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:1929 (load), 1942–1945 (save), 1997 (extClean), 4969 (Update-Hinweis nur auf „Heute“)
- **Was passiert:** load() fängt jeden Fehler von JSON.parse/normalize mit leerem catch und liefert einen leeren Zustand. Es gibt keinen Hinweis, keine Kopie des unlesbaren Speichers und keine Sperre: das nächste save() schreibt den leeren Zustand über die alten Daten. Dasselbe Muster in extClean: wirft die Prüfung einer Erweiterung, wird ihr Bereich still geleert. Richtig wäre: unlesbaren Speicher unangetastet lassen, sichern und den Nutzer informieren. Das ist genau die Lage von gestern: wer mit der fehlerhaften Fassung in der leer wirkenden App „Plan erstellen“ getippt hat, hat alles verloren. Verschärfend: eine Korrektur erreicht das Gerät erst beim zweiten Start (alte Seite zuerst aus dem Zwischenspeicher), und der Hinweis „Neu laden“ erscheint auf dem Einrichtungs-Bildschirm nicht.
- **Beleg:** e2-alte-daten.js Teil e (abgeschnittenes JSON, 5172 Zeichen): Start mit 0 Trainings, Plan null, 0 Seitenfehler, Warnung versteckt, sichtbar nur „Plan vorschlagen …“; Speicher zunächst unverändert; nach „Plan erstellen“: Speicher 2133 Zeichen, altes Training h1 nicht mehr enthalten, alter Inhalt in keinem localStorage-Schlüssel mehr. e8-alte-version.js (Fassung 2d8b5c9 mit dem gestrigen Fehler + abgewählte Scheiben): „Start: Trainings im Fenster 0 / im Speicher 3 / Hinweis sichtbar: false“, nach „Plan erstellen“: …
- **Für den Nutzer:** Nach einem Ladefehler (Programmfehler in einer neuen Fassung, beschädigter Speicher) sieht der Nutzer eine leere App wie beim ersten Start. Tippt er irgendetwas, das speichert, sind Plan, Verlauf, Essen und Gewichte endgültig weg.
- **Kleinste Korrektur:** In load(): Ist ein Rohwert vorhanden, aber Parsen/normalize wirft, den Rohtext unter einem zweiten Schlüssel ablegen (z. B. trainingsplan-v2-unlesbar), eine Marke loadFailed setzen und in save() nicht nach KEY schreiben, solange sie gesetzt ist. Dazu ein sichtbarer Hinweis mit „Neu laden“ und „Rohdaten als Datei sichern“. In extClean den Rohbereich behalten statt leeren, wenn die Prüfung wirft.

### 6. Markierung „steht in meinem Studio“ ist nicht verlässlich: die Geräteauswahl setzt sie still, und abgewählte Geräte bleiben ohne Hinweis im Plan und im Training

- **Schwere:** mittel · **Stand:** behoben – Die Geräteauswahl sagt sichtbar „jetzt als ‚im Studio‘ markiert“ und nimmt die Markierung beim Herausnehmen zurück; Geräte im Plan, die als „nicht im Studio“ markiert sind, stehen in der Planprüfung und sind in der Tagesansicht gekennzeichnet (PR #78). Bewusst belassen: Ein im laufenden Training hinzugefügtes Gerät gilt als im Studio – der Nutzer steht gerade daran. Test: E-runde3.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:8448-8452 (pick setzt off:false, nimmt es beim Abwählen nicht zurück), 5445 (sesAdd ebenso), 5491 (startTraining ohne Prüfung), Tagesansicht 5274-5305 und planCheck 7299-7310 ohne Hinweis
- **Was passiert:** (1) Tippt der Nutzer in der Geräteauswahl ein als „nicht im Studio“ gezeigtes Gerät an, wird es still als „im Studio“ markiert (Kommentar 8446: „Wer ein Gerät einplant, hat es im Studio“). Nimmt er es sofort wieder heraus, bleibt die Markierung. Der Generator darf es danach automatisch einplanen. (2) Wählt der Nutzer ein Gerät ab, das im Plan steht, bleibt es im Plan; weder Heute, Plan, Tag noch die Planprüfung weisen darauf hin, und das Training startet mit dem Gerät. Nur „Zeit für heute“ ersetzt es (und zeigt das an).
- **Beleg:** exp2_overwrite.js S5: Zeile „Beinpresse / Life Fitness … / nicht im Studio“, vorher off = true, 36 Geräte im Studio. Nach Antippen und Wieder-Abwählen: off = false, 37 im Studio, Gerät nicht im Tag. Danach erzeugter Plan (Hammer-Strength-Beinpresse nicht im Studio): Beine = lf-legpress, hs-hack, hs-legext, … S9: Brustpresse nachträglich abgewählt (off = true): Hinweis „nicht im Studio“ auf Heute/Plan/Tag: false/false/false; Planprüfung ohne Meldung dazu; gestartetes Training enthält hs-chest, hs-row, hs-legpress.
- **Für den Nutzer:** Ein versehentlich angetipptes Gerät gilt dauerhaft als vorhanden und kann in späteren Vorschlägen auftauchen. Umgekehrt führt die App im Training an ein Gerät, das der Nutzer ausdrücklich als nicht vorhanden markiert hat.
- **Kleinste Korrektur:** In pick merken, dass die Markierung durch dieses Antippen gesetzt wurde, und sie beim Herausnehmen wieder zurücksetzen (oder im Fenster sichtbar melden „als ‚im Studio‘ markiert“). In der Tagesansicht und in planCheck Geräte mit ex(id).off als „nicht im Studio“ kennzeichnen (Text wie in 5423) mit Verweis auf Tauschen oder Entfernen.

### 7. Auf einem neuen Gerät ist „Sicherung wiederherstellen“ erst nach dem Anlegen eines Plans erreichbar

- **Schwere:** mittel · **Stand:** behoben – „Schon eine Sicherung? Wiederherstellen“ steht auf dem Einstieg und im Formular „Plan vorschlagen“ (PR #78). Test: E-runde3.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:5227 (Zeile nur in den Einstellungen), Einstieg/Einrichtung (vSetup, Aktionen setupForm/emptyPlan/createPlan)
- **Was passiert:** Die Einstellungen sind nur über den Plan-Tab erreichbar, und die Tab-Leiste gibt es erst mit einem Plan. Der Einstieg und das Einrichtungsformular bieten keinen Weg zur Wiederherstellung. Der Hauptfall der Sicherung (neues Handy, gelöschte Browserdaten, leerer Start nach einem Ladefehler) verlangt also, erst einen Wegwerf-Plan anzulegen.
- **Beleg:** e1c-leere-app-intro.js auf frischem Gerät: „Erster Start, sichtbare Aktionen: emptyPlan setupForm / Wort Sicherung auf der Seite: false“; nach setupForm: „setupIntro setup setupDay openDevs createPlan / Wort Sicherung: false“; erst nach „Plan erstellen“ (3 Plan-Tage gespeichert): „importOpen jetzt sichtbar: true“. tests/run.js:155 geht denselben Umweg.
- **Für den Nutzer:** Nach Handywechsel findet der Nutzer keinen Weg, seine Sicherung einzuspielen, und hält die Daten für verloren – oder beginnt neu.
- **Kleinste Korrektur:** Auf dem Einstieg und im Einrichtungsformular eine Zeile „Schon eine Sicherung? Wiederherstellen“ mit data-a="importOpen" ergänzen (das Fenster braucht keinen Plan).

### 8. Letzter Satz der letzten Übung lässt sich nie bewerten

- **Schwere:** mittel · **Stand:** behoben – Die Zusammenfassung fragt „Wie war der letzte Satz?“; die Antwort fließt sofort in „Nächstes Mal“ ein (PR #77). Test: E-runde2.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5662 (doneSet ruft finish vor der Pausenansicht), 5555 und 5563 (lastHard, allEasy), 7665 (vSummary ohne Bewertung), 7845 (histSetSheet nur kg/Wdh.)
- **Was passiert:** Die Regeln „letzter Satz schwer oder Reserve 0 → nicht steigern“ und „alle Sätze leicht → steigern“ brauchen die Bewertung des letzten Satzes. Die Frage „Wie war Satz N?“ erscheint nur in der Pause nach dem Satz. Nach dem allerletzten Satz des Trainings gibt es keine Pause, und weder Zusammenfassung noch Verlauf bieten die Bewertung an. Für die letzte Übung jedes Trainings greifen beide Regeln daher nie.
- **Beleg:** exp5-lastset.js: „Brust Satz 2 erledigt … -> Bewertungsfrage: (keine – Ansicht: Tag A)“, „Zusammenfassung bietet Bewertung an: false“. Gespeichert: hs-row 30x12(h),30x12(h) ; hs-chest 40x12(h),40x12(–). Nächstes Mal: hs-row „Gewicht halten · letzter Satz schwer“, hs-chest „+2,5 kg · letztes Mal alles geschafft“, obwohl der Nutzer jeden bewertbaren Satz als schwer bewertet hat. Felder im Verlauf: hsKg, hsReps.
- **Für den Nutzer:** An der letzten Übung jedes Trainings steigert die App das Gewicht auch dann, wenn der Satz am Limit war. Die Steigerung wegen „leicht“ gibt es dort nie.
- **Kleinste Korrektur:** In der Zusammenfassung für den letzten erledigten Satz dieselbe Frage (Leicht/Passt/Schwer, Reserve) anbieten und in den gerade gespeicherten Verlaufseintrag schreiben.

### 9. „Frühere Einträge umstellen“ im laufenden Training speichert die neuen Sätze mit der alten Einheit

- **Schwere:** mittel · **Stand:** behoben – Noch nicht begonnene Übungen des Geräts werden mit der neuen Gewichtsangabe neu berechnet, auch zeitbedingt ausgeblendete (PR #77). Test: E-runde2.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:8496–8501 (devRelabel ändert state.dev sofort, Sitzung bleibt), 8483–8488 (devSave vergleicht danach mit der schon neuen Einheit), 5724 (finish nimmt x.u)
- **Was passiert:** Wer im Training vor dem ersten Satz das Gerät bearbeitet, die Gewichtsangabe ändert und „Frühere Einträge als … werten“ bestätigt, sieht im Training die neue Einheit. Der Sitzungseintrag behält die alte. Die heutigen Sätze werden mit der alten Einheit gespeichert. Richtig wäre: Sitzungseintrag mit umstellen, wie devSave es ohne Umstellung tut.
- **Beleg:** exp3-units.js Teil 3: „Anzeige im Training: kg insgesamt / Sitzungseintrag u = s / Gerät jetzt: t / Verlauf: hs-chest[t]“. Nach Eingabe 80 × 10: gespeichert „hs-chest[t] 40x10,40x10,40x9 // hs-chest[s] 80x10“, Volumen 1,6 t (80 × 10 × 2). Nächster Vorschlag „Letztes Mal 40 kg insgesamt × 10/10/9“, das heutige Training fehlt.
- **Für den Nutzer:** Das Training steht mit falscher Gewichtsangabe im Verlauf, zählt doppelt beim Volumen und fehlt für Vorschlag und Bestwerte der richtigen Einheit.
- **Kleinste Korrektur:** In devRelabel die noch nicht begonnenen Sitzungseinträge dieses Geräts wie in devSave (8487) neu berechnen; alternativ die Umstellung sperren, solange ein Training läuft.

### 10. Pausenregel greift nicht bei uneinheitlichen Sätzen

- **Schwere:** mittel · **Stand:** behoben – Ab 28 Tagen Pause auch bei uneinheitlichen Sätzen je Satz ein Schritt leichter, als Regel der App gekennzeichnet (PR #77). Test: E-runde2.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5617–5624 (Bedingung L.uniform; 21-Tage-Regel nur bei mode === "up")
- **Was passiert:** Die Regel der App „28 Tage oder länger → ein Schritt leichter“ gilt nur, wenn alle Sätze der letzten Einheit dasselbe Gewicht hatten. Waren die Gewichte unterschiedlich, bleibt nach beliebig langer Pause der normale Vorschlag stehen, hier mit je einer Wiederholung mehr. Die Pause wird im Text nicht genannt.
- **Beleg:** exp4-rules.js C3c (200 Tage Pause, zuletzt 40 × 12, 42,5 × 10, 42,5 × 9): „HOLD 40x12 42.5x11 42.5x10 … Gewichte satzweise übernommen, Ziel je 1 Wdh. mehr. Keine pauschale Steigerung.“ Zum Vergleich C3 (einheitlich, 200 Tage): „−2,5 kg · 200 Tage Pause … (Regel der App)“.
- **Für den Nutzer:** Nach Monaten Pause verlangt die App mehr Wiederholungen als beim letzten Mal und nennt die Pause nicht.
- **Kleinste Korrektur:** Bei gap ≥ 28 und uneinheitlicher letzter Einheit: fromLast(0) mit dem Pausentext, ohne „+1 Wdh.“.

### 11. „Rückgängig“ unter Hinweise setzt den ganzen Plan auf einen alten Stand: spätere Handänderungen und sogar ein neu erstellter Plan gehen verloren

- **Schwere:** mittel · **Stand:** behoben – „Rückgängig“ nur, solange der Plan seit der Änderung unverändert ist; sonst erklärt die Karte, warum es nicht mehr geht (PR #77). Ein neu erstellter Plan räumt das alte „Rückgängig“ ab (PR #76). Test: E-runde2.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:8206 und 8210 (prevPlan = Kopie des ganzen Plans), 8212 (coachUndo), Karte 7575-7579; 7946 und 8002 räumen prevPlan nicht ab
- **Was passiert:** Der Gerätetausch aus einem Hinweis und „Plan mit n Tagen“ legen eine Kopie des gesamten Plans in state.prevPlan ab. Die Karte „Plan geändert · … / Rückgängig / Behalten“ bleibt unbegrenzt stehen. „Rückgängig“ setzt ohne Rückfrage state.plan = prevPlan.plan – alles, was seitdem am Plan geändert wurde, ist weg. createPlan und emptyPlan löschen prevPlan nicht (plnLoad tut es, 9481), deshalb ersetzt ein späteres „Rückgängig“ sogar einen neu erstellten Plan. Erwartet: Rückgängig nur, solange der Plan seit der Änderung unverändert ist (so macht es dayCopyUndo, 8418-8419), sonst Hinweis oder Rückfrage.
- **Beleg:** exp2_overwrite.js S3: nach dem Tausch Brustpresse → Negativ-Brustpresse von Hand Rudern 4 → 6 Sätze und Armbeuger ergänzt (Tag A: hs-decline×5, hs-row×6, hs-legpress×4, hs-curl×3). Karte: „PLAN GEÄNDERT · 20. NOVEMBER / Brustpresse → Negativ-Brustpresse wegen Stillstand / Rückgängig / Behalten“. Nach „Rückgängig“ (Rückfrage = ""): Tag A = hs-chest×5, hs-row×4, hs-legpress×4 → Handänderungen verloren. S3b: nach dem Tausch neuen Plan erzeugt (Drücken, Ziehen, Beine); die Karte steht weiter da; „Rückgängig“ → Plan …
- **Für den Nutzer:** Die Karte beschreibt nur einen Gerätetausch; wer sie Tage später antippt, verliert unbemerkt alle Planänderungen seitdem. Der Satz „Die App ändert deinen Plan nie ohne deine Bestätigung“ (7586) stimmt dann nicht mehr.
- **Kleinste Korrektur:** In createPlan/emptyPlan state.prevPlan = null setzen. In coachSwap/coachPlanApply zusätzlich den Plan nach der Änderung als Text merken (prevPlan.after) und in coachUndo nur zurücksetzen, wenn JSON.stringify(state.plan) === prevPlan.after; sonst Meldung „Nicht mehr rückgängig: Der Plan wurde inzwischen geändert“ und prevPlan verwerfen.

### 12. Gerätetausch aus dem Hinweis „Stillstand“ erzeugt ein doppeltes Gerät im Tag

- **Schwere:** mittel · **Stand:** behoben – Die vorgeschlagene Alternative steht in keinem betroffenen Tag; Tage, die das Zielgerät schon enthalten, bleiben unverändert (PR #77). Test: E-runde2.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:7413 (Alternative wird nur gegen den ersten Tag mit dem Gerät geprüft), 8205-8207 (coachSwap tauscht in allen Tagen)
- **Was passiert:** Der Hinweis sucht die Alternative mit rankAlternatives(it.exId, Geräte des ERSTEN Tages, der das Gerät enthält). coachSwap ersetzt das Gerät aber in allen Tagen. Enthält ein anderer Tag sowohl das alte Gerät als auch die Alternative, steht die Alternative dort danach zweimal. Erwartet: kein Tausch in Tagen, die das Zielgerät schon enthalten.
- **Beleg:** exp2_overwrite.js S3: Tag A: Brustpresse, Rudern, Beinpresse; Tag B: Brustpresse, Negativ-Brustpresse, Brustpresse breit, Latziehen. Hinweis „Brustpresse: Stillstand seit 4 Wochen“ mit Knopf „Gegen Negativ-Brustpresse tauschen“ (from hs-chest, to hs-decline). Nach einem Tipp, ohne Rückfrage: „Mein Tag B: hs-decline×3, hs-decline×3, hs-widechest×3, hs-pulldown×3“; Auswertung „Doppelte je Tag: Mein Tag B: hs-decline“.
- **Für den Nutzer:** Im Training steht dasselbe Gerät zweimal hintereinander. Die Auswertung je Gerät liest pro Training nur den ersten Eintrag eines Geräts (compSessions, 5511), der zweite Block würde für Vorschläge und Stillstand nicht zählen. Betrifft vor allem selbst gebaute Pläne mit demselben Gerät an zwei Tagen.
- **Kleinste Korrektur:** In coachSwap Tage überspringen, die das Zielgerät (oder ein sameKind-Gerät) schon enthalten; besser schon in insights (7413) die Menge „used“ aus allen Tagen bilden, die das Gerät enthalten.

### 13. „Zeit für heute“ bleibt nach dem Bearbeiten des Tages gültig: neu hinzugefügtes Gerät wird beim Start still ausgeblendet, erhöhte Sätze werden gekürzt

- **Schwere:** mittel · **Stand:** behoben – Nach jeder Änderung am Tag wird die Anpassung mit denselben Minuten neu berechnet oder entfällt (PR #77). Test: E-runde2.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:8378-8385 (timeApply speichert keep je Geräte-Eintrag), 5497-5500 (startTraining: unbekannte Einträge → 0 Sätze), 4984-4986 (Heute-Karte zeigt gespeicherte Zahlen); kein Zurücksetzen in 8435 (saveItem), 8448-8452 (pick), 8436/8438 (löschen), 8424 (verschieben) – nur in 5327 und 8432
- **Was passiert:** Die Zeitanpassung für heute wird mit der Satzzahl je Planeintrag gespeichert. Ändert der Nutzer danach am selben Tag den Trainingstag, bleibt die alte Anpassung aktiv. Beim Start bekommt ein neu hinzugefügtes Gerät 0 Sätze (ausgeblendet), erhöhte Sätze werden auf den alten Wert gekürzt. Die Heute-Karte zeigt weiter die alte Zahl Übungen und Minuten. Erwartet: Die Anpassung wird bei jeder Änderung des Tages verworfen oder neu berechnet.
- **Beleg:** exp3_time.js S8: 30 Min. übernommen (keep a1..a6 = 2, „6 Übungen, 12 statt 18 Arbeitssätze“). Danach im Tag Hüftheben hinzugefügt und Brustpresse 3 → 5 Sätze: Tag = hs-chest×5, …, hs-hipthrust×3. Heute-Karte danach: „Tag A / 6 Übungen / ≈ 30 Min. / Für heute auf 30 Min. angepasst“ (Tag hat 7 Geräte). Gestartetes Training: hs-chest×2, hs-row×2, hs-legpress×2, hs-shoulder×2, hs-seatcurl×2, hs-curl×2; ausgeblendet: hs-hipthrust.
- **Für den Nutzer:** Die letzte, bewusste Entscheidung des Nutzers (Gerät dazu, mehr Sätze) wird beim Start ohne Hinweis übergangen. Das Gerät lässt sich im Training nur über „Zeit anpassen → Ursprüngliche Einheit fortsetzen“ zurückholen – wenn man weiß, dass es fehlt.
- **Kleinste Korrektur:** In saveItem, pick, delItem, delItemAt und moveItem dieselbe Zeile wie in dayCopyDo ergänzen: if (state.timeplan && state.timeplan.dayId === d.id) state.timeplan = null.

### 14. „Gerät tauschen“ bietet ein zeitbedingt ausgeblendetes Gerät des Tages an – danach steht es doppelt im Plan und im Training

- **Schwere:** mittel · **Stand:** behoben – Keine Geräte mehr in der Auswahl, die ausgeblendet sind oder im Plantag stehen (PR #77). Test: E-runde2.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:5920 (used nur aus s.list, nicht aus s.timeHidden), 8538-8543 (swap, bei „Auch im Plan“ ohne Prüfung des Plantags)
- **Was passiert:** Die Liste der Alternativen schließt nur Geräte aus, die gerade in der laufenden Liste stehen. Geräte, die wegen „Zeit anpassen“ ausgeblendet sind, gehören weiter zum Training und zum Plantag, werden aber als Alternative angeboten. Wählt man sie, ist das Gerät nach „Ursprüngliche Einheit fortsetzen“ zweimal im Training, mit „Auch im Plan“ auch zweimal im Plantag.
- **Beleg:** exp3_time.js S4: Tag Beinpresse, Hackenschmidt, Beinstrecker, Beinbeuger, Hüftheben, Wadenheben; „Noch 20 Minuten“ → „Entfällt: Hackenschmidt, Beinbeuger sitzend, Wadenheben stehend“. Tausch-Angebote an der Beinpresse: hs-isolegpress, hs-vsquat, hs-hack, hs-beltsquat, hs-smith. Nach Tausch gegen hs-hack mit „Auch im Plan“: Plantag = hs-hack, hs-hack, hs-legext, hs-seatcurl, hs-hipthrust, hs-calf. Nach „Ursprüngliche Einheit fortsetzen“: Training = hs-hack, hs-hack, hs-legext, hs-seatcurl, hs-hipthrust, hs-calf.
- **Für den Nutzer:** Ein dauerhaft doppeltes Gerät im Plantag und zwei Blöcke desselben Geräts im Training; die Beinpresse ist aus dem Plan verschwunden, ohne dass der Nutzer das Doppel bemerkt.
- **Kleinste Korrektur:** In swapSheet used = Geräte aus s.list und s.timeHidden; bei swapPerm zusätzlich die Geräte des Plantags ausschließen bzw. den Plan nur ändern, wenn der Tag das neue Gerät noch nicht enthält.

### 15. Planprüfung sagt „jeder Tag passt in dein Zeitbudget“, obwohl ein Tag bis zu 12,5 Minuten darüber liegt (40 % bei 30 Min.)

- **Schwere:** mittel · **Stand:** behoben – „Passt“ nur, wenn die Schätzung im Budget liegt; knapp darüber wird der Tag mit seiner Schätzung genannt (PR #77). Test: E-runde2.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:7308 (Meldung erst bei gerundeter Schätzung > Budget + 10), 7332 (Aussage), 2236 (Rundung auf 5 Min.)
- **Was passiert:** Der Generator hält das Budget exakt ein (Schätzung ≤ Minuten). Die Planprüfung meldet einen Tag aber erst, wenn die auf 5 Minuten gerundete Schätzung mehr als 10 Minuten über dem Budget liegt, also ab exakt Budget + 12,5 Min. Darunter erscheint der positive Satz „Alle großen Muskelgruppen sind dabei, jeder Tag passt in dein Zeitbudget.“ Gleichzeitig begründet dieselbe Prüfung fehlende Sätze mit „Mehr passt nicht in dein Zeitbudget“ nach der exakten Rechnung (7304, 7320). Erwartet: Die Aussage „passt“ nur, wenn die eigene Schätzung im Budget liegt.
- **Beleg:** exp3b_budgetcheck.js (Plan vom Assistenten, dann ein Gerät und Sätze von Hand ergänzt): Budget 30 Min.: „Drücken“ 5 Geräte, 18 Sätze, exakt 42,0 Min. = 40 % über Budget, Planzeile „Drücken 40 Min.“, 0 Zeit-Meldungen, Aussage „Alle großen Muskelgruppen sind dabei, jeder Tag passt in dein Zeitbudget.“ Budget 45 Min.: exakt 57,0 Min. = 27 % darüber, Anzeige 55 Min., gleiche Aussage. Budget 60 Min.: exakt 71,5 Min., 0 Zeit-Meldungen.
- **Für den Nutzer:** Wer seinen Plan von Hand erweitert, bekommt bestätigt, dass alles ins Zeitbudget passt, während die App selbst 40 statt 30 Minuten anzeigt. Die Toleranz von 10 Minuten ist nirgends genannt.
- **Kleinste Korrektur:** Den Satz „jeder Tag passt in dein Zeitbudget“ nur ausgeben, wenn für alle Tage estimateSec(d.items) / 60 <= p.minutes gilt; sonst eine neutrale Zeile „≈ 40 Min. bei 30 Min. Zeitbudget“ zeigen (die Zeile aus 7316 ab jeder Überschreitung, die bisherige Schwelle nur für die Zählung „Punkte zu prüfen“ verwenden).

### 16. Stillstand gemeldet, obwohl das Gewicht nach einer bewussten Reduktion viermal in Folge stieg

- **Schwere:** mittel · **Stand:** behoben – Kein Stillstand, wenn die letzten beiden Einheiten jeweils besser waren als die davor (PR #77). Test: E-runde2.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:2421-2435 (plateau), 7408-7419 (insights)
- **Was passiert:** plateau vergleicht jede Einheit nur mit dem bisherigen Höchstwert im Fenster der letzten 6 Einheiten. Liegt die erste Einheit im Fenster am höchsten, gilt alles danach als „kein Fortschritt“, auch ein klar steigender Verlauf. Die Karte bietet dann den Gerätetausch an.
- **Beleg:** exp3 Fall P1, Brustpresse 50 → 40 → 42,5 → 45 → 47,5 kg, je 3 × 10, 5 vollständige Einheiten in 28 Tagen: plateau = {weeks: 4, n: 5, reserve: false}; Karte auf Heute: „Brustpresse: Stillstand seit 4 Wochen … 5 vollständige Einheiten ohne mehr Gewicht oder Wiederholungen. Möglich: ein Gerät mit gleichem Bewegungsmuster (Negativ-Brustpresse) …“ mit Knopf „Gegen Negativ-Brustpresse tauschen“. Gegenprobe P2 (5 × 45 kg) liefert dasselbe Ergebnis – dort zu Recht.
- **Für den Nutzer:** Wer nach Pause, Krankheit oder Technikkorrektur leichter einsteigt und sich wieder hocharbeitet, bekommt eine falsche Aussage („ohne mehr Gewicht“) und die Empfehlung, das Gerät zu tauschen.
- **Kleinste Korrektur:** Keinen Stillstand melden, wenn die letzten zwei Einheiten jeweils besser waren als die Einheit davor (mehr Gewicht oder bei gleichem Gewicht mehr Wiederholungen). Testfall „Reduktion, dann Anstieg“ ergänzen.

### 17. Erholung zählt gelöschte Geräte als Brust und Einträge ohne gültigen Satz als Belastung – der Tagesvorschlag kippt

- **Schwere:** mittel · **Stand:** behoben – Erholung und Muskelbelastung zählen nur gültige Sätze und nur bekannte Geräte (PR #77). Test: E-runde2.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:2513-2525 (recovery), 1790 (devFrom), 8505-8507 (devDelete), 2402-2411 (baseDay), 6940 (weekStats), 7708 (vHistory)
- **Was passiert:** recovery() wertet jede Übung eines Verlaufseintrags aus, egal ob das Gerät noch bekannt ist und ob ein gültiger Satz vorliegt. Für unbekannte Geräte liefert devFrom den Ersatz muscle „brust“. Ein eigenes Gerät lässt sich löschen, sobald es nicht mehr im Plan steht – auch mit Verlauf. Die Muskel-Seite schließt solche Einträge bereits aus (mkLast 9326), recovery() nicht. Dieselbe Zuordnung zählt die Sätze im Wochenrückblick und in „Muskelbelastung“ zur Brust (Code 6940, 7708).
- **Beleg:** exp1 Fall 6: Verlauf nur mit gelöschtem eigenem Wadengerät vor 2 Std. → {brust: 2,8}, Waden 100. Fall 10: dadurch auf Heute „Angepasst – Ruecken-Tag – Brust ist noch nicht erholt. Heute lieber Ruecken-Tag, Brust-Tag danach.“ Fall 4: Eintrag nur mit Satz {kg: null, reps: 0} vor 1 Std. → Brust 1,4 / Schultern 2,1 / Trizeps 2,1.
- **Für den Nutzer:** Die App behauptet, die Brust sei nicht erholt, obwohl sie nicht trainiert wurde, und schlägt deshalb einen anderen Tag vor. Sätze eines gelöschten Geräts erscheinen als Brustsätze der Woche.
- **Kleinste Korrektur:** In recovery() nur Übungen mit bekanntem Gerät und mindestens einem validSet werten (wie mkLast); dieselbe Bedingung in 6940 und 7708. Alternativ beim Löschen eines Geräts mit Verlauf den Muskel im Verlaufseintrag festhalten.

### 18. Tests: eine Bestwert-Prüfung kann nie fehlschlagen, weitere sind leer oder uhrzeitabhängig; keine CI

- **Schwere:** mittel · **Stand:** behoben – Automatische Tests für Pull Requests sind eingerichtet (`.github/workflows/tests.yml`, PR #76). Die leeren und uhrzeitabhängigen Prüfungen sind ersetzt: Bestwert beim ersten Mal wird in der Pause geprüft, „genau diesen Tag starten“ mit zwei Tagen, die Barcode-Fälle am Text, „Termin verpasst“ mit fester Uhr (PR #78).
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** tests/run.js:2834, 3107, 1867, 1387, 1390; src/app.html:5662 (doneSet)
- **Was passiert:** 2834 („Erstes Mal an einem Gerät: kein Bestwert-Vergleich“) prüft, dass keine Ansage „30 Kilo“ enthält. Der geprüfte Satz ist aber der letzte des Trainings; doneSet ruft dort finish(true) auf (5662), bevor die Bestwert-Ansage (5670) erreicht wird. Die Bedingung ist also immer wahr. 3107 prüft „genau diesen Tag“ mit einem Plan aus einem einzigen Tag. 1867 besteht vor 2 Uhr nachts ohne Prüfung, 1387 und 1390 sind ok(…, true). Es gibt weder .github/workflows noch package.json.
- **Beleg:** exp4 Fall A: Plan mit 1 Satz, bisher 40 kg, heute 50 kg (echter Bestwert) → Ansagen: [„Los geht's. …“, „Training geschafft. Mit neuem Bestwert.“] – keine Zeile „Neuer Bestwert: 50 Kilo“. Derselbe Satz als erster von zwei → „Neuer Bestwert: 50 Kilo.“ Damit kann die Ansage im letzten Satz nie kommen, egal was livePr liefert. PLAN_SMALL: tests/run.js:43-46, ein Tag „d1“.
- **Für den Nutzer:** Kein direkter. Die Regel „erstes Mal ist kein Bestwert“ im Live-Training und „▶ startet genau diesen Tag“ sind in Wahrheit ungeprüft; Fehler dort blieben unbemerkt, und ohne CI läuft die Prüfung nur, wenn jemand daran denkt.
- **Kleinste Korrektur:** 2834: dem zweiten Gerät zwei Sätze geben und #livePr nach dem ersten prüfen. 3107: Plan mit zwei Tagen, den zweiten starten. 1867: Uhr wie in Abschnitt 66 feststellen. Danach ein Workflow mit build.sh, Playwright-Chromium und node tests/run.js.

### 19. Zwei Tabs: der ältere Tab überschreibt das Training aus dem neueren

- **Schwere:** mittel · **Stand:** behoben – Speichert ein anderes Fenster, übernimmt dieses Fenster dessen Stand (mit Hinweis), statt ihn später zu überschreiben (PR #77). Test: E-runde2.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:1942–1945 (save); kein storage-Ereignis im ganzen Skript
- **Was passiert:** Jeder Tab hält den ganzen Zustand im Arbeitsspeicher und schreibt ihn bei jeder Aktion komplett zurück. Es gibt weder einen Abgleich vor dem Schreiben noch eine Reaktion auf Änderungen aus einem anderen Tab. Ein offen gelassener Tab schreibt seinen alten Stand über alles, was inzwischen woanders gespeichert wurde.
- **Beleg:** e3-quota-tabs-restore.js Teil B: „Start: Trainings Tab A = 1 / Tab B = 1“; Tab B macht ein Training (4 Sätze): „Trainings im Speicher: 2“; Tab A zeigt nach dem Zurückkehren weiter 1; nach einem Tipp auf „Start“ in Tab A: „Trainings im Speicher = 1 / IDs: alt1 → Training aus Tab B ÜBERSCHRIEBEN“.
- **Für den Nutzer:** Wer die App in Safari in zwei Tabs offen hat, kann ein komplettes Training (oder Essen, Gewichte, Planänderungen) verlieren, ohne es zu merken. In der Home-Bildschirm-App mit nur einem Fenster tritt das nicht auf.
- **Kleinste Korrektur:** Einen Zähler im gespeicherten Zustand mitführen (z. B. rev). Vor dem Schreiben den Zähler im Speicher lesen: ist er höher als der beim Laden gemerkte, nicht schreiben, sondern neu laden bzw. den Nutzer hinweisen. Zusätzlich auf das storage-Ereignis hören und den Zustand neu laden, wenn kein Training und kein Fenster offen ist.

### 20. Wiederherstellen ersetzt neuere Daten ohne Rückfrage, sobald die Sicherung gleich viele Trainings hat

- **Schwere:** mittel · **Stand:** behoben – Rückfrage auch, wenn auf dem Gerät neuere Trainings liegen (PR #76). Der Stand von vorher bleibt 14 Tage als Kopie und lässt sich unter Einstellungen zurückholen; das Fenster nennt, was ersetzt wird (Plan, Verlauf, Essen, Gewichte, Einstellungen) (PR #78). Test: E-sicherheit, E-runde3.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:5249–5267 (tryRestore, restoreBackup), 7974–7991
- **Was passiert:** Die Rückfrage kommt nur, wenn die Sicherung weniger Trainings enthält als das Gerät. Bei gleicher oder größerer Anzahl wird sofort nach Dateiwahl bzw. „Text wiederherstellen“ alles ersetzt: andere, neuere Trainings, Essen-Tagebuch, Gewichte, Körpermaße, gespeicherte Pläne und ein pausiertes Training. Der Hinweis nennt nur „Plan und Verlauf“. Es gibt kein Rückgängig und keine Kopie des alten Stands.
- **Beleg:** e3 Teil C: Gerät mit 3 Trainings der letzten 3 Tage, 1 Essen-Tag, 2 Gewichten, 1 Körpermaß, 1 gespeichertem Plan; Sicherung mit 3 Trainings vom August: „Rückfrage erschienen: false / Trainings jetzt: alt1 2026-08-11, alt2, alt3 / Essen-Tage 0 (vorher 1) / Gewichte 1 (vorher 2) / Körpermaße 0 / Meine Pläne 0 / Rückgängig angeboten: false“. e9-kleinigkeiten.js 3: pausiertes Training mit 1 erledigten Satz, nach dem Wiederherstellen „Rückfrage: false / laufendes Training noch da: false“.
- **Für den Nutzer:** Wer versehentlich eine ältere Sicherungsdatei wählt, verliert die Trainings und Einträge seit dieser Sicherung endgültig – genau das, was die Regel „Trainingsdaten nie zerstören“ ausschließen soll.
- **Kleinste Korrektur:** Immer eine Bestätigung zeigen, sobald auf dem Gerät Daten liegen: „Auf dem Gerät: n Trainings, neuestes vom …; in der Sicherung: m, neuestes vom …“, und auf Essen, Gewichte und ein laufendes Training hinweisen. Vor dem Ersetzen den alten Stand unter einem zweiten Schlüssel ablegen und einmalig „Rückgängig“ anbieten.

### 21. Sicherungszeile sagt „aktuell“, obwohl seit der Sicherung Daten dazugekommen sind

- **Schwere:** mittel · **Stand:** behoben – „Aktuell“ nur, wenn ein Fingerabdruck der Daten seit der Sicherung unverändert ist; Trainings zählen nach dem Eintragszeitpunkt (PR #77). Test: E-runde2.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:1950 (sinceBackup), 1965 (backupLine), 5240 (backupSheet), 7540–7541 (Erinnerung)
- **Was passiert:** „Aktuell“ und „seitdem nichts Neues“ zählen nur Trainings, deren Trainingsdatum nach der letzten Sicherung liegt. Neue Gewichte, Essen-Einträge, Planänderungen, korrigierte Sätze und Trainings mit einem Datum vor der Sicherung zählen nicht; die Erinnerung (ab 5 Trainings und 14 Tagen) zählt genauso. Mit „nachträglich eintragen“ werden rückdatierte Trainings der Normalfall.
- **Beleg:** e4-session-reload.js Teil 4: Sicherung von gestern, danach 1 Gewicht, 1 Essen-Tag, 1 Übung aus dem Plan entfernt, 1 Satz im alten Training von 40 auf 45 kg geändert, 1 Training mit Datum vor 3 Tagen ergänzt (Trainings 1 → 2). Zeile in den Einstellungen unverändert: „Zuletzt am 19. November · aktuell“; im Sicherungsfenster: „Letzte Sicherung am 19. November, seitdem nichts Neues.“
- **Für den Nutzer:** Der Nutzer verlässt sich auf „aktuell“ und sichert nicht, obwohl seine Datei wichtige neue Daten nicht enthält; nachgetragene Trainings lösen nie eine Erinnerung aus.
- **Kleinste Korrektur:** In save() einen Zeitpunkt der letzten Änderung führen (außer in markBackup) und „aktuell“ nur zeigen, wenn er nicht nach backupAt liegt. Trainings für die Erinnerung nach Anlagezeitpunkt zählen (eigenes Feld am Training, in normalize aufnehmen), nicht nach Trainingsdatum.

### 22. Begründung „Ziel je 1 Wdh. mehr“ stimmt nicht, wenn Sätze schon am oberen Ziel waren

- **Schwere:** niedrig · **Stand:** behoben – Die Begründung nennt die tatsächlichen Ziele („Ziel heute 12/12/10 Wdh. … höchstens 12“) (PR #77). Test: E-runde2.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5542–5543 (fromLast mit clampR), 5614–5615, 5578
- **Was passiert:** Die Ziel-Wiederholungen werden auf den Bereich begrenzt. Der Text behauptet trotzdem für jeden Satz eine Wiederholung mehr. Das betrifft auch den häufigen Fall 12/12/10 → 12/12/11.
- **Beleg:** exp4-rules.js C7: zuletzt 40 × 14/12/9 → Vorschlag 40x12 40x12 40x10 mit „Gewicht halten, Ziel je 1 Wdh. mehr.“ (Satz 1: 2 weniger, Satz 2: gleich). C16: zuletzt 12/12/12/6, heute 3 Sätze → 40x12 40x12 40x12 mit demselben Text.
- **Für den Nutzer:** Der Text widerspricht den Zahlen direkt daneben.
- **Kleinste Korrektur:** Text aus den tatsächlichen Zielen bilden, z. B. „Ziel 12/12/11“, oder „je 1 Wdh. mehr, höchstens 12“.

### 23. Ohne gespeicherte Planung behauptet die App „nur X von Y Sätzen absolviert“

- **Schwere:** niedrig · **Stand:** behoben – Ohne gespeicherte Satzzahl keine Aussage über eine unvollständige Einheit (PR #77). Test: E-runde2.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5558 (ref = L.planned // n)
- **Was passiert:** Fehlt am Verlaufseintrag die geplante Satzzahl, vergleicht makeEntry mit dem heutigen Plan und formuliert das als Tatsache über das letzte Training. Betroffen sind heute nur Alteinträge. Ein Nachtrag ohne planned, rmin und rmax hätte denselben Fehler; außerdem bliebe die Erkennung „Wiederholungsbereich geändert“ aus.
- **Beleg:** exp4-rules.js C9: Eintrag ohne planned mit 40 × 12/12, Plan heute 3 Sätze → „Zuletzt nur 2 von 3 Sätzen absolviert (40 kg pro Seite × 12/12). Gewicht zunächst beibehalten.“
- **Für den Nutzer:** Die Begründung nennt ein unvollständiges Training, obwohl die App die damalige Planung nicht kennt.
- **Kleinste Korrektur:** Ohne L.planned den neutralen Zweig „Heute N statt M Sätze geplant“ benutzen. Nachgetragene Einträge immer mit planned, rmin, rmax und u speichern.

### 24. Kalorienbilanz: zweites Training am selben Tag fehlt; Bilanz auf 1 kcal genau ohne ≈

- **Schwere:** niedrig · **Stand:** behoben – Alle Trainings des Tages zählen; ohne erfasste Dauer wird nichts geschätzt; Bilanz mit ≈ und auf 10 kcal gerundet (PR #77). Test: E-runde2.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:4640-4641 (plannedOn), 4676 (dayEnergy), 4795 (tagBalInner), 5020 (vHome)
- **Was passiert:** plannedOn nimmt mit find() nur das erste Training eines Tages; dayEnergy rechnet den Trainingsverbrauch aus dessen Dauer. Die Bilanz steht als große Zahl auf 1 kcal genau, auf Heute ebenfalls; das ≈ steht nur im Vorlesetext und in Nebenzeilen.
- **Beleg:** exp2 K1, 80 kg, wenig aktiv: ein Training 30 Min. → trMin 30, trainKcal 100, total 2859. Zwei Trainings 30 + 45 Min. → unverändert trMin 30, trainKcal 100, total 2859 (nach der eigenen Formel 2,5 × 80 × 75/60 = 250). Anzeige: „Krafttraining · ≈ 30 Min. + 100 kcal“, „Verbrauch geschätzt 2.859 kcal“, „Defizit bisher 859 kcal“; Ring auf Heute „859 kcal übrig“.
- **Für den Nutzer:** An Tagen mit zwei Einheiten ist der Verbrauch zu niedrig (im Beispiel 150 kcal). Die Bilanz wirkt genauer, als eine Schätzung aus Grundumsatz × Aktivitätsfaktor sein kann.
- **Kleinste Korrektur:** In dayEnergy die Dauer aller Verlaufseinträge des Tages summieren. Bilanz und Ring mit ≈ zeigen und auf 10 oder 50 kcal runden.

## Designschwächen

Der Code tut, wofür er geschrieben wurde – das Verhalten ist aber riskant, irreführend oder widerspricht den Produktzielen.

### 25. Ein Tipp macht den App-Vorschlag zur Leistung und zum Bestwert

- **Schwere:** mittel · **Stand:** teilweise – Beim Nachtragen meldet die Zusammenfassung keinen Bestwert für Vorschläge, die unverändert übernommen wurden; gespeichert werden sie trotzdem (PR #78, Test: E-runde3). Bewusst belassen: Im Live-Modus gilt der Tipp auf „Satz fertig“ am Gerät als Bestätigung des angezeigten Werts – so arbeiten Trainings-Apps üblicherweise, und jeder Satz lässt sich davor ändern und danach korrigieren.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5542–5544 (Sätze mit Gewicht und Ziel-Wiederholungen vorbefüllt), 5656–5661 (doneSet), 2184 (livePr), 5728 (Bestwerte am Ende)
- **Was passiert:** Gewicht und Wiederholungen sind mit dem Vorschlag der App vorbefüllt, bei Steigerung mit dem höheren Gewicht. „Satz fertig“ ohne eigene Eingabe speichert diese Werte als Leistung. Die App unterscheidet nicht zwischen eingegebenen und nur übernommenen Werten und meldet sofort einen Bestwert.
- **Beleg:** exp2-confirmed.js Schritt 3: Vorschlag 42,5 × 8 unverändert, ein Tipp → „Neuer Bestwert: 42,5 kg pro Seite – mehr Gewicht als je zuvor.“ Schritt 5: Zusammenfassung „Neue Bestwerte Brustpresse Mehr Gewicht als je zuvor 42,5 kg pro Seite“.
- **Für den Nutzer:** Wer durchtippt, hat Bestwerte und Folgevorschläge, die auf Vorschlägen der App beruhen statt auf dem, was er geschafft hat.
- **Kleinste Korrektur:** Entscheidung des Architekten. Kleinste Variante: am Satz merken, ob Wiederholungen bestätigt oder geändert wurden, und Bestwerte nur dann melden. Im Nachtragen Vorschläge nur als Platzhalter zeigen, nicht als Wert.

### 26. Generator kürzt bei knapper Zeit blind vom Ende: Pläne ohne große Muskelgruppe, die eigene Planprüfung beanstandet den frischen Vorschlag

- **Schwere:** mittel · **Stand:** behoben – Gekürzt wird nach fester Reihenfolge und nur, wenn keine große Muskelgruppe aus dem Plan verschwindet (`dropForTime`). 72 Kombinationen: vorher 8 Pläne ohne Oberschenkelrückseite, jetzt 0, kein Tag über der Zeit. Liegt ein Muskel nur durch Mittrainiertes über dem Richtwert, erklärt die Planprüfung die Zahl, statt den frischen Vorschlag zu beanstanden (PR #78). Test: E-runde3.
- **Bereich:** Planerzeugung und automatische Planänderungen
- **Stelle (Stand der Prüfung):** src/app.html:2072-2075 und 2053-2055 (while over … items.pop()), 2104-2106 (Kürzen über dem Richtwert nur an Übungen mit diesem Hauptmuskel)
- **Was passiert:** Zum Einhalten des Zeitbudgets entfernt der Generator die letzten Geräte der Vorlage, ohne auf Muskelabdeckung zu achten (anders als fitToTime, das laut Kommentar 2253 „nicht blind vom Ende“ streicht). Bei 30 Minuten bleiben so je Tag die ersten drei Geräte: der Beintag besteht aus drei Übungen für die Oberschenkelvorderseite. Außerdem liegen viele frische Pläne für Kraft/Fitness bei den Schultern über dem Richtwert der App, weil mittrainierte Sätze halb zählen, aber nur Schulter-Hauptübungen gekürzt werden können.
- **Beleg:** exp1_grid.js/exp1b_details.js, Standardstudio, 72 Kombinationen: 8 Pläne mit fehlender großer Muskelgruppe, alle mit 30 Min. Beispiel Kraft/3 Tage/Einsteiger/30: „Beine“ = Beinpresse, Hackenschmidt, Beinstrecker; muscleSets Beine hinten 0, Po 3, Waden 0; Planprüfung direkt danach: low:beineh=0 („fehlt im Plan“). Aufbau/2 Tage/Fortgeschritten/30: Ganzkörper A = Brustpresse 4, Rudern 4, Beinpresse 5 → Beine hinten 0. 22 von 72 frischen Plänen (Kraft/Fitness, 3–4 Tage, ab 45 Min.) melden sofort „Schultern 13–15 Sätze …
- **Für den Nutzer:** Wer 30 Minuten wählt, bekommt einen Plan ohne Beinbeuger und fast ohne Po-Arbeit; die App meldet in ihrer eigenen Planprüfung sofort „fehlt im Plan“ bzw. „1 Punkt zu prüfen“ für einen Vorschlag, den sie gerade selbst gemacht hat.
- **Kleinste Korrektur:** Beim Kürzen statt items.pop() zuerst das letzte Gerät entfernen, dessen Hauptmuskel oder Bewegungsmuster im Tag noch ein zweites Mal vorkommt (Regel „redundant“ aus fitToTime 2284-2289), erst danach vom Ende. Für die Schultern: Meldung „über dem Richtwert“ bei frischen Plänen vermeiden, indem balanceVolume auch Sätze der mittrainierenden Übungen berücksichtigt, oder die Vorlagen (1757-1763) um eine Schulter-Isolationsübung kürzen. Den Test auf 30/45/90 Min. erweitern.

### 27. Wochenziel ist die Zahl der Plantage – auch leerer, auch bei weniger Terminen; Serie wird rückwirkend neu gerechnet

- **Schwere:** mittel · **Stand:** behoben – Wochenziel = Termine pro Woche, sonst Tage mit Geräten (`weekGoal`); leere Tage zählen nicht (PR #78). Offengelegt statt geändert: Die Serie wird mit dem heutigen Ziel für alle Wochen gerechnet, und jeder Eintrag im Verlauf zählt als ein Training („So entscheidet die App“). Test: E-runde3.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:4951-4953 (vHome), 5118-5125 (weekStreak), 6946-6951 (weekStats)
- **Was passiert:** goal = Math.max(1, plan.days.length). Leere Tage zählen mit, die Zahl der festen Termine nicht (die Planprüfung rechnet dagegen mit Terminen ÷ Tage). Die Serie wird für alle vergangenen Wochen mit dem heutigen Ziel neu gerechnet. Jeder Verlaufseintrag zählt als Training, unabhängig vom Umfang.
- **Beleg:** exp2 W1: 3 Plantage, 2 Termine pro Woche, seit 5 Wochen alle Termine erfüllt → Heute „2 von 3“, keine Serie, Wochenrückblick „Noch 1 Training bis zum Wochenziel“; planCheck().per = 0,667. W2: 2 Plantage → „4 Wochen in Folge“; nach Hinzufügen eines leeren dritten Tages → „0 von 3“, Serie weg. W3: ein Satz in 1 Min. bei einem Plantag → „1 von 1 · Ziel erreicht“, „1 Woche in Folge“, „Wochenziel geschafft: 1 von 1“.
- **Für den Nutzer:** Wer zweimal pro Woche trainiert und einen Drei-Tage-Plan im Wechsel nutzt, erreicht sein Wochenziel nie. Ein neu angelegter leerer Tag löscht die sichtbare Serie.
- **Kleinste Korrektur:** Ziel = Zahl der Termine, wenn Termine gesetzt sind, sonst Zahl der Tage mit Übungen (mindestens 1); auf Heute nennen, woher die Zahl kommt. Für die Serie das Ziel je Woche festhalten oder klar sagen, dass rückwirkend gerechnet wird.

### 28. Ältere Fassung löscht Daten einer neueren: unbekannte Felder und Erweiterungsbereiche fallen beim ersten Speichern weg

- **Schwere:** mittel · **Stand:** teilweise – Liegen Daten einer höheren Fassung (`v`) auf dem Gerät, speichert die App nichts und bittet ums Neuladen; eine neuere Sicherung wird nicht eingespielt (PR #78, Test: E-runde3). Offen: Der Schutz greift erst, wenn die Fassungsnummer steigt. Regel für die Entwicklung: Jedes neue gespeicherte Feld erhöht `DATA_V` (README).
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:1781 (v: 6 wird geschrieben, nie gelesen), 1821–1927 (normalize baut nur bekannte Felder), 1996–1998 (extClean: „unbekannte Bereiche fallen weg“)
- **Was passiert:** normalize übernimmt nur Felder, die diese Fassung kennt, extClean nur Bereiche registrierter Erweiterungen; die Versionsnummer wird nicht geprüft. Läuft eine ältere Fassung gegen neuere Daten (zurückgenommenes Deployment, Sicherung von einem neueren Gerät in eine App mit älterer Seite im Zwischenspeicher), gehen die neueren Felder beim ersten Speichern still verloren. Für „nachträglich eintragen“ heißt das auch: jedes neue Feld an einem Training oder Satz muss in normalize (1849–1859) aufgenommen werden, sonst ist es nach dem nächsten Laden und nach jeder Wiederherstellung weg.
- **Beleg:** e8-alte-version.js: Fassung 2d8b5c9 (zwei Commits alt) mit heutigem Zustand, nach einem Tipp auf „Start“: x.masse, x.plaene, x.aussehen → (fehlt). Fassung c4d0dba: ganzes x → (fehlt). Heutige Fassung mit Zustand „von morgen“: v 7 → 6, plan.days[0].items[0].tempo → (fehlt), history[0].nachgetragen → (fehlt), history[0].exercises[0].sets[0].geschaetzt → (fehlt), x.neueErweiterung → (fehlt), neuesFeld → (fehlt).
- **Für den Nutzer:** Körpermaße, gespeicherte Pläne, Aussehen und künftige neue Angaben können verschwinden, ohne dass der Nutzer etwas getan hat.
- **Kleinste Korrektur:** Beim Laden raw.v prüfen: ist sie höher als die eigene, nicht speichern und „Daten stammen aus einer neueren Fassung – bitte neu laden“ zeigen. Unbekannte Bereiche in state.x und unbekannte oberste Felder unverändert durchreichen statt verwerfen.

### 29. Erholungswert täuscht Genauigkeit vor: ein Satz zählt wie zwölf, Anzeige auf 1 %, Begründung als Tatsache

- **Schwere:** mittel · **Stand:** behoben – Drei Stufen statt Prozent; ein Muskel gilt erst ab 2 Sätzen in einem Training als belastet (mittrainiert halb); Begründung auf „Heute“ und Plan-Zeile als Schätzung der App gekennzeichnet (PR #77). Test: E-runde2.
- **Bereich:** Ehrlichkeit abgeleiteter Zahlen
- **Stelle (Stand der Prüfung):** src/app.html:2513-2526 (recovery, recColor), 5100-5108 (recSheet), 2406-2410 (baseDay), 5170-5171 (vPlan)
- **Was passiert:** Der Wert hängt nur von den Stunden seit dem letzten Eintrag ab (linear bis 72 bzw. 48 Std.). Satzzahl, Gewicht, Reserve und Muskelgröße spielen keine Rolle. Gezeigt wird er als ganze Prozentzahl je Muskel und steuert über feste Schwellen (50/55/25) den Tagesvorschlag. Die Kennzeichnung „Schätzung der App“ steht im Sheet, auf der Muskel-Seite und in der Hilfe, aber nicht in der Begründung auf Heute und nicht in der Plan-Zeile.
- **Beleg:** exp1 Fall 3: 1 Satz und 12 Sätze vor 1 Std. → identisch Brust 1,4 / Schultern 2,1 / Trizeps 2,1. Fall 9: ein einziger Rudersatz vor 20 Std. → „Angepasst – Bein-Tag – Rücken ist noch nicht erholt. Heute lieber Bein-Tag, Ruecken-Tag danach.“ exp5 Fall 3: dieselben Trainings nach 20 Std. → Bein-Tag (Rücken 28 %), nach 37 Std. → Ruecken-Tag (Rücken 51 %). Sheet zeigt „Brust0%“, Plan-Zeile „Brust und Schultern erholen sich noch“.
- **Für den Nutzer:** Der Nutzer liest „42 %“ und „ist noch nicht erholt“ wie eine Messung. Ein abgebrochenes Training mit einem Satz verschiebt den Plan genauso wie ein volles.
- **Kleinste Korrektur:** Nur die drei Stufen zeigen, keine Prozentzahl. Begründung auf Heute als „Nach Schätzung der App …“ formulieren. Einen Muskel erst ab einer Mindestlast als belastet werten (z. B. 2 gültige Sätze als Hauptmuskel), bevor der Tag getauscht wird.

### 30. Speicher voll: Warnung erscheint, aber die Zusammenfassung feiert ein nicht gespeichertes Training; Essen-Tagebuch wächst unbegrenzt

- **Schwere:** niedrig · **Stand:** teilweise – Die Zusammenfassung sagt „Noch nicht gespeichert“ und bietet die Datei-Sicherung an; der Hinweis oben hat denselben Knopf und verschwindet, sobald das Speichern wieder klappt (PR #78, Test: E-runde3). Offen: Das Essen-Tagebuch wächst unbegrenzt.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:756 (#saveWarn), 1942–1945 (save), 5720–5746 (finish)
- **Was passiert:** Wirft setItem, wird ein roter Hinweis oben auf der Seite eingeblendet – der Nutzer kann es also merken. Aber: die Zusammenfassung zeigt „Training beendet“ und neue Bestwerte, obwohl nichts gespeichert ist; der Hinweis verweist auf „Plan → Einstellungen“, das im Training nicht erreichbar ist; er bleibt stehen, auch wenn das Speichern wieder klappt. Das Essen-Tagebuch wird nie ausgelagert.
- **Beleg:** e3 Teil A: 8 fehlgeschlagene Speicherversuche, Warnung sichtbar (oben 16–111 px, Bildschirmfoto e3-quota-training.png), Ansicht „TRAINING BEENDET … Neue Bestwerte“, Trainings im Fenster 2, nach Neuladen 1. A2: nach wieder erfolgreichem Speichern „Warnung noch eingeblendet: true“. Teil D: 1 Jahr = 881.859 Zeichen (Essen 0,59 Mio., Trainings 0,24 Mio.), 3 Jahre 2,65 Mio., 5 Jahre 4,42 Mio.; gemessene Grenze in Chromium 5,00 Mio. Zeichen. Die Grenze in Safari konnte ich hier nicht messen.
- **Für den Nutzer:** Im privaten Modus oder bei vollem Speicher ist das gerade beendete Training nach dem Schließen weg, wenn der Nutzer den Hinweis übersieht. Wer täglich Essen einträgt, erreicht die Grenze nach einigen Jahren.
- **Kleinste Korrektur:** Hinweis ausblenden, sobald ein Speichern gelingt; im Hinweis direkt einen Knopf „Jetzt als Datei sichern“ anbieten; auf der Zusammenfassung „noch nicht gespeichert“ zeigen, solange saveFailed gesetzt ist. Später: alte Essen-Tage in einen eigenen Schlüssel auslagern.

### 31. Kein Auffangnetz beim Start: wirft die erste Ansicht, bleibt die App leer und die Sicherung ist unerreichbar

- **Schwere:** niedrig · **Stand:** behoben – Wirft die erste Ansicht, erscheint eine Rettungsseite (Daten als Datei sichern, neu laden, laufendes Training beenden oder verwerfen). Die zwei gefundenen Auslöser werden schon beim Laden bereinigt (PR #78). Test: E-runde3.
- **Bereich:** Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline
- **Stelle (Stand der Prüfung):** src/app.html:9785–9786 (extClean(); go(view)), 5769–5771 (vTrain, Pausenansicht: ns = nx.sets[ni])
- **Was passiert:** Der Start ruft go(view) ohne Fehlerbehandlung. Wirft die Ansicht für einen gespeicherten Zustand, bleibt die Seite leer; die Daten liegen noch im Speicher, aber der Nutzer kommt weder an „Sicherung erstellen“ noch an „Training verwerfen“. Gefunden habe ich nur zwei konstruierte Zustände eines laufenden Trainings; im normalen Ablauf (e4, Neuladen nach jedem Schritt) trat es nicht auf. Der erste davon entsteht auch durch normalize selbst: eine Übung mit sets:[null] besteht den Filter (1863) und hat danach null Sätze.
- **Beleg:** e2-alte-daten.js Teil d: „Session-Übung mit sets:[null]“ und „Pause, aktuelle Übung ohne offenen Satz“: Seitenfehler „Cannot read properties of undefined (reading 'kg')“, Text im Fenster 0 Zeichen, Trainings im Zustand weiterhin 3. Die übrigen 7 Formen zeichnen fehlerfrei.
- **Für den Nutzer:** Ein einziger fehlerhafter Wert im laufenden Training (oder ein Programmfehler in einer Ansicht) macht die App unbenutzbar; der einzige Ausweg wäre, die Website-Daten zu löschen – also alles.
- **Kleinste Korrektur:** go(view) beim Start in try/catch: bei Fehler eine einfache Rettungsseite zeigen (Rohdaten als Datei sichern, laufendes Training speichern oder verwerfen, neu laden). In normalize Übungen des laufenden Trainings erst nach dem Bereinigen der Sätze auf „mindestens ein Satz“ filtern.

## Vermutete Risiken

Nicht nachgewiesen. Erst prüfen, dann handeln.

### 32. Dasselbe Gerät zweimal in einem Training: nur der erste Eintrag zählt

- **Schwere:** niedrig · **Stand:** behoben – Vorschlag, „Letztes Mal“ und Kurve fassen alle Einträge desselben Geräts in einem Training zusammen (PR #78). Test: E-runde3.
- **Bereich:** Progressionslogik und Verlaufsdaten
- **Stelle (Stand der Prüfung):** src/app.html:5511 (compSessions: h.exercises.find), 2171 (lastPerf), 7873 (exChart)
- **Was passiert:** Vorschlag, „Letztes Mal“ und Kurve nehmen je Training nur den ersten Eintrag eines Geräts; Bestwerte (2201) zählen alle. Ob die App solche Daten selbst erzeugt, habe ich nicht nachgewiesen. Denkbar über coachSwap (8207 ersetzt in allen Tagen) oder beim Nachtragen.
- **Beleg:** exp4-rules.js C15 mit eingesetzten Daten (40 × 12/12/12 und 50 × 8/8/8 am selben Gerät im selben Training): Vorschlag „+2,5 kg … Letztes Mal alle 3 Sätze mit 12 Wdh. bei 40 kg pro Seite“; die 50 kg bleiben unberücksichtigt.
- **Für den Nutzer:** Falls es vorkommt: Vorschlag aus dem ersten Block, der zweite wird ignoriert.
- **Kleinste Korrektur:** In compSessions alle Einträge desselben Geräts und derselben Einheit eines Trainings zusammenfassen; beim Nachtragen doppelte Geräte verhindern.

## Geprüft und in Ordnung

Was die Prüfer untersucht und ohne Befund gelassen haben (jeweils durch Lesen des Codes und einen Versuch):

**Progressionslogik und Verlaufsdaten**

- Speichert ein beendetes Training nur Sätze, die mit „Satz fertig“ bestätigt wurden?
- Können vorbefüllte, nie bestätigte Werte einen Vorschlag ändern?
- Lässt sich ein Satz mit 0 kg, 0 Wiederholungen oder leerem Feld bestätigen?
- Erzeugen ungültige Sätze aus einem importierten Verlauf (0 kg, kein Gewicht, 0 Wdh.) Vorschläge, Bestwerte oder Volumen?
- Was passiert mit übersprungenen Sätzen („Übung beenden“) und einem früh beendeten Training?
- Beeinflusst ein pausiertes oder verworfenes Training Verlauf, Bestwerte oder Vorschläge?
- Sortiert „Datum ändern“ den Verlauf neu?
- Sind Bestwerte, Wochenstatistik und Meilensteine von der Array-Reihenfolge unabhängig?
- Bleiben „pro Seite“, „insgesamt“ und „am Block“ am selben Gerät getrennt?
- Wird beim „Gerät tauschen“ oder zwischen zwei Geräten desselben Muskels ein Gewicht übertragen?
- Wird nach späterer Änderung der Gewichtsangabe ein alter Wert in die neue Einheit übernommen?
- Erfindet die App bei zu wenig Daten ein Gewicht oder eine Prognose?
- Was passiert bei geändertem Wiederholungsbereich oder geänderter Satzzahl im Plan?
- Werden Probesätze aus „Gewicht finden“ oder geschätzte Werte als Leistung gespeichert?
- Prüft die Korrektur im Verlauf (Satz ändern/löschen) die Werte wie im Training?
- Meldet die Stillstandserkennung bei sortiertem Verlauf richtig?

**Planerzeugung und automatische Planänderungen**

- Überschreitet ein vom Assistenten erzeugter Tag das gewählte Zeitbudget nach der eigenen Schätzung der App?
- Ist die Zeitschätzung (estimateSec) rechnerisch nachvollziehbar und plausibel?
- „Zeit für heute“: Liegt die Schätzung bei „passt“ immer im Budget, ebenso das gestartete Training, und bleibt der Plan unverändert?
- Wird ein Gerät, das nicht als „in meinem Studio“ markiert ist, vom Generator, von „Trainingstag hinzufügen“ oder vom Ersatz in „Zeit für heute“ geplant?
- Erzeugt der Generator doppelte Geräte (auch gleiche Übungsart beider Marken) innerhalb eines Tages?
- Verändern Planoperationen den Verlauf?
- Ändert balanceVolume einen bestehenden, von Hand bearbeiteten Plan, und kann es endlos laufen?
- Ändert die Planprüfung („+ Übung“) den Plan selbstständig?
- Tag kopieren auf einen belegten Tag: Rückfrage und Rückgängig vorhanden?
- Gesicherten Plan laden („Meine Pläne“): Rückfrage und Angebot, den aktuellen Plan vorher zu sichern?
- Hinweis „Plan mit n Tagen“ (Neuerzeugung aus den Hinweisen): Vorschau, Bestätigung, Rückgängig?
- Zählt muscleSets richtig (Hauptmuskel voll, mittrainiert halb, Termine pro Woche, Supersätze)?
- Sind die Richtwerte (10–20 bzw. 6–12 Sätze) überall als Richtwert der App gekennzeichnet?
- Kleines Studio oder schräge Eingaben: Absturz oder Endlosschleife im Generator?
- Welcher Tag ist als Nächstes dran – stimmt der Ablauf?
- Lässt „Gerät tauschen – Nur heute“ den Plan unberührt und bleibt „Auch im Plan“ nicht versehentlich eingeschaltet?
- Nutzt der Generator das Zeitbudget aus, wenn Muskelgruppen unter dem Richtwert liegen?

**Ehrlichkeit abgeleiteter Zahlen**

- Stimmt die Erholung ohne Verlauf und bei einem sehr alten Training?
- Stimmt die Erholung bei zwei Trainings kurz nacheinander und bei einem Gerät mit mehreren Muskeln?
- Bleibt alles stimmig, wenn das Datum eines vergangenen Trainings geändert wird?
- Ändert die Erholung eine Empfehlung, ohne dass der Nutzer es sieht oder übersteuern kann?
- Gibt es feste Aussagen zu Erholungsstunden oder Satzzahlen, die als Tatsache ohne Quelle dastehen?
- Sind e1RM-Werte als Näherung gekennzeichnet?
- Entstehen Bestwerte aus leeren oder ungültigen Sätzen?
- Ist die Zielprognose („bei deinem Tempo etwa …“) ehrlich formuliert?
- Matrix 3: Pause und Fortsetzen nach Neuladen – abgedeckt?
- Matrix 8: Gerät im Training tauschen – abgedeckt?
- Matrix 9: Zeitbudget im Training ändern – abgedeckt?

**Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline**

- Lädt ein Zustand, der jede gespeicherte Funktion nutzt (inkl. laufendem Training, abgewählten Scheiben, state.x), beim Start vollständig?
- Gibt es weitere Ladereihenfolge-Fehler (const nach "state = load()", das normalize braucht)?
- Ist normalize idempotent?
- Speichern → neu laden: geht etwas verloren oder ändert sich?
- Sicherung (Text TP1 und Datei) über die App erstellen, in leerer App wiederherstellen: welche Felder fehlen?
- Wirft normalize bei alten/teilweisen Formen, null in Listen, falschen Typen, unbekannten Feldern?
- Browser-Neustart mitten im Live-Training: was überlebt?
- Neustart mitten in einer Eingabe in einem Fenster (nicht gespeichert)?
- Startet die App nach Installation des Service Workers ohne Netz?
- Was passiert mit der Lebensmittelsuche (api/food.js) ohne Netz?
- Ersetzt ein neues Deployment den Zwischenspeicher zuverlässig?
- build.sh und Bezug zwischen index.html und sw.js?

## Lücken in den Tests

Verhalten, das `tests/run.js` laut den Prüfern nicht absichert (Stichwortsuche und Lesen der Abschnitte; die Suite wurde dafür nicht ausgeführt):

**Progressionslogik und Verlaufsdaten**

- Hinweis: Die Aussagen zur Testabdeckung stammen aus einer Stichwortsuche in tests/run.js; die Suite habe ich nicht ausgeführt.
- Kein Test mit einem Verlauf, dessen Array-Reihenfolge vom Datum abweicht. Es gibt nur „Verlauf bleibt nach Datum sortiert“ nach „Datum ändern“ (tests/run.js:2971).
- Kein Test: pausiertes Training wird gespeichert, nachdem ein älteres Training auf ein späteres Datum gelegt wurde.
- Kein Test: normalize() bzw. Sicherung wiederherstellen mit unsortiertem Verlauf.
- Kein Test, dass der letzte Satz der letzten Übung bewertbar ist oder dass die Regeln „schwer/leicht“ für die letzte Übung greifen.
- „Frühere Einträge umstellen“ kommt nur einmal vor (tests/run.js:420), nicht während eines laufenden Trainings.
- Pausenregel (21/28 Tage) bei uneinheitlichen Sätzen: Stichwort „uneinheitlich“ kommt in den Tests nicht vor.
- Wahrheit der Begründungstexte bei gekappten Zielen („Ziel je 1 Wdh. mehr“) und bei Einträgen ohne planned.
- Bestwert-Meldung nach unverändert bestätigtem Vorschlag.
- Dasselbe Gerät zweimal in einem Training.
- Zu baseDay und personalStats fand die Stichwortsuche keinen direkten Test; indirekte Abdeckung über die Oberfläche habe ich nicht geprüft.

**Planerzeugung und automatische Planänderungen**

- Generator bei 30, 45 und 90 Minuten: tests/run.js:2098-2104 prüft „keine fehlende Muskelgruppe, kein Tag über dem Zeitbudget“ nur mit 60 Min.; die Meldung „über dem Richtwert“ direkt nach dem Erzeugen wird gar nicht geprüft.
- Neuer Plan bei vorhandenem Plan: Kein Test prüft Rückfrage, Rückgängig oder Sicherung für createPlan/emptyPlan (run.js:3980 klickt newPlan nur, um Texte des Assistenten zu prüfen).
- Gerätetausch aus dem Hinweis (coachSwap) nur mit einem Gerät an einem Tag getestet (run.js:2154-2160); kein Test mit demselben Gerät an zwei Tagen (Doppelte).
- „Rückgängig“ unter Hinweise wird nur direkt nach der Änderung getestet (run.js:2136, 2160); nicht nach späteren Handänderungen oder nach einem neu erstellten Plan (veraltetes prevPlan).
- „Zeit für heute“ gefolgt von einer Bearbeitung des Tages (veraltete Anpassung beim Start) ist nicht abgedeckt.
- „Gerät tauschen“ zusammen mit zeitbedingt ausgeblendeten Geräten (timeHidden) und „Auch im Plan“: kein Test auf Doppelte.
- Grenzfall der Planprüfung: Der Satz „jeder Tag passt in dein Zeitbudget“ kommt in tests/run.js nicht vor; getestet ist nur die deutliche Überschreitung (run.js:1912).
- Kleine Studios (0–5 Geräte): leere Tage, Tage mit einem Gerät, ungenutzte Geräte; „nächster Tag“ und Wochenvorschau mit leerem Tag (baseDay kommt in den Tests nicht vor).
- Studio-Markierung: Antippen und Wieder-Abwählen in der Geräteauswahl; abgewähltes Gerät, das noch im Plan steht (Hinweis, Start).
- Sicherung wiederherstellen bei gleicher Anzahl, aber anderen Trainings und bei laufendem Training.
- Abhängigkeit des „nächsten Tages“ von der Speicherreihenfolge des Verlaufs (wichtig für das nachträgliche Eintragen).
- Tagesnamen „Push“/„Pull“ werden beim Laden umbenannt – kein Test, dass Nutzernamen erhalten bleiben.

**Ehrlichkeit abgeleiteter Zahlen**

- recovery(): kein Test für Grenzfälle (Zukunftsdatum, kaputtes Datum, gelöschtes Gerät, Eintrag ohne gültigen Satz, ein Satz gegen viele). Vorhanden sind nur 5781/5804 (Wert gleich recovery(), Kennzeichnung) und Abschnitt 66 (ein Wechsel-Szenario).
- baseDay: Schwellen 50/55/25 an den Grenzen, Fall ohne Alternative, Abhängigkeit von der Uhrzeit, Ablauf nach gelöschtem Tag.
- Wochenziel und Serie auf Heute: 4623 prüft nur, dass ein Symbol da ist. Ungeprüft: Ziel bei Terminen ungleich Plantagen, leere Tage, Serie nach Änderung der Tageszahl, Serie nach Verschieben oder Löschen eines Trainings.
- Verlauf in falscher Reihenfolge laden (Sicherung) und Verlaufseinträge mit Zukunfts- oder kaputtem Datum; getestet ist nur ein kaputtes backupAt (2719).
- Stillstand nach Gewichtsreduktion oder bei schwankendem Gewicht.
- dayEnergy mit zwei Trainings am Tag und nach Korrektur von Datum oder Dauer eines Trainings.
- Sicherung wiederherstellen bei laufendem oder pausiertem Training.
- Trainingstag löschen (confirmDelDay wird nie ausgelöst): Verlauf, Ablauf, laufendes Training dieses Tages.
- Plan ändern während eines Trainings (Sätze, Gerät entfernen).
- Verwerfen: Zustand danach (Verlauf, session, selbst gewähltes Training, Zeit-Anpassung).
- Folgen einer Verlaufskorrektur oder -löschung für Gewichtsempfehlung, nächsten Tag, Wochenrückblick, Serie.
- Inhalt des Verlaufseintrags nach normalem Abschluss: dayId, Tagesname, Datum, Dauer; Start eines anderen als des nächsten Tages bei mehreren Tagen.
- Training nachträglich ohne Live-Modus eintragen: kein Test, Funktion fehlt.
- Offline: Training offline beenden und speichern, Neustart offline mit laufendem Training (384-391 prüft nur den Start-Knopf).
- Neustart mit getippten, noch nicht bestätigten Werten (Satz-Eingabe, offenes Korrektur-Sheet).
- e1RM über 12 Wiederholungen auf der Gerätekarte; „Trainings pro Woche“ bei weniger als 4 Wochen Verlauf.
- Keine CI; viele Abschnitte hängen an der echten Uhr.

**Speicherung, Migrationen, Sicherung/Wiederherstellung, Offline**

- Unlesbarer Speicher (kaputtes JSON oder werfendes normalize): kein Test prüft, dass der alte Rohwert erhalten bleibt und nichts überschrieben wird.
- Speichern schlägt fehl (setItem wirft): kein Test für die Warnung #saveWarn und das Verhalten danach (0 Treffer für saveWarn/QuotaExceeded in tests/run.js).
- Zwei Tabs bzw. zwei Fenster auf demselben Speicher: nicht getestet.
- Sicherung → Wiederherstellen mit einem Zustand, der wirklich jedes Feld nutzt (alle 35 Schlüssel, state.x aller Erweiterungen), als Feld-für-Feld-Vergleich; ebenso normalize(normalize(x)) = normalize(x).
- Wiederherstellen auf einem frischen Gerät ohne Plan (die Tests legen vorher einen Plan an, tests/run.js:155).
- Wiederherstellen mit gleich vielen, aber anderen Trainings, mit vorhandenem Essen-Tagebuch/Gewichten und bei pausiertem Training.
- Ältere Fassung gegen neueren Zustand (unbekannte Felder, höhere v, unbekannte Bereiche in state.x).
- Start mit jedem gespeicherten Zwischenstand eines laufenden Trainings (Neuladen nach jedem Schritt, in der Pause, mit geleertem Feld).
- Aussage der Sicherungszeile nach Änderungen ohne neues Training und nach rückdatierten Trainings.
- Service Worker: Verhalten nach geändertem Cache-Namen (three.min.js wird verworfen) und Ankunft einer neuen Fassung beim zweiten Öffnen über echten Abruf statt simulierter Nachricht (tests/run.js:398).

## Reihenfolge der nächsten Schritte

Kleine, einzeln prüfbare Änderungen, jeweils mit Test.

1. **Was von den Befunden bleibt**
   - Essen-Tagebuch: alte Tage in einen eigenen Schlüssel auslagern, bevor der Speicher knapp wird
   - Unbekannte Felder und Bereiche beim Laden unverändert durchreichen (Schutz auch ohne höhere Fassungsnummer)
   - Fehler im Bereich einer Erweiterung nicht still leeren (`extClean`), sondern wie beim Laden als Kopie aufheben
2. **Tests**
   - Übergänge aus der Lückenliste: Verwerfen, Plan ändern im Training, Verlauf korrigieren und löschen samt Folgen
   - Schnelle Tests ohne Browser für Progression und Planerstellung (Voraussetzung: Aufteilung unten, Schritte 2–4)
3. **Architektur (Phase E)** – erst wenn 1 und 2 stehen, in den unten beschriebenen Schritten
4. **Auf einem echten iPhone prüfen** – bisher lief alles im Chromium-Testbrowser

## Architektur (Phase E): Plan für die Aufteilung

Ziel: kleinere Dateien, ohne dass sich für Nutzer, Daten, Adressen oder den Offline-Betrieb etwas ändert. Keine Neuentwicklung.

**Grundsatz:** `build.sh` setzt weiterhin genau eine `index.html` zusammen. Die Quelle wird in Teile zerlegt, die in fester Reihenfolge aneinandergehängt werden. Damit bleiben Service Worker, Cache-Liste, Adressen und der Speicher-Schlüssel unverändert.

**Jeder Schritt ist nur ein Verschieben:**
1. Einen Teil aus `src/app.html` in eine eigene Datei unter `src/` legen.
2. `./build.sh` ausführen: Die neue `index.html` muss Zeichen für Zeichen der alten entsprechen (`git diff` leer).
3. Ganze Testsuite. Erst dann der nächste Teil.

**Reihenfolge (vom geringsten Risiko zum größten):**

| Schritt | Teil | Inhalt | Zusätzliche Absicherung |
|---|---|---|---|
| 1 | Gerätebibliothek | Geräte, Muskeln, Bewegungsdaten, Artikel, Quellen | – (reine Daten) |
| 2 | Speicher | `blank`, `normalize`, `load`, `save`, Sicherung, Migrationen | Schnelle Tests ohne Browser: alte Sicherungen als Dateien, Rundreise, Idempotenz |
| 3 | Progression | `compSessions`, `makeEntry`, Bestwerte, Stillstand | Schnelle Tests: Verlauf hinein, Empfehlung heraus – für jede Regel ein Fall |
| 4 | Planerstellung | Generator, Vorlagen, `muscleSets`, `balanceVolume`, `planCheck`, Zeitschätzung | Schnelle Tests über ein Raster von Eingaben (harte Regeln) |
| 5 | Statistik | Wochenrückblick, Erholung, Meilensteine, Rückblick | Schnelle Tests mit festen Verläufen |
| 6 | Erweiterungen | Nachtrag, Pläne, Körpermaße usw. (stehen schon in eigenen Blöcken) | – |
| 7 | Oberfläche und Navigation | Ansichten, Fenster, Gesten | bleibt bei den Browser-Tests |

**Voraussetzung für die Schritte 2–5:** Die Rechenfunktionen bekommen ihre Daten als Parameter (Verlauf, Plan, Zeitpunkt) statt sie aus dem globalen Zustand zu lesen. `compSessions` und `makeEntry` nehmen seit dem Nachtrag schon einen Zeitpunkt; das wird Schritt für Schritt fortgesetzt.

**Was sich nicht ändert:** Speicher-Schlüssel `trainingsplan-v2`, Aufbau der gespeicherten Daten, Dateinamen, `sw.js`, Adressen, Aussehen.

## Wissenschaftliche Aussagen

In den Runden bis Pull Request #78 wurden keine Aussagen über Trainingswirkung geändert oder ergänzt. Neu sind nur Regeln der App, die als solche gekennzeichnet sind (Stufen der Datengrundlage, Reihenfolge beim Kürzen, Wochenziel, 14 Tage Aufbewahrung der Kopie). Wenn Texte über Trainingswirkung angepasst werden, gilt: allgemeine Empfehlungen nur mit geprüfter Quelle (darunter die ACSM-Leitlinien von 2026, die ich dafür erst im Original prüfe), getrennt von den Heuristiken der App („Regel der App“) und von dem, was sich aus den eigenen Trainingsdaten ergibt. Keine festen Regenerationsstunden, keine „optimale“ Satzzahl.
