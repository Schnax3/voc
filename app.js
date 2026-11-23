// ---- Einstellungen ---------------------------------------------------------
// owner/repo leer lassen = automatisch aus der GitHub-Pages-Adresse ermitteln.
const CFG = { owner: null, repo: null, ignore: ['node_modules', 'assets', 'docs', 'scripts', 'tests'], prefer: /^database/i };
const DAYS = [0, 1, 3, 7, 21]; // Wartezeit in Tagen, bis eine Karte im Kasten 1..5 wieder faellig ist

// ---- Helfer ---------------------------------------------------------------
const app = document.getElementById('app');
// Testversion: liegt auf GitHub Pages unter .../dev/ (oder lokal mit ?env=dev) und liest den Branch "dev".
// Fortschritt und Einstellungen werden dort getrennt gespeichert, damit Tests den echten Stand nicht verändern.
const IS_DEV = /\/dev(\/|$)/.test(location.pathname) || new URLSearchParams(location.search).get('env') === 'dev';
const REF = IS_DEV ? 'dev' : 'HEAD';
const NS = IS_DEV ? 'dev:' : '';
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(NS + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch {} }
};
if (IS_DEV) {
  document.title = 'TEST · ' + document.title;
  document.body.insertAdjacentHTML('afterbegin',
    '<div id="devbar">TESTVERSION (Branch dev) · Fortschritt wird getrennt von der echten Seite gespeichert</div>');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const enc = encodeURIComponent;
const hash = s => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };

// Lokal (python -m http.server) werden die Dateien wie auf GitHub Pages relativ geladen.
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const onPages = location.hostname.endsWith('.github.io') || LOCAL;
const R = (() => {
  let { owner, repo } = CFG;
  if (!owner) {
    if (onPages && !LOCAL) {
      owner = location.hostname.split('.')[0];
      const p = location.pathname.split('/')[1];
      repo = p && !p.includes('.') ? p : location.hostname; // Projekt- oder User-Seite
    } else { owner = 'Schnax3'; repo = 'voc'; } // Fallback fuer lokales Testen
  }
  return { owner, repo };
})();
const rel = p => p.split('/').map(enc).join('/');
const fileUrl = p => onPages ? rel(p) : `https://raw.githubusercontent.com/${R.owner}/${R.repo}/${REF}/${rel(p)}`;
const dataUrl = t => fileUrl(`${t.dir}/${t.file}`);
const imageUrl = (table, path) => /^(?:data:|https?:|blob:)/i.test(path) ? path : fileUrl(`${table}/${path}`);
const audioUrl = (table, path) => /^(?:data:|https?:|blob:)/i.test(path) ? path : fileUrl(path.includes('/') ? path : `${table}/${path}`);
let au, audioPath; // aktuell spielende Audiodatei
// Sprachausgabe des Browsers als Ersatz, wenn eine Karte keine Audiodatei hat
const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let speech = null; // aktuell gesprochene Ausgabe
const updateAudioButtons = () => {
  const playing = Boolean((au && !au.paused) || speech);
  app.querySelectorAll('.spk').forEach(button => {
    button.textContent = playing ? '⏹' : '🔊';
    button.title = spkTitle(playing);
    button.setAttribute('aria-label', playing ? 'Stoppen' : 'Anhören');
  });
};
const stopAudio = () => {
  if (speech) {
    speech = null;
    speechSynthesis.cancel();
    updateAudioButtons();
  }
  if (!au) return;
  const current = au;
  au = null;
  audioPath = null;
  current.pause();
  updateAudioButtons();
};
const play = (table, p, onFail) => {
  const url = audioUrl(table, p);
  if (au && audioPath === url) {
    if (au.paused && !au.ended) {
      au.play().catch(error => {
        console.error(`Audio konnte nicht fortgesetzt werden: ${url}`, error);
      });
    } else if (!au.paused) {
      au.pause();
    } else {
      au.currentTime = 0;
      au.play().catch(error => {
        console.error(`Audio konnte nicht abgespielt werden: ${url}`, error);
      });
    }
    updateAudioButtons();
    return;
  }
  stopAudio();
  const audio = new Audio(url);
  au = audio;
  audioPath = url;
  audio.addEventListener('play', updateAudioButtons);
  audio.addEventListener('pause', updateAudioButtons);
  audio.addEventListener('ended', () => {
    if (au === audio) {
      updateAudioButtons();
    }
  });
  audio.play().catch(error => {
    const stillCurrent = au === audio; // false, wenn der Nutzer inzwischen gestoppt hat
    if (stillCurrent) {
      au = null;
      audioPath = null;
      updateAudioButtons();
    }
    console.error(`Audio konnte nicht abgespielt werden: ${url}`, error);
    if (stillCurrent && onFail) onFail(); // Datei fehlt/defekt: Sprachausgabe als Ersatz
  });
};
const speak = text => {
  if (!canSpeak || !text) return;
  if (speech) { stopAudio(); return; } // zweiter Klick stoppt die Sprachausgabe
  stopAudio();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = 0.9;
  const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith('fr'));
  if (voice) utterance.voice = voice;
  const finished = () => { if (speech === utterance) { speech = null; updateAudioButtons(); } };
  utterance.onend = finished;
  utterance.onerror = finished;
  speech = utterance;
  speechSynthesis.speak(utterance);
  updateAudioButtons();
};
const hasSound = c => Boolean(c.au) || canSpeak;
const sound = c => c.au ? play(c.table, c.au, () => speak(c.fr)) : speak(c.fr);

// ---- Verben: Konjugationen aus verben.json (Schlüssel = Vokabel in Kleinbuchstaben) --
let VERBS = {}, verbsLoaded = null;
const loadVerbs = () => verbsLoaded || (verbsLoaded = fetch(fileUrl('verben.json')).then(r => r.ok ? r.json() : {}).then(v => { VERBS = v || {}; }).catch(() => {}));

// ---- Tabellen automatisch finden (jeder Ordner mit einer .json = eine Tabelle) --
let tables = [];
const sortTables = list => list
  .map(t => { const n = t.file.match(/^database-(\d+)\.json$/i); return { ...t, order: n ? Number(n[1]) : Infinity }; })
  .sort((a, b) => a.order - b.order || a.dir.localeCompare(b.dir, 'de', { numeric: true }))
  .map(({ order, ...t }) => t);
const titleOf = dir => (tables.find(t => t.dir === dir) || {}).title || dir;
async function discover(force) {
  const key = `vk:tables2:${R.owner}/${R.repo}`, c = LS.get(key);
  // 1) index.json (wird von der GitHub-Action erzeugt, kein API-Limit)
  try {
    const r = await fetch(fileUrl('index.json'), force ? { cache: 'no-store' } : undefined);
    if (r.ok) {
      const idx = JSON.parse((await r.text()).replace(/^﻿/, ''));
      if (idx && Array.isArray(idx.tables)) {
        const list = sortTables(idx.tables.filter(t => t && t.dir && t.file).map(t => ({ dir: t.dir, file: t.file, title: t.title || '' })));
        LS.set(key, { t: Date.now(), tables: list });
        return list;
      }
    }
  } catch { /* weiter mit Fallback */ }
  // 2) Fallback: GitHub-API (nur 60 Abfragen pro Stunde und Netzwerk)
  if (c && !force && Date.now() - c.t < 18e5) return c.tables; // 30 Min Cache
  try {
    const r = await fetch(`https://api.github.com/repos/${R.owner}/${R.repo}/git/trees/${REF}?recursive=1`);
    if (!r.ok) throw new Error('GitHub-API ' + r.status);
    const { tree } = await r.json(), map = {};
    for (const e of tree) {
      if (e.type !== 'blob') continue;
      const ex = e.path.match(/^(lektionen|uebungen)\/([^/._][^/]*)\/([^/]+\.json)$/); // lektionen/<name>/database.json, uebungen/<name>/uebung.json
      if (ex) { (map[ex[1] + '/' + ex[2]] ??= []).push(ex[3]); continue; }
      const top = e.path.split('/')[0];
      if (top === e.path || '._'.includes(top[0]) || CFG.ignore.includes(top)) continue;
      const m = e.path.match(/^[^/]+\/([^/]+\.json)$/);
      if (m) (map[top] ??= []).push(m[1]);
    }
    const list = sortTables(Object.entries(map)
      .map(([dir, files]) => ({ dir, file: files.find(f => CFG.prefer.test(f)) || files[0] })));
    LS.set(key, { t: Date.now(), tables: list });
    return list;
  } catch (e) { if (c) return c.tables; throw e; }
}

// ---- Vokabeln laden (erst, wenn eine Tabelle angehakt wird) -------------------
const DB = new Map();
const INITIAL_LOAD_KEY = `vk:all-loaded:v3:${R.owner}/${R.repo}`; // v3: Lektionen liegen in lektionen/ (v2: Ordner umbenannt), alles einmal neu laden
async function load(t, force = false) {
  if (!force && DB.has(t.dir)) return DB.get(t.dir);
  const r = await fetch(dataUrl(t), force ? { cache: 'no-store' } : undefined);
  if (!r.ok) throw new Error(`${t.dir}/${t.file}: ${r.status}`);
  const raw = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
  await loadVerbs();
  const cards = raw.filter(e => e && e.french && e.german).map(e => {
    const fr = e.vocabulary || e.french;
    // Übung (Verb -> Passé composé): french = Verb, german = Übersetzung, answer = richtige Form
    if (e.answer) return { id: t.dir + '::' + hash(e.french + '|' + e.german), table: t.dir, fr: e.french, de: e.german,
      pc: String(e.answer), ref: e.ref || '', example: '', img: [], au: null };
    const verb = VERBS[String(e.vocabulary || '').trim().toLowerCase()];
    return {
      id: t.dir + '::' + hash(e.french + '|' + e.german), table: t.dir,
      fr, de: e.german, example: e.french, img: [].concat(e.image || []).filter(Boolean),
      au: e.audio || null, conj: verb || null
    };
  });
  migrateLegacyIds(cards);
  migrateFixedCards(cards);
  DB.set(t.dir, cards);
  const meta = LS.get('vk:meta', {}); meta[t.dir] = cards.map(c => c.id); LS.set('vk:meta', meta);
  return cards;
}

async function loadAllTables(force = false) {
  if (force) {
    DB.clear();
    LS.set('vk:meta', {});
  }
  const failures = [];
  await Promise.all(tables.map(async t => {
    try { await load(t, force); }
    catch (e) { failures.push(`${t.dir}: ${e.message}`); }
  }));
  list(); updateGo();
  return failures;
}

// ---- Migration: umbenannte Ordner und geänderte Karten-IDs ------------------------
// Alte Ordnernamen -> aktuelle. Der Fortschritt hängt am Ordnernamen (ID = Ordner::Hash) und wird hier umgezogen.
const DIR_RENAMES = {
  // alte Namen (Großschreibung, Leerzeichen) und die Namen vor dem Umzug nach lektionen/ -> aktueller Pfad
  'Dec3-U1-Revision-Negation': 'lektionen/dec3-u1-revision-negation',
  'Dec3-U2-A': 'lektionen/dec3-u2-a',
  'Dec3-U2-DE': 'lektionen/dec3-u2-de',
  'Dec3-U2-Rapp': 'lektionen/dec3-u2-rapp',
  'Découvertes': 'lektionen/dec3-u1-de',
  'Tu te rappelles': 'lektionen/dec3-u1-rapp',
  'U1A (AUDIO)': 'lektionen/dec3-u1a',
  'U1A(letztes_jahr)': 'lektionen/dec3-u1a-letztes-jahr',
  'U1B (AUDIO)': 'lektionen/dec3-u1b',
  'U1B_2': 'lektionen/dec3-u1b3-verben',
  'U7A (AUDIO)': 'lektionen/dec2-u7a',
  'dec3-u1-revision-negation': 'lektionen/dec3-u1-revision-negation',
  'dec3-u2-a': 'lektionen/dec3-u2-a',
  'dec3-u2-de': 'lektionen/dec3-u2-de',
  'dec3-u2-rapp': 'lektionen/dec3-u2-rapp',
  'dec3-u1-de': 'lektionen/dec3-u1-de',
  'dec3-u1-rapp': 'lektionen/dec3-u1-rapp',
  'dec3-u1a': 'lektionen/dec3-u1a',
  'dec3-u1a-letztes-jahr': 'lektionen/dec3-u1a-letztes-jahr',
  'dec3-u1b': 'lektionen/dec3-u1b',
  'dec3-u1b3-verben': 'lektionen/dec3-u1b3-verben',
  'dec2-u7a': 'lektionen/dec2-u7a'
};
(function migrateRenamedDirs() {
  const better = (a, b) => !b || a.b > b.b || (a.b === b.b && a.d > b.d);
  const prog = LS.get('vk:progress', {});
  let changed = false;
  for (const k of Object.keys(prog)) {
    const i = k.indexOf('::'), dir = i < 0 ? k : k.slice(0, i), to = DIR_RENAMES[dir];
    if (!to || i < 0) continue;
    const key = to + k.slice(i);
    if (better(prog[k], prog[key])) prog[key] = prog[k];
    delete prog[k]; changed = true;
  }
  if (changed) LS.set('vk:progress', prog);
  const sel0 = LS.get('vk:sel', []), sel1 = [...new Set(sel0.map(d => DIR_RENAMES[d] || d))];
  if (sel1.join('|') !== sel0.join('|')) LS.set('vk:sel', sel1);
  const meta = LS.get('vk:meta', {});
  let metaChanged = false;
  for (const d of Object.keys(meta)) if (DIR_RENAMES[d]) { delete meta[d]; metaChanged = true; }
  if (metaChanged) LS.set('vk:meta', meta);
})();

// Früher stand in manchen Karten das Liaison-Zeichen ⁔ (U+2054), jetzt ‿ (U+203F). Weil die ID aus dem Text
// entsteht, wird der Fortschritt unter der alten ID auf die neue übernommen (alle Mischformen werden probiert).
function legacyVariants(text) {
  const parts = text.split('‿'), n = parts.length - 1;
  if (!n || n > 6) return [];
  const out = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    let s = parts[0];
    for (let i = 0; i < n; i++) s += ((mask >> i) & 1 ? '⁔' : '‿') + parts[i + 1];
    out.push(s);
  }
  return out;
}
// Korrigierte Karten (Tippfehler usw.): Die ID entsteht aus dem Text, deshalb wird der Fortschritt von der
// alten auf die neue ID übertragen. Eintrag: [Lektion, alter Text, alte Übersetzung, neuer Text, neue Übersetzung].
const CARD_FIXES = [
  ["lektionen/dec2-u7a", "La voiture roule (Inf.: rouler) à 110 kilomètres à l'heure .", "das Auto fährt", "La voiture roule (Inf.: rouler) à 110 kilomètres à l'heure.", "das Auto fährt"],
  ["lektionen/dec2-u7a", "Combien d' heures est-ce qu'on met pour aller de  Blain à Nantes?", "Wie lange braucht man von … bis…?", "Combien d'heures est-ce qu'on met pour aller de  Blain à Nantes?", "Wie lange braucht man von … bis…?"],
  ["lektionen/dec2-u7a", "Combien d'heures est-ce qu'on met pour aller de  Blain à Nantes?", "Wie lange braucht man von … bis…?", "Combien d'heures est-ce qu'on met pour aller de Blain à Nantes?", "Wie lange braucht man von … bis…?"],
  ["lektionen/dec2-u7a", "On met environ une heure pour aller de  Blain à Nantes en voiture.", "Man braucht mit dem Auto etwa 1 h von … bis…", "On met environ une heure pour aller de Blain à Nantes en voiture.", "Man braucht mit dem Auto etwa 1 h von … bis…"],
  ["lektionen/dec3-u1-rapp", "Dans le texte, je marque les passages importants.", "interessant", "Dans le texte, je marque les passages intéressants.", "interessant"],
  ["lektionen/dec3-u1-rapp", "Douze mois, C'est‿une année.", "ein Jahr", "Douze mois, c'est‿une année.", "ein Jahr"],
  ["lektionen/dec3-u1-rapp", "Tu dois (infintif: devoir) faire ton travail!", "etw. tun müssen", "Tu dois (infinitif: devoir) faire ton travail!", "etw. tun müssen"],
  ["lektionen/dec3-u1a", "Voilà le secretariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre.j'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: jai inscrit…", "jemanden für etwas anmelden", "Voilà le secrétariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre.j'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: jai inscrit…", "jemanden für etwas anmelden"],
  ["lektionen/dec3-u1a", "Voilà le secrétariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre.j'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: jai inscrit…", "jemanden für etwas anmelden", "Voilà le secrétariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre. J'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: jai inscrit…", "jemanden für etwas anmelden"],
  ["lektionen/dec3-u1a", "Voilà le secrétariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre. J'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: jai inscrit…", "jemanden für etwas anmelden", "Voilà le secrétariat d'une école primaire. Les parents y vont pour inscrire leurs‿enfants à l'école: En avril ou mai, ils mettent les noms de leurs‿enfants sur une liste parce qu'ils veulent que leurs‿enfants entrent à cette école en septembre. J'inscris, nous‿inscrivons, elles‿inscrivent; passé composé: j'ai inscrit…", "jemanden für etwas anmelden"],
  ["lektionen/dec3-u1b", "Le bus est déjà la ⤄ Le bus n'est pas encore là.", "schon ⤄ noch nicht.", "Le bus est déjà là ⤄ Le bus n'est pas encore là.", "schon ⤄ noch nicht."],
  ["lektionen/dec3-u1-revision-negation", "Le bus est déjà la ⤄ Le bus n'est pas encore là.", "schon ⤄ noch nicht.", "Le bus est déjà là ⤄ Le bus n'est pas encore là.", "schon ⤄ noch nicht."],
  ["lektionen/dec3-u1b3-verben", "Il va à l'école pour apprendre beaucoup de choses. J'apprends, nous‿apprenons, ils‿apprennent, j'ai appris L'enfant apprend à aller à vélo.", "lernen; das Kind lernt Fahrradfahren", "Il va à l'école pour apprendre beaucoup de choses. J'apprends, nous‿apprenons, ils‿apprennent, j'ai appris. L'enfant apprend à aller à vélo.", "lernen; das Kind lernt Fahrradfahren"],
  ["lektionen/dec3-u1b3-verben", "Elle préfère (Inf: préférer) le chocolat. Je préfère, nous préférons, elles préfèrent Je peux aller à pied aussi, mais je préfère ____ aller à vélo.", "lieber mögen; ich fahre lieber Rad.", "Elle préfère (Inf: préférer) le chocolat. Je préfère, nous préférons, elles préfèrent. Je peux aller à pied aussi, mais je préfère ____ aller à vélo.", "lieber mögen; ich fahre lieber Rad."],
  ["lektionen/dec3-u1b3-verben", "Il veut essayer de faire du saut à l'élastique, mais il hésite: «Est-ce que c'est dangereux?» Il essaie de réparer la voiture, mais c'est difficile. j'essaie, nous‿essayons, elles‿essaient, j'ai essayé", "versuchen – ça se conjugue comme envoyer", "Il veut essayer de faire du saut à l'élastique, mais il hésite: «Est-ce que c'est dangereux?» Il essaie de réparer la voiture, mais c'est difficile. j'essaie, nous‿essayons, elles‿essaient, j'ai essayé", "versuchen – konjugiert wie envoyer"],
  ["lektionen/dec3-u2-a", "Il pense que Maman aime son petit frère >plusieurs que lui. Donc, il est jaloux (f: jalouse) de son petit frère.", "eifersuchtig; auch: neidisch auf jmdn.", "Il pense que Maman aime son petit frère plus que lui. Donc, il est jaloux (f: jalouse) de son petit frère.", "eifersuchtig; auch: neidisch auf jmdn."],
  ["lektionen/dec3-u2-a", "Voici la Côte d'Ivoire. C'est un pays d'Afrique. On fait de l'ivoire des dents des‿éléphants.", "Elfenbein-Küste", "Voici la Côte d'Ivoire. C'est un pays d'Afrique. On fait de l'ivoire des dents des‿éléphants.", "Elfenbeinküste"],
  ["lektionen/dec3-u2-a", "c'est le principal / la principale.", "Schulleiter/in", "C'est le principal / la principale.", "Schulleiter/in"],
  ["lektionen/dec3-u2-de", "On ne connaît pas encore le criminel, mais la police a un soupçon: La police croit savoir qui est le criminel", "Verdacht", "On ne connaît pas encore le criminel, mais la police a un soupçon: La police croit savoir qui est le criminel.", "Verdacht"],
  ["lektionen/dec3-u2-rapp", "d‘abord, ensuite, enfin / finalement", "Zunächst; anschließend; am Ende / Schließlich; auch: endlich", "d'abord, ensuite, enfin / finalement", "Zunächst; anschließend; am Ende / Schließlich; auch: endlich"],
  ["lektionen/dec3-u2-rapp", "Jean ne dit rien, mais tout‿à coup (= d‘un moment à l‘autre), il commence à rire.", "plötzlich", "Jean ne dit rien, mais tout‿à coup (= d'un moment à l'autre), il commence à rire.", "plötzlich"],
  ["lektionen/dec3-u2-rapp", "Dans un hôtel de luxe, il y a des suites (des appartements avec une pièce après l‘autre)", "Suite (Folge von Zimmern)", "Dans un hôtel de luxe, il y a des suites (des appartements avec une pièce après l'autre)", "Suite (Folge von Zimmern)"],
  ["lektionen/dec3-u2-rapp", "Il fait un coup sur la table.", "Schlag", "Il donne un coup sur la table.", "Schlag"]
];
function migrateFixedCards(cards) {
  let changed = false;
  for (const c of cards) {
    for (const [dir, oldFr, oldDe, newFr, newDe] of CARD_FIXES) {
      if (dir !== c.table || c.example !== newFr || c.de !== newDe) continue;
      const old = dir + '::' + hash(oldFr + '|' + oldDe);
      if (!P[old]) continue;
      if (!P[c.id]) P[c.id] = P[old];
      delete P[old]; changed = true;
    }
  }
  if (changed) save();
}
function migrateLegacyIds(cards) {
  let changed = false;
  for (const c of cards) {
    if (!c.example || !c.example.includes('‿')) continue;
    for (const variant of legacyVariants(c.example)) {
      const old = c.table + '::' + hash(variant + '|' + c.de);
      if (!P[old]) continue;
      if (!P[c.id]) P[c.id] = P[old];
      delete P[old]; changed = true;
    }
  }
  if (changed) save();
}

// ---- Fortschritt (Leitner-Kasten 1-5, pro Browser gespeichert) -----------------
// Pro Karte: b = Kasten, d = fällig ab (ms), w = Fehlerzähler (+1 falsch, -1 richtig, min. 0)
const HARD_AT = 2; // ab so vielen "Netto-Fehlern" gilt eine Karte als schwierig
let P = LS.get('vk:progress', {});
const st = id => P[id] || { b: 1, d: 0, w: 0 };
const isHard = id => (st(id).w || 0) >= HARD_AT;
const save = () => LS.set('vk:progress', P);
let sel = new Set(LS.get('vk:sel', []));
let opt = LS.get('vk:opt', { dir: 'fr', all: false, img: true });
let cheat = LS.get('vk:cheat', false); // versteckter Cheat-Modus (Alt+Shift+C im Hauptmenue)
document.documentElement.classList.toggle('big', Boolean(opt.big));

// Tageszähler und Serie (nur lokal): { 'JJJJ-MM-TT': Anzahl bewerteter Karten }
let S = LS.get('vk:stats', {});
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const bumpToday = by => {
  const key = dayKey(new Date()), n = (S[key] || 0) + by;
  if (n > 0) S[key] = n; else delete S[key];
  LS.set('vk:stats', S);
};
const streakDays = () => {
  const day = new Date();
  if (!S[dayKey(day)]) day.setDate(day.getDate() - 1); // heute noch nichts geübt: Serie von gestern zählt weiter
  let n = 0;
  while (S[dayKey(day)] > 0) { n++; day.setDate(day.getDate() - 1); }
  return n;
};

// Zurück-Taste (Android, Browser): beendet die Runde statt die Seite zu verlassen
let subscreen = false; // Runde oder Einstellungen offen
const enterScreen = () => { subscreen = true; if (!(window.history.state && window.history.state.sub)) window.history.pushState({ sub: true }, ''); };
const leaveScreen = () => { if (window.history.state && window.history.state.sub) window.history.back(); else home(); };

// ---- Offline (Service Worker + gezielter Audio-/Bilder-Speicher) -----------------
// Die App selbst und die Vokabel-JSONs merkt sich der Service Worker automatisch (sw.js).
// Audio und Bilder (viele MB) werden nur für Lektionen gespeichert, die man dafür auswählt.
const SW_OK = onPages && 'serviceWorker' in navigator && 'caches' in window;
const MEDIA_CACHE = 'vk-media-' + new URL('./', location.href).pathname.replace(/\W+/g, '_'); // muss zu sw.js passen
const OFFLINE_SAVED_KEY = `vk:offline-saved:${R.owner}/${R.repo}`;
const OFFLINE_KNOWN_KEY = `vk:offline-known:${R.owner}/${R.repo}`;
const OFFLINE_DOWNLOAD_CONCURRENCY = 8;
const offlineTableKey = table => `${table.dir}/${table.file}`;
// Alle Audio- und Bild-Adressen der (bereits geladenen) Lektionen
function offlineUrlList(dirs) {
  const urls = new Set();
  for (const d of dirs) for (const c of DB.get(d) || []) {
    if (c.au) urls.add(new URL(audioUrl(c.table, c.au), location.href).href);
    for (const s of c.img) urls.add(new URL(imageUrl(c.table, s), location.href).href);
  }
  return [...urls].filter(u => new URL(u).origin === location.origin);
}
async function saveOffline(dirs, progress) {
  const cache = await caches.open(MEDIA_CACHE), list = offlineUrlList(dirs);
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < list.length) {
      const url = list[next++];
      try {
        if (!(await cache.match(url))) {
          const r = await fetch(url);
          if (r.ok) await cache.put(url, r); else failed++;
        }
      } catch { failed++; }
      progress(++done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OFFLINE_DOWNLOAD_CONCURRENCY, list.length) }, worker));
  return { total: list.length, failed };
}

const idsOf = d => DB.has(d) ? DB.get(d).map(c => c.id) : (LS.get('vk:meta', {})[d] || null);

// ---- Startseite ------------------------------------------------------------
function home() {
  subscreen = false;
  document.getElementById('retype')?.remove();
  stopAudio();
  document.onkeydown = e => {
    if (e.altKey && e.shiftKey && e.code === 'KeyC') {
      e.preventDefault();
      cheat = !cheat;
      LS.set('vk:cheat', cheat);
    }
  };
  app.innerHTML = `<div class="hdr"><img class="logo" alt="" width="40" height="40" src="${esc(logoSmall())}"><h1>Vokabelkasten</h1>
    <button id="settings" class="gear" type="button" aria-label="Einstellungen" title="Einstellungen">⚙</button></div>
  <p class="mut lead">Wähle die Lektionen, die du üben willst.</p>
  <div class="btns small" id="offline-actions" hidden>
    <button id="offline-setup" type="button">Möchtest du offline gehen?</button>
    <button id="offline-update" type="button" hidden>Offline-Inhalte aktualisieren</button>
  </div>
  <p class="today" id="today" role="status"></p>
  <div class="progress goal" id="goal-bar" role="progressbar" aria-label="Tagesziel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><i></i></div>
  <details class="help"><summary>So funktioniert's</summary>
    <p>Jede Karte liegt in einem von 5 Kästen. Weißt du sie, rückt sie einen Kasten weiter und kommt erst nach ${DAYS.slice(1).join(', ')} Tagen wieder. Weißt du sie nicht, geht sie zurück in Kasten 1 und kommt in der Runde gleich nochmal.</p>
    <p>Karten, die du mehrfach falsch hattest, gelten als „schwierig“ und lassen sich gezielt üben. Alles wird nur in diesem Browser gespeichert. Mit Export und Import (unter ⚙ Einstellungen) ziehst du auf ein anderes Gerät um.</p>
  </details>
  <button id="sa-open" class="topic entry" type="button"><span class="sym" aria-hidden="true">🎓</span><span class="tt"><b>Schulaufgabe vorbereiten</b><small>Übungen zu Verben, Verneinung, Vergangenheit und Textproduktion</small></span></button>
  <div id="list"></div>
  <div id="secret-slot"></div>
  <section class="panel" aria-label="Diese Runde">
    <h2>Diese Runde</h2>
    <div class="opts">
      <label>Richtung
        <select id="dir"><option value="fr">Französisch → Deutsch</option><option value="de">Deutsch → Französisch</option><option value="mix">Gemischt</option></select></label>
      <label>Karten pro Runde
        <select id="limit"><option value="0">Alle</option><option value="10">10</option><option value="20">20</option><option value="30">30</option><option value="50">50</option></select></label>
      <label><input type="checkbox" id="all"> Auch Karten üben, die noch nicht fällig sind</label>
      <label><input type="checkbox" id="hard"> Nur schwierige Karten (mehrfach falsch)</label>
    </div>
    <button id="more-opts" class="linklike" type="button">Mehr Lerneinstellungen (Tagesziel, Verben, Tastatur)</button>
  </section>
  <div class="start"><button id="go" class="primary">Starten</button></div>`;
  const $ = s => app.querySelector(s);
  $('#dir').value = opt.dir; $('#all').checked = opt.all; $('#limit').value = String(opt.limit || 0);
  $('#hard').checked = opt.hard || false;
  renderToday();
  if (typeof mountGeheim === 'function') mountGeheim($('#secret-slot'));
  const setOpt = () => {
    opt = { ...opt, dir: $('#dir').value, all: $('#all').checked, hard: $('#hard').checked, limit: Number($('#limit').value) };
    LS.set('vk:opt', opt); updateGo();
  };
  ['#dir', '#limit', '#all', '#hard'].forEach(s => $(s).onchange = setOpt);
  $('#more-opts').onclick = () => {
    enterScreen(); settings();
    app.querySelector('#sec-learn').scrollIntoView({ block: 'start' });
  };
  $('#go').onclick = () => { const { queue, review } = nextQueue(); if (queue.length) learn(queue, review); };
  $('#sa-open').onclick = openSchulaufgabe;
  $('#settings').onclick = () => { enterScreen(); settings(); };
  $('#offline-setup').onclick = () => {
    enterScreen(); settings();
    app.querySelector('#sec-offline').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const offlineActions = $('#offline-actions'), setup = $('#offline-setup'), update = $('#offline-update');
  const refreshOfflineActions = async () => {
    if (!SW_OK) return;
    try {
      const savedDirs = LS.get(OFFLINE_SAVED_KEY, []);
      const cachedFiles = await (await caches.open(MEDIA_CACHE)).keys();
      const hasOfflineContent = savedDirs.length > 0 || cachedFiles.length > 0;
      let knownTables = LS.get(OFFLINE_KNOWN_KEY, null);
      if (!Array.isArray(knownTables)) {
        knownTables = tables.map(offlineTableKey);
        LS.set(OFFLINE_KNOWN_KEY, knownTables);
      }
      const newTables = tables.filter(t => !knownTables.includes(offlineTableKey(t)));
      setup.hidden = hasOfflineContent;
      update.hidden = !hasOfflineContent || newTables.length === 0;
      update.textContent = `Offline-Inhalte aktualisieren${newTables.length ? ` (${newTables.length})` : ''}`;
      offlineActions.hidden = setup.hidden && update.hidden;
    } catch (error) {
      console.error('Offline-Status konnte nicht gelesen werden:', error);
    }
  };
  update.onclick = async () => {
    const knownTables = LS.get(OFFLINE_KNOWN_KEY, []);
    const newTables = tables.filter(t => !knownTables.includes(offlineTableKey(t)));
    if (!newTables.length) { await refreshOfflineActions(); return; }
    update.disabled = true;
    update.textContent = 'Aktualisiere Offline-Inhalte …';
    try {
      await Promise.all(newTables.map(t => load(t, true)));
      const result = await saveOffline(newTables.map(t => t.dir), (i, n) => {
        update.textContent = `Aktualisiere offline … ${i}/${n}`;
      });
      const savedDirs = new Set(LS.get(OFFLINE_SAVED_KEY, []));
      newTables.forEach(t => savedDirs.add(t.dir));
      LS.set(OFFLINE_SAVED_KEY, [...savedDirs]);
      if (result.failed) throw new Error(`${result.failed} Datei(en) fehlen oder konnten nicht geladen werden.`);
      LS.set(OFFLINE_KNOWN_KEY, tables.map(offlineTableKey));
      await refreshOfflineActions();
    } catch (error) {
      console.error('Offline-Inhalte konnten nicht aktualisiert werden:', error);
      update.textContent = 'Update fehlgeschlagen – erneut versuchen';
    } finally {
      update.disabled = false;
    }
  };
  refreshOfflineActions();
  list(); updateGo();
}

// Lektionen nach Einheit gruppieren: "Dec3 · U1 Tu te rappelles" -> Gruppe "Dec3 · U1", Name "Tu te rappelles"
const groupOf = t => {
  const title = t.title || t.dir;
  if (t.dir.startsWith('uebungen/')) return { key: 'Übungen', rank: 9, name: title.replace(/^Übung\s*·\s*/, '') };
  const m = title.match(/^(\S+ · U\d+)\s+(.+)$/);
  if (m) return { key: m[1], rank: 1, name: /^[A-Z](\s|$)/.test(m[2]) ? 'Teil ' + m[2] : m[2] };
  return { key: 'Weitere', rank: 5, name: title };
};
async function setSelected(dirs, on) {
  for (const d of dirs) on ? sel.add(d) : sel.delete(d);
  LS.set('vk:sel', [...sel]);
  list(); updateGo();
  if (on) {
    await Promise.all(dirs.map(async d => {
      try { await load(tables.find(t => t.dir === d)); } catch { sel.delete(d); }
    }));
    LS.set('vk:sel', [...sel]);
  }
  list(); updateGo();
}

function list() {
  const el = app.querySelector('#list'); if (!el) return;
  const now = Date.now(), groups = new Map();
  for (const t of tables) {
    const g = groupOf(t);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push({ t, name: g.name });
  }
  const ordered = [...groups.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key, 'de', { numeric: true }));
  el.innerHTML = ordered.map((g, gi) => {
    const dirs = g.items.map(x => x.t.dir), chosen = dirs.filter(d => sel.has(d)).length;
    const rows = g.items.map(({ t, name }) => {
      const ids = idsOf(t.dir), n = ids ? ids.length : null;
      let info = 'noch nicht geladen', bar = '';
      if (n !== null) {
        const box = [0, 0, 0, 0, 0]; let due = 0, hard = 0;
        ids.forEach(id => { const s = st(id); box[s.b - 1]++; if (s.d <= now) due++; if (isHard(id)) hard++; });
        info = `${n} Karten · ${due} fällig${hard ? ` · ${hard} schwierig` : ''}`;
        bar = `<div class="bar" title="Kasten 1–5: ${box.join(' / ')}">${box.map(x => `<i style="width:${n ? x / n * 100 : 0}%"></i>`).join('')}</div>`;
      }
      return `<label class="row" title="${esc(t.title || t.dir)}"><input type="checkbox" data-d="${esc(t.dir)}" ${sel.has(t.dir) ? 'checked' : ''}>
        <span style="flex:1"><b>${esc(name)}</b><span class="mut">${info}</span>${bar}</span></label>`;
    }).join('');
    return `<section class="grp"><div class="grp-h"><h2>${esc(g.key)}</h2><span class="mut">${chosen} von ${dirs.length} gewählt</span>
      <button type="button" class="lnk" data-g="${gi}">${chosen === dirs.length ? 'keine' : 'alle'}</button></div>${rows}</section>`;
  }).join('') || '<p class="mut">Keine Tabellen gefunden. Lege einen Ordner mit einer .json-Datei an.</p>';
  el.querySelectorAll('input').forEach(cb => cb.onchange = () => setSelected([cb.dataset.d], cb.checked));
  el.querySelectorAll('.lnk').forEach(button => button.onclick = () => {
    const dirs = ordered[Number(button.dataset.g)].items.map(x => x.t.dir);
    setSelected(dirs, !dirs.every(d => sel.has(d)));
  });
}

const conjActive = c => Boolean(c.conj) && (opt.conjPres !== false || opt.conjPc !== false);
const cards = n => `${n} ${n === 1 ? 'Karte' : 'Karten'}`;
function renderToday() {
  const el = app.querySelector('#today'); if (!el) return;
  const n = S[dayKey(new Date())] || 0, days = streakDays(), goal = goalToday();
  const done = goal > 0 && n >= goal ? ' 🎯' : '';
  el.textContent = n || days || goal ? `Heute geübt: ${goal ? `${n} von ${cards(goal)}` : cards(n)}${done}${days >= 2 ? ` · ${days} Tage in Folge 🔥` : ''}` : '';
  const bar = app.querySelector('#goal-bar');
  if (bar) { bar.hidden = !goal; if (goal) { const pct = Math.min(100, Math.round(n / goal * 100)); bar.setAttribute('aria-valuenow', String(pct)); bar.firstElementChild.style.width = `${pct}%`; } }
}
function updateGo() {
  const go = app.querySelector('#go'); if (!go) return;
  const { queue, review } = nextQueue(), n = queue.length;
  go.textContent = n ? `${review ? 'Weiter üben' : 'Starten'} (${cards(n)})` : 'Starten';
  go.disabled = n === 0;
  let note = app.querySelector('#go-hint');
  if (!note) {
    note = document.createElement('p');
    note.id = 'go-hint'; note.className = 'hint'; note.setAttribute('role', 'status');
    go.parentElement.append(note);
  }
  note.textContent = review ? 'Heute ist nichts mehr fällig. Du kannst trotzdem weiterlernen: Es kommen die Karten, die am schwächsten sind.' : n ? '' : !sel.size ? 'Wähle oben mindestens eine Lektion aus.'
    : opt.hard ? 'In den gewählten Lektionen gibt es keine schwierigen Karten.'
    : opt.all ? 'In den gewählten Lektionen gibt es keine Karten.'
    : 'Heute ist nichts fällig. Schalte „Auch noch nicht fällige Karten üben“ ein, um trotzdem zu üben.';
}

// ---- Lernen ----------------------------------------------------------------
function buildQueue(o = opt) {
  const now = Date.now(), q = [];
  for (const d of sel) for (const c of DB.get(d) || [])
    if (o.hard ? isHard(c.id) : (o.all || st(c.id).d <= now)) q.push({ c, dir: c.pc || conjActive(c) ? 'fr' : opt.dir === 'mix' ? (Math.random() < .5 ? 'fr' : 'de') : opt.dir });
  q.sort(() => Math.random() - .5);                    // mischen
  q.sort((a, b) => st(a.c.id).b - st(b.c.id).b); // niedrige Kaesten zuerst
  return o.limit > 0 ? q.slice(0, o.limit) : q;   // optional: nur die ersten N Karten
}

// ---- Weiterlernen ohne Ende ------------------------------------------------
// Ist nichts mehr fällig, geht es mit einer Wiederholung weiter (die schwächsten Karten zuerst), statt dass das Lernen endet.
const endlessOn = () => opt.endless !== false;
// Eingetippte Vokabel prüfen (Groß-/Kleinschreibung egal, Liaison-Zeichen und Satzzeichen am Ende egal).
// Erlaubt sind auch Kurzformen ohne „+ Inf.“, „qn.“/„qc.“ und ohne Klammern sowie jede Variante bei „/“ und „ou“.
const normAns = text => String(text).toLowerCase().replace(/[’‘`´]/g, "'").replace(/[‿⁔]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '').trim();
function answerForms(fr) {
  const base = normAns(fr), forms = new Set();
  const noInf = x => x.replace(/\s*\+\s*inf\.?/g, '').trim();
  const noParen = x => x.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const noRef = x => x.replace(/\s+(qn|qc|qqn|qqch)\.?(?=\s|$)/g, '').replace(/\s+/g, ' ').trim();
  for (const part of [base, ...base.split(/\s*\/\s*|\s+ou\s+/)]) {
    for (const v of [part, noInf(part), noParen(part), noParen(noInf(part)), noRef(noParen(noInf(part)))]) if (v) forms.add(v);
  }
  return [...forms];
}
const checkTyped = (typed, fr) => answerForms(fr).includes(normAns(typed));
const keyAudio = () => (opt.keymap === 'alt' ? ' ' : 'p');
const keyReveal = () => (opt.keymap === 'alt' ? 'p' : ' ');
const keysOff = () => Boolean(opt.keysOff);
const spkTitle = (stop = false) => (stop ? 'Stoppen' : 'Anhören') + (keysOff() ? '' : ' (' + keyAudioName() + ')');
const keyAudioName = () => (opt.keymap === 'alt' ? 'Leertaste' : 'P');
const goalToday = () => (opt.goal === undefined ? 20 : Number(opt.goal) || 0); // Tagesziel in Karten, 0 = aus
function nextQueue() {
  let queue = buildQueue(), review = false;
  if (!queue.length && endlessOn() && sel.size && !opt.hard) { queue = buildQueue({ ...opt, all: true }); review = queue.length > 0; }
  return { queue, review };
}
function showToast(text) {
  let toast = document.getElementById('toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; toast.setAttribute('role', 'status'); document.body.append(toast); }
  toast.textContent = text; toast.classList.add('on');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('on'), 4500);
}

// Eingabe prüfen: Groß-/Kleinschreibung, Apostroph-Form und Leerzeichen sind egal; "(e)" darf fehlen oder als "e" stehen.
const normPc = s => s.toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim();
// "(e)" und "(s)" in der Lösung sind optional und dürfen auch ausgeschrieben werden (venu(e)s -> venus, venues).
const expandOptional = text => {
  let variants = [normPc(text)];
  for (const [mark, letter] of [['(e)', 'e'], ['(s)', 's']])
    variants = variants.flatMap(v => v.includes(mark) ? [v.split(mark).join(''), v.split(mark).join(letter)] : [v]);
  return variants;
};
const checkPc = (typed, expected) => {
  const t = normPc(typed);
  return t !== '' && expandOptional(expected).includes(t);
};
// Eine Zeile der Konjugation: Pronomen ("je", "j'", "il") als Beschriftung, der Rest wird eingetippt.
const splitPerson = form => { const m = form.match(/^(j'|\S+ )(.*)$/); return m ? [m[1].trim(), m[2]] : ['', form]; };

function learn(q, isReview = false) {
  enterScreen();
  let lastAuto = null;
  let shown = false, hint = false, typedAnswer = '', typedForms = {}, ok = 0, bad = 0, retyped = false, retypeOpen = false;
  const total = q.length, missed = new Map(), history = [];
  const roundCards = [...new Map(q.map(x => [x.c.id, x.c]).filter(([, c]) => c)).values()];
  const lessons = [...new Set(q.map(x => titleOf(x.c.table)))];
  const preloadedImages = new Set();
  const preloadNextImages = () => {
    const next = q[1];
    if (!opt.img || !next) return;
    for (const path of next.c.img) {
      const url = imageUrl(next.c.table, path);
      if (preloadedImages.has(url)) continue;
      preloadedImages.add(url);
      const image = new Image();
      image.decoding = 'async';
      image.src = url;
    }
  };
  // Aussprache automatisch: Französisch vorn -> beim Zeigen der Karte, sonst beim Aufdecken. Nur einmal je Seite.
  const autoPlay = (c, key, fn) => {
    if (!opt.auto) return;
    const mark = c.id + key;
    if (lastAuto === mark) return;
    lastAuto = mark;
    stopAudio(); // läuft noch die vorige Ausgabe, würde ein zweiter Aufruf sie nur stoppen
    fn();
  };
  const resetCard = () => { shown = false; hint = false; typedAnswer = ''; typedForms = {}; retyped = false; retypeOpen = false; };
  const answer = good => {
    stopAudio();
    const it = q.shift(), s = st(it.c.id), nb = good ? Math.min(5, s.b + 1) : 1;
    const newlyMissed = !good && !missed.has(it.c.id);
    history.push({ it, prev: P[it.c.id], good, newlyMissed });
    bumpToday(1);
    if (goalToday() > 0 && (S[dayKey(new Date())] || 0) === goalToday()) showToast('🎯 Tagesziel erreicht! Du kannst einfach weiterlernen.');
    P[it.c.id] = { b: nb, d: Date.now() + (good ? DAYS[nb - 1] * 864e5 : 0), w: good ? Math.max(0, (s.w || 0) - 1) : (s.w || 0) + 1 };
    save();
    if (good) ok++; else { bad++; missed.set(it.c.id, it.c); q.push(it); } // falsche Karten kommen am Ende nochmal
    resetCard(); draw();
  };
  // Letzte Antwort zurücknehmen (Fortschritt, Zähler und Warteschlange werden wiederhergestellt)
  const undo = () => {
    const h = history.pop(); if (!h) return;
    stopAudio();
    bumpToday(-1);
    if (h.good) ok--; else { q.pop(); bad--; if (h.newlyMissed) missed.delete(h.it.c.id); }
    q.unshift(h.it);
    if (h.prev) P[h.it.c.id] = h.prev; else delete P[h.it.c.id];
    save(); resetCard(); draw();
  };
  const topHtml = c => {
    const remaining = new Set(q.map(x => x.c.id)).size, pct = Math.round((total - remaining) / total * 100);
    return `<div class="top"><span class="tl"><button id="end">← Beenden</button>${history.length ? '<button id="undo" title="Letzte Antwort rückgängig machen">↶ Zurück</button>' : ''}<button id="overview" type="button">Übersicht</button></span>
      <span class="mut">noch ${q.length} · Kasten ${st(c.id).b}${isHard(c.id) ? ' · schwierig' : ''}${isReview ? ' · Wiederholung' : ''}${goalToday() ? ` · Heute ${S[dayKey(new Date())] || 0}/${goalToday()}` : ''}</span></div>
    <div class="progress" role="progressbar" aria-label="Fortschritt dieser Runde" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`;
  };
  const openOverview = () => {
    if (document.getElementById('card-overview')) return;
    stopAudio();
    const box = document.createElement('div');
    box.id = 'card-overview';
    box.className = 'overlay';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'overview-title');
    box.innerHTML = `<div class="dlg overview-dlg"><h2 id="overview-title">Alle Karten dieser Runde</h2>
      <p class="mut">${cards(roundCards.length)}</p>
      <div class="overview-list">${roundCards.map(c => `<div class="overview-row"><div><b>${esc(c.fr)}</b></div><div>${esc(c.pc || c.de)}</div></div>`).join('')}</div>
      <div class="btns"><button id="overview-close" class="primary" type="button">Zurück zur Karte</button></div></div>`;
    document.body.append(box);
    const close = () => box.remove();
    box.querySelector('#overview-close').onclick = close;
    box.addEventListener('click', event => { if (event.target === box) close(); });
    box.querySelector('#overview-close').focus();
  };
  const buttonsHtml = flipLabel => `<div class="btns">${shown
    ? `<button id="no" class="bad">✗ Falsch ${keysOff() ? '' : '<span class="key">(←)</span>'}</button><button id="yes" class="good">✓ Richtig ${keysOff() ? '' : '<span class="key">(→)</span>'}</button>`
    : `<button id="flip" class="primary" style="flex:1">${flipLabel}</button>`}</div>${shown ? '<p class="hint swipe">Du kannst auch wischen: nach rechts = richtig, nach links = falsch.</p>' : ''}`;
  // gemeinsame Bedienung beider Kartenarten: Knöpfe, Tippen zum Aufdecken, Wischen zum Bewerten
  const bind = (onSpeak, rerender) => {
    const $ = x => app.querySelector(x);
    $('#end').onclick = leaveScreen;
    if ($('#undo')) $('#undo').onclick = undo;
    if ($('#overview')) $('#overview').onclick = openOverview;
    app.querySelectorAll('.spk').forEach(button => { button.onclick = event => { event.stopPropagation(); onSpeak(); }; });
    if (shown) { $('#no').onclick = () => answer(false); $('#yes').onclick = () => answer(true); }
    else $('#flip').onclick = () => { shown = true; rerender(); };
    const card = $('#card');
    card.onclick = event => { if (!shown && !event.target.closest('button,input,label,a')) { shown = true; rerender(); } };
    let startX = null;
    card.ontouchstart = event => { startX = shown && event.touches.length === 1 ? event.touches[0].clientX : null; };
    card.ontouchend = event => {
      if (startX === null) return;
      const dx = event.changedTouches[0].clientX - startX; startX = null;
      if (Math.abs(dx) > 80) answer(dx > 0);
    };
  };
  const draw = () => {
    if (!q.length) return done();
    if (conjActive(q[0].c)) return drawConj();
    if (q[0].c.pc) return drawPc();
    const { c, dir } = q[0], front = dir === 'fr' ? c.fr : c.de, back = dir === 'fr' ? c.de : c.fr;
    const checks = Boolean(opt.retype) && dir === 'de', typedField = opt.typing || checks;
    const spk = hasSound(c) ? '<button class="spk" title="' + spkTitle() + '" aria-label="Anhören">🔊</button>' : '';
    const imgs = opt.img && c.img.length ? `<div class="imgs">${c.img.map(s => `<img src="${esc(imageUrl(c.table, s))}" alt="" decoding="async" fetchpriority="high" onerror="this.remove()">`).join('')}</div>` : '';
    app.innerHTML = `${topHtml(c)}
    <div class="card" id="card"><span class="mut">${esc(titleOf(c.table))}</span>${imgs}<div class="q">${esc(front)}${dir === 'fr' ? spk : ''}</div>
      ${typedField ? `<label class="answer-field">Deine Antwort (${checks ? 'wird geprüft' : 'wird nicht automatisch geprüft'})
        <input id="typed-answer" type="text" autocomplete="off" spellcheck="false" placeholder="Antwort hier eingeben" value="${esc(typedAnswer)}">
      </label>` : ''}
      ${shown ? `<hr><div class="a">${esc(back)}${dir === 'fr' ? '' : spk}</div>${c.example ? `<div class="example">${esc(c.example)}</div>` : ''}` : ''}</div>
    ${buttonsHtml('Antwort zeigen')}
    ${cheat ? `<div class="cheat">${esc(back)}</div>` : ''}`;
    const currentImage = app.querySelector('.imgs img');
    if (currentImage && !currentImage.complete) {
      currentImage.addEventListener('load', preloadNextImages, { once: true });
      currentImage.addEventListener('error', preloadNextImages, { once: true });
    } else preloadNextImages();
    bind(() => sound(c), draw);
    if (hasSound(c) && ((dir === 'fr' && !shown) || (dir === 'de' && shown))) autoPlay(c, shown ? 'a' : 'q', () => sound(c));
    const answerInput = app.querySelector('#typed-answer');
    if (answerInput) {
      answerInput.oninput = () => { typedAnswer = answerInput.value; };
      if (!retypeOpen) answerInput.focus();
    }
    if (shown && checks && !retyped && typedAnswer.trim() && !checkTyped(typedAnswer, c.fr)) openRetype(c);
  };
  // Falsch getippt: Fenster, bis die Vokabel einmal richtig geschrieben wurde (Einstellung „Falsch getippt wiederholen“)
  const openRetype = c => {
    retypeOpen = true;
    stopAudio();
    let attempts = 0;
    const box = document.createElement('div');
    box.id = 'retype'; box.className = 'overlay'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'rt-title');
    box.innerHTML = `<div class="dlg"><h2 id="rt-title">Noch nicht richtig</h2>
      <p class="mut">Du hast geschrieben: <b>${esc(typedAnswer.trim())}</b></p>
      <p class="mut">Richtig ist:</p><div class="a">${esc(c.fr)}</div>
      <label class="answer-field">Schreibe die Vokabel jetzt richtig, dann geht es weiter.
        <input id="rt-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Vokabel schreiben"></label>
      <p id="rt-msg" class="mut" role="status"></p>
      <div class="btns"><button id="rt-ok" class="primary" type="button">Prüfen</button><button id="rt-skip" type="button">Überspringen</button></div></div>`;
    document.body.append(box);
    const input = box.querySelector('#rt-input'), msg = box.querySelector('#rt-msg');
    const close = () => { box.remove(); retypeOpen = false; retyped = true; draw(); };
    const check = () => {
      if (checkTyped(input.value, c.fr)) return close();
      attempts++;
      msg.textContent = `Noch nicht ganz${input.value.trim() ? ' („' + input.value.trim() + '“)' : ''}. Versuch ${attempts}: schau auf die richtige Schreibweise und schreib sie nochmal.`;
      input.select();
    };
    box.querySelector('#rt-ok').onclick = check;
    box.querySelector('#rt-skip').onclick = close;
    input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); check(); } };
    input.focus();
  };
  // Übung: französisches Verb zeigen, Deutsch auf Wunsch aufdecken, Passé composé eintippen, dann die Lösung zeigen
  const drawPc = () => {
    const { c } = q[0], hit = shown && checkPc(typedAnswer, c.pc);
    const spk = canSpeak ? '<button class="spk" title="' + spkTitle() + '" aria-label="Anhören">🔊</button>' : '';
    app.innerHTML = `${topHtml(c)}
    <div class="card" id="card"><span class="mut">${esc(titleOf(c.table))}</span>
      <div class="q">${esc(c.fr)}${spk}</div>
      <div class="hintde">${hint ? '🇩🇪 ' + esc(c.de) : '<button id="hint" type="button">🇩🇪 Deutsch aufdecken</button>'}</div>
      <label class="answer-field">Passé composé (mit Personalpronomen, z. B. „j’ai dormi“)
        <input id="typed-answer" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Passé composé eintippen" value="${esc(typedAnswer)}" ${shown ? 'readonly' : ''}>
      </label>
      ${shown ? `<hr><div class="a">${esc(c.pc)}</div>
        <div class="mut">${hit ? '✓ Deine Eingabe stimmt.' : typedAnswer.trim() ? '✗ Deine Eingabe weicht ab: ' + esc(typedAnswer) : 'Nichts eingegeben.'}${c.ref ? ' · ' + esc(c.ref) : ''}</div>` : ''}</div>
    ${buttonsHtml('Lösung zeigen')}
    ${cheat ? `<div class="cheat">${esc(c.pc)}</div>` : ''}`;
    bind(() => speak(c.fr), drawPc);
    if (canSpeak) autoPlay(c, shown ? 'a' : 'q', () => speak(shown ? c.pc : c.fr));
    const input = app.querySelector('#typed-answer');
    input.oninput = () => { typedAnswer = input.value; };
    if (!shown) input.focus();
    if (app.querySelector('#hint')) app.querySelector('#hint').onclick = () => { hint = true; drawPc(); };
  };
  // Verb konjugieren: pro gewählter Zeit eine Zeile je Person (je ... / tu ... / il ...), danach die Lösung
  const drawConj = () => {
    const { c } = q[0];
    const tenses = [['praesens', 'Présent', opt.conjPres !== false], ['passe_compose', 'Passé composé', opt.conjPc !== false]]
      .filter(t => t[2] && c.conj[t[0]].some(Boolean));
    let right = 0, rows = 0;
    const section = ([key, label]) => `<div class="tense"><h3>${label}</h3>${c.conj[key].map((form, i) => {
      if (!form) return '';
      const [pro, rest] = splitPerson(form), id = `${key}-${i}`, typed = typedForms[id] || '', hit = checkPc(typed, rest);
      rows++; if (shown && hit) right++;
      return `<div class="crow${shown ? (hit ? ' ok' : ' bad') : ''}"><span class="pro">${esc(pro)}</span>
        <input data-id="${id}" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(typed)}" ${shown ? 'readonly' : ''} aria-label="${esc(label + ' ' + pro)}">
        ${shown && !hit ? `<span class="sol">${esc(rest)}</span>` : ''}</div>`;
    }).join('')}</div>`;
    const html = tenses.map(section).join('');
    const spk = hasSound(c) || canSpeak ? '<button class="spk" title="' + spkTitle() + '" aria-label="Anhören">🔊</button>' : '';
    app.innerHTML = `${topHtml(c)}
    <div class="card" id="card"><span class="mut">${esc(titleOf(c.table))}</span>
      <div class="q">${esc(c.fr)}${spk}</div>
      <div class="hintde">${hint || shown ? '🇩🇪 ' + esc(c.de) : '<button id="hint" type="button">🇩🇪 Deutsch aufdecken</button>'}</div>
      ${html}
      ${shown ? `${c.example ? `<div class="example">${esc(c.example)}</div>` : ''}<div class="mut">${right} von ${rows} Formen richtig${c.ref ? ' · ' + esc(c.ref) : ''}</div>` : ''}</div>
    ${buttonsHtml('Lösung zeigen')}`;
    bind(() => hasSound(c) ? sound(c) : speak(c.fr), drawConj);
    const inputs = [...app.querySelectorAll('.crow input')];
    inputs.forEach((input, index) => {
      input.oninput = () => { typedForms[input.dataset.id] = input.value; };
      input.onkeydown = event => {
        if (event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation();
        if (inputs[index + 1]) inputs[index + 1].focus(); else { shown = true; drawConj(); }
      };
    });
    if (!shown && inputs[0]) inputs[0].focus();
    if (app.querySelector('#hint')) app.querySelector('#hint').onclick = () => { hint = true; drawConj(); };
  };
  document.onkeydown = e => {
    if (!q.length || retypeOpen || keysOff()) return;
    const { c, dir } = q[0];
    const key = e.key.toLowerCase();
    const plain = !(e.ctrlKey || e.metaKey || e.altKey);
    const inField = e.target instanceof HTMLInputElement && !opt.keysInInput;
    if (plain && key === keyAudio() && hasSound(c) && !inField) { e.preventDefault(); c.pc ? speak(c.fr) : sound(c); return; }
    if (key === 'z' && (e.ctrlKey || e.metaKey) && history.length) { e.preventDefault(); undo(); return; }
    if (!shown && (e.key === 'Enter' || e.key === 'ArrowDown' || (plain && key === keyReveal() && !inField))) {
      e.preventDefault();
      shown = true;
      draw();
    } else if (shown && (e.key === 'ArrowLeft' || (e.key === '1' && !inField))) {
      e.preventDefault();
      answer(false);
    } else if (shown && (e.key === 'ArrowRight' || (e.key === '2' && !inField))) {
      e.preventDefault();
      answer(true);
    }
  };
  const done = () => {
    stopAudio();
    document.onkeydown = null;
    const wrong = [...missed.values()], first = total - wrong.length;
    const { queue: nextQ, review } = endlessOn() ? nextQueue() : { queue: buildQueue(), review: false }, more = nextQ.length;
    const list = wrong.length
      ? `<h2 class="sp">Hier hattest du Fehler</h2><ul class="miss">${wrong.map(c => `<li><b>${esc(c.fr)}</b> – ${esc(c.pc || c.de)}</li>`).join('')}</ul>`
      : '<p class="mut">Alle Karten gleich beim ersten Mal richtig. Stark!</p>';
    const today = S[dayKey(new Date())] || 0, goal = goalToday();
    const goalLine = goal ? `<p class="mut">${today >= goal ? `🎯 Tagesziel erreicht: ${cards(today)} heute.` : `Heute ${today} von ${cards(goal)}. Noch ${goal - today} bis zum Ziel.`}</p>` : '';
    const reviewNote = more && review ? '<p class="mut">Heute ist nichts mehr fällig. Es geht mit einer Wiederholung weiter: Du bekommst die Karten, die am schwächsten sind.</p>' : '';
    app.innerHTML = `<h1>Runde geschafft! 🎉</h1><p class="big">${first} von ${total} beim ersten Mal richtig</p>${goalLine}${list}${reviewNote}
      <div class="btns">${more ? `<button id="again" class="primary">Weiter lernen (${cards(more)})</button>` : ''}<button id="back"${more ? '' : ' class="primary"'}>${more ? 'Aufhören' : 'Zurück zur Auswahl'}</button></div>
      ${more && !keysOff() ? '<p class="hint">Mit Enter geht es sofort weiter.</p>' : ''}
      <p class="end-note"><button id="suggest" type="button" class="lnk-btn">💡 Verbesserung vorschlagen</button></p>`;
    app.querySelector('#back').onclick = leaveScreen;
    app.querySelector('#suggest').onclick = () => openFeedback({ where: 'Rundenende', lessons });
    if (more) {
      const again = app.querySelector('#again');
      again.onclick = () => learn(nextQ, review);
      again.focus();
      if (!keysOff()) document.onkeydown = e => { if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); again.click(); } };
    }
    window.scrollTo(0, 0);
  };
  draw();
}

window.addEventListener('popstate', () => { if (subscreen) home(); });

// ---- Start -----------------------------------------------------------------
if (SW_OK) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Offline-Modus nicht verfügbar:', e));
(async () => {
  if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve)); // settings.js ist dann geladen
  app.innerHTML = '<p class="mut">Lade Tabellen …</p>';
  try { tables = await discover(); }
  catch (e) {
    app.innerHTML = `<h1>Vokabelkasten</h1><p>Tabellen konnten nicht geladen werden (${esc(e.message)}).</p>
    <p class="mut">Ist das Repo öffentlich? GitHub erlaubt ohne Login nur 60 Abfragen pro Stunde je Netzwerk – später nochmal versuchen.</p>`;
    return;
  }
  sel = new Set([...sel].filter(d => tables.some(t => t.dir === d)));
  let loadFailures = [];
  if (!LS.get(INITIAL_LOAD_KEY, false)) {
    loadFailures = await loadAllTables();
    if (!loadFailures.length) LS.set(INITIAL_LOAD_KEY, true);
  }
  home();
  for (const d of sel) load(tables.find(t => t.dir === d)).then(() => { list(); updateGo(); }).catch(() => {});
})();
