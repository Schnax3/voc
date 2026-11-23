#!/usr/bin/env node
// Verschlüsselt einen geheimen Link (z. B. Google-Drive-Ordner) mit einem Passwort und schreibt geheim.json.
// Gedacht für den Seiten-Build (deploy-site.yml): Link und Passwort kommen aus Repository-Secrets und stehen nie im Repo.
// Auf der Seite liegt nur der verschlüsselte Text (PBKDF2-SHA256 + AES-256-GCM); der Browser entschlüsselt ihn nach der
// Passwort-Eingabe (geheim.js). Ohne Passwort ist der Link weder sichtbar noch im Quelltext lesbar.
//
// Aufruf:  DRIVE_LINK=... DRIVE_PASSWORT=... [DRIVE_HINWEIS=...] node scripts/encrypt_link.cjs <ausgabe.json> [weitere.json ...]
// Fehlt eines der Secrets, wird nichts geschrieben (die App zeigt dann keinen Bereich an).
const crypto = require('node:crypto');
const fs = require('node:fs');

const ITERATIONS = 310000;

function encrypt(link, password, hint) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(link, 'utf8'), cipher.final(), cipher.getAuthTag()]); // wie WebCrypto: Text + Tag
  const box = { v: 1, iter: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') };
  if (hint) box.hint = hint;
  return box;
}

if (require.main === module) {
  const link = (process.env.DRIVE_LINK || '').trim(), password = process.env.DRIVE_PASSWORT || '';
  const outputs = process.argv.slice(2);
  if (!link || !password) { console.log('DRIVE_LINK oder DRIVE_PASSWORT fehlt: geheim.json wird nicht erzeugt.'); process.exit(0); }
  if (!outputs.length) { console.error('Ausgabedatei fehlt.'); process.exit(1); }
  const box = encrypt(link, password, (process.env.DRIVE_HINWEIS || '').trim());
  for (const file of outputs) { fs.writeFileSync(file, JSON.stringify(box) + '\n'); console.log('geschrieben:', file); }
}
module.exports = { encrypt, ITERATIONS };
