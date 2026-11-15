/**
 * Zwischendienst für Verbesserungsvorschläge (Google Apps Script).
 * Nimmt einen Vorschlag der App entgegen und legt daraus ein GitHub-Issue an.
 * Besucher brauchen dafür kein GitHub-Konto. Der GitHub-Token liegt nur hier und nie in der Seite.
 *
 * Einrichtung: siehe README, Abschnitt "Verbesserungsvorschläge ohne GitHub-Konto".
 * Script-Eigenschaften (Projekteinstellungen -> Script-Eigenschaften):
 *   GITHUB_TOKEN  Fine-grained Token, nur für dieses Repository, nur Berechtigung "Issues: Read and write"
 *   GITHUB_REPO   z. B. owner/repo
 */
var MAX_TEXT = 3000;          // Zeichen im Issue-Text
var MAX_PER_HOUR = 20;        // Vorschläge pro Stunde insgesamt (Schutz vor Spam)
var ALLOWED_LABELS = ['vorschlag', 'enhancement', 'bug', 'vokabeln'];

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
