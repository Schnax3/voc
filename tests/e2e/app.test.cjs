'use strict';
/*
 * Browser-Tests für den Vokabelkasten (Playwright + lokaler Server, kein Internet nötig).
 *
 * Lokal:   npm install --no-save playwright && npx playwright install chromium && node tests/e2e/app.test.cjs
 * In CI:   siehe .github/workflows/tests.yml
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.csv': 'text/csv',
};

// Gleiche Formel wie in index.html (ID einer Karte = Ordner::hash(französisch|deutsch))
const hash = s => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, ''));
const cardId = (dir, e) => `${dir}::${hash(e.french + '|' + e.german)}`;

function startServer() {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('nicht gefunden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => { sockets.forEach(s => s.destroy()); server.close(done); }),
  })));
}

async function openApp(browser, base, { query = '', seed = {}, waitRows = true } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const stats = { gtm: 0, api: 0, indexJson: 0, errors: [] };
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname.includes('googletagmanager')) { stats.gtm++; return route.abort(); }
    if (u.hostname === 'api.github.com') { stats.api++; return route.abort(); }
    if (u.pathname.endsWith('/index.json')) stats.indexJson++;
    return route.continue();
  });
  await context.addInitScript(([values]) => {
    window.__spoken = [];
    if (window.speechSynthesis) speechSynthesis.speak = u => window.__spoken.push(u.text);
    if (localStorage.getItem('__seeded')) return;
    localStorage.setItem('__seeded', '1');
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, JSON.stringify(v));
  }, [seed]);
  const page = await context.newPage();
  page.on('pageerror', e => stats.errors.push(e.message));
  await page.goto(`${base}/${query}`);
  if (waitRows) await page.waitForSelector('.row');
  return { context, page, stats };
}

const storage = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
const appKeys = page => page.evaluate(() => Object.keys(localStorage).filter(k => k !== '__seeded'));

// Lerneinstellungen liegen unter ⚙ Einstellungen: öffnen, ändern, zurück zur Startseite
const setLearn = async (page, change) => {
  await page.click('#settings'); await page.waitForSelector('#sec-learn');
  await change(page);
  await page.click('#back-home'); await page.waitForSelector('#go');
};
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Lektionsliste kommt aus index.json, nicht aus der GitHub-API', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base);
  const index = readJson('index.json');
  assert.equal(await page.locator('.row').count(), index.tables.length);
  assert.ok(stats.indexJson >= 1, 'index.json wurde nicht geladen');
  assert.equal(stats.api, 0, 'die GitHub-API darf nicht gebraucht werden');
  const titles = await page.locator('.row b').allTextContents();
  assert.ok(titles.includes('Teil A') && titles.includes('Tu te rappelles'), `Anzeigename fehlt: ${titles}`);
  const groups = await page.locator('.grp h2').allTextContents();
  assert.deepEqual(groups, ['Dec2 · U7', 'Dec3 · U1', 'Dec3 · U2', 'Übungen'], 'Lektionen sind nach Einheit gruppiert');
  assert.deepEqual(stats.errors, []);
  await context.close();
});

test('Fällt index.json aus, springt die GitHub-API als Ersatz ein', async ({ browser, base }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let apiCalls = 0;
  await context.route('**/index.json', route => route.fulfill({ status: 404, body: 'x' }));
  await context.route('https://api.github.com/**', route => {
    apiCalls++;
    route.fulfill({ json: { tree: [{ type: 'blob', path: 'lektionen/dec3-u1a/database-5.json' }, { type: 'blob', path: 'index.json' }] } });
  });
  await page.goto(`${base}/`);
  await page.waitForSelector('.row');
  assert.ok(apiCalls >= 1);
  assert.equal(await page.locator('.row').count(), 1);
  await context.close();
});

test('Testmodus ?env=dev: Hinweisleiste, getrennter Speicher, keine Statistik', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base, { query: '?env=dev' });
  assert.ok(await page.locator('#devbar').isVisible());
  assert.ok((await page.title()).startsWith('TEST'));
  assert.equal(await page.locator('#consent').isVisible(), false);
  await page.locator('.row input').first().click();
  const keys = await appKeys(page);
  assert.ok(keys.length > 0 && keys.every(k => k.startsWith('dev:')), `Schlüssel ohne dev:-Präfix: ${keys}`);
  assert.equal(stats.gtm, 0);
  await context.close();
});

test('Google Analytics lädt nur nach Einwilligung', async ({ browser, base }) => {
  const a = await openApp(browser, base);
  assert.ok(await a.page.locator('#consent').isVisible(), 'Hinweisleiste fehlt');
  assert.equal(a.stats.gtm, 0, 'vor der Entscheidung darf nichts geladen werden');
  await a.page.click('#consent-no');
  await a.page.reload(); await a.page.waitForSelector('.row');
  assert.equal(a.stats.gtm, 0, 'nach "Ablehnen" darf nichts geladen werden');
  assert.equal(await a.page.locator('#consent').isVisible(), false);
  await a.context.close();

  const b = await openApp(browser, base);
  await b.page.click('#consent-yes');
  await b.page.waitForTimeout(300);
  assert.ok(b.stats.gtm >= 1, 'nach "Erlauben" muss das Skript angefragt werden');
  await b.context.close();
});

test('Fortschritt bleibt bei korrigierten Karten erhalten', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const card = db.find(e => e.french.includes('plus que lui'));
  assert.ok(card, 'korrigierte Karte fehlt');
  const oldKey = `lektionen/dec3-u2-a::${hash(card.french.replace('plus que lui', '>plusieurs que lui') + '|' + card.german)}`;
  const { context, page } = await openApp(browser, base, {
    seed: { 'vk:progress': { [oldKey]: { b: 3, d: 77, w: 2 } }, 'vk:sel': ['lektionen/dec3-u2-a'] },
  });
  const newKey = cardId('lektionen/dec3-u2-a', card);
  await page.waitForFunction(k => k in (JSON.parse(localStorage.getItem('vk:progress')) || {}), newKey);
  const progress = await storage(page, 'vk:progress');
  assert.deepEqual(progress[newKey], { b: 3, d: 77, w: 2 });
  assert.equal(oldKey in progress, false);
  await context.close();
});

test('Fortschritt zieht bei umbenannten Ordnern und geändertem Liaison-Zeichen um', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const card = db.find(e => e.french.includes('‿'));
  assert.ok(card, 'Testkarte mit ‿ fehlt');
  const oldFrench = card.french.split('‿').join('⁔'); // früher: ⁔
  const oldKey = `Dec3-U2-A::${hash(oldFrench + '|' + card.german)}`;
  const otherKey = `U1A (AUDIO)::${hash('x|y')}`;
  const preMoveKey = `dec3-u1b::${hash('p|q')}`; // Name vor dem Umzug nach lektionen/
  const { context, page } = await openApp(browser, base, {
    seed: { 'vk:progress': { [oldKey]: { b: 4, d: 999, w: 1 }, [otherKey]: { b: 3, d: 5 }, [preMoveKey]: { b: 2, d: 7 } }, 'vk:sel': ['Dec3-U2-A'] },
  });
  const newKey = cardId('lektionen/dec3-u2-a', card);
  await page.waitForFunction(k => k in (JSON.parse(localStorage.getItem('vk:progress')) || {}), newKey);
  const progress = await storage(page, 'vk:progress');
  assert.deepEqual(progress[newKey], { b: 4, d: 999, w: 1 });
  assert.equal(oldKey in progress, false, 'alte ID muss entfernt sein');
  assert.deepEqual(progress[`lektionen/dec3-u1a::${hash('x|y')}`], { b: 3, d: 5 });
  assert.equal(Object.keys(progress).some(k => k.startsWith('U1A (AUDIO)')), false);
  assert.deepEqual(progress[`lektionen/dec3-u1b::${hash('p|q')}`], { b: 2, d: 7 });
  assert.equal(Object.keys(progress).some(k => k.startsWith('dec3-u1b::')), false);
  assert.deepEqual(await storage(page, 'vk:sel'), ['lektionen/dec3-u2-a']);
  await context.close();
});

test('Schwierige Karten: Anzeige, Filter und Fehlerzähler', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const hardKey = cardId('lektionen/dec3-u2-a', db[0]), softKey = cardId('lektionen/dec3-u2-a', db[1]);
  const { context, page } = await openApp(browser, base, {
    seed: { 'vk:progress': { [hardKey]: { b: 1, d: 0, w: 2 }, [softKey]: { b: 2, d: 0, w: 1 } }, 'vk:sel': ['lektionen/dec3-u2-a'] },
  });
  const row = page.locator('.grp:has(h2:text-is("Dec3 · U2")) .row:has(b:text-is("Teil A"))');
  assert.match(await row.innerText(), /1 schwierig/);
  await page.check('#hard');
  assert.equal(await page.textContent('#go'), 'Starten (1 Karte)');
  await page.uncheck('#hard');

  // eine falsche Antwort erhöht den Zähler der Karte
  await page.click('#go'); await page.waitForSelector('#flip');
  await page.click('#flip'); await page.click('#no');
  const progress = await storage(page, 'vk:progress');
  const changed = Object.entries(progress).filter(([k, s]) => s.b === 1 && s.d <= Date.now() && ![hardKey, softKey].includes(k));
  assert.ok(Object.values(progress).some(s => s.w >= 1) && changed.length + 2 <= Object.keys(progress).length);
  await context.close();
});

test('Export und Import behalten den Fehlerzähler', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const key = cardId('lektionen/dec3-u2-a', db[0]);
  const a = await openApp(browser, base, { seed: { 'vk:progress': { [key]: { b: 3, d: 1234, w: 2 } } } });
  const [download] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#settings').then(() => a.page.click('#export'))]);
  // Playwright löscht Downloads beim Schließen des Kontexts: Kopie für den zweiten Browser anlegen
  const file = path.join(os.tmpdir(), `vk-export-${process.pid}.json`);
  fs.copyFileSync(await download.path(), file);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(exported.progress[key], { b: 3, d: 1234, w: 2 });
  await a.context.close();

  const b = await openApp(browser, base);
  b.page.on('dialog', d => d.accept());
  await b.page.click('#settings');
  await b.page.setInputFiles('#import-file', file);
  await b.page.waitForFunction(k => (JSON.parse(localStorage.getItem('vk:progress')) || {})[k], key);
  assert.deepEqual((await storage(b.page, 'vk:progress'))[key], { b: 3, d: 1234, w: 2 });
  await b.context.close();
  fs.rmSync(file, { force: true });
});

test('Fehlendes Audio: Sprachausgabe als Ersatz, kaputte Bilder verschwinden', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u1b3-verben'] } });
  await page.click('#go'); await page.waitForSelector('.card');
  await page.click('.spk');
  await page.waitForFunction(() => window.__spoken.length > 0);
  assert.equal(await page.locator('.card img').count(), 0, 'kaputte Bilder müssen ausgeblendet werden');
  await context.close();
});

test('Manifest, Icons und Datenschutzseite sind vorhanden', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  assert.equal(await page.locator('link[rel="manifest"]').count(), 1);
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.equal((await page.request.get(`${base}/${icon.src}`)).status(), 200, icon.src);
  assert.ok(await page.locator('#foot a[href="datenschutz.html"]').isVisible());
  await page.goto(`${base}/datenschutz.html`);
  assert.match(await page.textContent('h1'), /Datenschutzerklärung/);
  assert.match(await page.textContent('main'), /Google Analytics/);
  await context.close();
});

test('Offline: gespeicherte Lektion läuft ohne Server, nicht gespeicherte nicht', async ({ browser }) => {
  const server = await startServer();
  const { context, page } = await openApp(browser, server.base);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  await page.click('#consent-no'); // sonst liegt die Hinweisleiste über den unteren Schaltflächen
  await page.click('.grp:has(h2:text-is("Dec3 · U1")) .row:has(b:text-is("Teil A"))'); // lektionen/dec3-u1a (mit Audio), nicht "letztes Jahr"
  await page.click('#offline-setup');
  await page.waitForSelector('#sec-offline');
  await page.click('#offline-save');
  await page.waitForFunction(() => /Offline gespeichert: \d+/.test(document.querySelector('#offline-status').textContent), null, { timeout: 30000 });

  const audio = readJson('lektionen/dec3-u1a/database-5.json').find(e => e.audio).audio;
  const saved = `${server.base}/lektionen/dec3-u1a/${encodeURIComponent(audio)}`;
  const other = readJson('lektionen/dec2-u7a/database-4.json').find(e => e.audio).audio;
  const notSaved = `${server.base}/lektionen/dec2-u7a/${encodeURIComponent(other)}`;

  await server.close(); // ab jetzt gibt es kein Netz mehr
  await page.reload();
  await page.waitForSelector('.row', { timeout: 15000 });
  assert.equal(await page.locator('.row').count(), readJson('index.json').tables.length, 'App muss offline starten');

  const partial = await page.evaluate(async url => {
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    return { status: r.status, length: (await r.arrayBuffer()).byteLength };
  }, saved);
  assert.deepEqual(partial, { status: 206, length: 100 }, 'gespeichertes Audio muss Range-Anfragen beantworten');
  const missing = await page.evaluate(url => fetch(url).then(() => 'geladen', () => 'fehlgeschlagen'), notSaved);
  assert.equal(missing, 'fehlgeschlagen', 'nicht gespeicherte Medien dürfen offline nicht verfügbar sein');
  await context.close();
});

test('Startseite: Offline-Einrichtung nur ohne Download, Update für neue Lektionen', async ({ browser, base }) => {
  const fresh = await openApp(browser, base);
  await fresh.page.waitForFunction(() => !document.querySelector('#offline-actions').hidden);
  assert.ok(await fresh.page.locator('#offline-setup').isVisible());
  assert.equal(await fresh.page.locator('#offline-update').isVisible(), false);
  await fresh.context.close();

  const index = readJson('index.json');
  const knownTables = index.tables.slice(0, -1).map(t => `${t.dir}/${t.file}`);
  const prepared = await openApp(browser, base, {
    seed: {
      'vk:offline-saved:Schnax3/voc': ['lektionen/dec3-u1a'],
      'vk:offline-known:Schnax3/voc': knownTables,
    }
  });
  await prepared.page.waitForFunction(() => !document.querySelector('#offline-update').hidden);
  assert.equal(await prepared.page.locator('#offline-setup').isVisible(), false);
  assert.match(await prepared.page.textContent('#offline-update'), /1/);
  await prepared.page.click('#offline-update');
  await prepared.page.waitForFunction(() => document.querySelector('#offline-update').hidden);
  assert.ok((await storage(prepared.page, 'vk:offline-saved:Schnax3/voc')).includes('uebungen/passe-compose'));
  await prepared.context.close();
});

test('Startseite: Gruppen lassen sich komplett an- und abwählen', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  const group = page.locator('.grp:has(h2:text-is("Dec3 · U2"))');
  const total = await group.locator('.row').count();
  await group.locator('.lnk').click();
  await page.waitForFunction(n => document.querySelectorAll('.grp:nth-of-type(3) input:checked').length === n, total);
  assert.match(await group.locator('.grp-h .mut').innerText(), new RegExp(`${total} von ${total}`));
  assert.deepEqual((await storage(page, 'vk:sel')).sort(), ['lektionen/dec3-u2-a', 'lektionen/dec3-u2-de', 'lektionen/dec3-u2-rapp']);
  assert.equal(await group.locator('.lnk').innerText(), 'keine');
  await group.locator('.lnk').click();
  assert.deepEqual(await storage(page, 'vk:sel'), []);
  await context.close();
});

test('Übung Passé composé: Verb sehen, Deutsch aufdecken, eintippen, Lösung zeigen', async ({ browser, base }) => {
  const data = readJson('uebungen/passe-compose/uebung.json');
  const first = data[0];
  const { context, page, stats } = await openApp(browser, base, { seed: { 'vk:sel': ['uebungen/passe-compose'] } });
  const row = page.locator('.row', { hasText: 'Les formes du passé composé' });
  assert.match(await row.innerText(), new RegExp(`${data.length} Karten`));
  assert.equal(await page.textContent('#go'), `Starten (${data.length} Karten)`);

  // Karte mit bekannter Lösung nach vorn holen: nur diese eine Karte als "schwierig" markieren
  await page.evaluate(id => localStorage.setItem('vk:progress', JSON.stringify({ [id]: { b: 1, d: 0, w: 2 } })), cardId('uebungen/passe-compose', first));
  await page.reload(); await page.waitForSelector('.row');
  await page.check('#hard');
  assert.equal(await page.textContent('#go'), 'Starten (1 Karte)');
  await page.click('#go');
  await page.waitForSelector('#typed-answer');
  assert.match(await page.textContent('.q'), new RegExp(first.french));
  assert.doesNotMatch(await page.innerText('#card'), new RegExp(first.german), 'Deutsch darf erst auf Wunsch erscheinen');
  assert.doesNotMatch(await page.innerText('#card'), /suis venu/, 'Lösung darf noch nicht sichtbar sein');
  await page.click('#hint');
  assert.match(await page.innerText('.hintde'), new RegExp(first.german));

  // "(e)" darf als "e" geschrieben werden, Großschreibung und Apostroph-Form sind egal
  await page.fill('#typed-answer', 'Je suis venue');
  await page.click('#flip');
  assert.match(await page.innerText('#card'), /je suis venu\(e\)/);
  assert.match(await page.innerText('#card'), /Deine Eingabe stimmt/);
  await page.click('#yes');
  await page.waitForSelector('h1');
  const progress = await storage(page, 'vk:progress');
  assert.equal(progress[cardId('uebungen/passe-compose', first)].b, 2);
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();

  // falsche Eingabe wird als Abweichung gezeigt
  const second = await openApp(browser, base, { seed: { 'vk:sel': ['uebungen/passe-compose'], 'vk:opt': { dir: 'fr', all: false, img: true } } });
  await second.page.click('#go'); await second.page.waitForSelector('#typed-answer');
  await second.page.fill('#typed-answer', 'falsch'); await second.page.click('#flip');
  assert.match(await second.page.innerText('#card'), /weicht ab: falsch/);
  await second.context.close();
});

test('Abstand zwischen Wort und Audio-Button (Frage und Antwort)', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:opt': { dir: 'de', all: true, img: false } } });
  await page.click('#go'); await page.waitForSelector('#flip');
  await page.click('#flip'); await page.waitForSelector('.a .spk');
  for (const sel of ['.a .spk']) {
    assert.ok(await page.$eval(sel, el => parseFloat(getComputedStyle(el).marginLeft)) >= 20, `${sel} braucht Abstand`);
  }
  await page.click('#yes');
  await context.close();
  const fr = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:opt': { dir: 'fr', all: true, img: false } } });
  await fr.page.click('#go'); await fr.page.waitForSelector('.q .spk');
  assert.ok(await fr.page.$eval('.q .spk', el => parseFloat(getComputedStyle(el).marginLeft)) >= 20);
  await fr.context.close();
});

test('Runde: Fortschrittsbalken, Tippen zum Aufdecken, Zurück-Knopf und Zusammenfassung', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u1-revision-negation'], 'vk:opt': { dir: 'fr', all: true, img: false } } });
  assert.equal(await page.textContent('#go'), 'Starten (5 Karten)');
  await page.click('#go'); await page.waitForSelector('#flip');
  assert.equal(await page.getAttribute('.progress', 'aria-valuenow'), '0');
  assert.equal(await page.$('#undo'), null, 'Zurück erst nach einer Antwort');
  await page.click('.q'); // Tippen auf die Karte deckt auf
  await page.waitForSelector('#yes');
  await page.click('#no');
  await page.waitForSelector('#undo');
  assert.match(await page.innerText('.top .mut'), /noch 5/, 'falsche Karte kommt wieder');
  await page.click('#undo');
  assert.match(await page.innerText('.top .mut'), /noch 5/);
  assert.deepEqual(await storage(page, 'vk:progress'), {}, 'Zurück stellt den Fortschritt wieder her');
  await page.click('#flip'); await page.click('#no'); // erster Fehler zählt
  for (let i = 0; i < 20 && !(await page.$('h1')); i++) { await page.click('#flip'); await page.click('#yes'); }
  assert.match(await page.innerText('h1'), /Runde geschafft/);
  assert.match(await page.innerText('.big'), /4 von 5 beim ersten Mal richtig/);
  assert.equal(await page.locator('.miss li').count(), 1);
  assert.match(await page.innerText('#again'), /Weiter lernen \(5 Karten\)/);
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();
});

test('Startseite: Hinweis, warum nichts gestartet werden kann', async ({ browser, base }) => {
  const none = await openApp(browser, base);
  assert.equal(await none.page.isDisabled('#go'), true);
  assert.match(await none.page.innerText('#go-hint'), /mindestens eine Lektion/);
  await none.context.close();
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const later = Date.now() + 1e10, progress = Object.fromEntries(db.map(c => [cardId('lektionen/dec3-u2-a', c), { b: 2, d: later }]));
  const due = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:progress': progress, 'vk:opt': { dir: 'fr', all: false, img: false } } });
  // Nichts fällig: mit „Immer weiterlernen“ gibt es trotzdem eine Wiederholung
  assert.equal(await due.page.isDisabled('#go'), false);
  assert.match(await due.page.innerText('#go'), /Weiter üben/);
  assert.match(await due.page.innerText('#go-hint'), /nichts mehr fällig/);
  await setLearn(due.page, p => p.uncheck('#endless'));
  assert.equal(await due.page.isDisabled('#go'), true);
  assert.match(await due.page.innerText('#go-hint'), /Heute ist nichts fällig/);
  await due.page.check('#all');
  assert.equal(await due.page.isDisabled('#go'), false);
  assert.equal(await due.page.innerText('#go-hint'), '');
  await due.context.close();
});

test('Aussprache automatisch, große Schrift, Tageszähler und Zurück-Taste', async ({ browser, base }) => {
  const data = readJson('uebungen/passe-compose/uebung.json');
  const { context, page, stats } = await openApp(browser, base, { seed: { 'vk:sel': ['uebungen/passe-compose'], 'vk:opt': { dir: 'fr', all: true, img: false, auto: true, big: true } } });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('big')), true, 'Große Schrift');
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  const verb = await page.$eval('.q', el => el.firstChild.textContent.trim());
  assert.deepEqual(await page.evaluate(() => window.__spoken), [verb], 'Verb wird automatisch gesprochen');
  await page.click('#hint');
  assert.equal((await page.evaluate(() => window.__spoken)).length, 1, 'Hinweis spricht nicht nochmal');
  await page.click('#flip');
  const spoken = await page.evaluate(() => window.__spoken);
  assert.deepEqual(spoken, [verb, data.find(e => e.french === verb).answer], 'Lösung wird beim Aufdecken gesprochen');
  await page.click('#yes');
  await page.click('#end'); // über die Zurück-Funktion des Browsers
  await page.waitForSelector('#go');
  assert.equal(await page.innerText('#today'), 'Heute geübt: 1 von 20 Karten');
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.goBack(); // Zurück-Taste beendet nur die Runde
  await page.waitForSelector('#go');
  assert.equal(await page.$('#typed-answer'), null);
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();

  const key = daysAgo => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const streak = await openApp(browser, base, { seed: { 'vk:stats': { [key(0)]: 2, [key(1)]: 5, [key(2)]: 3, [key(4)]: 9 } } });
  assert.equal(await streak.page.innerText('#today'), 'Heute geübt: 2 von 20 Karten · 3 Tage in Folge 🔥');
  await streak.context.close();
  const yesterday = await openApp(browser, base, { seed: { 'vk:stats': { [key(1)]: 5 } } });
  assert.equal(await yesterday.page.innerText('#today'), 'Heute geübt: 0 von 20 Karten', 'eine Serie von einem Tag wird nicht beworben');
  await yesterday.context.close();
});

test('Leertaste deckt die Antwort auf', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:opt': { dir: 'fr', all: true, img: false, conjPres: false, conjPc: false } } });
  await page.click('#go'); await page.waitForSelector('#flip');
  await page.keyboard.press('Space');
  await page.waitForSelector('#yes');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#flip');
  await context.close();
});

test('Falsch getippt: Fenster, bis die Vokabel einmal richtig geschrieben ist (Einstellung)', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const seed = extra => ({ 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:opt': { dir: 'de', all: true, img: false, conjPres: false, conjPc: false, ...extra } });
  const frontOf = async page => (await page.innerText('.q')).replace('🔊', '').trim();
  const solutionOf = async page => { const front = await frontOf(page); return db.find(e => e.german === front).vocabulary; };
  // Aus: kein Eingabefeld, kein Fenster
  let { context, page } = await openApp(browser, base, { seed: seed({}) });
  await page.click('#go'); await page.waitForSelector('#flip');
  assert.equal(await page.$('#typed-answer'), null);
  await context.close();
  // Einstellung lässt sich auf der Seite „Einstellungen“ einschalten
  ({ context, page } = await openApp(browser, base, {}));
  await setLearn(page, p => p.check('#retype'));
  assert.equal((await storage(page, 'vk:opt')).retype, true);
  await context.close();
  // An: richtig getippt -> kein Fenster; falsch -> Fenster, wiederholen bis richtig
  ({ context, page } = await openApp(browser, base, { seed: seed({ retype: true }) }));
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.fill('#typed-answer', (await solutionOf(page)).toUpperCase());
  await page.click('#flip'); await page.waitForSelector('#yes');
  assert.equal(await page.$('#retype'), null, 'richtige Eingabe öffnet kein Fenster');
  await page.click('#yes');
  await page.waitForSelector('#typed-answer');
  const solution = await solutionOf(page);
  await page.fill('#typed-answer', 'xyz');
  await page.click('#flip');
  await page.waitForSelector('#retype');
  assert.match(await page.innerText('#retype'), new RegExp(solution.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await page.fill('#rt-input', 'immer noch falsch'); await page.keyboard.press('Enter');
  assert.match(await page.innerText('#rt-msg'), /Versuch 1/);
  assert.notEqual(await page.$('#retype'), null, 'bleibt offen, bis es stimmt');
  await page.keyboard.press('ArrowRight');   // Kürzel wirken im Fenster nicht auf die Karte
  assert.notEqual(await page.$('#retype'), null);
  await page.fill('#rt-input', solution); await page.keyboard.press('Enter');
  await page.waitForSelector('#retype', { state: 'detached' });
  await page.waitForSelector('#yes');
  await context.close();
  // Überspringen schließt das Fenster
  ({ context, page } = await openApp(browser, base, { seed: seed({ retype: true }) }));
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.fill('#typed-answer', 'xyz'); await page.click('#flip');
  await page.waitForSelector('#retype'); await page.click('#rt-skip');
  await page.waitForSelector('#retype', { state: 'detached' });
  await context.close();
});

test('Tastenkürzel: im Eingabefeld normal tippen; als Option auch dort Kürzel, auch mit anderer Belegung', async ({ browser, base }) => {
  const seed = keys => ({ 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:opt': { dir: 'fr', all: true, img: false, typing: true, conjPres: false, conjPc: false, ...keys } });
  // Standard: Leertaste und P erscheinen im Feld, die Karte bleibt zu
  let { context, page } = await openApp(browser, base, { seed: seed({}) });
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.keyboard.type('un p a');
  assert.equal(await page.inputValue('#typed-answer'), 'un p a');
  assert.equal(await page.$('#yes'), null, 'Karte ist noch zu');
  // Pfeiltasten und Tastenkombinationen gelten im Eingabefeld immer: ↓ deckt auf, → = gewusst
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('#yes');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !document.querySelector('#yes'));
  await context.close();
  // Option „auch im Eingabefeld“ mit alternativer Belegung: P deckt auf und wird nicht getippt
  ({ context, page } = await openApp(browser, base, { seed: seed({ keymap: 'alt', keysInInput: true }) }));
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.keyboard.type('x');
  await page.keyboard.press('p');
  await page.waitForSelector('#yes');
  assert.equal(await page.inputValue('#typed-answer'), 'x');
  assert.equal(await page.evaluate(() => keyAudioName()), 'Leertaste');
  await context.close();
  // Standardbelegung mit Option: Leertaste deckt im Feld auf
  ({ context, page } = await openApp(browser, base, { seed: seed({ keysInInput: true }) }));
  await page.click('#go'); await page.waitForSelector('#typed-answer');
  await page.keyboard.press('Space');
  await page.waitForSelector('#yes');
  assert.equal(await page.inputValue('#typed-answer'), '');
  await context.close();
  // Einstellung auf der Startseite wird gespeichert
  ({ context, page } = await openApp(browser, base, {}));
  assert.equal(await page.$('#keymap'), null, 'Tastenkürzel gehören nicht auf die Startseite');
  await setLearn(page, async p => { await p.selectOption('#keymap', 'alt'); await p.check('#keys-input'); });
  const opt = await page.evaluate(() => JSON.parse(localStorage.getItem('vk:opt') || localStorage.getItem('dev:vk:opt')));
  assert.equal(opt.keymap, 'alt'); assert.equal(opt.keysInInput, true);
  await context.close();
});

test('Einstellungen: Farbvorlagen, eigene Farben, Modus und Zurücksetzen', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base);
  const css = name => page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  assert.equal(await css('--acc'), '#2f6fed');
  await page.click('#settings');
  await page.waitForSelector('#presets');
  await page.selectOption('#mode', 'dark');
  assert.equal(await theme(), 'dark');
  await page.selectOption('#mode', 'light');
  await page.click('.chip[data-preset="forest"]');
  assert.equal(await css('--acc'), '#2e7d3a');
  assert.equal(await page.isDisabled('#mode'), false, 'Modus bleibt auch mit Vorlage wählbar');
  await page.selectOption('#mode', 'dark');
  assert.equal(await theme(), 'dark');
  assert.notEqual(await css('--acc'), '#2e7d3a', 'Vorlage verwendet eine dunkle Farbvariante');
  await page.selectOption('#mode', 'auto');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await theme(), 'dark', 'automatische Vorlage folgt dem dunklen Gerätemodus');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.equal(await theme(), 'light', 'automatische Vorlage folgt dem hellen Gerätemodus');
  await page.selectOption('#mode', 'dark');
  await page.click('.chip[data-preset="night"]');
  assert.equal(await theme(), 'dark');
  await page.selectOption('#mode', 'light');
  // einzelne Farbe ändern: Akzent hell -> Schrift auf Knöpfen wird dunkel
  await page.evaluate(() => { const i = document.querySelector('input[data-key="acc"]'); i.value = '#ffe066'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await css('--acc'), '#ffe066');
  assert.equal(await css('--on-acc'), '#111111');
  // bleibt nach dem Neuladen
  await page.reload(); await page.waitForSelector('#go');
  assert.equal(await css('--acc'), '#ffe066');
  assert.equal(await theme(), 'light');
  await page.click('#settings'); await page.click('#colors-reset');
  assert.equal(await css('--acc'), '#2f6fed', 'Standard, Modus bleibt hell');
  await page.selectOption('#mode', 'dark');
  assert.equal(await css('--acc'), '#6b9bff');
  await page.selectOption('#mode', 'auto');
  assert.deepEqual((await storage(page, 'vk:look')), { mode: 'auto', preset: 'standard', custom: {} });
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();
  // alte Einstellung "Dunkles Design" wird übernommen
  const old = await openApp(browser, base, { seed: { 'vk:theme': 'dark' } });
  assert.equal(await old.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await old.context.close();
});

test('Einstellungen: Logo (Symbol, Standard) wirkt auf Kopf, Tab-Symbol und Manifest', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base);
  const href = sel => page.getAttribute(sel, 'href');
  assert.equal(await href('link[rel="apple-touch-icon"]'), 'icons/icon-180.png');
  await page.click('#settings'); await page.waitForSelector('#sec-logo');
  await page.check('input[name="logo-type"][value="text"]');
  await page.fill('#logo-text', '🇫🇷');
  assert.match(await href('link[rel="apple-touch-icon"]'), /^data:image\/png;base64,/);
  assert.match(await href('link[rel="icon"]'), /^data:image\/png/);
  assert.match(await href('link[rel="manifest"]'), /^blob:/);
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
  assert.equal(manifest.icons.length, 2); assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, new URL('./', await page.url()).href);
  await page.click('#back-home'); await page.waitForSelector('#go');
  assert.match(await page.getAttribute('.hdr img.logo', 'src'), /^data:image\/png/);
  // bleibt nach dem Neuladen; zurück auf Standard
  await page.reload(); await page.waitForSelector('#go');
  assert.match(await page.getAttribute('.hdr img.logo', 'src'), /^data:image\/png/);
  await page.click('#settings'); await page.check('input[name="logo-type"][value="default"]');
  assert.equal(await href('link[rel="manifest"]'), 'manifest.webmanifest');
  assert.equal(await page.getAttribute('.hdr img.logo, img.big-logo', 'src'), 'icons/icon-192.png');
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();
});

test('Einstellungen: Installationshilfe je Gerät, Anzeige-Optionen und Zurück-Taste', async ({ browser, base }) => {
  const ua = { ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36' };
  for (const [name, agent, expected] of [['ios', ua.ios, /Zum Home-Bildschirm/], ['android', ua.android, /App installieren/]]) {
    const context = await browser.newContext({ userAgent: agent });
    const page = await context.newPage();
    await page.goto(base + '/'); await page.waitForSelector('#settings');
    await page.click('#settings');
    assert.match(await page.innerText('#install-box'), expected, name);
    await context.close();
  }
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['lektionen/dec3-u2-a'] } });
  await page.click('#settings'); await page.waitForSelector('#sec-display');
  await page.uncheck('#img'); await page.check('#big');
  assert.deepEqual(await page.evaluate(() => [JSON.parse(localStorage.getItem('vk:opt')).img, JSON.parse(localStorage.getItem('vk:opt')).big, document.documentElement.classList.contains('big')]), [false, true, true]);
  await page.goBack(); // Zurück-Taste des Browsers verlässt die Einstellungen
  await page.waitForSelector('#go');
  assert.equal(await page.$('#sec-display'), null);
  // Rundenlänge
  await page.selectOption('#limit', '10'); await page.check('#all');
  assert.equal(await page.textContent('#go'), 'Starten (10 Karten)');
  await context.close();
});

test('Vorschlag ohne Endpunkt öffnet ein vorausgefülltes GitHub-Issue', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await context.route('**/feedback-config.json', route => route.fulfill({ json: { repo: 'o/r' } }));
  await page.click('#feedback-link');
  await page.waitForSelector('dialog#feedback[open]');
  assert.equal(await page.textContent('#fb-send'), 'Weiter zu GitHub');
  await page.fill('#fb-text', 'ab'); await page.click('#fb-send');
  assert.match(await page.textContent('#fb-status'), /mindestens/);
  await page.fill('#fb-text', 'Bitte mehr Übungen\nzu Verben');
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#fb-send')]);
  const url = popup.url();
  assert.ok(url.startsWith('https://github.com/o/r/issues/new?'), url);
  assert.ok(decodeURIComponent(url).includes('[Wunsch] Bitte mehr Übungen'));
  await context.close();
});

test('Vorschlag mit Endpunkt wird direkt gesendet, Spam-Falle und Pause greifen', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  const posts = [];
  await context.route('**/feedback-config.json', route => route.fulfill({ json: { endpoint: 'https://hook.test/x' } }));
  await context.route('https://hook.test/**', route => { posts.push(JSON.parse(route.request().postData())); return route.fulfill({ json: { ok: true }, headers: { 'access-control-allow-origin': '*' } }); });
  await page.click('#feedback-link');
  await page.waitForSelector('dialog#feedback[open]');
  await page.selectOption('#fb-type', 'fehler');
  await page.evaluate(() => { document.getElementById('fb-hp').value = 'bot'; });
  await page.fill('#fb-text', 'Ein Fehler beim Start'); await page.click('#fb-send');
  assert.equal(posts.length, 0);
  await page.evaluate(() => { document.getElementById('fb-hp').value = ''; });
  await page.click('#fb-send');
  await page.waitForFunction(() => /Danke/.test(document.getElementById('fb-status').textContent));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, '[Fehler] Ein Fehler beim Start');
  assert.deepEqual(posts[0].labels, ['vorschlag', 'bug']);
  await page.click('#fb-cancel'); await page.click('#feedback-link');
  await page.fill('#fb-text', 'Noch ein Vorschlag'); await page.click('#fb-send');
  assert.match(await page.textContent('#fb-status'), /warte/);
  assert.equal(posts.length, 1);
  await context.close();
});

test('Am Rundenende gibt es den Vorschlag-Knopf', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await page.click('.row >> nth=0'); await page.check('#all'); await page.selectOption('#limit', '10');
  await page.click('#go');
  for (let i = 0; i < 60 && !(await page.$('#suggest')); i++) {
    if (await page.$('#flip')) await page.click('#flip');
    if (await page.$('#yes')) await page.click('#yes');
  }
  await page.click('#suggest');
  await page.waitForSelector('dialog#feedback[open]');
  await context.close();
});

// Karten durchblättern, bis eine Verb-Karte mit Konjugationszeilen kommt (oder bis zu 80 Schritte)
async function untilConjugation(page, expected = true) {
  for (let i = 0; i < 80; i++) {
    if (await page.$('.crow')) return true;
    if (!(await page.$('#card'))) break;
    if (await page.$('#flip')) await page.click('#flip');
    if (await page.$('#yes')) await page.click('#yes');
  }
  return false;
}

test('Verb-Karten in den Lektionen lassen sich konjugieren', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base, { seed: { 'vk:opt': { dir: 'fr', all: true, img: false, limit: 0 } } });
  await page.click('.row:has-text("U1 Tu te rappelles"), .row:has-text("Tu te rappelles")');
  await page.click('#go');
  assert.ok(await untilConjugation(page), 'keine Verb-Karte gefunden');
  assert.equal(await page.locator('h3').count(), 2);
  assert.ok((await page.locator('.crow input').count()) >= 2);
  // Enter springt zur nächsten Zeile, nach der letzten wird aufgedeckt
  const count = await page.locator('.crow input').count();
  await page.locator('.crow input').first().fill('xxx');
  for (let i = 0; i < count; i++) await page.keyboard.press('Enter');
  await page.waitForSelector('.crow.bad');
  assert.ok(await page.$('.crow .sol'));
  assert.match(await page.textContent('.card'), /Formen richtig/);
  await context.close();
});

test('Verben konjugieren: Schalter für die Zeiten, (e) und (s) werden erkannt', async ({ browser, base }) => {
  const seed = { 'vk:opt': { dir: 'fr', all: true, img: false, limit: 0, conjPres: false, conjPc: true } };
  const { context, page } = await openApp(browser, base, { seed });
  await page.click('.row:has-text("Tu te rappelles")');
  await page.click('#go');
  assert.ok(await untilConjugation(page));
  assert.equal(await page.locator('h3:has-text("Présent")').count(), 0);
  assert.equal(await page.locator('h3:has-text("Passé composé")').count(), 1);
  const checks = await page.evaluate(() => [checkPc('venus', 'venu(e)s'), checkPc('VENUES', 'venu(e)s'), checkPc('venu', 'venu(e)(s)'), checkPc('venues', 'venu(e)(s)'), checkPc('venue', 'venu(e)s')]);
  assert.deepEqual(checks, [true, true, true, true, false]);
  await page.click('#end');
  await page.waitForSelector('#go');
  await setLearn(page, p => p.uncheck('#conj-pc'));
  await page.click('#go');
  await page.waitForSelector('#card');
  for (let i = 0; i < 40; i++) {
    assert.equal(await page.locator('.crow').count(), 0); // beide aus: nur Grundform
    if (await page.$('#flip')) await page.click('#flip');
    if (await page.$('#yes')) await page.click('#yes'); else break;
  }
  await context.close();
});

// Schulaufgabe: eine Runde lösen. Die richtigen Antworten kommen aus den geladenen Daten (SA), mit `wrongEvery` jede n-te Aufgabe absichtlich falsch.
async function solveSchulaufgabe(page, topicId, { wrongEvery = 0 } = {}) {
  await page.click('#sa-open');
  await page.click(`.topic[data-id="${topicId}"]`);
  await page.selectOption('#sa-count', '0');
  await page.click('#sa-go');
  let n = 0;
  while (await page.$('#sa-check')) {
    const topic = await page.evaluate(id => SA.themen.find(t => t.id === id), topicId);
    const header = (await page.textContent('.sa-card')).trim();
    const inputs = page.locator('.blank'), count = await inputs.count();
    const wrong = wrongEvery && ++n % wrongEvery === 0;
    let item;
    if (topic.typ === 'konjugieren') {
      const verb = (await page.textContent('.sa-card .q')).trim();
      const tense = (await page.textContent('.sa-card .mut + .mut b, .sa-card b')).trim();
      item = topic.items.find(i => i.verb === verb && i.zeitname === tense);
      const forms = item.formen.filter(Boolean);
      for (let i = 0; i < count; i++) await inputs.nth(i).fill(wrong ? 'xx' : forms[i].replace(/^(j'|\S+ )/, '').replace(/\(e\)|\(s\)/g, ''));
    } else if (topic.typ === 'verneinung') {
      const q = (await page.textContent('.sa-card .q')).trim();
      item = topic.items.find(i => i.q === q);
      await inputs.nth(0).fill(wrong ? 'xx' : item.antworten[0].toLowerCase().replace(/\.$/, ''));
    } else {
      const shown = await page.evaluate(() => [...document.querySelector('.gap').childNodes].map(n => (n.nodeType === 3 ? n.textContent : '___')).join(''));
      item = topic.items.find(i => i.q === shown);
      assert.ok(item, `Aufgabe nicht gefunden: ${shown}`);
      for (let i = 0; i < count; i++) await inputs.nth(i).fill(wrong ? 'xx' : item.blanks[i][0].replace('–', '-'));
    }
    await page.keyboard.press('Enter'); // Enter in einer Zeile springt weiter, in der letzten wird geprüft
    for (let i = 1; i < count; i++) if (!(await page.$('#sa-feedback .okmsg, #sa-feedback .badmsg'))) await page.keyboard.press('Enter');
    await page.waitForSelector('#sa-feedback .okmsg, #sa-feedback .badmsg');
    await page.keyboard.press('Enter');
  }
}

test('Schulaufgabe: Menü, Themen und Zurück', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await page.click('#sa-open');
  await page.waitForSelector('.topic[data-id="verneinung"]');
  assert.equal(await page.locator('.topics .topic').count(), 6);
  await page.click('.topic[data-id="verneinung"]');
  assert.ok(await page.$('details.rules[open]'));
  await page.click('#sa-back');
  assert.equal(await page.locator('.topics .topic').count(), 6);
  await page.click('#sa-back');
  await page.waitForSelector('.row');
  await context.close();
});

for (const id of ['verneinung', 're', 'infinitiv', 'vergangenheit', 'verben']) {
  test(`Schulaufgabe: Thema ${id} komplett richtig lösen`, async ({ browser, base }) => {
    const { context, page, stats } = await openApp(browser, base);
    await solveSchulaufgabe(page, id);
    const result = await page.textContent('.big');
    const [, ok, total] = result.match(/(\d+) von (\d+)/);
    assert.equal(ok, total, result);
    assert.deepEqual(stats.errors, []);
    await context.close();
  });
}

test('Schulaufgabe: Fehler zeigen die Lösung, werden gemerkt und lassen sich nochmal üben', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await solveSchulaufgabe(page, 'verneinung', { wrongEvery: 4 });
  const [, ok, total] = (await page.textContent('.big')).match(/(\d+) von (\d+)/);
  assert.equal(Number(total) - Number(ok), 4);
  assert.equal(await page.locator('.miss li').count(), 4);
  const saved = await storage(page, 'vk:sa');
  assert.equal(saved.verneinung.last.total, Number(total));
  assert.equal(Object.values(saved.verneinung.items).filter(x => x.bad === 1).length, 4);
  await page.click('#sa-again-wrong');
  assert.match(await page.textContent('.top'), /1 von 4/);
  await context.close();
});

test('Schulaufgabe: „–“ bei Lücken ohne Präposition wird als -, – oder rien erkannt', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  const result = await page.evaluate(() => ['-', '–', ' rien ', 'à'].map(t => saMatches(t, ['–'])));
  assert.deepEqual(result, [true, true, true, false]);
  assert.equal(await page.evaluate(() => saMatches("Il n’a rien dit !", ["Il n'a rien dit."])), true);
  assert.equal(await page.evaluate(() => saMatches('Il ne a rien dit.', ["Il n'a rien dit."])), false);
  await context.close();
});

test('Schulaufgabe: Textproduktion mit Bausteinen, gespeichertem Text und Checkliste', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await page.click('#sa-open'); await page.click('.topic[data-id="schreiben"]');
  await page.click('[data-task="ecole"]');
  await page.click('.block >> nth=2');
  assert.match(await page.inputValue('#sa-text'), /^Cette année, je veux/);
  await page.fill('#sa-text', 'Bonjour tout le monde'); await page.check('.checks input >> nth=0');
  assert.equal(await page.textContent('#sa-count'), '4 Wörter');
  await page.reload(); await page.waitForSelector('.row');
  await page.click('#sa-open'); await page.click('.topic[data-id="schreiben"]'); await page.click('[data-task="ecole"]');
  assert.equal(await page.inputValue('#sa-text'), 'Bonjour tout le monde');
  assert.equal(await page.isChecked('.checks input >> nth=0'), true);
  await context.close();
});

test('Update: neue Version wird erkannt, „Später“ blendet aus, „Jetzt aktualisieren“ lädt neu und merkt die Version', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  let version = 'aaa1111';
  await context.route('**/version.json', route => route.fulfill({ json: { version, built: '2026-11-16T10:00:00Z' }, headers: { 'cache-control': 'no-store' } }));
  await page.reload(); await page.waitForSelector('.row');
  await page.evaluate(() => checkForUpdate());
  assert.equal(await page.locator('#update-banner').count(), 0);
  assert.equal(await storage(page, 'vk:app-version'), 'aaa1111');
  version = 'bbb2222';
  assert.equal(await page.evaluate(() => checkForUpdate()), 'available');
  await page.waitForSelector('#update-banner');
  assert.match(await page.textContent('#update-banner'), /neue Version/);
  await page.click('#update-later');
  assert.equal(await page.locator('#update-banner').count(), 0);
  await page.evaluate(() => { updateDismissed = false; return checkForUpdate(); });
  await Promise.all([page.waitForNavigation(), page.click('#update-now')]);
  await page.waitForSelector('.row');
  assert.equal(await storage(page, 'vk:app-version'), 'bbb2222');
  await page.evaluate(() => checkForUpdate());
  assert.equal(await page.locator('#update-banner').count(), 0);
  await context.close();
});

test('Update: Einstellungen zeigen die Version und suchen nach Updates', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await context.route('**/version.json', route => route.fulfill({ json: { version: 'ccc3333abc', built: '2026-11-16T10:00:00Z' } }));
  await page.click('#settings');
  await page.waitForSelector('#sec-update');
  await page.click('#update-check');
  await page.waitForFunction(() => /Du hast die neueste Version/.test(document.getElementById('update-status').textContent));
  assert.match(await page.textContent('#update-status'), /Version ccc3333/);
  assert.equal(await page.isHidden('#update-apply'), true);
  await context.close();
});

test('Update: geänderte, neue und gelöschte Audio-/Bilddateien werden im Offline-Speicher aufgefrischt', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  const files = { '/__m/changed.mp3': { etag: '"new"', body: 'NEU' }, '/__m/same.mp3': { etag: '"s"', body: 'SAME' }, '/__m/added.mp3': { etag: '"a"', body: 'ADDED' } };
  await context.route('**/__m/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/__m/gone.mp3') return route.fulfill({ status: 404, body: '' });
    const file = files[path];
    if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { etag: file.etag } });
    return route.fulfill({ status: 200, headers: { etag: file.etag, 'content-type': 'audio/mpeg' }, body: file.body });
  });
  const result = await page.evaluate(async origin => {
    const cache = await caches.open(MEDIA_CACHE);
    const put = (name, etag, body) => cache.put(`${origin}/__m/${name}`, new Response(body, { headers: { etag } }));
    await put('changed.mp3', '"old"', 'ALT'); await put('same.mp3', '"s"', 'SAME'); await put('gone.mp3', '"g"', 'WEG');
    const urls = ['changed', 'same', 'added', 'gone'].map(n => `${origin}/__m/${n}.mp3`);
    const r = await refreshMedia(urls);
    const text = async n => { const hit = await cache.match(`${origin}/__m/${n}.mp3`); return hit ? hit.text() : null; };
    return { r, changed: await text('changed'), same: await text('same'), added: await text('added'), gone: await text('gone') };
  }, base);
  assert.deepEqual(result.r, { total: 4, changed: 3, failed: 0 });
  assert.equal(result.changed, 'NEU'); assert.equal(result.same, 'SAME'); assert.equal(result.added, 'ADDED'); assert.equal(result.gone, null);
  await context.close();
});

test('Schulaufgabe: Anleitung, Erklärungen zum Thema, Merkkasten in der Runde und Erklärung nach der Antwort', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base);
  await page.click('#sa-open');
  assert.match(await page.textContent('details.rules[open]'), /So funktioniert es/);
  await page.click('.topic[data-id="verneinung"]');
  assert.ok(await page.$('.about'));
  assert.ok(await page.locator('details.rules summary:has-text("Beispiele")').count());
  assert.ok(await page.locator('details.rules summary:has-text("So gibst du die Antwort ein")').count());
  await page.selectOption('#sa-count', '5'); await page.click('#sa-go');
  assert.ok(await page.locator('summary:has-text("Merkkasten ansehen")').count());
  await page.fill('.blank', 'xx'); await page.keyboard.press('Enter');
  await page.waitForSelector('#sa-feedback .tip');
  assert.match(await page.textContent('#sa-feedback .tip'), /💡/);
  await context.close();
});

test('Immer weiterlernen: nach der Runde geht es mit Enter weiter, auch wenn nichts mehr fällig ist', async ({ browser, base }) => {
  const db = readJson('lektionen/dec3-u2-a/database.json');
  const progress = Object.fromEntries(db.map(c => [cardId('lektionen/dec3-u2-a', c), { b: 2, d: Date.now() + 1e10 }]));
  const seed = { 'vk:sel': ['lektionen/dec3-u2-a'], 'vk:progress': progress, 'vk:opt': { dir: 'fr', all: false, img: false, limit: 5 } };
  const { context, page, stats } = await openApp(browser, base, { seed });
  await page.click('#go'); await page.waitForSelector('#flip');
  assert.match(await page.innerText('.top .mut'), /Wiederholung/);
  for (let i = 0; i < 30 && !(await page.$('#again')); i++) { await page.click('#flip'); await page.click('#yes'); }
  assert.match(await page.innerText('h1'), /Runde geschafft/);
  assert.match(await page.innerText('p.mut:has-text("nichts mehr fällig")'), /nichts mehr fällig/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'again', 'Weiter lernen ist vorausgewählt');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#flip');
  assert.match(await page.innerText('.top .mut'), /noch 5/);
  assert.equal(stats.errors.length, 0, stats.errors.join('; '));
  await context.close();
});

test('Tagesziel: Fortschritt auf der Startseite, Hinweis beim Erreichen, einstellbar', async ({ browser, base }) => {
  const key = new Date(); const day = `${key.getFullYear()}-${String(key.getMonth() + 1).padStart(2, '0')}-${String(key.getDate()).padStart(2, '0')}`;
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['uebungen/passe-compose'], 'vk:stats': { [day]: 9 }, 'vk:opt': { dir: 'fr', all: true, img: false, goal: 10 } } });
  assert.equal(await page.innerText('#today'), 'Heute geübt: 9 von 10 Karten');
  assert.equal(await page.getAttribute('#goal-bar', 'aria-valuenow'), '90');
  await page.click('#go'); await page.waitForSelector('#flip');
  await page.click('#flip'); await page.click('#yes');
  await page.waitForSelector('#toast.on');
  assert.match(await page.innerText('#toast'), /Tagesziel erreicht/);
  await page.click('#end'); await page.waitForSelector('#go');
  assert.match(await page.innerText('#today'), /10 von 10 Karten 🎯/);
  await setLearn(page, p => p.selectOption('#goal', '0'));
  assert.equal(await page.isHidden('#goal-bar'), true);
  assert.match(await page.innerText('#today'), /^Heute geübt: 10 Karten/);
  await context.close();
});

(async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  let failed = 0;
  for (const { name, fn } of tests) {
    const started = Date.now();
    try {
      await fn({ browser, base: server.base });
      console.log(`✓ ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed++;
      console.log(`✗ ${name}\n    ${String(error.stack || error).split('\n').slice(0, 6).join('\n    ')}`);
    }
  }
  await browser.close();
  await server.close();
  console.log(failed ? `\n${failed} von ${tests.length} Tests fehlgeschlagen` : `\nAlle ${tests.length} Tests bestanden`);
  process.exit(failed ? 1 : 0);
})();
