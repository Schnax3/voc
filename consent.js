// ---- Google Analytics nur nach Einwilligung -----------------------------------
(() => {
  const GA_ID = 'G-244LVTNJQX';
  const KEY = 'vk:analytics'; // 'yes' | 'no'
  const box = document.getElementById('consent');
  // Die Leiste liegt fest am unteren Rand: Platz schaffen, damit sie keine Bedienelemente verdeckt.
  const pad = () => { document.body.style.paddingBottom = box.hidden ? '' : box.offsetHeight + 'px'; };
  addEventListener('resize', pad);
  const read =() => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = v => { try { localStorage.setItem(KEY, v); } catch {} };
  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', GA_ID);
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(s);
  };
  const decide = v => {
    write(v);
    box.hidden = true; pad();
    if (v === 'yes') load();
    // Beim Widerruf wird nichts mehr gesendet; ein bereits geladenes Skript endet mit dem Neuladen.
    else if (loaded) { alert('Die Statistik wird nach dem Neuladen der Seite nicht mehr geladen.'); }
  };
  document.getElementById('consent-yes').onclick = () => decide('yes');
  document.getElementById('consent-no').onclick = () => decide('no');
  document.getElementById('stat-link').onclick = () => { box.hidden = false; pad(); };
  if (typeof IS_DEV !== 'undefined' && IS_DEV) { // Testversion: keine Statistik, keine Abfrage
    document.getElementById('stat-link').hidden = true;
    return;
  }
  const saved = read();
  if (saved === 'yes') load();
  else if (saved !== 'no') { box.hidden = false; pad(); }
})();
