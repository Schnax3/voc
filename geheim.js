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

// Zeigt auf der Startseite den passwortgeschützten Link an (nur wenn geheim.json existiert, also beide Secrets gesetzt sind).
// Das richtige Passwort wird in diesem Browser gemerkt (nicht im Fortschritts-Export). Es gibt keinen Sperr-Knopf. Ändert sich das Passwort, wird neu gefragt.
function mountGeheim(slot) {
  if (!slot) return;
  fetch('geheim.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(box => {
    if (!box || !box.data || !slot.isConnected) return;
    slot.innerHTML = `<section class="panel" id="sec-secret" aria-label="Audio-Link">
      <h2>Audio-Link</h2>
      <p class="hint" id="secret-hint">Der Audio-Link ist mit einem Passwort geschützt. Du bekommst das Passwort über den WhatsApp-Klassengruppenchat.</p>
      <button id="secret-hint-btn" class="linklike" type="button" aria-expanded="false" hidden>Hinweis</button>
      <p class="hint" id="secret-hint-text" hidden></p>
      <div class="opts" id="secret-form"><label>Passwort <input type="password" id="secret-pw" autocomplete="off" spellcheck="false"></label></div>
      <div class="btns small" id="secret-btns"><button id="secret-open" type="button" class="primary">Link anzeigen</button></div>
      <p class="hint" id="secret-msg" role="status"></p>
      <p id="secret-link" hidden></p>
    </section>`;
    const $ = s => slot.querySelector(s);
    if (box.hint) {
      // Der Hinweis (Variable DRIVE_HINWEIS) steht erst nach Klick auf den blauen Text „Hinweis“ da.
      $('#secret-hint-text').textContent = box.hint;
      $('#secret-hint-btn').hidden = false;
      $('#secret-hint-btn').onclick = () => {
        const open = $('#secret-hint-text').hidden;
        $('#secret-hint-text').hidden = !open; $('#secret-hint-btn').setAttribute('aria-expanded', String(open));
      };
    }
    const show = link => {
      if (!/^https?:\/\//i.test(link)) throw new Error('kein Link');
      const a = document.createElement('a');
      a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Audio-Link öffnen';
      $('#secret-link').replaceChildren(a); $('#secret-link').hidden = false;
      $('#secret-form').hidden = true; $('#secret-btns').hidden = true; $('#secret-pw').value = '';
    };
    const open = async () => {
      $('#secret-msg').textContent = '';
      const password = $('#secret-pw').value;
      try { show(await entschluesseln(box, password)); LS.set('secretpw', password); }
      catch { $('#secret-msg').textContent = 'Falsches Passwort.'; }
    };
    $('#secret-open').onclick = open;
    $('#secret-pw').onkeydown = e => { if (e.key === 'Enter') open(); };
    const saved = LS.get('secretpw', '');
    if (saved) entschluesseln(box, saved).then(show).catch(() => LS.set('secretpw', ''));
  }).catch(() => { /* kein geschützter Link vorhanden */ });
}
if (typeof module !== 'undefined') module.exports = { entschluesseln };
