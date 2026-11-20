# Vokabelkasten

Vokabeltrainer für Französisch (Découvertes, 8. Jahrgangsstufe).

## Projektstruktur

```
index.html, style.css, app.js, settings.js, schulaufgabe.js, updates.js, feedback.js, consent.js   die App (statisch, kein Build nötig)
sw.js, manifest.webmanifest, icons/          Offline-Modus und Installation als App
datenschutz.html                             Datenschutzerklärung
lektionen/<name>/database*.json (+ Audio/Bilder)   Vokabellektionen
uebungen/<name>/uebung.json                  Übungen (z. B. passé composé)
index.json, titles.json                      Lektionsliste (automatisch erzeugt) und Anzeigenamen
sources.csv, sources_uebungen.csv            Quellen für den automatischen Import
scripts/, tests/                             Import, Index, Tests
.github/workflows/                           Automatisierung (siehe unten)
```

Wichtige Befehle (nach `npm run setup`): `npm test` (alle Tests), `npm run serve` (lokal ansehen), `npm run index` (Lektionsliste neu erzeugen), `npm run import`.

**Workflows:** `pages.yml` veröffentlicht bei Commits auf `main`, `pages-dev.yml` bei Commits auf `dev`, `dev-pull-request.yml` hält einen Pull Request `dev` → `main` bereit, `tests.yml` führt alle Tests aus, `import-vocabulary.yml` und `index.yml` pflegen die Daten.

**Empfohlene GitHub-Einstellungen (nur im Browser möglich):** *Settings → Branches*: Regel für `main` mit „Require a pull request“ und „Require status checks“ (Tests). *Settings → General*: „Allow squash merging“. *Settings → Actions → General*: „Allow GitHub Actions to create and approve pull requests“ einschalten, damit `dev-pull-request.yml` den Pull Request anlegen kann.

## Vokabelseiten automatisch importieren

In `sources.csv` sind die direkten Découvertes-3-HTML-Quellen eingetragen. Jede Zeile enthält Zielordner, direkte HTML-URL und `merge_existing`:

```csv
folder,url,merge_existing
lektionen/dec3-u2-de,https://jsgdruethkarperancis.s3.eu-central-1.amazonaws.com/Dec3/U2/Dec3-U2_DE_projecteur.html,false
lektionen/dec3-u1-de,https://jsgdruethkarperancis.s3.eu-central-1.amazonaws.com/Dec3/U1/Dec3-U1DE-projecteur.html,true
```

Setze `merge_existing` auf `false` für einen neuen Ordner oder auf `true`, wenn genau eine passende `database*.json` im Zielordner liegt. Beim Zusammenführen bleiben vorhandene Einträge erhalten; neue Einträge mit einer noch nicht vorhandenen deutschen Abfrage werden ergänzt. Mehrere URLs können denselben Zielordner verwenden; ihre HTML-Dateien werden dort gespeichert und ihre Einträge in einem JSON zusammengeführt.

Der Import speichert nur noch die `database*.json` (und `.vocabulary-import.json`) im Zielordner. Die Quell-HTML-Seiten werden nicht mehr ins Repository kopiert, und eingebettete base64-Bilder oder -Audios (`data:`-URIs) werden verworfen. Bilder und Audios gehören als Dateien in den Lektionsordner und werden in der JSON über ihren Dateinamen referenziert (`"image": "Dieb.jpg"`, `"audio": "voleur.mp3"`).

Vor jedem Import laufen die Tests (`python -m unittest tests.test_import_vocabulary`), lokal genauso.

Du kannst den Import später erneut starten, indem du `sources.csv` änderst und pushst oder GitHub unter **Actions → Import vocabulary pages → Run workflow** verwendest. Die Action committet die erzeugten Dateien automatisch zurück ins Repository.

Die HTML-Quellen müssen direkte HTTPS-Links auf Vokabelseiten sein. Der Import erwartet Vokabelzeilen mit deutscher Übersetzung, französischer Antwort und markiertem Vokabeltext.

## Übungen (Unterordner `uebungen/`)

Übungen liegen in `uebungen/<name>/uebung.json` und erscheinen in der App wie Lektionen. Die erste ist `uebungen/passe-compose` („Les formes du passé composé“). Die Karte zeigt das französische Verb. Du kannst das Deutsche aufdecken, tippst das passé composé ein und lässt dir dann die Lösung zeigen. Die App vergleicht deine Eingabe (Groß-/Kleinschreibung egal, „(e)“ darf als „e“ stehen) und du entscheidest mit „Richtig“ oder „Falsch“ wie sonst.

```json
{"french": "venir", "german": "kommen", "answer": "je suis venu(e)", "ref": "Déc-Kl-6"}
```

Quelle ist nur die Seite mit der Lösung (`…-tout.html`). Die Varianten tâche, incopiable, de, mix1 und mix2 haben denselben Inhalt und werden nicht gebraucht. Die Adresse steht in `sources_uebungen.csv` (`folder,url`). Der Import läuft im Workflow „Import vocabulary pages“, von Hand mit `python scripts/import_exercises.py`, oder mit einer lokal gespeicherten Seite: `python scripts/import_exercises.py seite.html passe-compose`.

## Verben konjugieren (`verben.json`)

Jede Verb-Karte in den Lektionen lässt sich konjugieren: Unter dem Verb stehen Zeilen für je, tu, il, nous, vous, ils, getrennt für Présent und Passé composé; man tippt die Formen, Enter springt zur nächsten Zeile, danach kommt die Lösung. In der Lernauswahl gibt es zwei Schalter („Verben konjugieren: Présent“ und „Passé composé“). Sind beide aus, kommt nur die Grundform.

`scripts/import_conjugation.py` erzeugt `verben.json` aus den Vokabeln aller Lektionen. Als Verb gilt eine Vokabel, deren erstes Wort auf -er/-ir/-re/-oir endet (Zusätze wie „de + Inf.“, „qn“, „à“ werden ignoriert, feste Wendungen wie „jouer au foot“ nicht). Regelmäßige Verben bildet das Skript nach Regeln, unregelmäßige stehen in der Tabelle `IRREGULAR` im Skript. Das Passé composé der Verben aus den Übungen (`uebungen/*/uebung.json`) wird aus der dort angegebenen Form abgeleitet. Unbekannte Verben rät das Skript nicht; es meldet sie im Lauf, dann den Eintrag in `IRREGULAR` ergänzen. Der Import-Workflow führt das Skript automatisch aus und committet `verben.json`.

## Bereich „Schulaufgabe“ (`schulaufgabe.json`)

Auf der Startseite führt „Schulaufgabe vorbereiten“ zu Themen mit Merkkasten und Übungen: Verben konjugieren (Présent, Passé composé, Imparfait), Vorsilbe re-, Verben mit Infinitivanschluss, Verneinung, Passé composé und Imparfait sowie Textproduktion mit Satzbausteinen und Checkliste. Aufgaben, die man falsch hatte, kommen in der nächsten Runde zuerst.

Die Themen pflegst du in `scripts/schulaufgabe_themen.json` (Typen `luecke`, `verneinung`, `konjugieren`, `schreiben`). Danach `npm run schulaufgabe` ausführen: Das Skript prüft die Datei, berechnet die Verbformen und schreibt `schulaufgabe.json`. Ein Test stellt sicher, dass beide Dateien zusammenpassen. Neue Themen müssen den Stoff des Zettels abdecken; die Inhalte zu „Kasten S. 165“ und „on dit S. 17“ stammen nicht aus dem Buch und sollten mit diesem verglichen werden.

## Einstellungen in der App (⚙ oben rechts)

- **Farben:** Modus (automatisch, hell, dunkel), sieben Farbvorlagen (Standard, Ozean, Wald, Sonnenuntergang, Lavendel, Mitternacht, Hoher Kontrast) mit hellen und dunklen Varianten sowie sechs einzelne Farben (Akzent, Hintergrund, Karten, Text, Richtig, Falsch). Im automatischen Modus folgt auch die gewählte Vorlage dem Gerät. Die Schrift auf Knöpfen passt sich der Farbe an. Gespeichert wird in `vk:look`.
- **Logo:** Standard, Symbol/Buchstaben mit eigenen Farben oder ein eigenes Bild. Es erscheint im Seitenkopf, als Tab-Symbol, als `apple-touch-icon` und in einem zur Laufzeit erzeugten Manifest. Eine bereits installierte App behält ihr altes Symbol. Gespeichert wird in `vk:logo`. Die Logik steht in `settings.js`.
- **Anzeige, Installation, Offline, Fortschritt:** Bilder und große Schrift, Installationshilfe für iPhone, Android und Computer (mit Installationsknopf, wo der Browser ihn anbietet), Offline-Speicher für ausgewählte oder alle Lektionen, Export/Import/Zurücksetzen des Fortschritts.
- Auf der Startseite bleiben die Lernoptionen (Richtung, Karten pro Runde, fällige/schwierige Karten, Eintippen, automatische Aussprache).

## Entwickeln und testen mit dem Branch `dev`

- `main` ist die echte Seite, `dev` ist zum Ausprobieren. Änderungen kommen zuerst auf `dev`.
- Die Testseite liegt unter `…/voc/dev/`. Sie liest den Branch `dev`, speichert Fortschritt und Einstellungen **getrennt** von der echten Seite, zeigt oben einen orangen Hinweis und sendet keine Statistik.
- Sind die Änderungen in Ordnung, wird `dev` nach `main` übernommen (am einfachsten über einen Pull Request auf GitHub: `dev` → `main`, „Merge“).
- Zwei Workflows veröffentlichen die Seite: `pages.yml` bei jedem Commit auf `main`, `pages-dev.yml` bei jedem Commit auf `dev` (beide bauen über `deploy-site.yml` die Seite aus `main` und `dev`, weil GitHub Pages nur eine Veröffentlichung kennt). Dafür muss unter *Settings → Pages → Build and deployment → Source* **GitHub Actions** eingestellt sein.
- Lokal testen: `python -m http.server` im Repo starten und `http://localhost:8000/?env=dev` öffnen. Die App liest dann direkt deine lokalen Dateien (auch nicht committete) und braucht kein GitHub.

## Lektionsliste (`index.json`) und Anzeigenamen

- Jeder Ordner mit einer Vokabel-JSON ist eine Lektion. Die App liest die Liste aus `index.json`, damit sie nicht die GitHub-API fragen muss (nur 60 Anfragen pro Stunde und IP).
- `index.json` wird automatisch erzeugt (Workflows „Import vocabulary pages“ und „Update lesson index“). Von Hand: `python scripts/build_index.py`.
- Anzeigenamen stehen in `titles.json` (`{"ordnername": "Anzeigename"}`). Fehlt ein Eintrag, zeigt die App den Ordnernamen.
- Ordnernamen: klein, ohne Leerzeichen und Sonderzeichen, z. B. `lektionen/dec3-u1a`. Der Lernfortschritt hängt am Ordnernamen. Wird ein Ordner umbenannt, muss der alte Name in `DIR_RENAMES` in `app.js` eingetragen werden, sonst geht der Fortschritt verloren.
- Audio und Bilder stehen als reine Dateinamen in der JSON (`"audio": "voleur.mp3"`) und liegen im Ordner der Lektion.

## Verbesserungsvorschläge ohne GitHub-Konto

Die App hat „Verbesserung vorschlagen“ (Startseite unten und am Rundenende). Ohne Einrichtung öffnet das Formular ein vorausgefülltes GitHub-Issue; dafür braucht man ein GitHub-Konto. GitHub allein kann keine Issues ohne Konto anlegen, deshalb braucht es für anonymes Senden einen kleinen Zwischendienst. Vorlage: `backend/apps-script.gs` (Google Apps Script, kostenlos).

1. GitHub: *Settings → Developer settings → Fine-grained tokens* → Token nur für dieses Repository, nur „Issues: Read and write“. Labels `vorschlag`, `enhancement`, `bug`, `vokabeln` im Repository anlegen.
2. script.google.com: neues Projekt, Inhalt von `backend/apps-script.gs` einfügen. *Projekteinstellungen → Script-Eigenschaften*: `GITHUB_TOKEN` (der Token), `GITHUB_REPO` (`owner/repo`) und optional `FEEDBACK_DRIVE_FOLDER_ID` (Google-Drive-Ordner für Bilder). Für den Ordner: Ordner in Google Drive anlegen, Ordner-ID aus der URL kopieren und als Skript-Eigenschaft eintragen.
   NSFWJS und TensorFlow.js prüfen ausgewählte Bilder kostenlos lokal im Browser, bevor sie an Apps Script gesendet werden. Die Bibliotheken und das Modell werden bei der ersten Bildprüfung von jsDelivr und GitHub geladen; die Bilder selbst werden nicht an diese Anbieter übertragen. Bilder mit hoher Wahrscheinlichkeit für „Porn“/„Hentai“ (ab 0,5) oder „Sexy“ (ab 0,85) werden blockiert. Die Prüfung kann falsch-positive oder falsch-negative Ergebnisse liefern und ist clientseitig nicht manipulationssicher.
3. Das Löschen geschlossener Anhänge braucht einen GitHub-Webhook:
   - GitHub: *Settings → Webhooks → Add webhook*
   - Payload URL: dieselbe Apps-Script-Web-App-Adresse
   - Content type: `application/json`
   - Secret: ein eigenes, zufälliges Geheimnis
   - Event: „Issues“
   - In den Apps-Script-Script-Eigenschaften `GITHUB_WEBHOOK_SECRET` auf denselben Wert setzen.

   Beim Schließen eines Issues sucht der Dienst die gespeicherten Drive-Dateien für diese Issue-Nummer und verschiebt sie in den Papierkorb.
3. *Bereitstellen → Neue Bereitstellung → Web-App*, Ausführen als „Ich“, Zugriff „Jeder“. Die Web-App-Adresse kopieren.
4. In `feedback-config.json` eintragen: `{ "endpoint": "https://script.google.com/macros/s/…/exec" }`.

Der Token steht nur im Zwischendienst, nie im Code der Seite. Der Dienst begrenzt auf 20 Vorschläge pro Stunde; die App hat zusätzlich eine Pause und eine Spam-Falle.
Zur Fehlersuche im Apps-Script-Editor links auf **Ausführungen** klicken und den fehlgeschlagenen Lauf öffnen. Für den Drive-Zugriff kann `testDriveFolderAccess` direkt im Editor ausgeführt werden; die Funktion protokolliert den Ordnernamen oder zeigt den konkreten Zugriffsfehler.

## Updates für offline gespeicherte Apps

Audio und Bilder werden offline aus dem Speicher geliefert. Damit geänderte Dateien nicht alt bleiben, legt die Veröffentlichung (`deploy-site.yml`) pro Seite eine `version.json` mit dem Commit ab und setzt denselben Commit als Cache-Version in `sw.js`. Die App (`updates.js`) vergleicht beim Öffnen, beim Zurückkehren zur App und bei wieder vorhandenem Internet:

- läuft eine ältere Version als die veröffentlichte (App lange offen), erscheint oben eine Leiste „Es gibt eine neue Version“;
- sind offline gespeicherte Lektionen nicht mehr aktuell, erscheint „Es gibt neue Inhalte“.

„Jetzt aktualisieren“ lädt die Lektionen neu, prüft jede gespeicherte Audio-/Bilddatei per ETag/Last-Modified, lädt nur geänderte und neue Dateien nach, entfernt gelöschte und lädt die App neu. In den Einstellungen gibt es „Version und Updates“ mit „Nach Updates suchen“. Lokal (ohne `version.json`) bleibt das ohne Wirkung.

## KI-Bearbeitung neuer Issues (Gemini)

`.github/workflows/ki-issues.yml` startet bei jedem neuen Issue und ruft `scripts/ki_issue.py` auf:

1. **Einordnen:** Gemini schreibt eine kurze Zusammenfassung als Kommentar und setzt Labels (`bug`, `enhancement`, `vokabeln`, `vorschlag`).
2. **Vorschlagen:** Bei kleinen, eindeutigen Wünschen schlägt Gemini Änderungen vor. Sie werden geprüft (nur erlaubte Dateien, höchstens 150 Zeilen, keine neuen externen Adressen, kein eval/Tracking), angewendet und mit den Unit- und Browser-Tests getestet.
3. **Pull Request:** Bei bestandenen Tests entsteht der Branch `ki/issue-N` und ein Pull Request **gegen `dev`** mit Label `ki-vorschlag`. Es wird nichts gemergt und nichts veröffentlicht. Du liest den Diff und mergst selbst.
4. **Benachrichtigung:** Eine Push-Nachricht über [ntfy.sh](https://ntfy.sh) mit Zusammenfassung und Link, bei jedem Ausgang (auch bei Fehlern).

Warum ein Pull Request: Die Seite `/dev/` liegt auf derselben Adresse wie die Hauptseite und könnte deren Browser-Daten lesen. Ungeprüfter Code von der KI soll deshalb nie direkt auf `dev` landen. Issues sind außerdem Eingaben von Fremden.

Es bearbeitet die KI nur Issues des Repo-Besitzers (dazu zählen die über den Zwischendienst angelegten). Bei Issues anderer Personen kommt nur die Benachrichtigung. Mit dem Label `ki-ignorieren` nimmst du ein Issue aus. Es gibt höchstens 3 offene KI-Pull-Requests.

Einrichtung unter *Settings → Secrets and variables → Actions*:

- Secret `GEMINI_API_KEY`: Schlüssel von aistudio.google.com. Ohne ihn gibt es nur die Benachrichtigung.
- Secret `NTFY_TOPIC`: geheimer Themenname (z. B. `voc-vorschlaege-48213`). Diesen Namen abonnierst du in der ntfy-App auf dem Handy.
- Variable `GEMINI_MODEL` (optional): Modellname, falls der Standard `gemini-3.5-flash-lite` nicht mehr verfügbar ist.

- Variable `KI_DIRECT_DEV` (optional): `true` = nach bestandenen Tests direkt auf `dev` pushen statt Pull Request. Das ist riskanter, weil `/dev/` auf derselben Adresse wie die Hauptseite liegt. Klappt der Push nicht, entsteht ein Pull Request.

Manuell starten: *Actions → Neue Issues bearbeiten (KI) → Run workflow* und die Issue-Nummer eingeben.

## Offline-Nutzung

Wenn noch keine Offline-Inhalte gespeichert sind, zeigt die Startseite den kleinen Knopf **„Möchtest du offline gehen?“**. Speichere dann einmal online alle Lektionen oder nur die ausgewählten; so werden auch Audio und Bilder verfügbar. Kommen später neue Lektionen hinzu, bietet die Startseite **„Offline-Inhalte aktualisieren“** an. Anschließend kannst du die Seite über „Als App installieren“ zum Startbildschirm oder Desktop hinzufügen. Der Service Worker steht in `sw.js`.

## Tests

- Python: `python -m unittest discover -s tests -t .`
- Browser (Playwright): `npm install --no-save playwright && npx playwright install chromium && node tests/e2e/app.test.cjs`
- Beides läuft bei jedem Push im Workflow „Tests“.

## Tastenkürzel

In der Lernrunde: **P** = Anhören, **Leertaste**, **Enter** oder **↓** = Aufdecken, **←/→** oder **1/2** = falsch/richtig, **Strg+Z** = zurück.
Auf der Startseite lässt sich unter „Tastenkürzel“ die Belegung tauschen (Leertaste = Anhören, P = Aufdecken). Das Häkchen
„Kürzel auch im Eingabefeld“ lässt auch Leertaste und P während des Tippens gelten (dann nicht mehr tippbar, deshalb standardmäßig aus).
Pfeiltasten, Enter und Strg+Z funktionieren im Eingabefeld immer.

## Korrekturen an importierten Lektionen

Die Lektionen werden aus den Quellseiten importiert (`sources.csv`), deshalb würden direkte Änderungen an den JSON-Dateien beim
nächsten Import verloren gehen. Korrekturen (Tippfehler, doppelte oder kaputte Karten) stehen in `scripts/korrekturen.json` und werden
nach jedem Import von `scripts/apply_corrections.py` erneut angewendet. In Lektionen mit `merge_existing=true` darf dabei das Feld
`german` nicht geändert werden, weil der Import neue Karten daran erkennt. Wird der Text einer Karte geändert, trägt man ihn zusätzlich in
`CARD_FIXES` (`app.js`) ein, damit der Lernfortschritt der Karte erhalten bleibt.

## Falsch getippt wiederholen

Unter Einstellungen → Lernen gibt es „Falsch getippt: Vokabel wiederholen, bis sie einmal richtig geschrieben ist“. Bei Karten mit Deutsch vorn
wird die eingetippte Antwort beim Aufdecken geprüft (Groß-/Kleinschreibung egal; „+ Inf.“, „qn.“/„qc.“, Klammern und bei „/“ jede Variante sind
optional). Ist sie falsch, öffnet sich ein Fenster mit der richtigen Schreibweise, das erst zugeht, wenn man die Vokabel einmal richtig geschrieben hat
(oder „Überspringen“ wählt). Danach bewertet man die Karte wie gewohnt. Bei Karten mit Französisch vorn (deutsche Antwort) wird nichts geprüft.
