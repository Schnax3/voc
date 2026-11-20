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
 *   GITHUB_WEBHOOK_SECRET  Geheimnis des GitHub-Issue-Webhooks zum Löschen geschlossener Anhänge
 */
var MAX_TEXT = 3000;          // Zeichen im Issue-Text
var MAX_PER_HOUR = 20;        // Vorschläge pro Stunde insgesamt (Schutz vor Spam)
var ALLOWED_LABELS = ['vorschlag', 'enhancement', 'bug', 'vokabeln'];
var MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
var MAX_ATTACHMENTS = 5;
function doPost(e) {
  try {
    var raw = getPostData(e);
    var data = JSON.parse(raw);
    if (data.action && data.issue) {
      Logger.log('doPost: GitHub webhook received; action=' + data.action + ', issue=' + data.issue.number);
      return handleGitHubWebhook(e, raw, data);
    }
    Logger.log('doPost: feedback request received; attachments=' + (Array.isArray(data.attachments) ? data.attachments.length : 0));
    var title = String(data.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    var body = String(data.body || '').trim().slice(0, MAX_TEXT);
    if (title.length < 8 || body.length < 10) {
      Logger.log('doPost: rejected request because title or body is too short');
      return reply({ ok: false, error: 'Zu kurz' });
    }

    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('GITHUB_TOKEN'), repo = props.getProperty('GITHUB_REPO');
    if (!token || !repo) {
      Logger.log('doPost: missing required GITHUB_TOKEN or GITHUB_REPO script property');
      return reply({ ok: false, error: 'Nicht eingerichtet' });
    }
    if (!underLimit()) {
      Logger.log('doPost: request rejected by rate limit');
      return reply({ ok: false, error: 'Gerade zu viele Vorschläge, bitte später nochmal' });
    }

    var labels = (Array.isArray(data.labels) ? data.labels : []).filter(function (l) { return ALLOWED_LABELS.indexOf(l) >= 0; });
    var uploaded = uploadAttachments(data.attachments);
    if (uploaded.error) {
      Logger.log('doPost: attachment processing failed: ' + uploaded.error);
      return reply({ ok: false, error: uploaded.error });
    }
    if (uploaded.links.length) body += '\n\nAnhänge:\n' + uploaded.links.join('\n');
    var response = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/issues', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      payload: JSON.stringify({ title: title, body: body, labels: labels }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 201) {
      Logger.log('doPost: GitHub issue creation failed with HTTP ' + code);
      return reply({ ok: false, error: 'GitHub ' + code });
    }
    var created = JSON.parse(response.getContentText());
    if (uploaded.fileIds.length && created.number) {
      PropertiesService.getScriptProperties().setProperty('FEEDBACK_ISSUE_' + created.number, JSON.stringify(uploaded.fileIds));
    }
    Logger.log('doPost: GitHub issue created; issue=' + created.number + ', attachments=' + uploaded.fileIds.length);
    return reply({ ok: true, url: created.html_url });
  } catch (err) {
    Logger.log('doPost: unexpected error: ' + (err && err.stack ? err.stack : err));
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
  if (!secret) {
    Logger.log('handleGitHubWebhook: GITHUB_WEBHOOK_SECRET is not configured');
    return reply({ ok: false, error: 'Webhook nicht eingerichtet' });
  }

  var headers = e.headers || {};
  var signature = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '';
  var expected = 'sha256=' + bytesToHex(Utilities.computeHmacSha256Signature(raw, secret));
  if (!secureEqual(signature, expected)) {
    Logger.log('handleGitHubWebhook: signature missing or invalid');
    return reply({ ok: false, error: 'Ungültige Signatur' });
  }

  if (payload.action !== 'closed' || !payload.issue) {
    Logger.log('handleGitHubWebhook: no cleanup needed for this event');
    return reply({ ok: true });
  }
  var key = 'FEEDBACK_ISSUE_' + payload.issue.number;
  var prop = PropertiesService.getScriptProperties();
  var ids = JSON.parse(prop.getProperty(key) || '[]');
  Logger.log('handleGitHubWebhook: closing issue=' + payload.issue.number + '; files=' + ids.length);
  ids.forEach(function (id) {
    try { DriveApp.getFileById(id).setTrashed(true); }
    catch (err) { Logger.log('handleGitHubWebhook: could not trash a Drive attachment: ' + err.message); }
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
  if (!Array.isArray(files) || !files.length) return { links: [], fileIds: [] };
  Logger.log('uploadAttachments: starting; files=' + files.length);
  if (files.length > MAX_ATTACHMENTS) {
    Logger.log('uploadAttachments: too many files; maximum=' + MAX_ATTACHMENTS);
    return { error: 'Es sind höchstens ' + MAX_ATTACHMENTS + ' Bilder erlaubt' };
  }
  if (!folderId) {
    Logger.log('uploadAttachments: FEEDBACK_DRIVE_FOLDER_ID is missing');
    return { error: 'Bilder sind nicht eingerichtet' };
  }
  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) {
    Logger.log('uploadAttachments: Drive folder lookup failed: ' + (err && err.stack ? err.stack : err));
    return { error: 'Bildordner ist nicht erreichbar' };
  }
  Logger.log('uploadAttachments: Drive folder access succeeded; folder=' + folder.getName());

  var links = [];
  var fileIds = [];
  var allowed = files;
  for (var i = 0; i < allowed.length; i++) {
    var file = allowed[i];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(String(file.type || ''))) {
      Logger.log('uploadAttachments: rejected unsupported MIME type at index=' + i);
      return { error: 'Nur Bilddateien sind erlaubt' };
    }
    var data = String(file.data || '');
    if (!data || data.length > 5600000) {
      Logger.log('uploadAttachments: missing or oversized image data at index=' + i);
      return { error: 'Ein Bild ist zu groß' };
    }
    var bytes;
    try { bytes = Utilities.base64Decode(data); }
    catch (err) {
      Logger.log('uploadAttachments: invalid base64 at index=' + i + ': ' + err.message);
      return { error: 'Ungültige Bilddaten' };
    }
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) {
      Logger.log('uploadAttachments: decoded image is empty or oversized at index=' + i);
      return { error: 'Ein Bild ist zu groß' };
    }
    var name = String(file.name || ('Screenshot-' + (i + 1))).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    var uploaded;
    try {
      uploaded = folder.createFile(Utilities.newBlob(bytes, file.type, name));
    } catch (err) {
      // Schritt 1 gescheitert: Datei konnte im Ordner nicht angelegt werden (Schreibrechte, Kontingent, Ordner-ID)
      Logger.log('uploadAttachments: STEP createFile failed at index=' + i + ': ' + (err && err.stack ? err.stack : err));
      trashUploaded(fileIds);
      return { error: 'Bild konnte im Drive-Ordner nicht gespeichert werden' };
    }
    fileIds.push(uploaded.getId());
    try {
      uploaded.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      // Schritt 2 gescheitert: Freigabe „Jeder mit dem Link“ ist oft durch Workspace-Richtlinien gesperrt.
      // Dann muss der Ordner selbst freigegeben sein (Dateien erben die Freigabe), sonst bleibt der Link leer.
      Logger.log('uploadAttachments: STEP setSharing failed at index=' + i + ' (Richtlinie? Ordner selbst freigeben): ' + (err && err.stack ? err.stack : err));
      if (!isFolderShared(folder)) {
        trashUploaded(fileIds);
        return { error: 'Bild-Freigabe ist nicht erlaubt (Ordner freigeben oder Richtlinie prüfen)' };
      }
    }
    links.push('- [' + name + '](' + uploaded.getUrl() + ')');
    Logger.log('uploadAttachments: image uploaded successfully; index=' + i);
  }
  Logger.log('uploadAttachments: complete; uploaded=' + fileIds.length);
  return { links: links, fileIds: fileIds };
}

function isFolderShared(folder) {
  try { return folder.getSharingAccess() !== DriveApp.Access.PRIVATE; }
  catch (err) { Logger.log('isFolderShared failed: ' + err); return false; }
}

// Räumt Dateien dieses Aufrufs auf, wenn der Vorschlag nicht abgeschickt werden kann (keine verwaisten Bilder)
function trashUploaded(fileIds) {
  for (var k = 0; k < fileIds.length; k++) {
    try { DriveApp.getFileById(fileIds[k]).setTrashed(true); }
    catch (err) { Logger.log('trashUploaded failed for index=' + k + ': ' + err); }
  }
}

// Zum Testen im Editor (Ausführen): legt eine Mini-Datei an und prüft Datei-Erstellung und Freigabe getrennt
function testDriveUpload() {
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FEEDBACK_DRIVE_FOLDER_ID'));
  var file = folder.createFile(Utilities.newBlob('test', 'text/plain', 'upload-test.txt'));
  Logger.log('createFile: OK');
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); Logger.log('setSharing: OK'); }
  catch (err) { Logger.log('setSharing: FEHLER ' + err + ' | Ordner geteilt: ' + isFolderShared(folder)); }
  file.setTrashed(true);
}

function testDriveFolderAccess() {
  var folderId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_DRIVE_FOLDER_ID');
  if (!folderId) throw new Error('FEEDBACK_DRIVE_FOLDER_ID ist nicht gesetzt');
  var folder = DriveApp.getFolderById(folderId);
  Logger.log('Drive-Zugriff erfolgreich; Ordnername=' + folder.getName());
  return folder.getName();
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
