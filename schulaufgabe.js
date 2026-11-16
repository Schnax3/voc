// ---- Bereich "Schulaufgabe": Themen mit Merkkasten und Übungen ----------------------------------
// Daten: schulaufgabe.json (erzeugt von scripts/build_schulaufgabe.py aus scripts/schulaufgabe_themen.json).
// Themen-Typen: luecke (Lückensätze), verneinung (Satz umformen), konjugieren (Formen je Person), schreiben (Textaufgabe).
// Fortschritt: LS "vk:sa" { themaId: { last: {ok, total}, items: { schlüssel: {ok, bad} } } }, Texte: "vk:sa-text:<id>", Haken: "vk:sa-check:<id>".

let SA = null;
const saLoad = async () => {
  if (SA) return SA;
  const response = await fetch(fileUrl('schulaufgabe.json'));
  if (!response.ok) throw new Error(`schulaufgabe.json: ${response.status}`);
  return (SA = await response.json());
};
const saProgress = () => LS.get('vk:sa', {});
const saStore = data => LS.set('vk:sa', data);
const saKey = (topic, item) => `${topic.id}::${hash(item.q || `${item.verb}|${item.zeit}`)}`;
const SA_NONE = ['-', '–', '—', '/', 'x', 'rien', 'keine', '0'];

// Eingaben vergleichen: Groß-/Kleinschreibung, Apostroph-Form, Leerzeichen und Satzzeichen am Ende sind egal.
const saNorm = text => normPc(text).replace(/\s+([.!?,])/g, '$1').replace(/[.!?]+$/, '').trim();
const saMatches = (typed, alternatives) => alternatives.some(alt =>
  alt === '–' ? SA_NONE.includes(normPc(typed)) : expandOptional(alt).map(saNorm).includes(saNorm(typed)));

function openSchulaufgabe() { enterScreen(); saMenu(); }

async function saMenu() {
  stopAudio();
  document.onkeydown = event => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) leaveScreen(); };
  let data;
  try { data = await saLoad(); } catch {
    app.innerHTML = '<div class="top"><button id="sa-back" type="button">← Zurück</button></div><h1>Schulaufgabe</h1><p class="mut">Die Übungen konnten nicht geladen werden. Prüfe deine Internetverbindung und versuche es nochmal.</p>';
    app.querySelector('#sa-back').onclick = leaveScreen; return;
  }
  const progress = saProgress();
  app.innerHTML = `<div class="top"><button id="sa-back" type="button">← Zurück</button></div>
  <h1>${esc(data.titel)}</h1><p class="mut lead">${esc(data.untertitel)}</p>
  <div class="topics">${data.themen.map(topic => {
    const last = (progress[topic.id] || {}).last;
    const state = topic.typ === 'schreiben' ? 'Schreibaufgabe' : last ? `Zuletzt ${last.ok} von ${last.total} richtig` : 'Noch nicht geübt';
    return `<button type="button" class="topic" data-id="${esc(topic.id)}"><span class="sym" aria-hidden="true">${topic.symbol}</span>
      <span class="tt"><b>${esc(topic.titel)}</b><small>${esc(topic.kurz)}</small></span><span class="st">${esc(state)}</span></button>`;
  }).join('')}</div>
  <p class="hint">Die Übungen folgen dem Zettel zur Schulaufgabe. Prüfe zusätzlich im Buch und im Übungsheft, ob alles abgedeckt ist.</p>`;
  app.querySelector('#sa-back').onclick = leaveScreen;
  app.querySelectorAll('.topic').forEach(button => { button.onclick = () => saTopic(button.dataset.id); });
  window.scrollTo(0, 0);
}

function saTopic(id) {
  const topic = SA.themen.find(t => t.id === id);
  stopAudio();
  document.onkeydown = event => { if (event.key === 'Escape' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) saMenu(); };
  const rules = (topic.merk || []).map(line => `<li>${esc(line)}</li>`).join('');
  const isWriting = topic.typ === 'schreiben';
  app.innerHTML = `<div class="top"><button id="sa-back" type="button">← Themen</button></div>
  <h1>${topic.symbol} ${esc(topic.titel)}</h1>
  ${rules ? `<details class="rules" ${isWriting ? '' : 'open'}><summary>Merkkasten</summary><ul>${rules}</ul></details>` : ''}
  <p class="mut">${esc(topic.aufgabe)}</p>
  ${isWriting ? `<div class="topics">${topic.aufgaben.map(task => `<button type="button" class="topic" data-task="${esc(task.id)}"><span class="sym" aria-hidden="true">✍️</span><span class="tt"><b>${esc(task.titel)}</b></span></button>`).join('')}</div>`
    : `<section class="panel"><div class="opts"><label>Aufgaben pro Runde
        <select id="sa-count"><option value="5">5</option><option value="10">10</option><option value="0">Alle (${topic.items.length})</option></select></label></div></section>
      <div class="start"><button id="sa-go" class="primary" type="button">Üben starten</button></div>
      <p class="hint">Aufgaben, die du bisher falsch hattest, kommen zuerst.</p>`}`;
  app.querySelector('#sa-back').onclick = saMenu;
  if (isWriting) {
    app.querySelectorAll('[data-task]').forEach(button => { button.onclick = () => saWrite(topic, topic.aufgaben.find(t => t.id === button.dataset.task)); });
  } else {
    const select = app.querySelector('#sa-count');
    select.value = String(LS.get('vk:sa-count', 10));
    app.querySelector('#sa-go').onclick = () => { const n = Number(select.value); LS.set('vk:sa-count', n); saRound(topic, n); };
  }
  window.scrollTo(0, 0);
}

// Reihenfolge einer Runde: Aufgaben mit Fehlern zuerst, sonst gemischt
function saPick(topic, count) {
  const stats = (saProgress()[topic.id] || {}).items || {};
  const weight = item => { const s = stats[saKey(topic, item)]; return s ? s.bad - s.ok : 0; };
  const items = topic.items.map(item => ({ item, w: weight(item), r: Math.random() }))
    .sort((a, b) => (b.w > 0) - (a.w > 0) || b.r - a.r).map(x => x.item);
  const picked = count > 0 ? items.slice(0, count) : items;
  return picked.sort(() => Math.random() - .5);
}

function saRound(topic, count, fixed) {
  const queue = fixed || saPick(topic, count), total = queue.length, wrong = [];
  let index = 0, checked = false, right = 0;
  const finish = () => {
    stopAudio(); document.onkeydown = null;
    const progress = saProgress(), entry = progress[topic.id] || { items: {} };
    entry.last = { ok: right, total };
    progress[topic.id] = entry; saStore(progress);
    const list = wrong.length ? `<h2 class="sp">Hier hattest du Fehler</h2><ul class="miss">${wrong.map(w => `<li>${w}</li>`).join('')}</ul>`
      : '<p class="mut">Alles beim ersten Mal richtig. Stark!</p>';
    app.innerHTML = `<h1>Geschafft! 🎉</h1><p class="big">${right} von ${total} richtig</p>${list}
      <div class="btns">${wrong.length ? '<button id="sa-again-wrong" class="primary" type="button">Fehler nochmal üben</button>' : ''}<button id="sa-again" type="button">Neue Runde</button><button id="sa-topic" type="button">Zum Thema</button></div>`;
    const redo = queue.filter((_, i) => wrongIdx.has(i));
    if (app.querySelector('#sa-again-wrong')) app.querySelector('#sa-again-wrong').onclick = () => saRound(topic, 0, redo);
    app.querySelector('#sa-again').onclick = () => saRound(topic, count);
    app.querySelector('#sa-topic').onclick = () => saTopic(topic.id);
    window.scrollTo(0, 0);
  };
  const wrongIdx = new Set();

  const record = (item, good) => {
    const progress = saProgress(), entry = progress[topic.id] || { items: {} };
    entry.items = entry.items || {};
    const s = entry.items[saKey(topic, item)] || { ok: 0, bad: 0 };
    if (good) s.ok++; else s.bad++;
    entry.items[saKey(topic, item)] = s; progress[topic.id] = entry; saStore(progress);
  };
  const solutionText = item => topic.typ === 'konjugieren' ? item.formen.filter(Boolean).join(' · ')
    : topic.typ === 'verneinung' ? item.antworten[0] : item.q.split('___').reduce((acc, part, i) => acc + part + (i < item.blanks.length ? `[${item.blanks[i][0]}]` : ''), '');
  const questionText = item => topic.typ === 'konjugieren' ? `${item.verb}, ${item.zeitname}` : item.q;

  const draw = () => {
    const item = queue[index], pct = Math.round(index / total * 100);
    checked = false;
    let body = '';
    if (topic.typ === 'luecke') {
      const parts = item.q.split('___');
      body = `<div class="gap">${parts.map((part, i) => esc(part) + (i < parts.length - 1 ? `<input class="blank" data-i="${i}" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Lücke ${i + 1}" style="width:${Math.max(6, Math.max(...item.blanks[i].map(a => a.length)) + 3)}ch">` : '')).join('')}</div>`;
    } else if (topic.typ === 'verneinung') {
      body = `<div class="q small">${esc(item.q)}</div>
        <label class="answer-field">Verneinter Satz <input class="blank wide" data-i="0" type="text" autocomplete="off" autocapitalize="sentences" spellcheck="false"></label>`;
    } else {
      body = `<div class="q">${esc(item.verb)}</div><div class="mut">${esc(item.deutsch)} · <b>${esc(item.zeitname)}</b></div>
        <div class="tense">${item.formen.map((form, i) => {
          if (!form) return '';
          const [pronoun] = splitPerson(form);
          return `<div class="crow" data-row="${i}"><span class="pro">${esc(pronoun)}</span><input class="blank" data-i="${i}" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="${esc(item.zeitname + ' ' + pronoun)}"></div>`;
        }).join('')}</div>`;
    }
    app.innerHTML = `<div class="top"><span class="tl"><button id="sa-end" type="button">← Beenden</button></span><span class="mut">${index + 1} von ${total}</span></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
      <div class="card sa-card"><span class="mut">${esc(topic.titel)}</span>${body}<div class="feedback" id="sa-feedback" role="status"></div></div>
      <div class="btns"><button id="sa-check" class="primary" type="button" style="flex:1">Prüfen</button></div>`;
    const inputs = [...app.querySelectorAll('.blank')];
    app.querySelector('#sa-end').onclick = () => saTopic(topic.id);
    app.querySelector('#sa-check').onclick = () => (checked ? next() : check());
    inputs.forEach((input, i) => {
      input.onkeydown = event => {
        if (event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation();
        if (checked) return next();
        if (inputs[i + 1]) inputs[i + 1].focus(); else check();
      };
    });
    document.onkeydown = event => { if (event.key === 'Enter' && checked) { event.preventDefault(); next(); } };
    if (inputs[0]) inputs[0].focus();
  };

  const check = () => {
    if (checked) return;
    const item = queue[index], inputs = [...app.querySelectorAll('.blank')];
    let good = true;
    if (topic.typ === 'luecke') {
      inputs.forEach((input, i) => { const hit = saMatches(input.value, item.blanks[i]); good = good && hit; input.classList.add(hit ? 'ok' : 'bad'); input.readOnly = true; });
    } else if (topic.typ === 'verneinung') {
      good = saMatches(inputs[0].value, item.antworten);
      inputs[0].classList.add(good ? 'ok' : 'bad'); inputs[0].readOnly = true;
    } else {
      inputs.forEach(input => {
        const i = Number(input.dataset.i), [, rest] = splitPerson(item.formen[i]), hit = saMatches(input.value, [rest]);
        good = good && hit; input.readOnly = true;
        const row = input.closest('.crow'); row.classList.add(hit ? 'ok' : 'bad');
        if (!hit) row.insertAdjacentHTML('beforeend', `<span class="sol">${esc(rest)}</span>`);
      });
    }
    checked = true;
    if (good) right++; else { wrong.push(`<b>${esc(questionText(item))}</b> → ${esc(solutionText(item))}`); wrongIdx.add(index); }
    record(item, good);
    const tip = !good && item.tipp ? `<div class="tip">💡 ${esc(item.tipp)}</div>` : '';
    const answer = !good && topic.typ !== 'konjugieren' ? `<div class="sol">Lösung: ${esc(solutionText(item))}</div>` : '';
    app.querySelector('#sa-feedback').innerHTML = `<div class="${good ? 'okmsg' : 'badmsg'}">${good ? '✓ Richtig!' : '✗ Leider falsch.'}</div>${answer}${tip}`;
    const button = app.querySelector('#sa-check');
    button.textContent = index + 1 < total ? 'Weiter' : 'Ergebnis'; button.focus();
  };
  const next = () => { index++; if (index < total) draw(); else finish(); };
  if (!total) { saTopic(topic.id); return; }
  draw();
}

// Textproduktion: Satzbausteine zum Einfügen, Text und Checkliste werden im Browser gespeichert
function saWrite(topic, task) {
  stopAudio();
  const textKey = `vk:sa-text:${task.id}`, checkKey = `vk:sa-check:${task.id}`;
  document.onkeydown = null;
  app.innerHTML = `<div class="top"><button id="sa-back" type="button">← ${esc(topic.titel)}</button></div>
  <h1>✍️ ${esc(task.titel)}</h1><p class="mut">${esc(task.text)}</p>
  <section class="panel"><h2>Satzbausteine</h2><p class="hint">Tippe auf einen Baustein, um ihn in deinen Text einzufügen.</p>
    <div class="blocks">${task.bausteine.map(([fr, de], i) => `<button type="button" class="block" data-i="${i}"><span lang="fr">${esc(fr)}</span><small>${esc(de)}</small></button>`).join('')}</div></section>
  <label class="answer-field">Dein Text
    <textarea id="sa-text" rows="10" spellcheck="false" lang="fr" placeholder="Écris ton texte ici …"></textarea></label>
  <p class="hint" id="sa-count"></p>
  <div class="btns small"><button id="sa-speak" type="button">🔊 Text vorlesen</button><button id="sa-clear" type="button">Text löschen</button></div>
  <section class="panel"><h2>Checkliste</h2><div class="checks">${task.checkliste.map((line, i) => `<label><input type="checkbox" data-i="${i}"> ${esc(line)}</label>`).join('')}</div></section>
  <p class="hint">Alles bleibt nur in diesem Browser gespeichert. Die App prüft den Text nicht. Lass ihn zusätzlich von einer Lehrkraft oder einer Person, die Französisch kann, lesen.</p>`;
  const area = app.querySelector('#sa-text'), counter = app.querySelector('#sa-count'), checks = [...app.querySelectorAll('.checks input')];
  area.value = LS.get(textKey, '');
  const ticked = LS.get(checkKey, []);
  checks.forEach((box, i) => { box.checked = Boolean(ticked[i]); box.onchange = () => LS.set(checkKey, checks.map(b => b.checked)); });
  const count = () => {
    const words = area.value.trim() ? area.value.trim().split(/\s+/).length : 0;
    counter.textContent = `${words} ${words === 1 ? 'Wort' : 'Wörter'}`;
  };
  area.oninput = () => { LS.set(textKey, area.value); count(); };
  count();
  app.querySelectorAll('.block').forEach(button => {
    button.onclick = () => {
      const phrase = task.bausteine[Number(button.dataset.i)][0].replace(/ \+ Infinitiv/, ' ').replace(/…/g, '').trim() + ' ';
      const start = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? start;
      area.value = area.value.slice(0, start) + phrase + area.value.slice(end);
      area.focus(); area.selectionStart = area.selectionEnd = start + phrase.length;
      area.oninput();
    };
  });
  app.querySelector('#sa-speak').onclick = () => { if (area.value.trim()) speak(area.value); };
  app.querySelector('#sa-clear').onclick = () => { if (area.value && confirm('Den Text wirklich löschen?')) { area.value = ''; area.oninput(); } };
  app.querySelector('#sa-back').onclick = () => saTopic(topic.id);
  window.scrollTo(0, 0);
}
