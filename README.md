# Vokabelkasten

Vokabeltrainer für Französisch (Découvertes, 8. Jahrgangsstufe).

## Vokabelseiten automatisch importieren

In `sources.csv` sind die direkten Découvertes-3-HTML-Quellen eingetragen. Jede Zeile enthält Zielordner, direkte HTML-URL und `merge_existing`:

```csv
folder,url,merge_existing
Dec3-U2-DE,https://jsgdruethkarperancis.s3.eu-central-1.amazonaws.com/Dec3/U2/Dec3-U2_DE_tout.html,false
Découvertes,https://jsgdruethkarperancis.s3.eu-central-1.amazonaws.com/Dec3/U1/Dec3-U1DE-tout.html,true
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

## Entwickeln und testen mit dem Branch `dev`

- `main` ist die echte Seite, `dev` ist zum Ausprobieren. Änderungen kommen zuerst auf `dev`.
- Die Testseite liegt unter `…/voc/dev/`. Sie liest den Branch `dev`, speichert Fortschritt und Einstellungen **getrennt** von der echten Seite, zeigt oben einen orangen Hinweis und sendet keine Statistik.
- Sind die Änderungen in Ordnung, wird `dev` nach `main` übernommen (am einfachsten über einen Pull Request auf GitHub: `dev` → `main`, „Merge“).
- Der Workflow `.github/workflows/pages.yml` veröffentlicht beide Branches. Dafür muss unter *Settings → Pages → Build and deployment → Source* **GitHub Actions** eingestellt sein.
- Lokal testen: `python -m http.server` im Repo starten und `http://localhost:8000/?env=dev` öffnen. Die App liest dann direkt deine lokalen Dateien (auch nicht committete) und braucht kein GitHub.

## Lektionsliste (`index.json`) und Anzeigenamen

- Jeder Ordner mit einer Vokabel-JSON ist eine Lektion. Die App liest die Liste aus `index.json`, damit sie nicht die GitHub-API fragen muss (nur 60 Anfragen pro Stunde und IP).
- `index.json` wird automatisch erzeugt (Workflows „Import vocabulary pages“ und „Update lesson index“). Von Hand: `python scripts/build_index.py`.
- Anzeigenamen stehen in `titles.json` (`{"ordnername": "Anzeigename"}`). Fehlt ein Eintrag, zeigt die App den Ordnernamen.
- Ordnernamen: klein, ohne Leerzeichen und Sonderzeichen, z. B. `dec3-u1a`. Der Lernfortschritt hängt am Ordnernamen. Wird ein Ordner umbenannt, muss der alte Name in `DIR_RENAMES` in `index.html` eingetragen werden, sonst geht der Fortschritt verloren.
- Audio und Bilder stehen als reine Dateinamen in der JSON (`"audio": "voleur.mp3"`) und liegen im Ordner der Lektion.

## Offline-Nutzung

Die Seite lässt sich als App installieren (PWA). Die App selbst und die Vokabeln merkt sie sich automatisch. Audio und Bilder werden nur für Lektionen gespeichert, die du auswählst und mit „Ausgewählte Lektionen offline speichern“ sicherst. Das hält den Speicher klein. Der Service Worker steht in `sw.js`.

## Tests

- Python: `python -m unittest discover -s tests -t .`
- Browser (Playwright): `npm install --no-save playwright && npx playwright install chromium && node tests/e2e/app.test.cjs`
- Beides läuft bei jedem Push im Workflow „Tests“.
