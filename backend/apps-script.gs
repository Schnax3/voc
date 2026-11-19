/**
 * Zwischendienst für Verbesserungsvorschläge (Google Apps Script).
 * Nimmt einen Vorschlag der App entgegen und legt daraus ein GitHub-Issue an.
 * Besucher brauchen dafür kein GitHub-Konto. Der GitHub-Token liegt nur hier und nie in der Seite.
 *
 * Einrichtung: siehe README, Abschnitt "Verbesserungsvorschläge ohne GitHub-Konto".
 * Script-Eigenschaften (Projekteinstellungen -> Script-Eigenschaften):
 *   GITHUB_TOKEN  Fine-grained Token, nur für dieses Repository, nur Berechtigung "Issues: Read and write"
 *   GITHUB_REPO   z. B. owner/repo
 *   FEEDBACK_DRIVE_FOLDER_ID  Google-Drive-Ordner für Bildanhänge (optional, für Bilder erforderlich)
 *   GOOGLE_VISION_API_KEY  API-Key für Google Cloud Vision SafeSearch
 *   GITHUB_WEBHOOK_SECRET  Geheimnis des GitHub-Issue-Webhooks zum Löschen geschlossener Anhänge
 */
var MAX_TEXT = 3000;          // Zeichen im Issue-Text
var MAX_PER_HOUR = 20;        // Vorschläge pro Stunde insgesamt (Schutz vor Spam)
var ALLOWED_LABELS = ['vorschlag', 'enhancement', 'bug', 'vokabeln'];
var MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
var MAX_ATTACHMENTS = 5;
var MODERATION_WEIGHTS = {
  UNKNOWN: 0,
  VERY_UNLIKELY: 0,
  UNLIKELY: 1,
  POSSIBLE: 2,
  LIKELY: 3,
  VERY_LIKELY: 4
};

function doPost(e) {
  try {
    var raw = getPostData(e);
    var data = JSON.parse(raw);
    if (data.action && data.issue) return handleGitHubWebhook(e, raw, data);
    var title = String(data.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    var body = String(data.body || '').trim().slice(0, MAX_TEXT);
    if (title.length < 8 || body.length < 10) return reply({ ok: false, error: 'Zu kurz' });

    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('GITHUB_TOKEN'), repo = props.getProperty('GITHUB_REPO');
    if (!token || !repo) return reply({ ok: false, error: 'Nicht eingerichtet' });
    if (!underLimit()) return reply({ ok: false, error: 'Gerade zu viele Vorschläge, bitte später nochmal' });

    var labels = (Array.isArray(data.labels) ? data.labels : []).filter(function (l) { return ALLOWED_LABELS.indexOf(l) >= 0; });
    var uploaded = uploadAttachments(data.attachments);
    if (uploaded.error) return reply({ ok: false, error: uploaded.error });
    if (uploaded.links.length) body += '\n\nAnhänge:\n' + uploaded.links.join('\n');
    var response = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/issues', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      payload: JSON.stringify({ title: title, body: body, labels: labels }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 201) return reply({ ok: false, error: 'GitHub ' + code });
    var created = JSON.parse(response.getContentText());
    if (uploaded.fileIds.length && created.number) {
      PropertiesService.getScriptProperties().setProperty('FEEDBACK_ISSUE_' + created.number, JSON.stringify(uploaded.fileIds));
    }
    return reply({ ok: true, url: created.html_url });
  } catch (err) {
    return reply({ ok: false, error: 'Ungültige Anfrage' });
  }
}

function getPostData(e) {
  if (e.postData && e.postData.contents) return e.postData.contents;
  if (e.parameter && e.parameter.payload) return e.parameter.payload;
  return '';
}

function handleGitHubWebhook(e, raw, payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('GITHUB_WEBHOOK_SECRET');
  if (!secret) return reply({ ok: false, error: 'Webhook nicht eingerichtet' });

  var headers = e.headers || {};
  var signature = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '';
  var expected = 'sha256=' + bytesToHex(Utilities.computeHmacSha256Signature(raw, secret));
  if (!secureEqual(signature, expected)) return reply({ ok: false, error: 'Ungültige Signatur' });

  if (payload.action !== 'closed' || !payload.issue) return reply({ ok: true });
  var key = 'FEEDBACK_ISSUE_' + payload.issue.number;
  var prop = PropertiesService.getScriptProperties();
  var ids = JSON.parse(prop.getProperty(key) || '[]');
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { /* Datei war bereits entfernt */ }
  });
  prop.deleteProperty(key);
  return reply({ ok: true, deleted: ids.length });
}

function bytesToHex(bytes) {
  return bytes.map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function secureEqual(a, b) {
  if (a.length !== b.length) return false;
  var unequal = 0;
  for (var i = 0; i < a.length; i++) if (a.charAt(i) !== b.charAt(i)) unequal++;
  return unequal === 0;
}

function uploadAttachments(files) {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FEEDBACK_DRIVE_FOLDER_ID');
  var visionKey = props.getProperty('GOOGLE_VISION_API_KEY');
  if (!Array.isArray(files) || !files.length) return { links: [], fileIds: [] };
  if (!folderId) return { error: 'Bilder sind nicht eingerichtet' };
  if (!visionKey) return { error: 'Bildprüfung ist nicht eingerichtet' };

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) { return { error: 'Bildordner ist nicht erreichbar' }; }

  var links = [];
  var fileIds = [];
  var allowed = files.slice(0, MAX_ATTACHMENTS);
  for (var i = 0; i < allowed.length; i++) {
    var file = allowed[i];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(String(file.type || ''))) return { error: 'Nur Bilddateien sind erlaubt' };
    var data = String(file.data || '');
    if (!data || data.length > 5600000) return { error: 'Ein Bild ist zu groß' };
    var bytes;
    try { bytes = Utilities.base64Decode(data); }
    catch (err) { return { error: 'Ungültige Bilddaten' }; }
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) return { error: 'Ein Bild ist zu groß' };
    var moderation = moderateImage(visionKey, data);
    if (moderation.error) return moderation;
    if (moderation.blocked) return { error: 'Bild abgelehnt: Der Inhalt wurde als nicht jugendfrei erkannt' };
    var name = String(file.name || ('Screenshot-' + (i + 1))).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    try {
      var blob = Utilities.newBlob(bytes, file.type, name);
      var uploaded = folder.createFile(blob);
      uploaded.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      links.push('- [' + name + '](' + uploaded.getUrl() + ')');
      fileIds.push(uploaded.getId());
    } catch (err) { return { error: 'Ein Bild konnte nicht hochgeladen werden' }; }
  }
  return { links: links, fileIds: fileIds };
}

function moderateImage(apiKey, base64) {
  var threshold = MODERATION_WEIGHTS.POSSIBLE;
  var response;
  try {
    response = UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey), {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }]
        }]
      })
    });
  } catch (err) { return { error: 'Bildprüfung konnte nicht erreicht werden' }; }

  if (response.getResponseCode() !== 200) return { error: 'Bildprüfung fehlgeschlagen' };
  var result = JSON.parse(response.getContentText());
  var safe = result.responses && result.responses[0] && result.responses[0].safeSearchAnnotation;
  if (!safe) return { error: 'Bildprüfung lieferte kein Ergebnis' };
  var blocked = ['adult', 'racy'].some(function (field) {
    return MODERATION_WEIGHTS[safe[field] || 'UNKNOWN'] >= threshold;
  });
  return { blocked: blocked };
}

// Zur Kontrolle im Browser: die Adresse der Web-App aufrufen
function doGet() { return reply({ ok: true, service: 'Vorschläge' }); }

function underLimit() {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var cache = CacheService.getScriptCache(), n = Number(cache.get('count') || 0);
    if (n >= MAX_PER_HOUR) return false;
    cache.put('count', String(n + 1), 3600);
    return true;
  } finally { lock.releaseLock(); }
}

function reply(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);
}
