# Vokabelkasten

Vokabeltrainer für Französisch (Découvertes, 8. Jahrgangsstufe).

## Projektstruktur

```
index.html, style.css, app.js, settings.js, schulaufgabe.js, feedback.js, consent.js   die App (statisch, kein Build nötig)
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
2. script.google.com: neues Projekt, Inhalt von `backend/apps-script.gs` einfügen. *Projekteinstellungen → Script-Eigenschaften*: `GITHUB_TOKEN` (der Token) und `GITHUB_REPO` (`owner/repo`).
3. *Bereitstellen → Neue Bereitstellung → Web-App*, Ausführen als „Ich“, Zugriff „Jeder“. Die Web-App-Adresse kopieren.
4. In `feedback-config.json` eintragen: `{ "endpoint": "https://script.google.com/macros/s/…/exec" }`.

Der Token steht nur im Zwischendienst, nie im Code der Seite. Der Dienst begrenzt auf 20 Vorschläge pro Stunde; die App hat zusätzlich eine Pause und eine Spam-Falle.

## Offline-Nutzung

Wenn noch keine Offline-Inhalte gespeichert sind, zeigt die Startseite den kleinen Knopf **„Möchtest du offline gehen?“**. Speichere dann einmal online alle Lektionen oder nur die ausgewählten; so werden auch Audio und Bilder verfügbar. Kommen später neue Lektionen hinzu, bietet die Startseite **„Offline-Inhalte aktualisieren“** an. Anschließend kannst du die Seite über „Als App installieren“ zum Startbildschirm oder Desktop hinzufügen. Der Service Worker steht in `sw.js`.

## Tests

- Python: `python -m unittest discover -s tests -t .`
- Browser (Playwright): `npm install --no-save playwright && npx playwright install chromium && node tests/e2e/app.test.cjs`
- Beides läuft bei jedem Push im Workflow „Tests“.
