// ---- Updates: neue Version erkennen und offline gespeicherte Inhalte auffrischen ------------------------
// Die Veröffentlichung legt eine version.json ab ({"version": "<Commit>", "built": "<Zeit>"}). Die App vergleicht sie
//  (a) mit der Version, die beim Öffnen der Seite lief (lange offene App läuft sonst mit altem Code) und
//  (b) mit der Version, bei der die offline gespeicherten Audio-/Bilddateien zuletzt aufgefrischt wurden.
// Audio und Bilder liegen offline im Cache und werden von dort geliefert; ohne Auffrischen blieben geänderte Dateien alt.
// Lokal (ohne version.json) tut dieser Teil nichts.

const VERSION_KEY = 'vk:app-version';
const UPDATE_CHECK_MIN_MS = 10 * 60 * 1000;
let loadedVersion = null, remoteVersion = null, lastUpdateCheck = 0, updateBusy = false, updateDismissed = false;
const updateListeners = new Set();
const shortDate = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); };

async function fetchVersion() {
  try {
    const response = await fetch('version.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return data && data.version ? data : null;
  } catch { return null; }
}

async function hasOfflineContent() {
  if (!SW_OK) return false;
  try { return LS.get(OFFLINE_SAVED_KEY, []).length > 0 || (await (await caches.open(MEDIA_CACHE)).keys()).length > 0; } catch { return false; }
}

// Gibt zurück: 'offline' | 'unknown' (keine version.json) | 'current' | 'available'
async function checkForUpdate() {
  lastUpdateCheck = Date.now();
  if (!navigator.onLine) return 'offline';
  const version = await fetchVersion();
  if (!version) return 'unknown';
  remoteVersion = version;
  if (!loadedVersion) loadedVersion = version.version;
  const offline = await hasOfflineContent();
  if (!offline) LS.set(VERSION_KEY, version.version); // ohne Offline-Inhalte gibt es nichts aufzufrischen
  const state = updateState();
  updateListeners.forEach(fn => fn(state));
  renderUpdateBanner(state);
  return state.available ? 'available' : 'current';
}

function updateState() {
  const remote = remoteVersion && remoteVersion.version;
  const codeStale = Boolean(remote && loadedVersion && remote !== loadedVersion);
  const offlineStale = Boolean(remote && LS.get(VERSION_KEY, null) !== remote && SW_OK && (LS.get(OFFLINE_SAVED_KEY, []).length > 0));
  return { codeStale, offlineStale, available: codeStale || offlineStale, version: remote || loadedVersion, built: remoteVersion && remoteVersion.built };
}

// Dateien, deren Kennung (ETag/Last-Modified) sich geändert hat, neu laden; fehlende Dateien nachladen; gelöschte entfernen.
async function refreshMedia(urls, progress = () => {}) {
  const cache = await caches.open(MEDIA_CACHE);
  let done = 0, changed = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const hit = await cache.match(url);
        let download = !hit;
        if (hit) {
          const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
          if (head.status === 404) { await cache.delete(url); changed++; }
          else if (head.ok) {
            const same = name => hit.headers.get(name) && hit.headers.get(name) === head.headers.get(name);
            download = !(same('etag') || same('last-modified'));
          }
        }
        if (download) {
          // Der Zusatz ?v= umgeht den Cache des Service Workers; gespeichert wird unter der normalen Adresse.
          const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store' });
          if (response.ok) { await cache.put(url, response); changed++; } else failed++;
        }
      } catch { failed++; }
      progress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OFFLINE_DOWNLOAD_CONCURRENCY, urls.length) }, worker));
  return { total: urls.length, changed, failed };
}

async function applyUpdate(progress = () => {}) {
  if (updateBusy) return { ok: false };
  updateBusy = true;
  try {
    const version = remoteVersion || await fetchVersion();
    let failed = 0;
    if (SW_OK) {
      try { const registration = await navigator.serviceWorker.getRegistration(); if (registration) await registration.update(); } catch { /* optional */ }
      const saved = LS.get(OFFLINE_SAVED_KEY, []).filter(d => tables.some(t => t.dir === d));
      if (saved.length || await hasOfflineContent()) {
        progress('Lade Lektionen …');
        await Promise.all(saved.map(d => load(tables.find(t => t.dir === d), true)));
        const cached = (await (await caches.open(MEDIA_CACHE)).keys()).map(r => r.url);
        const urls = [...new Set([...offlineUrlList(saved), ...cached])];
        const result = await refreshMedia(urls, (i, n) => progress(`Aktualisiere Audio und Bilder … ${i}/${n}`));
        failed = result.failed;
      }
    }
    if (failed) return { ok: false, failed };
    if (version) LS.set(VERSION_KEY, version.version);
    return { ok: true };
  } finally { updateBusy = false; }
}

// Hinweisleiste oben auf jeder Seite
function renderUpdateBanner(state) {
  let bar = document.getElementById('update-banner');
  if (!state.available || updateDismissed) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-banner'; bar.setAttribute('role', 'status');
    document.body.prepend(bar);
  }
  const what = state.codeStale ? 'Es gibt eine neue Version der App.' : 'Es gibt neue Inhalte. Deine offline gespeicherten Audio- und Bilddateien sind nicht mehr aktuell.';
  bar.innerHTML = `<span class="msg">🔄 ${esc(what)}</span><span class="acts"><button type="button" id="update-now" class="primary">Jetzt aktualisieren</button><button type="button" id="update-later">Später</button></span>`;
  bar.querySelector('#update-later').onclick = () => { updateDismissed = true; bar.remove(); };
  bar.querySelector('#update-now').onclick = async () => {
    const message = bar.querySelector('.msg'), buttons = bar.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    const result = await applyUpdate(text => { message.textContent = `🔄 ${text}`; }).catch(() => ({ ok: false }));
    if (result.ok) { message.textContent = '✓ Fertig. Die App wird neu geladen …'; setTimeout(() => location.reload(), 600); }
    else { message.textContent = `Das Aktualisieren hat nicht ganz geklappt${result.failed ? ` (${result.failed} Datei(en) fehlen)` : ''}. Bitte später nochmal versuchen.`; buttons.forEach(b => { b.disabled = false; }); }
  };
}

// Bereich in den Einstellungen: Version anzeigen, nach Updates suchen
function bindUpdateSection(root) {
  const box = root.querySelector('#sec-update');
  if (!box) return;
  const status = box.querySelector('#update-status'), button = box.querySelector('#update-check'), apply = box.querySelector('#update-apply');
  const paint = state => {
    const version = state.version ? `Version ${state.version.slice(0, 7)}${state.built ? ` (Stand ${shortDate(state.built)})` : ''}.` : 'Keine Versionsangabe auf dieser Seite.';
    status.textContent = version;
    apply.hidden = !state.available;
  };
  paint(updateState());
  updateListeners.add(paint);
  button.onclick = async () => {
    button.disabled = true; status.textContent = 'Suche nach Updates …';
    const result = await checkForUpdate();
    button.disabled = false;
    const state = updateState(); paint(state);
    if (result === 'offline') status.textContent = 'Du bist offline. Verbinde dich mit dem Internet und versuche es nochmal.';
    else if (result === 'unknown') status.textContent += ' Die Update-Prüfung funktioniert nur auf der veröffentlichten Seite.';
    else if (result === 'current') status.textContent += ' Du hast die neueste Version.';
    else status.textContent += ' Ein Update ist verfügbar.';
  };
  apply.onclick = async () => {
    updateDismissed = false; apply.disabled = true; button.disabled = true;
    const result = await applyUpdate(text => { status.textContent = text; }).catch(() => ({ ok: false }));
    if (result.ok) { status.textContent = 'Fertig. Die App wird neu geladen …'; setTimeout(() => location.reload(), 600); }
    else { status.textContent = `Das Aktualisieren hat nicht ganz geklappt${result.failed ? ` (${result.failed} Datei(en) fehlen)` : ''}. Bitte später nochmal versuchen.`; apply.disabled = false; button.disabled = false; }
  };
}

// Prüfen: kurz nach dem Start, beim Zurückkehren zur App, bei wieder vorhandenem Internet
setTimeout(() => checkForUpdate().catch(() => {}), 1500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > UPDATE_CHECK_MIN_MS) checkForUpdate().catch(() => {});
});
window.addEventListener('online', () => { checkForUpdate().catch(() => {}); });
