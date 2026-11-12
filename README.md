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
