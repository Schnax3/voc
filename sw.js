/* Service Worker des Vokabelkastens.
 *
 * - App, Vokabel-JSONs und alles Übrige: erst das Netz (immer aktuell), ohne Netz der zuletzt gesehene Stand.
 * - Audio und Bilder: nur aus dem Speicher, wenn die Lektion ausdrücklich "offline gespeichert" wurde
 *   (die Seite legt sie dazu in den Cache MEDIA); sonst ganz normal aus dem Netz. Der Speicher wird
 *   dadurch nicht automatisch voll.
 * - Der Cache-Name enthält den Pfad, damit die Hauptseite (/voc/) und die Testseite (/voc/dev/) getrennt bleiben.
 *   Die Formel muss zu MEDIA_CACHE in index.html passen.
 */
const VERSION = 'v1';
const SCOPE_ID = new URL('./', self.registration.scope).pathname.replace(/\W+/g, '_');
const SHELL = `vk-shell-${VERSION}-${SCOPE_ID}`;
const MEDIA = `vk-media-${SCOPE_ID}`;
const SHELL_FILES = [
  './', 'index.html', 'datenschutz.html', 'manifest.webmanifest', 'index.json',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const MEDIA_FILE = /\.(mp3|ogg|m4a|wav|jpe?g|png|webp|gif|svg)$/i;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // einzeln, damit eine fehlende Datei die Installation nicht verhindert
    await Promise.allSettled(SHELL_FILES.map(file => cache.add(new Request(file, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const own = `vk-shell-${VERSION}-${SCOPE_ID}`;
    for (const name of await caches.keys()) {
      if (name.startsWith('vk-shell-') && name.endsWith(`-${SCOPE_ID}`) && name !== own) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // z. B. GitHub-API, Google: nicht anfassen
  if (MEDIA_FILE.test(url.pathname) && !url.pathname.includes('/icons/')) {
    event.respondWith(mediaResponse(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const page = await caches.match(new URL('index.html', self.registration.scope).href);
      if (page) return page;
    }
    throw error;
  }
}

async function mediaResponse(request) {
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(request.url);
  if (!hit) return fetch(request); // nicht offline gespeichert: normal aus dem Netz
  const range = request.headers.get('range');
  return range ? rangeResponse(hit, range) : hit;
}

// Safari und Chrome fragen Audio mit Range-Anfragen ab; aus dem Cache muss der Ausschnitt selbst geliefert werden.
async function rangeResponse(response, header) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return response;
  const buffer = await response.clone().arrayBuffer();
  const size = buffer.byteLength;
  let start, end;
  if (match[1] === '') { // letzte N Bytes
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
