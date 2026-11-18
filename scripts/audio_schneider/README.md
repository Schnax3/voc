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

Standardmäßig ist der Abwechsel-Modus an: Aufnahmen mit „Deutsch, Französisch, Deutsch, Französisch …“ schneidest du einfach durchgehend mit **S**. Jeder deutsche Abschnitt wird verworfen, jeder französische gespeichert und erkannt. Kommt eine Erklärung dazwischen, drückst du an ihrem Ende **D**. Das Häkchen „Abwechselnd“ schaltet den Modus aus, dann speichert **S** jedes Stück.

Das geschnittene Stück verschwindet aus der Timeline. Namen kannst du in der Liste ändern, Stücke abspielen oder löschen.
Wird nichts erkannt, heißt die Datei „Segment 1“ usw.

## Optionen

- `--model small|medium|large-v3-turbo` (Standard `large-v3-turbo`)
- `--lang fr` Sprache der Vokabeln
- `--stt none` ohne Spracherkennung, Namen von Hand vergeben
- `--port 8765`, `--no-browser`

Der Dateiname ist der erkannte Text ohne Satzzeichen am Rand, gleiche Namen bekommen ` 2`, ` 3` usw. Die Dateien liegen
danach im Lektionsordner; in der `database.json` trägst du den Namen im Feld `audio` ein.
