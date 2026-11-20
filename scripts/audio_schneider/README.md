# Audio-Schneider

Zerlegt eine lange Aufnahme in einzelne Vokabel-Dateien. Läuft auf deinem Rechner, die Aufnahme verlässt ihn nicht.

## Einrichten (einmalig)

1. Python 3 und **ffmpeg** (Windows: `winget install ffmpeg`).
2. Spracherkennung: `pip install faster-whisper`.
   Für GPU-Betrieb braucht faster-whisper CUDA-12-cuBLAS und cuDNN 9. Audio-Schneider sucht die DLLs automatisch
   in `CUDA_PATH`, den üblichen CUDA-Installationsordnern und `%LOCALAPPDATA%\Audio-Schneider\cuda-runtime`.
   Unter Windows kann das von faster-whisper verlinkte [CUDA-12-cuBLAS/cuDNN-Bundle](https://github.com/Purfview/whisper-standalone-win/releases/tag/libs)
   in diesen lokalen Ordner entpackt werden. Der NVIDIA-Treiber allein genügt nicht.
   Fehlen DLLs wie `cublas64_12.dll`, startet das Programm direkt mit CPU-`small`/int8 und `beam_size=1`
   (schneller, aber eventuell mit leicht geringerer Genauigkeit); der Browser zeigt den aktiven Modus an.

## Benutzen

```
python scripts/audio_schneider/schneider.py --out lektionen/dec3-u2-a
```

Der Browser öffnet sich. Aufnahme hineinziehen, abspielen und an jeder Wortgrenze **S** drücken.

| Taste | Wirkung |
|---|---|
| **S** | Stück seit dem letzten Schnitt ausschneiden, erkennen, als `<Wort>.mp3` im Zielordner speichern. Die Aufnahme läuft weiter. |
| **D** | Stück verwerfen (nicht speichern), z. B. eine Erklärung. Die Reihenfolge Deutsch/Französisch ändert sich dabei nicht. |
| **T** | Umschalten, ob der nächste Schnitt Deutsch (verwerfen) oder Französisch (speichern) ist |
| Leertaste | Abspielen / Pause |
| **Z** | Letzten Schnitt zurück (Datei wird wieder gelöscht) |
| ← / → | 1 s springen (mit Umschalt 0,2 s) |

**Deutsch und Französisch in einem Stück** (der übliche Fall): Du schneidest nach dem französischen Wort mit **S**. Das Programm teilt das Stück an kurzen Sprechpausen und analysiert lange Abschnitte zusätzlich in überlappenden Fenstern. Whisper transkribiert standardmäßig direkt mit der Zielsprache (`fr`) und prüft bei mehreren Abschnitten den letzten zuerst. So wird bevorzugt das französische Wort am Ende erkannt statt der deutschen Erklärung davor.
Mit dem Häkchen „Nur den französischen Teil speichern“ enthält die MP3 nur das französische Wort, sonst das ganze Stück.

**Getrennte Schnitte:** Wer Deutsch und Französisch lieber einzeln schneidet, schaltet „Getrennte Schnitte“ ein. Jeder deutsche Abschnitt wird dann verworfen, jeder französische gespeichert. Mit **D** verwirfst du ein Stück ohne Wechsel (z. B. eine Erklärung).

Das geschnittene Stück verschwindet aus der Timeline. Namen kannst du in der Liste ändern, Stücke abspielen oder löschen. Umbenennen ändert nur den Namen der vorhandenen MP3-Datei; Whisper und Seed-VC werden dabei nicht erneut ausgeführt.
Wird nichts erkannt, heißt die Datei „Segment 1“ usw.
Bei einem Clip ohne französische Erkennung erscheint **FR ↻**: Damit wird Whisper auf dem Originalausschnitt
gezielt mit Französisch erneut ausgeführt, ohne Seed-VC nochmals zu starten. Einen erkannten Namensvorschlag
musst du bestätigen; die vorhandene Audiodatei bleibt dabei erhalten.

## Projekt im Browser

Für jeden Zielordner wird das zuletzt bearbeitete Projekt lokal im Browser (IndexedDB) gespeichert: Quelldatei,
Referenzstimme, Schnitte, Fortschritt und Einstellungen. Beim erneuten Öffnen derselben Audio-Schneider-Adresse und
desselben Zielordners wird es automatisch wiederhergestellt. Die Audiodateien bleiben auf diesem Computer; sie werden
nicht an einen externen Speicherdienst gesendet. Browserdaten im privaten Modus oder manuell gelöschte Websitedaten
können das Projekt entfernen. Laufende Schnitte zeigen im Browser ihren aktuellen Arbeitsschritt und die Laufzeit;
das Debug-Protokoll enthält zusätzlich Whisper-Abschnitte und Seed-VC-Statusmeldungen. Nach einem Neuladen versucht
die Oberfläche, laufende Aufträge mit demselben Server wieder aufzunehmen. Wurde der Server zwischenzeitlich beendet,
prüfe den Zielordner, bevor du einen als unterbrochen markierten Abschnitt erneut schneidest.

## Optionale Seed-VC-Umwandlung

Wenn Seed-VC V2 lokal über Pinokio läuft, kannst du vor dem Schneiden „Seed-VC V2 vor dem Speichern verwenden“ aktivieren. Lade eine Referenzstimme hoch, stelle die V2-Parameter ein und schneide wie gewohnt. Jeder Clip wird nach Schnitt und optionaler Spracherkennung an die lokale Seed-VC-API gesendet; gespeichert wird nur die erfolgreich umgewandelte MP3. Bei einem Fehler wird der Clip nicht gespeichert und der Fehler im Browser angezeigt.

Die Seed-VC-Adresse ist editierbar und muss auf den lokalen Pinokio-Port zeigen (Standard `http://127.0.0.1:42003`). Eine Referenzstimme ist erforderlich, außer wenn „Anonymisierung“ aktiviert ist. Die Referenz wird nicht an einen externen Dienst gesendet.

Die im Referenz-Auswahlfeld geladene Stimme wird zusätzlich lokal als Standard für alle Zielordner gespeichert und nach einem Neustart automatisch geladen. Unter Windows liegt sie in `%LOCALAPPDATA%\Audio-Schneider\seedvc-reference.<Endung>` (zum Beispiel `seedvc-reference.wav`). Du kannst die Datei dort ablegen oder durch eine neue Auswahl im Browser ersetzen. Eine bereits in einem Browserprojekt gespeicherte projektspezifische Referenz bleibt für dieses Projekt erhalten; Projekte ohne eigene Referenz verwenden den Standard.

## Optionen

- `--model small|medium|large-v3-turbo` (Standard `large-v3-turbo`)
- `--lang fr` Sprache der Vokabeln
- `--stt none` ohne Spracherkennung, Namen von Hand vergeben
- `--port 8765`, `--no-browser`

Der Dateiname ist der erkannte Text ohne Satzzeichen am Rand, gleiche Namen bekommen ` 2`, ` 3` usw. Die Dateien liegen
danach im Lektionsordner; in der `database.json` trägst du den Namen im Feld `audio` ein.
