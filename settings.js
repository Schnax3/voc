// ---- Aussehen (Farben, Vorlagen), Logo, Installation, Einstellungsbildschirm -------------------
// Wird nach app.js geladen und nutzt dessen globale Werte (LS, opt, sel, tables, P, ...).

// --- Farben ---------------------------------------------------------------------------------------
const BASE_COLORS = {
  light: { bg: '#f6f5f1', card: '#ffffff', ink: '#1d1d1b', acc: '#2f6fed', ok: '#1f9d55', bad: '#d64545' },
  dark: { bg: '#161614', card: '#222220', ink: '#efeee8', acc: '#6b9bff', ok: '#1f9d55', bad: '#d64545' }
};
// Jede Vorlage außer "standard" enthält Farben für beide Modi und folgt damit auch der Geräteeinstellung.
const PRESETS = {
  standard: { name: 'Standard' },
  ocean: { name: 'Ozean', light: { bg: '#eaf3fb', card: '#ffffff', ink: '#10263a', acc: '#0b6fbd', ok: '#13875a', bad: '#c93a47' }, dark: { bg: '#101d29', card: '#182a39', ink: '#e5f1fb', acc: '#63b8ff', ok: '#5ed49a', bad: '#ff7b83' } },
  forest: { name: 'Wald', light: { bg: '#eef4ea', card: '#fbfdf9', ink: '#1b2a1c', acc: '#2e7d3a', ok: '#1c7f46', bad: '#c0452e' }, dark: { bg: '#121b14', card: '#1c2a1e', ink: '#e6f2e5', acc: '#78c879', ok: '#62d692', bad: '#ff8272' } },
  sunset: { name: 'Sonnenuntergang', light: { bg: '#fff1e5', card: '#fffdfb', ink: '#3a2216', acc: '#c9481a', ok: '#2a7f50', bad: '#b8322a' }, dark: { bg: '#241711', card: '#342219', ink: '#fff0e4', acc: '#ff9866', ok: '#67d79c', bad: '#ff7770' } },
  lavender: { name: 'Lavendel', light: { bg: '#f3eefa', card: '#ffffff', ink: '#2a2038', acc: '#6f45c8', ok: '#26905d', bad: '#c93a55' }, dark: { bg: '#1c1726', card: '#292136', ink: '#f1eafa', acc: '#bd9aff', ok: '#68d69b', bad: '#ff8196' } },
  night: { name: 'Mitternacht', light: { bg: '#edf3fa', card: '#ffffff', ink: '#192535', acc: '#176bc1', ok: '#147a49', bad: '#c93d45' }, dark: { bg: '#0e1319', card: '#18202a', ink: '#e6edf3', acc: '#58a6ff', ok: '#3fb06a', bad: '#f0645f' } },
  contrast: { name: 'Hoher Kontrast', light: { bg: '#ffffff', card: '#ffffff', ink: '#000000', acc: '#0000c8', ok: '#006400', bad: '#b00000', line: '#000000' }, dark: { bg: '#000000', card: '#111111', ink: '#ffffff', acc: '#8ab4ff', ok: '#63e68b', bad: '#ff8585', line: '#ffffff' } }
};
const COLOR_FIELDS = [
  ['acc', 'Akzent', 'Knöpfe, Balken, Links'],
  ['bg', 'Hintergrund', ''],
  ['card', 'Karten und Flächen', ''],
  ['ink', 'Text', ''],
  ['ok', '„Richtig“', ''],
  ['bad', '„Falsch“', '']
];
const hexToRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgbToHex = rgb => '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
const mixHex = (a, b, t) => { const A = hexToRgb(a), B = hexToRgb(b); return rgbToHex(A.map((v, i) => v + (B[i] - v) * t)); }; // t=0: a, t=1: b
const luminance = h => {
  const [r, g, b] = hexToRgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
};
const onColor = h => luminance(h) > .18 ? '#111111' : '#ffffff'; // lesbare Schrift auf farbigem Knopf
const VAR_NAMES = ['--bg', '--card', '--ink', '--acc', '--ok', '--bad', '--mut', '--line', '--on-acc', '--on-ok', '--on-bad'];

const getLook = () => {
  const saved = LS.get('vk:look', null);
  if (saved) return { mode: 'auto', preset: 'standard', ...saved, custom: saved.custom || {} };
  const old = LS.get('vk:theme', null); // frühere Einstellung "Dunkles Design"
  return { mode: old === 'dark' || old === 'light' ? old : 'auto', preset: 'standard', custom: {} };
};
const effectiveColors = look => {
  const preset = PRESETS[look.preset] || PRESETS.standard;
  const scheme = look.mode === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : look.mode;
  const presetColors = preset[scheme] || {};
  const own = Object.fromEntries(COLOR_FIELDS.map(([k]) => [k, presetColors[k]]).filter(([, value]) => value));
  return {
    scheme, preset, presetColors,
    colors: { ...BASE_COLORS[scheme], ...own, ...look.custom },
    styled: Boolean(preset[scheme]) || Object.keys(look.custom).length > 0
  };
};
function applyLook() {
  const look = getLook(), root = document.documentElement, e = effectiveColors(look), c = e.colors;
  root.dataset.theme = e.scheme;
  if (!e.styled) VAR_NAMES.forEach(v => root.style.removeProperty(v));
  else {
    const vars = {
      '--bg': c.bg, '--card': c.card, '--ink': c.ink, '--acc': c.acc, '--ok': c.ok, '--bad': c.bad,
      '--mut': mixHex(c.ink, c.bg, .4), '--line': look.custom.bg || !e.presetColors.line ? mixHex(c.bg, c.ink, .14) : e.presetColors.line,
      '--on-acc': onColor(c.acc), '--on-ok': onColor(c.ok), '--on-bad': onColor(c.bad)
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = c.acc;
}
const setLook = look => { LS.set('vk:look', look); applyLook(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getLook().mode === 'auto') applyLook(); });
applyLook();

// --- Logo -------------------------------------------------------------------------------------------
const getLogo = () => LS.get('vk:logo', { type: 'default' });
const isCustomLogo = cfg => (cfg.type === 'text' && cfg.text) || (cfg.type === 'image' && cfg.img);
function logoDataUrl(cfg, size) {
  if (cfg.type === 'image') return cfg.img;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const g = canvas.getContext('2d'), text = Array.from(cfg.text || '').slice(0, 2).join('');
  g.fillStyle = cfg.bg || '#2f6fed'; g.fillRect(0, 0, size, size);
  g.fillStyle = cfg.fg || '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `600 ${Math.round(size * (Array.from(text).length > 1 ? .42 : .56))}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  g.fillText(text, size / 2, size / 2 + size * .03);
  return canvas.toDataURL('image/png');
}
const logoSmall = () => { const cfg = getLogo(); return isCustomLogo(cfg) ? logoDataUrl(cfg, 192) : 'icons/icon-192.png'; };
let manifestUrl = null;
function applyLogo() {
  const cfg = getLogo(), custom = isCustomLogo(cfg), small = logoSmall();
  const link = sel => document.querySelector(sel);
  link('link[rel="icon"]').href = small;
  link('link[rel="apple-touch-icon"]').href = custom ? logoDataUrl(cfg, 180) : 'icons/icon-180.png';
  document.querySelectorAll('img.logo').forEach(img => { img.src = small; });
  const manifest = link('link[rel="manifest"]');
  if (manifestUrl) { URL.revokeObjectURL(manifestUrl); manifestUrl = null; }
  if (custom) { // eigenes Manifest, damit auch die Installation unter Android das Logo übernimmt
    const base = new URL('./', location.href).href, big = logoDataUrl(cfg, 512);
    manifestUrl = URL.createObjectURL(new Blob([JSON.stringify({
      name: 'Vokabelkasten', short_name: 'Vokabeln', lang: 'de', start_url: base, scope: base, display: 'standalone',
      background_color: '#f6f5f1', theme_color: '#2f6fed',
      icons: [{ src: small, sizes: '192x192', type: 'image/png' }, { src: big, sizes: '512x512', type: 'image/png' }]
    })], { type: 'application/manifest+json' }));
    manifest.href = manifestUrl;
  } else manifest.href = 'manifest.webmanifest';
}
const setLogo = cfg => {
  LS.set('vk:logo', cfg);
  applyLogo();
  return LS.get('vk:logo', { type: 'default' }).img === cfg.img; // false: Speicher voll
};
async function logoFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i); i.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.')); i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
applyLogo();

// --- Installation -----------------------------------------------------------------------------------
let installEvent = null; // Chrome/Edge/Android bieten einen eigenen Installationsdialog an
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); installEvent = e;
  const button = document.getElementById('install-now'); if (button) button.hidden = false;
});
window.addEventListener('appinstalled', () => { installEvent = null; const box = document.getElementById('install-box'); if (box) box.innerHTML = installHtml(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const platform = () => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return /Android/i.test(ua) ? 'android' : 'desktop';
};
function installHtml() {
  if (isStandalone()) return '<p>✓ Du nutzt gerade die installierte App.</p>';
  const steps = {
    ios: ['Öffne diese Seite in Safari.', 'Tippe unten auf „Teilen“ (Quadrat mit Pfeil nach oben).', 'Wähle „Zum Home-Bildschirm“ und bestätige mit „Hinzufügen“.'],
    android: ['Öffne das Menü ⋮ oben rechts in Chrome.', 'Wähle „App installieren“ (oder „Zum Startbildschirm hinzufügen“).', 'Bestätige. Das Symbol erscheint auf deinem Startbildschirm.'],
    desktop: ['In Chrome und Edge: Klicke in der Adressleiste rechts auf das Installieren-Symbol (Monitor mit Pfeil).', 'Oder öffne das Browser-Menü und wähle „App installieren“ bzw. „Seite als App installieren“.', 'In Safari am Mac: „Ablage → Zum Dock hinzufügen“.']
  }[platform()];
  return `<ol class="steps">${steps.map(t => `<li>${esc(t)}</li>`).join('')}</ol>
    <div class="btns small"><button id="install-now" type="button" class="primary"${installEvent ? '' : ' hidden'}>App jetzt installieren</button>
    <button id="copy-link" type="button">Link zur App kopieren</button></div>
    <p class="hint" id="install-note"></p>
    <p class="hint">Danach öffnet sich die App ohne Browserleiste und funktioniert mit gespeicherten Lektionen auch ohne Internet.</p>`;
}

// --- Einstellungsbildschirm ---------------------------------------------------------------------------
const fmtMb = bytes => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576) : Math.round(bytes / 104857.6) / 10).toString().replace('.', ',') + ' MB';
function openSettings() { enterScreen(); settings(); }
function settings() {
  stopAudio();
  document.onkeydown = e => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) leaveScreen(); };
  app.innerHTML = `<div class="top"><button id="back-home" type="button">← Zurück</button></div>
  <h1>Einstellungen</h1>

  <section class="panel" id="sec-learn" aria-label="Lernen">
    <h2>Lernen</h2>
    <div class="opts">
      <label>Tagesziel
        <select id="goal"><option value="0">Aus</option><option value="10">10 Karten</option><option value="20">20 Karten</option><option value="30">30 Karten</option><option value="50">50 Karten</option><option value="100">100 Karten</option></select></label>
      <label><input type="checkbox" id="endless"> Immer weiterlernen</label>
      <p class="hint">Nach jeder Runde geht es gleich weiter. Ist nichts mehr fällig, wiederholst du schon gelernte Karten.</p>
      <label><input type="checkbox" id="typing"> Antwort vor dem Aufdecken eintippen</label>
      <label><input type="checkbox" id="auto"> Aussprache automatisch abspielen</label>
      <label><input type="checkbox" id="retype"> Falsch getippt: Vokabel wiederholen, bis sie einmal richtig geschrieben ist</label>
      <p class="hint">Gilt für Karten mit Deutsch vorn (Antwort auf Französisch). Beim Aufdecken wird deine Eingabe geprüft. Ist sie falsch, kommt ein Fenster, bis du die Vokabel richtig schreibst. Das Eingabefeld erscheint dann auch ohne „Antwort eintippen“.</p>
      <h3>Verben konjugieren</h3>
      <label><input type="checkbox" id="conj-pres"> Présent</label>
      <label><input type="checkbox" id="conj-pc"> Passé composé</label>
      <p class="hint">Gilt für alle Verben in den Lektionen. Sind beide aus, kommt nur die Grundform.</p>
      <h3>Tastatur</h3>
      <label><input type="checkbox" id="keys-off"> Alle Tastenkürzel ausschalten</label>
      <p class="hint">Dann gehen Aufdecken, Bewerten, Anhören und Zurück nur noch per Klick oder Wischen. Eingabefelder funktionieren normal.</p>
      <label>Tastenkürzel
        <select id="keymap"><option value="std">P = Anhören, Leertaste = Aufdecken</option><option value="alt">Leertaste = Anhören, P = Aufdecken</option></select></label>
      <label><input type="checkbox" id="keys-input"> Kürzel auch im Eingabefeld</label>
      <p class="hint">Gilt für Leertaste und P (die lassen sich dort dann nicht mehr tippen). Pfeiltasten, Enter und Tastenkombinationen wie Strg+Z funktionieren im Eingabefeld immer.</p>
    </div>
  </section>

  <section class="panel" id="sec-colors" aria-label="Farben">
    <h2>Farben</h2>
    <div class="opts">
      <label>Modus <select id="mode"><option value="auto">Automatisch (wie dein Gerät)</option><option value="light">Hell</option><option value="dark">Dunkel</option></select></label>
    </div>
    <p class="hint" id="mode-note"></p>
    <h2 class="sp2">Vorlagen</h2>
    <div class="chips" id="presets" role="group" aria-label="Farbvorlagen">${Object.entries(PRESETS).map(([id, p]) => {
      const light = p.light || BASE_COLORS.light, dark = p.dark || BASE_COLORS.dark;
      return `<button type="button" class="chip" data-preset="${id}" aria-pressed="false"><span class="sw" style="background:linear-gradient(135deg,${light.bg} 50%,${dark.bg} 50%)"><i style="background:linear-gradient(135deg,${light.acc} 50%,${dark.acc} 50%)"></i></span>${esc(p.name)}</button>`;
    }).join('')}</div>
    <h2 class="sp2">Einzelne Farben</h2>
    <div class="colors">${COLOR_FIELDS.map(([key, label, note]) => `<label class="color"><span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</span><input type="color" data-key="${key}" aria-label="${esc(label)}"></label>`).join('')}</div>
    <div class="btns small"><button id="colors-reset" type="button">Farben zurücksetzen</button></div>
  </section>

  <section class="panel" id="sec-logo" aria-label="Logo">
    <h2>Logo</h2>
    <div class="logo-edit">
      <img class="logo big-logo" alt="Vorschau des Logos" width="72" height="72">
      <div class="logo-choices">
        <label><input type="radio" name="logo-type" value="default"> Standard</label>
        <label><input type="radio" name="logo-type" value="text"> Symbol oder Buchstaben</label>
        <label><input type="radio" name="logo-type" value="image"> Eigenes Bild</label>
      </div>
    </div>
    <div id="logo-text-box" hidden>
      <label class="color"><span>Symbol oder Buchstaben<small>z. B. 🇫🇷 oder FR</small></span><input type="text" id="logo-text" autocomplete="off" spellcheck="false" style="width:6em"></label>
      <label class="color"><span>Hintergrund</span><input type="color" id="logo-bg"></label>
      <label class="color"><span>Schrift</span><input type="color" id="logo-fg"></label>
    </div>
    <div id="logo-image-box" hidden><label class="color"><span>Bild auswählen<small>wird quadratisch zugeschnitten</small></span><input type="file" id="logo-file" accept="image/*"></label></div>
    <p class="hint" id="logo-note">Das Logo erscheint oben in der App, im Browser-Tab und beim Hinzufügen zum Home-Bildschirm. Eine schon installierte App behält ihr altes Symbol: entferne sie und installiere sie neu.</p>
  </section>

  <section class="panel" id="sec-display" aria-label="Anzeige">
    <h2>Anzeige</h2>
    <div class="opts">
      <label><input type="checkbox" id="img"> Bilder auf den Karten anzeigen</label>
      <label><input type="checkbox" id="big"> Große Schrift</label>
    </div>
  </section>

  <section class="panel" id="sec-install" aria-label="App installieren">
    <h2>Als App installieren</h2>
    <div id="install-box">${installHtml()}</div>
  </section>

  <section class="panel" id="sec-update" aria-label="Version und Updates">
    <h2>Version und Updates</h2>
    <p class="hint">Ist die App offline gespeichert, liefert sie Audio und Bilder aus dem Speicher. Mit einem Update lädst du neue und geänderte Dateien nach und die neueste Version der App. Die App sucht beim Öffnen automatisch danach.</p>
    <p class="hint" id="update-status" role="status"></p>
    <div class="btns small"><button id="update-check" type="button">Nach Updates suchen</button><button id="update-apply" type="button" class="primary" hidden>Jetzt aktualisieren</button></div>
  </section>

  <section class="panel" id="sec-offline" aria-label="Offline-Nutzung">
    <h2>Offline-Nutzung</h2>
    <p class="hint">Einmal online vorbereiten: Speichere die App und Lektionen, solange du Internet hast. „Alle Lektionen offline speichern“ ist der einfachste Weg; danach kannst du die Seite auch ohne Verbindung öffnen.</p>
    <div id="offline-box" hidden>
      <p class="hint" id="offline-status" role="status"></p>
      <p class="hint" id="offline-storage"></p>
      <div class="btns small"><button id="offline-save" type="button">Ausgewählte Lektionen speichern</button><button id="offline-save-all" type="button" class="primary">Alle Lektionen offline speichern</button><button id="offline-clear" type="button">Offline-Speicher leeren</button></div>
    </div>
    <p class="hint" id="offline-unavailable" hidden>Offline-Nutzung braucht die Seite über https (zum Beispiel auf GitHub Pages) und einen Browser mit Service Worker.</p>
    <p class="hint">Die App selbst und die Vokabeln merkt sich der Browser automatisch. Audio und Bilder werden nur für Lektionen gespeichert, die du hier sicherst.</p>
  </section>

  <section class="panel" id="sec-data" aria-label="Fortschritt und Daten">
    <h2>Fortschritt und Daten</h2>
    <div class="btns small"><button id="export" type="button">Fortschritt exportieren</button><button id="import" type="button">Fortschritt importieren</button>
      <button id="reset" type="button">Fortschritt der gewählten Lektionen zurücksetzen</button><button id="reload" type="button">Lektionen neu laden</button></div>
    <p class="hint">Der Fortschritt liegt nur in diesem Browser. Mit Export und Import ziehst du auf ein anderes Gerät um oder sicherst ihn.</p>
  </section>
  <input type="file" id="import-file" accept="application/json,.json" hidden>`;
  const $ = s => app.querySelector(s);

  // Farben
  const syncColors = () => {
    const look = getLook(), e = effectiveColors(look);
    $('#mode').value = look.mode; $('#mode').disabled = false;
    $('#mode-note').textContent = '';
    app.querySelectorAll('.chip').forEach(chip => { const on = chip.dataset.preset === look.preset; chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', String(on)); });
    app.querySelectorAll('input[type="color"][data-key]').forEach(input => { input.value = e.colors[input.dataset.key]; });
  };
  $('#mode').onchange = () => { setLook({ ...getLook(), mode: $('#mode').value }); syncColors(); };
  app.querySelectorAll('.chip').forEach(chip => chip.onclick = () => { setLook({ ...getLook(), preset: chip.dataset.preset, custom: {} }); syncColors(); });
  app.querySelectorAll('input[type="color"][data-key]').forEach(input => input.oninput = () => {
    const look = getLook(); setLook({ ...look, custom: { ...look.custom, [input.dataset.key]: input.value } }); syncColors();
  });
  $('#colors-reset').onclick = () => { setLook({ ...getLook(), preset: 'standard', custom: {} }); syncColors(); };
  syncColors();

  // Logo
  let pendingImage = false;
  const syncLogo = () => {
    const cfg = getLogo(), type = pendingImage ? 'image' : cfg.type === 'text' ? 'text' : cfg.type === 'image' && cfg.img ? 'image' : 'default';
    app.querySelectorAll('input[name="logo-type"]').forEach(r => { r.checked = r.value === type; });
    $('#logo-text-box').hidden = type !== 'text'; $('#logo-image-box').hidden = type !== 'image';
    if (type === 'text') { $('#logo-text').value = cfg.text || ''; $('#logo-bg').value = cfg.bg || '#2f6fed'; $('#logo-fg').value = cfg.fg || '#ffffff'; }
    app.querySelector('.big-logo').src = logoSmall();
  };
  app.querySelectorAll('input[name="logo-type"]').forEach(radio => radio.onchange = () => {
    pendingImage = radio.value === 'image';
    if (radio.value === 'default') setLogo({ type: 'default' });
    else if (radio.value === 'text') { const old = getLogo(); setLogo({ type: 'text', text: old.type === 'text' ? old.text : 'FR', bg: old.bg || effectiveColors(getLook()).colors.acc, fg: old.fg || '#ffffff' }); }
    syncLogo();
  });
  const updateText = () => { setLogo({ type: 'text', text: $('#logo-text').value, bg: $('#logo-bg').value, fg: $('#logo-fg').value }); $('.big-logo').src = logoSmall(); };
  ['#logo-text', '#logo-bg', '#logo-fg'].forEach(s => $(s).oninput = updateText);
  $('#logo-file').onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const ok = setLogo({ type: 'image', img: await logoFromFile(file) });
      if (!ok) { setLogo({ type: 'default' }); alert('Das Bild ist zu groß für den Browser-Speicher. Nimm ein kleineres Bild.'); }
      pendingImage = false;
    } catch (e) { alert(e.message); }
    syncLogo();
  };
  syncLogo();

  // Anzeige
  $('#img').checked = opt.img !== false; $('#big').checked = Boolean(opt.big);
  const setDisplay = () => {
    opt = { ...opt, img: $('#img').checked, big: $('#big').checked };
    LS.set('vk:opt', opt); document.documentElement.classList.toggle('big', opt.big);
  };
  $('#img').onchange = setDisplay; $('#big').onchange = setDisplay;

  // Lernen
  $('#goal').value = String(goalToday()); $('#endless').checked = endlessOn();
  $('#typing').checked = Boolean(opt.typing); $('#auto').checked = Boolean(opt.auto); $('#retype').checked = Boolean(opt.retype);
  $('#conj-pres').checked = opt.conjPres !== false; $('#conj-pc').checked = opt.conjPc !== false;
  $('#keys-off').checked = Boolean(opt.keysOff); $('#keymap').value = opt.keymap === 'alt' ? 'alt' : 'std'; $('#keys-input').checked = Boolean(opt.keysInInput);
  const setLearn = () => {
    opt = { ...opt, goal: Number($('#goal').value), endless: $('#endless').checked, typing: $('#typing').checked, auto: $('#auto').checked, retype: $('#retype').checked,
      conjPres: $('#conj-pres').checked, conjPc: $('#conj-pc').checked, keysOff: $('#keys-off').checked, keymap: $('#keymap').value, keysInInput: $('#keys-input').checked };
    LS.set('vk:opt', opt);
  };
  ['#goal', '#endless', '#typing', '#auto', '#retype', '#conj-pres', '#conj-pc', '#keys-off', '#keymap', '#keys-input'].forEach(sel => { $(sel).onchange = setLearn; });

  // Installation
  const bindInstall = () => {
    const now = $('#install-now');
    if (now) now.onclick = async () => {
      if (!installEvent) return;
      installEvent.prompt();
      try { await installEvent.userChoice; } catch { /* egal */ }
      installEvent = null; now.hidden = true;
    };
    const copy = $('#copy-link');
    if (copy) copy.onclick = async () => {
      const url = new URL('./', location.href).href, note = $('#install-note');
      try { await navigator.clipboard.writeText(url); note.textContent = 'Link kopiert: ' + url; }
      catch { note.textContent = 'Zum Kopieren markieren: ' + url; }
    };
  };
  bindInstall();

  // Offline-Speicher
  if (SW_OK) {
    const status = $('#offline-status'), storage = $('#offline-storage'), saveButtons = [$('#offline-save'), $('#offline-save-all')];
    $('#offline-box').hidden = false;
    const refresh = async () => {
      try {
        const n = (await (await caches.open(MEDIA_CACHE)).keys()).length;
        status.textContent = n ? `Offline gespeichert: ${n} Audio-/Bilddateien.`
          : 'Noch nichts offline gespeichert. Wähle Lektionen aus und speichere sie, dann funktionieren Audio und Bilder auch ohne Internet.';
        const estimate = await navigator.storage?.estimate?.();
        storage.textContent = estimate && estimate.usage ? `Belegter Speicher dieser App: ${fmtMb(estimate.usage)}.` : '';
      } catch { status.textContent = ''; }
    };
    refresh();
    const saveDirs = async dirs => {
      if (!dirs.length) { status.textContent = 'Wähle zuerst mindestens eine Lektion aus.'; return; }
      saveButtons.forEach(b => { b.disabled = true; });
      try {
        await Promise.all(dirs.map(d => load(tables.find(t => t.dir === d))));
        try { await navigator.storage?.persist?.(); } catch { /* optional */ }
        const r = await saveOffline(dirs, (i, n) => { status.textContent = `Speichere … ${i}/${n}`; });
        const savedDirs = new Set(LS.get(OFFLINE_SAVED_KEY, []));
        dirs.forEach(d => savedDirs.add(d));
        LS.set(OFFLINE_SAVED_KEY, [...savedDirs]);
        const allDirs = tables.map(t => t.dir);
        if (!Array.isArray(LS.get(OFFLINE_KNOWN_KEY, null)) || (dirs.length === allDirs.length && allDirs.every(d => dirs.includes(d)))) {
          LS.set(OFFLINE_KNOWN_KEY, tables.map(offlineTableKey));
        }
        await refresh();
        if (r.failed) status.textContent += ` ${r.failed} Datei(en) fehlen oder konnten nicht geladen werden.`;
      } catch (e) { status.textContent = `Speichern fehlgeschlagen: ${e.message}`; }
      finally { saveButtons.forEach(b => { b.disabled = false; }); }
    };
    $('#offline-save').onclick = () => saveDirs([...sel]);
    $('#offline-save-all').onclick = () => saveDirs(tables.map(t => t.dir));
    $('#offline-clear').onclick = async () => {
      if (!confirm('Offline gespeicherte Audio- und Bilddateien löschen?')) return;
      await caches.delete(MEDIA_CACHE);
      LS.set(OFFLINE_SAVED_KEY, []);
      LS.set(OFFLINE_KNOWN_KEY, tables.map(offlineTableKey));
      refresh();
    };
  } else $('#offline-unavailable').hidden = false;

  // Fortschritt und Daten
  $('#reload').onclick = async () => {
    const button = $('#reload'); button.disabled = true;
    try {
      tables = await discover(true);
      sel = new Set([...sel].filter(d => tables.some(t => t.dir === d)));
      const failures = await loadAllTables(true);
      LS.set(INITIAL_LOAD_KEY, failures.length === 0);
    }
    catch (e) { console.error(e); }
    finally { button.disabled = false; }
  };
  $('#reset').onclick = () => {
    if (!sel.size || !confirm('Fortschritt der ausgewählten Tabellen zurücksetzen?')) return;
    for (const k of Object.keys(P)) if (sel.has(k.split('::')[0])) delete P[k];
    save();
  };
  // Fortschritt sichern bzw. auf einem anderen Gerät einspielen (Daten liegen sonst nur in diesem Browser)
  $('#export').onclick = () => {
    const data = { app: 'vokabelkasten', version: 1, exported: new Date().toISOString(), progress: P };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `vokabelkasten-fortschritt-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('#import').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse((await file.text()).replace(/^﻿/, ''));
      const incoming = data && data.progress;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Keine gültige Fortschrittsdatei.');
      const valid = Object.entries(incoming).filter(([id, s]) => typeof id === 'string' && id.includes('::') && s
        && Number.isInteger(s.b) && s.b >= 1 && s.b <= 5 && Number.isFinite(s.d));
      if (!valid.length) throw new Error('Die Datei enthält keinen verwertbaren Fortschritt.');
      if (!confirm(`${valid.length} Karten aus der Datei übernehmen? Bei Überschneidungen gilt der höhere Kasten.`)) return;
      for (const [id, s] of valid) {
        const cur = P[id];
        if (!cur || s.b > cur.b || (s.b === cur.b && s.d > cur.d)) {
          P[id] = { b: s.b, d: s.d, w: Number.isInteger(s.w) && s.w > 0 ? Math.min(s.w, 99) : 0 };
        }
      }
      save();
    } catch (e) { alert(`Import fehlgeschlagen: ${e.message}`); }
  };

  $('#back-home').onclick = leaveScreen;
  bindUpdateSection(app);
  window.scrollTo(0, 0);
}
