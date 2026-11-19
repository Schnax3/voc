// ---- Verbesserungsvorschläge --------------------------------------------------------------------
// Ohne Einrichtung öffnet "Absenden" ein vorausgefülltes GitHub-Issue (dafür braucht man ein GitHub-Konto).
// Trägt man in feedback-config.json eine "endpoint"-Adresse ein (siehe README, z. B. Google Apps Script),
// wird der Vorschlag direkt gesendet und als Issue angelegt, ganz ohne GitHub-Konto.
// Kontext von außen: openFeedback({ where: 'Rundenende', lessons: ['Dec3 · U1 A'] })

const FEEDBACK_TYPES = [
  ['wunsch', 'Wunsch oder Idee', 'Wunsch', 'enhancement'],
  ['fehler', 'Fehler in der App', 'Fehler', 'bug'],
  ['vokabel', 'Falsche oder fehlende Vokabel', 'Vokabel', 'vokabeln'],
  ['sonst', 'Etwas anderes', 'Vorschlag', 'vorschlag']
];
const FEEDBACK_MIN = 5, FEEDBACK_MAX = 1500, FEEDBACK_PAUSE_MS = 30000;
const FEEDBACK_MAX_FILE_BYTES = 4 * 1024 * 1024;
const FEEDBACK_MAX_FILES = 5;
const NSFWJS_TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const NSFWJS_URL = 'https://cdn.jsdelivr.net/npm/nsfwjs@2.4.2/dist/nsfwjs.min.js';
const NSFWJS_MODEL_URL = 'https://raw.githubusercontent.com/infinitered/nsfwjs/2286f17b7efee1558356dc8736391e63c6959a6e/models/mobilenet_v2/model.json';
const NSFWJS_THRESHOLDS = { Porn: 0.5, Hentai: 0.5, Sexy: 0.85 };
let nsfwModelPromise = null;

function loadExternalScript(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => { script.remove(); reject(new Error('Prüfbibliothek konnte nicht geladen werden')); };
    document.head.appendChild(script);
  });
}

function loadNsfwModel() {
  if (!nsfwModelPromise) {
    nsfwModelPromise = (async () => {
      await loadExternalScript(NSFWJS_TF_URL, () => Boolean(window.tf));
      window.tf.enableProdMode();
      await window.tf.ready();
      await loadExternalScript(NSFWJS_URL, () => Boolean(window.nsfwjs));
      return window.nsfwjs.load(NSFWJS_MODEL_URL);
    })().catch(error => {
      nsfwModelPromise = null;
      throw error;
    });
  }
  return nsfwModelPromise;
}

async function classifyFeedbackImage(file, model) {
  const image = new Image(), objectUrl = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Bild konnte nicht lokal gelesen werden'));
      image.src = objectUrl;
    });
    const predictions = await model.classify(image);
    return predictions.filter(prediction => prediction.probability >= (NSFWJS_THRESHOLDS[prediction.className] || 1));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function feedbackConfig() {
  try {
    const response = await fetch('feedback-config.json', { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch { /* ohne Konfiguration: GitHub-Link */ }
  return {};
}
// "owner/repo" aus der Adresse (GitHub Pages: owner.github.io/repo/), sonst aus der Konfiguration
const feedbackRepo = cfg => {
  if (cfg.repo) return cfg.repo;
  const host = location.hostname.match(/^([^.]+)\.github\.io$/), segment = location.pathname.split('/')[1];
  return host && segment ? `${host[1]}/${segment}` : '';
};
function feedbackPayload(ctx, type, text, attachments = []) {
  const kind = FEEDBACK_TYPES.find(t => t[0] === type) || FEEDBACK_TYPES[3];
  const lessons = (ctx.lessons || []).join(', ');
  let body = `${text.trim()}\n\n---\nArt: ${kind[1]}\nOrt in der App: ${ctx.where || 'Startseite'}${lessons ? `\nLektionen: ${lessons}` : ''}\nSeite: ${IS_DEV ? 'dev (Testseite)' : 'main'}\nGesendet über die App`;
  if (attachments.length) body += `\nAnhänge: ${attachments.map(file => file.name).join(', ')}`;
  const firstLine = text.trim().split('\n')[0].slice(0, 70);
  return { type: kind[0], title: `[${kind[2]}] ${firstLine}`, body, labels: ['vorschlag', kind[3]], attachments };
}

function feedbackDialog() {
  let dialog = document.getElementById('feedback');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'feedback';
  dialog.setAttribute('aria-labelledby', 'fb-title');
  dialog.innerHTML = `<form id="fb-form" novalidate>
    <p class="dlg-title" id="fb-title">💡 Verbesserung vorschlagen</p>
    <label>Worum geht es?
      <select id="fb-type">${FEEDBACK_TYPES.map(t => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select></label>
    <label>Dein Vorschlag
      <textarea id="fb-text" rows="6" maxlength="${FEEDBACK_MAX}" placeholder="Was soll besser werden? Bei Vokabeln bitte Lektion und Wort nennen."></textarea></label>
    <label>Screenshot oder Bild (optional)
      <input id="fb-files" type="file" accept="image/jpeg,image/png,image/webp" multiple>
      <small class="hint">Bis zu ${FEEDBACK_MAX_FILES} JPG-, PNG- oder WebP-Bilder (je höchstens 4 MB). Bilder werden vor dem Upload kostenlos lokal geprüft und nicht an den Prüfdienst gesendet.</small></label>
    <div class="hp" aria-hidden="true"><label>Bitte leer lassen <input id="fb-hp" tabindex="-1" autocomplete="off"></label></div>
    <p class="hint" id="fb-info"></p>
    <p class="hint" id="fb-status" role="status"></p>
    <div class="btns"><button id="fb-send" class="primary" type="submit">Absenden</button><button id="fb-cancel" type="button">Schließen</button></div>
  </form>`;
  document.body.appendChild(dialog);
  return dialog;
}

async function openFeedback(ctx = {}) {
  const dialog = feedbackDialog(), $ = s => dialog.querySelector(s);
  const cfg = await feedbackConfig(), repo = feedbackRepo(cfg), direct = Boolean(cfg.endpoint);
  $('#fb-text').value = ''; $('#fb-files').value = ''; $('#fb-hp').value = ''; $('#fb-status').textContent = ''; $('#fb-send').disabled = false; $('#fb-send').hidden = false;
  $('#fb-send').textContent = direct ? 'Absenden' : 'Weiter zu GitHub';
  $('#fb-info').textContent = direct
    ? 'Dein Vorschlag wird ohne Anmeldung an das Projekt übermittelt und dort öffentlich sichtbar. Bitte keine persönlichen Angaben machen.'
    : 'Zum Absenden öffnet sich GitHub mit einem vorausgefüllten Formular. Dafür brauchst du ein kostenloses GitHub-Konto. Der Text wird dort öffentlich sichtbar. Bitte keine persönlichen Angaben machen.';
  $('#fb-cancel').onclick = () => dialog.close();
  $('#fb-form').onsubmit = async event => {
    event.preventDefault();
    const status = $('#fb-status'), text = $('#fb-text').value;
    if ($('#fb-hp').value) { status.textContent = 'Danke!'; return; } // Spam-Falle: Menschen sehen das Feld nicht
    if (text.trim().length < FEEDBACK_MIN) { status.textContent = `Bitte schreibe mindestens ${FEEDBACK_MIN} Zeichen.`; return; }
    const files = [...($('#fb-files').files || [])];
    if (files.length > FEEDBACK_MAX_FILES) { status.textContent = `Bitte wähle höchstens ${FEEDBACK_MAX_FILES} Bilder aus.`; return; }
    const oversized = files.find(file => file.size > FEEDBACK_MAX_FILE_BYTES);
    if (oversized) { status.textContent = `„${oversized.name}“ ist größer als 4 MB.`; return; }
    const unsupported = files.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type));
    if (unsupported) { status.textContent = 'Bitte verwende JPG-, PNG- oder WebP-Bilder.'; return; }
    let attachments = [];
    if (files.length) {
      if (!direct) { status.textContent = 'Ohne Direktversand können Bilder noch nicht angehängt werden. Bitte sende den Text über GitHub.'; return; }
      $('#fb-send').disabled = true;
      status.textContent = 'Prüfe Bilder lokal …';
      try {
        console.info('[Feedback] Prüfe Bilder lokal', { attachments: files.length });
        const model = await loadNsfwModel();
        for (let i = 0; i < files.length; i++) {
          const flagged = await classifyFeedbackImage(files[i], model);
          if (flagged.length) {
            const categories = flagged.map(prediction => prediction.className);
            console.warn('[Feedback] NSFWJS hat ein Bild blockiert', { fileIndex: i, categories });
            status.textContent = `Bild ${i + 1} wurde als möglicherweise nicht jugendfrei erkannt. Es wurde nichts gesendet.`;
            $('#fb-send').disabled = false;
            return;
          }
        }
        console.info('[Feedback] Bilder lokal geprüft', { attachments: files.length, blocked: false });
        status.textContent = 'Bereite Bilder vor …';
        attachments = await Promise.all(files.map(async file => ({
          name: file.name,
          type: file.type || 'application/octet-stream',
          data: await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
            reader.readAsDataURL(file);
          })
        })));
      } catch (error) {
        console.error('[Feedback] Lokale Bildprüfung fehlgeschlagen', { message: error.message });
        $('#fb-send').disabled = false;
        status.textContent = `Das Bild konnte nicht vorbereitet werden (${error.message}).`;
        return;
      }
    }
    const payload = feedbackPayload(ctx, $('#fb-type').value, text, attachments);
    if (!direct) {
      if (!repo) { status.textContent = 'Das Senden ist hier noch nicht eingerichtet.'; return; }
      const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(payload.title)}&body=${encodeURIComponent(payload.body.slice(0, 1800))}&labels=${encodeURIComponent(payload.labels.join(','))}`;
      window.open(url, '_blank', 'noopener');
      status.textContent = 'GitHub wurde geöffnet. Dort noch auf „Submit new issue“ tippen.';
      return;
    }
    const last = Number(LS.get('vk:feedback-at', 0));
    if (Date.now() - last < FEEDBACK_PAUSE_MS) { $('#fb-send').disabled = false; status.textContent = 'Bitte warte einen Moment, bevor du noch einen Vorschlag sendest.'; return; }
    if (!navigator.onLine) { $('#fb-send').disabled = false; status.textContent = 'Du bist offline. Sende den Vorschlag, sobald du wieder Internet hast.'; return; }
    $('#fb-send').disabled = true; status.textContent = 'Sende …';
    let responseStatus = null, responseType = null;
    try {
      // text/plain vermeidet eine CORS-Vorabfrage (wichtig für Google Apps Script)
      console.info('[Feedback] Sende Vorschlag', { attachments: attachments.length });
      const response = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
      responseStatus = response.status;
      responseType = response.headers.get('content-type') || 'unbekannt';
      const responseText = await response.text();
      let data;
      try { data = JSON.parse(responseText); }
      catch {
        console.error('[Feedback] Ungültige Backend-Antwort', { status: responseStatus, contentType: responseType });
        throw new Error(`Ungültige Serverantwort (HTTP ${responseStatus})`);
      }
      if (!response.ok || data.ok === false) {
        console.error('[Feedback] Backend hat die Anfrage abgelehnt', { status: responseStatus, contentType: responseType, error: data.error || 'Unbekannter Fehler' });
        throw new Error(data.error || `Fehler ${response.status}`);
      }
      console.info('[Feedback] Vorschlag angenommen', { status: responseStatus });
      LS.set('vk:feedback-at', Date.now());
      status.textContent = 'Danke! Dein Vorschlag ist angekommen.';
      $('#fb-text').value = ''; $('#fb-files').value = ''; $('#fb-send').hidden = true; $('#fb-cancel').textContent = 'Schließen';
    } catch (e) {
      console.error('[Feedback] Senden fehlgeschlagen', { status: responseStatus, contentType: responseType, message: e.message });
      $('#fb-send').disabled = false;
      status.textContent = `Das Senden hat nicht geklappt (${e.message}). Du kannst es später nochmal versuchen.`;
    }
  };
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
  $('#fb-text').focus();
}
document.getElementById('feedback-link')?.addEventListener('click', () => {
  const lessons = [...sel].map(titleOf);
  openFeedback({ where: subscreen ? 'Einstellungen oder Runde' : 'Startseite', lessons });
});
