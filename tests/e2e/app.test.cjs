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
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
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

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Lektionsliste kommt aus index.json, nicht aus der GitHub-API', async ({ browser, base }) => {
  const { context, page, stats } = await openApp(browser, base);
  const index = readJson('index.json');
  assert.equal(await page.locator('.row').count(), index.tables.length);
  assert.ok(stats.indexJson >= 1, 'index.json wurde nicht geladen');
  assert.equal(stats.api, 0, 'die GitHub-API darf nicht gebraucht werden');
  const titles = await page.locator('.row b').allTextContents();
  assert.ok(titles.includes('Dec3 · U1 A'), `Anzeigename fehlt: ${titles}`);
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
    route.fulfill({ json: { tree: [{ type: 'blob', path: 'dec3-u1a/database-5.json' }, { type: 'blob', path: 'index.json' }] } });
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
  await page.click('.row:first-child');
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

test('Fortschritt zieht bei umbenannten Ordnern und geändertem Liaison-Zeichen um', async ({ browser, base }) => {
  const db = readJson('dec3-u2-a/database.json');
  const card = db.find(e => e.french.includes('‿'));
  assert.ok(card, 'Testkarte mit ‿ fehlt');
  const oldFrench = card.french.split('‿').join('⁔'); // früher: ⁔
  const oldKey = `Dec3-U2-A::${hash(oldFrench + '|' + card.german)}`;
  const otherKey = `U1A (AUDIO)::${hash('x|y')}`;
  const { context, page } = await openApp(browser, base, {
    seed: { 'vk:progress': { [oldKey]: { b: 4, d: 999, w: 1 }, [otherKey]: { b: 3, d: 5 } }, 'vk:sel': ['Dec3-U2-A'] },
  });
  const newKey = cardId('dec3-u2-a', card);
  await page.waitForFunction(k => k in (JSON.parse(localStorage.getItem('vk:progress')) || {}), newKey);
  const progress = await storage(page, 'vk:progress');
  assert.deepEqual(progress[newKey], { b: 4, d: 999, w: 1 });
  assert.equal(oldKey in progress, false, 'alte ID muss entfernt sein');
  assert.deepEqual(progress[`dec3-u1a::${hash('x|y')}`], { b: 3, d: 5 });
  assert.equal(Object.keys(progress).some(k => k.startsWith('U1A (AUDIO)')), false);
  assert.deepEqual(await storage(page, 'vk:sel'), ['dec3-u2-a']);
  await context.close();
});

test('Schwierige Karten: Anzeige, Filter und Fehlerzähler', async ({ browser, base }) => {
  const db = readJson('dec3-u2-a/database.json');
  const hardKey = cardId('dec3-u2-a', db[0]), softKey = cardId('dec3-u2-a', db[1]);
  const { context, page } = await openApp(browser, base, {
    seed: { 'vk:progress': { [hardKey]: { b: 1, d: 0, w: 2 }, [softKey]: { b: 2, d: 0, w: 1 } }, 'vk:sel': ['dec3-u2-a'] },
  });
  const row = page.locator('.row', { hasText: 'Dec3 · U2 A' });
  assert.match(await row.innerText(), /1 schwierig/);
  await page.check('#hard');
  assert.equal(await page.textContent('#go'), 'Starten (1 Karten)');
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
  const db = readJson('dec3-u2-a/database.json');
  const key = cardId('dec3-u2-a', db[0]);
  const a = await openApp(browser, base, { seed: { 'vk:progress': { [key]: { b: 3, d: 1234, w: 2 } } } });
  const [download] = await Promise.all([a.page.waitForEvent('download'), a.page.click('#export')]);
  // Playwright löscht Downloads beim Schließen des Kontexts: Kopie für den zweiten Browser anlegen
  const file = path.join(os.tmpdir(), `vk-export-${process.pid}.json`);
  fs.copyFileSync(await download.path(), file);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(exported.progress[key], { b: 3, d: 1234, w: 2 });
  await a.context.close();

  const b = await openApp(browser, base);
  b.page.on('dialog', d => d.accept());
  await b.page.setInputFiles('#import-file', file);
  await b.page.waitForFunction(k => (JSON.parse(localStorage.getItem('vk:progress')) || {})[k], key);
  assert.deepEqual((await storage(b.page, 'vk:progress'))[key], { b: 3, d: 1234, w: 2 });
  await b.context.close();
  fs.rmSync(file, { force: true });
});

test('Fehlendes Audio: Sprachausgabe als Ersatz, kaputte Bilder verschwinden', async ({ browser, base }) => {
  const { context, page } = await openApp(browser, base, { seed: { 'vk:sel': ['dec3-u1b3-verben'] } });
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
  await page.click('.row:has(b:text-is("Dec3 · U1 A"))'); // dec3-u1a (mit Audio), nicht "letztes Jahr"
  await page.click('#offline-save');
  await page.waitForFunction(() => /Offline gespeichert: \d+/.test(document.querySelector('#offline-status').textContent), null, { timeout: 30000 });

  const audio = readJson('dec3-u1a/database-5.json').find(e => e.audio).audio;
  const saved = `${server.base}/dec3-u1a/${encodeURIComponent(audio)}`;
  const other = readJson('dec2-u7a/database-4.json').find(e => e.audio).audio;
  const notSaved = `${server.base}/dec2-u7a/${encodeURIComponent(other)}`;

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
  assert.equal(await page.textContent('#go'), 'Starten (1 Karten)');
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
