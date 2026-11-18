# Audio-Schneider

Zerlegt eine lange Aufnahme in einzelne Vokabel-Dateien. Läuft auf deinem Rechner, die Aufnahme verlässt ihn nicht.

## Einrichten (einmalig)

1. Python 3 und **ffmpeg** (Windows: `winget install ffmpeg`).
2. Spracherkennung: `pip install faster-whisper`.
   Mit NVIDIA-Karte (z. B. RTX 4060) läuft Whisper auf der GPU. Fehlen dafür Bibliotheken, wechselt das Programm
   von selbst auf die CPU mit dem Modell „small“ (langsamer, für einzelne Wörter reicht es meist).

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

**Deutsch und Französisch in einem Stück** (der übliche Fall): Du schneidest nach dem französischen Wort mit **S**. Das Programm teilt das Stück an den Sprechpausen, bestimmt für jeden Abschnitt, ob er Französisch oder Deutsch ist, und benennt die Datei nach dem ersten französischen Abschnitt. Deutsche Wörter und Erklärungen fließen nicht in den Namen ein. Damit das klappt, muss zwischen dem deutschen und dem französischen Wort eine kleine Pause (mindestens 0,3 s) sein.
Mit dem Häkchen „Nur den französischen Teil speichern“ enthält die MP3 nur das französische Wort, sonst das ganze Stück.

**Getrennte Schnitte:** Wer Deutsch und Französisch lieber einzeln schneidet, schaltet „Getrennte Schnitte“ ein. Jeder deutsche Abschnitt wird dann verworfen, jeder französische gespeichert. Mit **D** verwirfst du ein Stück ohne Wechsel (z. B. eine Erklärung).

Das geschnittene Stück verschwindet aus der Timeline. Namen kannst du in der Liste ändern, Stücke abspielen oder löschen.
Wird nichts erkannt, heißt die Datei „Segment 1“ usw.

## Optionen

- `--model small|medium|large-v3-turbo` (Standard `large-v3-turbo`)
- `--lang fr` Sprache der Vokabeln
- `--stt none` ohne Spracherkennung, Namen von Hand vergeben
- `--port 8765`, `--no-browser`

Der Dateiname ist der erkannte Text ohne Satzzeichen am Rand, gleiche Namen bekommen ` 2`, ` 3` usw. Die Dateien liegen
danach im Lektionsordner; in der `database.json` trägst du den Namen im Feld `audio` ein.
