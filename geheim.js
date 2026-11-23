// Entschlüsselt den geheimen Link aus geheim.json (erzeugt von scripts/encrypt_link.cjs) mit dem eingegebenen Passwort.
// PBKDF2-SHA256 + AES-256-GCM über WebCrypto. Falsches Passwort -> Fehler (GCM-Prüfsumme stimmt nicht).
async function entschluesseln(box, password) {
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(box.salt), iterations: box.iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
  return new TextDecoder().decode(plain);
}
if (typeof module !== 'undefined') module.exports = { entschluesseln };
