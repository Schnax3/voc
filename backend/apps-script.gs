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
 */
var MAX_TEXT = 3000;          // Zeichen im Issue-Text
var MAX_PER_HOUR = 20;        // Vorschläge pro Stunde insgesamt (Schutz vor Spam)
var ALLOWED_LABELS = ['vorschlag', 'enhancement', 'bug', 'vokabeln'];
var MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
var MAX_ATTACHMENTS = 5;

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
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
    return reply({ ok: true, url: JSON.parse(response.getContentText()).html_url });
  } catch (err) {
    return reply({ ok: false, error: 'Ungültige Anfrage' });
  }

}

function uploadAttachments(files) {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FEEDBACK_DRIVE_FOLDER_ID');
  if (!Array.isArray(files) || !files.length) return { links: [] };
  if (!folderId) return { error: 'Bilder sind nicht eingerichtet' };

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) { return { error: 'Bildordner ist nicht erreichbar' }; }

  var links = [];
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
    var name = String(file.name || ('Screenshot-' + (i + 1))).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    try {
      var blob = Utilities.newBlob(bytes, file.type, name);
      var uploaded = folder.createFile(blob);
      uploaded.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      links.push('- [' + name + '](' + uploaded.getUrl() + ')');
    } catch (err) { return { error: 'Ein Bild konnte nicht hochgeladen werden' }; }
  }
  return { links: links };
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
