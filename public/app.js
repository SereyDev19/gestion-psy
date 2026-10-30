// Gestion Psy : interface (JavaScript pur, aucune dépendance)
let exportHook = null;      // sur la page d'une séance : enregistre d'abord la saisie en cours, pour que le fichier soit à jour
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Verrouillage (mot de passe facultatif) ----------
const auth = { protege: false, delai: 0, verrouille: false, nom: 'Gestion Psy' };
const _fetch = window.fetch.bind(window);
window.fetch = async (...a) => {                         // toute réponse « verrouillé » (session expirée…) ramène à l'écran du mot de passe
  const r = await _fetch(...a);
  if (r.status === 401 && !String(a[0]).includes('/api/auth/') && !auth.verrouille) montrerVerrou();
  return r;
};
function appliquerNom(n) { auth.nom = n; $('#brand-name').textContent = n; document.title = n; }
const majBoutonVerrou = () => { $('#lockbtn').hidden = !auth.protege; };
let idleT = null, dernierGeste = 0;
function armerInactivite() {
  clearTimeout(idleT);
  if (auth.protege && auth.delai && !auth.verrouille) idleT = setTimeout(verrouillerMaintenant, auth.delai * 60000);
}
['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(ev => document.addEventListener(ev, () => {
  const n = Date.now(); if (n - dernierGeste > 5000) { dernierGeste = n; armerInactivite(); }
}, true));
async function verrouillerMaintenant() {
  if (!auth.protege || auth.verrouille) return;
  try { if (exportHook) await exportHook(); } catch { /* la saisie en cours a au mieux été enregistrée */ }
  try { await _fetch('/api/auth/verrouiller', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* ignoré */ }
  montrerVerrou();
}
async function appelAuth(url, body) {
  const r = await _fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}
function montrerVerrou() {
  auth.verrouille = true; clearTimeout(idleT);
  app.innerHTML = ''; ['#modal-root', '#search-root', '#picker-root'].forEach(s => { $(s).innerHTML = ''; });
  if (typeof searchState !== 'undefined') searchState.ouvert = false;
  const root = $('#lock-root');
  const fin = () => { auth.verrouille = false; root.innerHTML = ''; armerInactivite(); render(); refreshDoublons(); };
  const cadre = corps => { root.innerHTML = `<div class="lock"><div class="lockbox"><img src="/logo-256.png" alt="" width="64" height="64"><h1>${esc(auth.nom)}</h1>${corps}</div></div>`; };
  const ecran = () => {
    cadre(`<form id="lockform"><p class="muted">Saisissez votre mot de passe</p>
      <input type="password" id="lockpw" autocomplete="current-password" aria-label="Mot de passe">
      <div class="lockerr" id="lockerr" role="alert"></div>
      <button class="btn primary" style="width:100%">Déverrouiller</button></form>
      <a href="#" id="forgot" class="tiny">Mot de passe oublié ?</a>`);
    $('#lockpw').focus();
    $('#lockform').onsubmit = async e => {
      e.preventDefault();
      const { ok, j } = await appelAuth('/api/auth/connexion', { mdp: $('#lockpw').value });
      if (ok) fin(); else { $('#lockerr').textContent = j.error || 'Erreur'; $('#lockpw').select(); }
    };
    $('#forgot').onclick = e => { e.preventDefault(); oubli(); };
  };
  const oubli = () => {
    cadre(`<form id="forgotform"><p class="muted">Saisissez la clé de secours notée à l’activation du mot de passe, puis choisissez un nouveau mot de passe.</p>
      <input id="fkey" placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX" autocomplete="off" aria-label="Clé de secours">
      <input type="password" id="fpw" placeholder="Nouveau mot de passe (8 caractères min.)" autocomplete="new-password">
      <input type="password" id="fpw2" placeholder="Confirmez le nouveau mot de passe" autocomplete="new-password">
      <div class="lockerr" id="lockerr" role="alert"></div>
      <button class="btn primary" style="width:100%">Définir un nouveau mot de passe</button></form>
      <a href="#" id="back" class="tiny">← Retour</a>`);
    $('#fkey').focus();
    $('#back').onclick = e => { e.preventDefault(); ecran(); };
    $('#forgotform').onsubmit = async e => {
      e.preventDefault();
      if ($('#fpw').value !== $('#fpw2').value) { $('#lockerr').textContent = 'Les deux mots de passe sont différents'; return; }
      const { ok, j } = await appelAuth('/api/auth/secours', { cle: $('#fkey').value, mdp: $('#fpw').value });
      if (!ok) { $('#lockerr').textContent = j.error || 'Erreur'; return; }
      cadre(`<p>Nouveau mot de passe enregistré. Votre <b>nouvelle clé de secours</b> (l’ancienne ne fonctionne plus) :</p><div class="cle">${esc(j.cle_secours)}</div>
        <p class="muted tiny">Notez-la en lieu sûr, hors de cet ordinateur. Elle ne sera plus affichée.</p><button class="btn primary" id="cont" style="width:100%">J’ai noté la clé, continuer</button>`);
      $('#cont').onclick = fin;
    };
  };
  ecran();
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (!(r.status === 409 && (j.doublons || j.conflits)) && !j.verrouille) toast(j.error || 'Erreur');     // ces 409 sont des avertissements : l'écran concerné les affiche lui-même
    throw Object.assign(new Error(j.error || r.status), { data: j, status: r.status });
  }
  return j;
}
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); };

const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const euro = n => (Number(n) || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
// Aperçu texte : on ignore les titres de section du modèle et on espace les blocs
const strip = html => { const d = document.createElement('div'); d.innerHTML = html || ''; d.querySelectorAll('h3').forEach(h => h.remove());
  return (d.innerText || d.textContent || '').replace(/\s+/g, ' ').trim(); };

let HOMO = new Set();          // identifiants des patients qui ont un homonyme (rechargé à chaque affichage)
// Pour distinguer deux homonymes : âge, date de naissance, précision libre
const idPerso = (p, complet = true) => [p.age_texte, complet && p.date_naissance ? 'né(e) le ' + fmtDate(p.date_naissance) : '', p.complement].filter(Boolean).join(' · ');
// Nom + (âge · précision) si, et seulement si, un autre patient porte le même nom
const nomHtml = (id, nom, dn, complement) => {
  if (!HOMO.has(id)) return esc(nom);
  const t = [ageInfo(dn) && ageInfo(dn).texte, complement].filter(Boolean).join(' · ');
  return `${esc(nom)} <span class="homo">${t ? '(' + esc(t) + ')' : '(homonyme)'}</span>`;
};

const STATUTS_PATIENT = ['suivi en cours', 'en pause', 'terminé', 'proche'];
const STATUT_LABEL = { 'proche': 'proche (non suivi)' };
const STATUTS_CONSULT = ['planifiée', 'réalisée', 'annulée', 'absence'];
const MODES = ['cabinet', 'visio', 'téléphone', 'domicile'];
const MODES_PAIEMENT = ['chèque', 'espèces', 'virement', 'CB'];

function statutBadge(s) {
  const cls = { 'suivi en cours': 'ok', 'réalisée': 'ok', 'planifiée': 'blue', 'en pause': 'warn', 'absence': 'warn', 'annulée': '', 'terminé': '' }[s] || '';
  return `<span class="badge ${cls}">${esc(STATUT_LABEL[s] || s)}</span>`;
}

// Âge à partir d'une date de naissance AAAA-MM-JJ : { annees, texte } ou null (même règle que le serveur)
function ageInfo(dn) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dn || ''); if (!mt) return null;
  const now = new Date(); let mois = (now.getFullYear() - Number(mt[1])) * 12 + (now.getMonth() + 1 - Number(mt[2]));
  if (now.getDate() < Number(mt[3])) mois--;
  if (mois < 0) return null;
  const ans = Math.floor(mois / 12);
  return { annees: ans, texte: ans >= 2 ? `${ans} ans` : mois >= 1 ? `${mois} mois` : 'moins d’un mois' };
}

// Un patient archivé affiche « Archivé » à la place de son statut
const etatBadge = p => p.archive_le ? '<span class="badge">Archivé</span>' : statutBadge(p.statut);

// ---------- Modale ----------
function modal(title, bodyHtml, onSubmit, submitLabel = 'Enregistrer', danger = false, cls = '') {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><form class="modal ${cls}"><h2>${esc(title)}</h2>${bodyHtml}
    <div class="actions"><button type="button" class="btn" data-close>Annuler</button><button class="btn primary${danger ? ' dangerfill' : ''}">${esc(submitLabel)}</button></div></form></div>`;
  const close = () => root.innerHTML = '';
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.overlay').addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) close(); });
  const form = root.querySelector('form');
  form.onsubmit = async e => {
    e.preventDefault();
    const ok = form.querySelector('button.primary'); if (ok.disabled) return;      // un double-clic ne crée pas deux fiches
    ok.disabled = true;
    try { await onSubmit(new FormData(form), form); close(); } catch { ok.disabled = false; /* erreur déjà affichée */ }
  };
  const first = form.querySelector('input,select'); first && first.focus();
}

// ---------- Téléphone / e-mail : format imposé (comme sur le serveur) ----------
// Téléphone : 10 chiffres français affichés « 06 12 34 56 78 » ; un numéro commençant par « + » est laissé au format international.
function formaterTelClient(v) {
  const t = String(v || '').trim();
  if (t.startsWith('+') || t.startsWith('00')) return '+' + t.replace(/\D/g, '').replace(/^00/, '').slice(0, 15);
  return t.replace(/\D/g, '').slice(0, 10).replace(/(\d{2})(?=\d)/g, '$1 ');
}
const telOk = v => { const t = String(v || '').trim().replace(/[\s.()-]/g, '').replace(/^00/, '+'); return !t || /^0[1-9]\d{8}$/.test(t) || /^\+[1-9]\d{7,14}$/.test(t); };
const mailOk = v => { const e = String(v || '').trim(); return !e || /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(e); };
// Branche un champ téléphone / e-mail : mise en forme automatique, bordure rouge + message tant que le format n'est pas bon.
function imposerFormats(racine = document) {
  const tel = racine.querySelector('input[name=telephone]'), mail = racine.querySelector('input[name=email]');
  const note = (el, ok, msg) => {
    el.classList.toggle('invalide', !ok); el.setCustomValidity(ok ? '' : msg);
    let n = el.parentElement.querySelector('.fmtmsg'); if (!n) { n = document.createElement('div'); n.className = 'fmtmsg tiny'; el.parentElement.appendChild(n); } n.textContent = ok ? '' : msg;
  };
  if (tel) {
    tel.placeholder = '06 12 34 56 78'; tel.inputMode = 'tel'; tel.maxLength = 20;
    const maj = () => { const f = formaterTelClient(tel.value); if (f !== tel.value) tel.value = f; note(tel, telOk(tel.value), '10 chiffres (06 12 34 56 78) ou +code pays…'); };
    tel.addEventListener('input', maj); if (tel.value) maj();
  }
  if (mail) {
    mail.placeholder = 'nom@exemple.fr'; mail.autocapitalize = 'off';
    const maj = () => note(mail, mailOk(mail.value), 'Adresse e-mail incomplète (nom@exemple.fr)');
    mail.addEventListener('input', maj); mail.addEventListener('blur', () => { mail.value = mail.value.trim().toLowerCase(); maj(); }); if (mail.value) maj();
  }
}

// ---------- Éditeur de texte riche ----------
function editorHtml(html) {
  return `<div class="editor-wrap"><div class="etb">
    <button type="button" data-cmd="formatBlock:h3" title="Titre de section">Titre</button>
    <button type="button" data-cmd="formatBlock:p">Texte</button>
    <button type="button" data-cmd="bold"><b>G</b></button>
    <button type="button" data-cmd="italic"><i>I</i></button>
    <button type="button" data-cmd="underline" title="Souligné (Ctrl/Cmd + U)"><u>S</u></button>
    <span class="colwrap"><button type="button" id="colbtn" title="Couleur du texte">A<span class="colbar" id="colbar"></span></button><div class="colpop" id="colpop" hidden></div></span>
    <button type="button" data-cmd="insertUnorderedList">• Liste</button>
    <button type="button" data-cmd="insertOrderedList">1. Liste</button></div>
    <div class="editor" contenteditable="true" id="editor">${html || '<p></p>'}</div></div>`;
}
// Couleurs du texte : celles de la charte graphique, puis des couleurs courantes (toutes lisibles sur fond blanc)
const COULEURS = [
  ['Charte', [['#9e6bc0', 'Violet'], ['#8650a8', 'Violet soutenu'], ['#2c2c2c', 'Anthracite'], ['#c98f8f', 'Rose'], ['#a39da8', 'Gris']]],
  ['Autres', [['#000000', 'Noir'], ['#c0392b', 'Rouge'], ['#d9822b', 'Orange'], ['#b8962e', 'Ocre'], ['#2e8b57', 'Vert'], ['#2f6db5', 'Bleu'], ['#77727a', 'Gris foncé']]],
];
function wireEditor(onChange) {
  const pop = $('#colpop'), cb = $('#colbtn');
  if (pop) {
    let derniere = '#9e6bc0';
    pop.innerHTML = COULEURS.map(([t, l]) => `<div class="coltit">${t}</div><div class="colrow">${l.map(([c, n]) => `<button type="button" class="sw" data-c="${c}" title="${n}" style="background:${c}"></button>`).join('')}</div>`).join('')
      + `<button type="button" class="colreset" data-c="#2c2c2c">Couleur par défaut</button>`;
    const appliquer = c => { document.execCommand('styleWithCSS', false, false); document.execCommand('foreColor', false, c); derniere = c; $('#colbar').style.background = c; pop.hidden = true; onChange(); };
    $('#colbar').style.background = derniere;
    cb.onmousedown = e => { e.preventDefault(); pop.hidden = !pop.hidden; };
    pop.onmousedown = e => { e.preventDefault(); const b = e.target.closest('[data-c]'); if (b) appliquer(b.dataset.c); };
    document.addEventListener('mousedown', e => { if (!pop.hidden && !e.target.closest('.colwrap')) pop.hidden = true; });
  }
  document.querySelectorAll('.etb button[data-cmd]').forEach(b => b.onmousedown = e => {
    e.preventDefault();
    const [cmd, val] = b.dataset.cmd.split(':');
    document.execCommand(cmd, false, val ? '<' + val + '>' : null);
    onChange();
  });
  $('#editor').addEventListener('input', onChange);
}

// ---------- Routeur ----------
const routes = [
  [/^#\/patients$/, viewPatients],
  [/^#\/patient\/(\d+)$/, viewPatient],
  [/^#\/consultations$/, viewConsultations],
  [/^#\/consultation\/(\d+)$/, viewConsultation],
  [/^#\/modeles(?:\/(\d+))?$/, viewModeles],
  [/^#\/doublons$/, viewDoublons],
  [/^#\/parametres$/, viewParametres],
  [/^#\/corbeille$/, viewCorbeille],
];
async function render() {
  if (auth.verrouille) return;
  const h = location.hash || '#/patients';
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      const nav = h.split('/')[1].replace(/s$/, '');
      document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav.replace(/s$/, '') === (nav === 'patient' ? 'patient' : nav)));
      refreshTrash();
      exportHook = null;
      try { HOMO = new Set(await (await fetch('/api/homonymes')).json()); } catch { HOMO = new Set(); }
      try { await fn(m); } catch (e) { app.innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`; }
      return;
    }
  }
  location.hash = '#/patients';
}
window.addEventListener('hashchange', render);
async function demarrer() {
  let e = {}; try { e = await (await _fetch('/api/auth/etat')).json(); } catch { /* serveur injoignable : l'écran le montrera */ }
  auth.protege = !!e.protege; auth.delai = e.delai_min || 0; appliquerNom(e.nom || 'Gestion Psy'); majBoutonVerrou();
  $('#lockbtn').onclick = verrouillerMaintenant;
  if (e.verrouille) { montrerVerrou(); return; }
  armerInactivite(); render(); refreshDoublons();
}
demarrer();

// ---------- Création d'une séance (fiche patient ET onglet Consultations) ----------
// patient : objet fixe (depuis une fiche) ou null (on choisit dans une liste)
// ---------- Sélecteur de patient (fenêtre centrale, recherche dynamique + filtres) ----------
// 1 caractère d'origine -> 1 caractère normalisé (sans accent, minuscule) : les positions restent alignées pour surligner.
const normPos = t => Array.from(String(t || '')).map(c => { const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); return n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c; }).join('');
const normTxt = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function surligne(texte, mots) {
  const src = Array.from(String(texte || '')), n = normPos(texte), marque = new Array(src.length).fill(false);
  for (const w of mots) { let i = -1; while ((i = n.indexOf(w, i + 1)) >= 0) for (let k = i; k < i + w.length; k++) marque[k] = true; }
  let o = '', ouvert = false;
  src.forEach((c, i) => { if (marque[i] && !ouvert) { o += '<mark>'; ouvert = true; } if (!marque[i] && ouvert) { o += '</mark>'; ouvert = false; } o += esc(c); });
  return o + (ouvert ? '</mark>' : '');
}
// Renvoie une promesse : le patient choisi, ou null si la fenêtre est fermée sans choix.
function choisirPatient(patients, { titre = 'Choisir un patient', exclure = [], statut = 'actifs' } = {}) {
  return new Promise(resolve => {
    const root = $('#picker-root'), LIMITE = 50;
    const f = { q: '', statut, type: 'tous', recents: false };
    const STAT = [['actifs', 'En cours'], ['en pause', 'En pause'], ['terminé', 'Terminés'], ['proche', 'Proches'], ['archives', 'Archivés'], ['tous', 'Tous']];
    const TYPES = [['tous', 'Tous âges'], ['adulte', 'Adultes'], ['mineur', 'Mineurs']];
    const il_y_a_3_mois = iso(new Date(Date.now() - 92 * 864e5));
    root.innerHTML = `<div class="overlay top pick"><div class="palette" role="dialog" aria-label="${esc(titre)}">
      <div class="phead"><b>${esc(titre)}</b><button type="button" class="x" id="pclose" title="Fermer">×</button></div>
      <input id="pq" type="search" placeholder="Nom, prénom, téléphone, e-mail…" autocomplete="off" spellcheck="false">
      <div class="pfilters"><div class="pills" id="pstat"></div><div class="pills" id="ptype"></div></div>
      <div class="pcount muted tiny" id="pcount"></div>
      <div class="sres" id="pk-res"></div></div></div>`;
    const input = $('#pq'); let items = [], sel = 0;
    const fermer = v => { root.innerHTML = ''; document.removeEventListener('keydown', clavier, true); resolve(v); };
    const passe = p => {
      if (exclure.includes(p.id)) return false;
      if (f.statut === 'archives') { if (!p.archive_le) return false; }
      else {
        if (p.archive_le) return false;                                           // « Tous » = tous les patients non archivés
        if (f.statut === 'actifs' ? p.statut !== 'suivi en cours' : f.statut !== 'tous' && p.statut !== f.statut) return false;
      }
      if (f.type !== 'tous' && p.type !== f.type) return false;
      if (f.recents && !((p.derniere && p.derniere >= il_y_a_3_mois) || p.prochaine)) return false;
      return true;
    };
    const mots = () => normTxt(f.q).split(/\s+/).filter(Boolean);
    const correspond = (p, ws) => { const t = normTxt([p.nom, p.telephone, p.email].join(' ')); return ws.every(w => t.includes(w)); };
    const tracer = () => {
      const ws = mots(), ok = patients.filter(p => passe(p) && correspond(p, ws));
      // Les correspondances dans le NOM passent avant celles trouvées seulement dans le téléphone ou l'e-mail (tri stable : l'ordre alphabétique est conservé)
      const dansNom = p => { const n = normTxt(p.nom); return ws.every(w => n.includes(w)) ? 0 : 1; };
      if (ws.length) ok.sort((a, b) => dansNom(a) - dansNom(b));
      items = ok.slice(0, LIMITE);
      $('#pstat').innerHTML = STAT.map(([k, l]) => `<span class="chip ${f.statut === k ? 'on' : ''}" data-s="${k}">${l}</span>`).join('');
      $('#ptype').innerHTML = TYPES.map(([k, l]) => `<span class="chip ${f.type === k ? 'on' : ''}" data-t="${k}">${l}</span>`).join('') + `<span class="chip ${f.recents ? 'on' : ''}" data-r="1" title="Vus ces 3 derniers mois ou avec une séance à venir">Récents</span>`;
      $('#pcount').textContent = ok.length > LIMITE ? `${LIMITE} premiers sur ${ok.length} — affinez la recherche ou les filtres` : `${ok.length} patient${ok.length > 1 ? 's' : ''}`;
      let html = items.map((p, i) => `<div class="sitem prow" data-i="${i}"><div style="min-width:0"><div class="stitre">${surligne(p.nom, ws)}${idPerso(p) ? ` <span class="muted tiny">${esc(idPerso(p))}</span>` : ''}</div>
        <div class="ssous muted tiny">${[p.telephone, p.email].filter(Boolean).map(x => surligne(x, ws)).join(' · ') || ' '}${p.derniere ? ` · dernière séance ${fmtDate(p.derniere)}` : ''}</div></div>
        <div class="badges">${p.type === 'mineur' ? '<span class="badge blue">Mineur</span>' : ''}${etatBadge(p)}</div></div>`).join('');
      if (!html) {
        const ailleurs = patients.filter(p => !exclure.includes(p.id) && correspond(p, ws)).length;
        html = `<div class="empty">Aucun patient ne correspond.${ws.length && ailleurs && (f.statut !== 'tous' || f.type !== 'tous' || f.recents) ? `<br><a href="#" id="pwiden">${ailleurs} résultat${ailleurs > 1 ? 's' : ''} avec d’autres filtres : tout afficher</a>` : ''}</div>`;
      }
      $('#pk-res').innerHTML = html; sel = Math.min(sel, Math.max(items.length - 1, 0)); marquer(false);
      document.querySelectorAll('#pk-res .prow').forEach(r => { r.onclick = () => fermer(items[Number(r.dataset.i)]); r.onmousemove = () => { sel = Number(r.dataset.i); marquer(false); }; });
      const w = $('#pwiden'); if (w) w.onclick = e => { e.preventDefault(); Object.assign(f, { statut: 'tous', type: 'tous', recents: false }); sel = 0; tracer(); };
    };
    const marquer = scroll => document.querySelectorAll('#pk-res .prow').forEach(r => { const on = Number(r.dataset.i) === sel; r.classList.toggle('on', on); if (on && scroll) r.scrollIntoView({ block: 'nearest' }); });
    const clavier = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(null); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; marquer(true); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; marquer(true); } }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); if (items[sel]) fermer(items[sel]); }
    };
    document.addEventListener('keydown', clavier, true);
    input.oninput = () => { f.q = input.value; sel = 0; tracer(); };
    root.addEventListener('click', e => {
      const c = e.target.closest('.chip'); if (!c) return;
      if (c.dataset.s) f.statut = c.dataset.s; else if (c.dataset.t) f.type = c.dataset.t; else if (c.dataset.r) f.recents = !f.recents;
      sel = 0; tracer(); input.focus();
    });
    $('#pclose').onclick = () => fermer(null);
    root.querySelector('.overlay').addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) fermer(null); });
    tracer(); input.focus();
  });
}

// ---------- Alerte « cette personne existe peut-être déjà » ----------
// Se branche sur un formulaire : vérifie pendant la saisie (sans bloquer). « fort » = case à cocher obligatoire ; « possible » = simple information.
// onChoisir(c) (facultatif) : ajoute un bouton « C'est cette personne » (ex. relier une fiche qui existe déjà au lieu d'en créer une seconde).
function doublonsBox(box, { exclureId = 0, payload, onChoisir = null, pasDeBouton = [] }) {
  let cands = [], timer = null, seq = 0;
  const fort = () => cands.some(c => c.niveau === 'fort');
  const draw = () => {
    if (!cands.length) { box.innerHTML = ''; return; }
    const f = fort(), coche = $('#dbl-ok', box) ? $('#dbl-ok', box).checked : false;
    box.innerHTML = `<div class="dbl ${f ? 'fort' : ''}" role="alert">
      <div class="dbl-t">${f ? '⚠ Cette personne existe très probablement déjà' : 'ℹ Une fiche ressemble à celle-ci'}</div>
      ${cands.map(c => `<div class="dbl-c"><div style="min-width:0">
          <a href="#/patient/${c.id}" target="_blank" rel="noopener" class="name">${esc(c.nom)}</a> <span class="muted tiny">${esc(idPerso(c))}</span>
          <div class="muted tiny">${esc([c.telephone, c.email].filter(Boolean).join(' · ') || 'pas de coordonnées')}</div>
          <div class="dbl-r tiny">${esc(c.raisons.join(' · '))}</div></div>
        <div class="badges">${etatBadge(c)}${onChoisir && !pasDeBouton.includes(c.id) ? `<button type="button" class="btn small" data-use="${c.id}">C’est cette personne</button>` : ''}</div></div>`).join('')}
      ${f ? `<label class="check dbl-ok"><input type="checkbox" id="dbl-ok" ${coche ? 'checked' : ''}> Je confirme que c’est une autre personne</label>`
          : '<div class="muted tiny">Si c’est bien une autre personne, enregistrez normalement.</div>'}</div>`;
    box.querySelectorAll('[data-use]').forEach(b => b.onclick = () => onChoisir(cands.find(c => String(c.id) === b.dataset.use)));
  };
  const verifier = async () => {
    const mine = ++seq, pl = payload();
    try {
      const r = await api('POST', '/api/patients/doublons', { ...pl, id: exclureId });
      if (mine === seq) { cands = r.doublons; draw(); }
    } catch { /* ignoré : la vérification est un confort, le serveur recontrôle à l'enregistrement */ }
  };
  return {
    planifier() { clearTimeout(timer); timer = setTimeout(verifier, 350); },
    async maintenant() { clearTimeout(timer); await verifier(); },
    // true si on peut enregistrer (sinon explique pourquoi)
    pret() { if (fort() && !($('#dbl-ok', box) || {}).checked) { toast('Cochez « Je confirme que c’est une autre personne » pour enregistrer'); return false; } return true; },
    aDesCandidats: () => cands.length > 0,
    // Réponse 409 du serveur (saisie très rapide) : on affiche l'alerte, l'utilisateur confirmera puis réenregistrera
    afficher(list) { cands = list; draw(); },
    effacer() { cands = []; draw(); },
  };
}

async function newConsultationModal(patient, defaults = {}) {
  const [modeles, patients, rec] = await Promise.all([api('GET', '/api/modeles'), patient ? Promise.resolve([patient]) : api('GET', '/api/patients'), api('GET', '/api/tarif-suggere')]);
  // Tarif proposé : celui de la dernière séance du patient, sinon le dernier tarif saisi (modifiable)
  const suggere = id => { const x = patients.find(y => y.id === id); return x && x.dernier_tarif != null ? x.dernier_tarif : rec.tarif; };
  modal('Nouvelle séance', `
    ${patient ? '' : `<div class="field"><label>Patient</label><input type="hidden" name="patient">
      <button type="button" class="pickfield" id="pickbtn"><span id="picklbl" class="muted">Choisir un patient…</span><span class="pickchg">Rechercher ▾</span></button></div>`}
    <div class="fields dht"><div class="field"><label>Date</label><input name="date" type="date" required value="${esc(defaults.date || today())}"></div>
    <div class="field"><label>Heure</label><input name="heure" type="time" value="${esc(defaults.heure || '14:00')}"></div>
    <div class="field"><label>Tarif (€)</label><input name="tarif" type="number" min="0" step="1" required value="${esc(suggere(patient ? patient.id : null))}"></div></div>
    <div class="field"><label>Modèle de séance</label><select name="modele"><option value="">Page vide</option>${modeles.map(t => `<option value="${t.id}">${esc(t.nom)}</option>`).join('')}</select></div>
    <div id="cflbox"></div>`,
    async fd => {
      const pid = patient ? patient.id : Number(fd.get('patient'));
      const pat = patients.find(x => x.id === pid);
      if (!pat) { toast('Choisissez un patient'); throw new Error('patient'); }
      const t = modeles.find(x => String(x.id) === fd.get('modele'));
      let c;
      try {
        c = await api('POST', '/api/consultations', { patient_id: pid, date: fd.get('date'), heure: fd.get('heure'), tarif: Number(fd.get('tarif')) || 0, contenu: t ? t.contenu : '', presents: ['patient'], ...(forcer ? { confirme_doublon: true } : {}) });
      } catch (e) {
        if (!(e.data && e.data.conflits)) throw e;
        // Séance déjà prévue à ce moment : on l'indique et le bouton devient « Créer quand même »
        forcer = true;
        $('#cflbox').innerHTML = `<div class="dbl fort" role="alert"><div class="dbl-t">⚠ Vérifiez l’horaire</div>${e.data.conflits.map(x => `<div class="dbl-c"><div>
          <a href="#/consultation/${x.id}" target="_blank" rel="noopener" class="name">${esc(x.patient_nom)}</a> <span class="muted tiny">${esc(x.heure || 'sans heure')}</span>
          <div class="dbl-r tiny">${x.type === 'meme' ? 'Ce patient a déjà une séance ce jour-là (doublon ?)' : 'Cette séance chevauche l’horaire d’un autre patient'}</div></div></div>`).join('')}
          <div class="muted tiny">Modifiez la date ou l’heure, ou créez la séance quand même.</div></div>`;
        $('.modal button.primary').textContent = 'Créer quand même';
        throw e;
      }
      location.hash = '#/consultation/' + c.id;
    }, 'Créer');
  let forcer = false;
  ['date', 'heure'].forEach(n => $(`[name=${n}]`).addEventListener('input', () => { if (forcer) { forcer = false; $('#cflbox').innerHTML = ''; $('.modal button.primary').textContent = 'Créer'; } }));
  // Dans l'onglet Consultations : le patient se choisit dans une fenêtre de recherche ; le tarif suit ce choix tant qu'on ne l'a pas modifié à la main
  if (!patient) {
    const hid = $('input[name=patient]'), tar = $('input[name=tarif]'), lbl = $('#picklbl'); let touched = false;
    tar.oninput = () => { touched = true; };
    const ouvrir = async () => {
      const p = await choisirPatient(patients);
      if (!p) return;
      hid.value = p.id; lbl.textContent = p.nom; lbl.classList.remove('muted');
      if (!touched) tar.value = suggere(p.id);
      $('input[name=date]').focus();
    };
    $('#pickbtn').onclick = ouvrir;
    ouvrir();                                   // le patient est la première chose à choisir : on ouvre directement la recherche
  }
}

// ---------- Lien parent ↔ enfant (un seul enregistrement, visible des deux fiches) ----------
// sens = 'parent' : on ajoute un parent/responsable à "p" ; sens = 'enfant' : on ajoute un enfant/ado à "p"
// Relier une personne à un patient. Deux façons : choisir quelqu'un qui existe déjà (fenêtre de recherche) ou en créer une nouvelle.
//  - sens 'parent' : la personne est un parent / responsable / proche du patient ; sens 'enfant' : c'est un enfant ou ado du patient.
//  - Une NOUVELLE personne reliée comme parent / proche est enregistrée « proche (non suivi) » ; un nouvel enfant / ado est un patient suivi (mineur).
//  - Une personne qui existe déjà garde son statut.
//  onDone(id) : appelé avec l'identifiant de la personne reliée (sinon la page est simplement rechargée).
async function lierPersonne(p, sens, onDone) {
  const tous = (await api('GET', '/api/patients')).filter(x => x.id !== p.id && !p.liens.some(l => l.autre_id === x.id));
  const titre = onDone ? 'Lier une personne' : sens === 'parent' ? 'Ajouter un parent ou responsable' : 'Ajouter un enfant ou ado';
  const proche = sens === 'parent';
  modal(titre, `
    <div class="pills" id="lmode" style="margin-bottom:14px"><span class="chip on" data-m="new">Nouvelle personne</span><span class="chip" data-m="old">Personne déjà enregistrée</span></div>
    <div id="lnew">
      <div id="dblbox"></div>
      <div class="fields"><div class="field"><label>Nom</label><input name="nom"></div><div class="field"><label>Prénom</label><input name="prenom"></div></div>
      <div class="fields"><div class="field"><label>Téléphone</label><input name="telephone" type="tel"></div><div class="field"><label>E-mail</label><input name="email" type="email"></div></div>
      <p class="muted tiny" style="margin:0 0 12px">${proche ? 'Cette personne sera enregistrée comme <b>proche (non suivi)</b>. Vous pourrez la passer en suivi plus tard.' : 'Cet enfant / ado sera enregistré comme nouveau <b>patient mineur</b>.'}</p></div>
    <div id="lold" style="display:none"><div class="field"><label>Personne</label><input type="hidden" name="autre">
      <button type="button" class="pickfield" id="pickbtn"><span id="picklbl" class="muted">Choisir une personne…</span><span class="pickchg">Rechercher ▾</span></button></div></div>
    <div class="field"><label>Lien avec ${esc(p.nom)}</label><select name="role"><option value="parent">Parent</option><option value="responsable légal">Responsable légal</option><option value="autre proche">Autre proche</option></select></div>`,
    async fd => {
      let autreId = Number(fd.get('autre'));
      if (mode === 'new') {
        const nom = String(fd.get('nom') || '').trim();
        if (!nom) { toast('Indiquez un nom'); throw new Error('nom'); }
        await dbl.maintenant();
        if (!dbl.pret()) throw new Error('doublon');
        let n;
        try {
          n = await api('POST', '/api/patients', { nom, prenom: fd.get('prenom'), telephone: fd.get('telephone'), email: fd.get('email'),
            ...(proche ? { type: 'adulte', statut: 'proche' } : { type: 'mineur', statut: 'suivi en cours' }), ...(dbl.aDesCandidats() ? { confirme_doublon: true } : {}) });
        } catch (e) { if (e.data && e.data.doublons) { dbl.afficher(e.data.doublons); toast('Cette personne existe peut-être déjà : vérifiez ci-dessous'); } throw e; }
        autreId = n.id;
      } else if (!autreId) { toast('Choisissez une personne'); throw new Error('autre'); }
      const body = proche ? { patient_id: p.id, proche_id: autreId, role: fd.get('role') } : { patient_id: autreId, proche_id: p.id, role: fd.get('role') };
      await api('POST', '/api/liens', body);
      if (onDone) await onDone(autreId); else render();
    }, 'Relier');
  let mode = 'new';
  imposerFormats($('.modal'));
  const dbl = doublonsBox($('#dblbox'), { pasDeBouton: [p.id, ...p.liens.map(l => l.autre_id)],
    payload: () => ({ nom: $('[name=nom]').value, prenom: $('[name=prenom]').value, telephone: $('[name=telephone]').value, email: $('[name=email]').value }),
    // « C'est cette personne » : on relie la fiche existante au lieu d'en créer une seconde
    onChoisir: c => { mode = 'old'; $('input[name=autre]').value = c.id; $('#picklbl').textContent = c.nom; $('#picklbl').classList.remove('muted'); montrer(); dbl.effacer(); } });
  ['nom', 'prenom', 'telephone', 'email'].forEach(n => $(`[name=${n}]`).addEventListener('input', () => dbl.planifier()));
  const montrer = () => { $('#lnew').style.display = mode === 'new' ? '' : 'none'; $('#lold').style.display = mode === 'old' ? '' : 'none';
    document.querySelectorAll('#lmode .chip').forEach(c => c.classList.toggle('on', c.dataset.m === mode)); };
  document.querySelectorAll('#lmode .chip').forEach(c => c.onclick = () => { mode = c.dataset.m; montrer(); if (mode === 'old' && !$('input[name=autre]').value) $('#pickbtn').click(); });
  $('#pickbtn').onclick = async () => {
    const x = await choisirPatient(tous, { titre: proche ? 'Choisir le parent / proche' : 'Choisir l’enfant / ado', statut: 'tous' });
    if (x) { $('input[name=autre]').value = x.id; $('#picklbl').textContent = x.nom; $('#picklbl').classList.remove('muted'); }
  };
}

// ---------- Export : fenêtre d'options ----------
const exportBtn = (kind, base, label = 'Exporter…') => `<button class="btn" data-export="${kind}" data-base="${base}">${label}</button>`;
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  if (exportHook) await exportHook();
  exportModal(b.dataset.export, b.dataset.base);
});
function exportModal(kind, base) {
  const STATUTS = ['planifiée', 'réalisée', 'absence', 'annulée'];
  const OPT = {
    patient: [['infos', 'Informations du patient (coordonnées, naissance…)'], ['liens', 'Liens familiaux'], ['ressources', 'Ressources (liens web)'], ['notes', 'Notes des séances'], ['finances', 'Tarifs et paiements']],
    seance: [['notes', 'Notes de la séance'], ['ressources', 'Ressources (liens web)'], ['finances', 'Tarifs et paiements']],
    patients: [['infos', 'Coordonnées et identité'], ['liens', 'Liens familiaux'], ['finances', 'Montant restant à régler']],
    seances: [['notes', 'Notes des séances'], ['finances', 'Tarifs et paiements']],
  }[kind];
  const csvSeul = kind === 'patients' || kind === 'seances';
  const avecPeriode = kind !== 'seance', avecStatuts = kind === 'patient' || kind === 'seances';
  const titre = { patient: 'Exporter le dossier', seance: 'Exporter la séance', patients: 'Exporter tous les patients', seances: 'Exporter toutes les séances' }[kind];
  modal(titre, `
    ${csvSeul ? '<p class="muted tiny" style="margin-top:0">Fichier tableur (.csv), à ouvrir avec Excel.</p>' : `<div class="field"><label>Format</label><div class="pills" id="xfmt">
      ${[['pdf', 'PDF (impression)'], ['docx', 'Word (.docx)'], ['md', 'Markdown (.md)'], ['csv', 'Tableur (.csv)']].map(([k, l], i) => `<label class="chip ${i ? '' : 'on'}"><input type="radio" name="fmt" value="${k}" hidden ${i ? '' : 'checked'}>${l}</label>`).join('')}</div></div>`}
    ${avecPeriode ? `<div class="field"><label>${kind === 'patients' ? 'Période prise en compte pour les séances' : 'Période des séances'} <span class="muted tiny">(vide = toutes)</span></label>
      <div class="fields"><div class="field"><label class="tiny muted">Du</label><input type="date" name="du"></div><div class="field"><label class="tiny muted">Au</label><input type="date" name="au"></div></div></div>` : ''}
    ${avecStatuts ? `<div class="field"><label>Statuts des séances</label><div class="pills">${STATUTS.map(x => `<label class="chip on"><input type="checkbox" name="st" value="${x}" hidden checked>${x}</label>`).join('')}</div></div>` : ''}
    <div class="field"><label>Contenu à inclure</label>${OPT.map(([k, l]) => `<label class="check"><input type="checkbox" name="inc" value="${k}" checked> ${l}</label>`).join('')}</div>`,
    fd => {
      const p = new URLSearchParams();
      p.set('format', csvSeul ? 'csv' : fd.get('fmt'));
      if (fd.get('du')) p.set('du', fd.get('du')); if (fd.get('au')) p.set('au', fd.get('au'));
      if (avecStatuts) p.set('statuts', fd.getAll('st').join(','));
      p.set('inclure', fd.getAll('inc').join(','));
      const url = base + (base.includes('?') ? '&' : '?') + p.toString();
      if (!csvSeul && fd.get('fmt') === 'pdf') window.open(url, '_blank'); else location.href = url;     // PDF : page prête à imprimer
    }, 'Exporter');
  // Les « puces » (format, statuts) se comportent comme des cases / boutons radio
  document.querySelectorAll('.modal .chip input').forEach(inp => inp.addEventListener('change', () => {
    if (inp.type === 'radio') document.querySelectorAll('#xfmt .chip').forEach(c => c.classList.toggle('on', c.contains(inp) ? inp.checked : false));
    else inp.closest('.chip').classList.toggle('on', inp.checked);
  }));
}

// ---------- Ressources : liens web joints à un patient ou à une séance ----------
const lienLocal = u => /^[a-z]:[\\/]/i.test(u) || /^\\\\/.test(u) || /^\/(?!\/)/.test(u) || /^~[\\/]/.test(u) || /^file:\/\//i.test(u);
const hoteDe = u => { if (lienLocal(u)) return 'Fichier local · ' + u; try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
// scope : 'patients' ou 'consultations'. Le composant se redessine seul après chaque ajout / modification / suppression.
function mountRessources(el, scope, id, liste) {
  const draw = list => {
    el.innerHTML = `
      ${list.length ? `<div class="docs">${list.map(r => `
        <div class="doc" data-id="${r.id}">
          <span class="dico">${lienLocal(r.url) ? '📁' : '🔗'}</span>
          <div style="min-width:0">${lienLocal(r.url)
            ? `<a class="dname" href="#" data-open="${r.id}" title="Ouvrir sur cet ordinateur">${esc(r.titre)}</a>`
            : `<a class="dname" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.titre)}</a>`}
            <div class="muted tiny">${esc(hoteDe(r.url))} · ajouté le ${fmtDate(r.ajoute_le.slice(0, 10))}${scope === 'patients' && r.consultation_id ? ` · <a href="#/consultation/${r.consultation_id}">séance du ${fmtDate(r.seance_date)}</a>` : ''}</div></div>
          <div class="dact"><button class="btn small" data-ren="${r.id}" title="Modifier">✎</button>
            <button class="btn small danger" data-del="${r.id}" title="Mettre à la corbeille">🗑</button></div>
        </div>`).join('')}</div>` : '<div class="muted" style="margin-bottom:10px">Aucun lien.</div>'}
      <button class="btn small" id="addres-${scope}">+ Ajouter un lien</button>`;
    wire(list);
  };
  const refresh = async () => draw(await api('GET', `/api/${scope}/${id}/ressources`));
  const champs = r => `<div class="field"><label>Adresse du lien</label><input name="url" required placeholder="https://…  ou  C:\\Dossier\\fichier.pdf" value="${esc(r ? r.url : '')}">
      <div class="muted tiny" style="margin-top:4px">Lien web, ou chemin d’un fichier / dossier de cet ordinateur ou du réseau (ex. : <code>C:\\Patients\\bilan.pdf</code>, <code>/Users/…/bilan.pdf</code>). Astuce Windows : Maj + clic droit sur le fichier &gt; « Copier en tant que chemin ».</div></div>
    <div class="field"><label>Titre <span class="muted tiny">(facultatif)</span></label><input name="titre" placeholder="Nom affiché" value="${esc(r ? r.titre : '')}"></div>`;
  const wire = list => {
    el.querySelector('[id^=addres-]').onclick = () => modal('Ajouter un lien', champs(), async fd => { await api('POST', `/api/${scope}/${id}/ressources`, { url: fd.get('url'), titre: fd.get('titre') }); toast('Lien ajouté'); refresh(); });
    el.querySelectorAll('[data-open]').forEach(a => a.onclick = async e => { e.preventDefault(); try { await api('POST', '/api/ressources/' + a.dataset.open + '/ouvrir'); } catch { /* message déjà affiché */ } });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('DELETE', '/api/ressources/' + b.dataset.del); toast('Lien placé dans la corbeille'); refresh(); refreshTrash(); });
    el.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
      const r = list.find(x => String(x.id) === b.dataset.ren);
      modal('Modifier le lien', champs(r), async fd => { await api('PUT', '/api/ressources/' + r.id, { url: fd.get('url'), titre: fd.get('titre') }); refresh(); });
    });
  };
  draw(liste);
}

// ---------- Vue : liste des patients ----------
async function viewPatients() {
  const [patients, P] = await Promise.all([api('GET', '/api/patients'), api('GET', '/api/parametres')]);
  let q = '', filtre = 'actifs';
  app.innerHTML = `
    ${P.rappel_export ? `<div class="banner" id="rappel"><div><b>Pensez à exporter vos données.</b> ${P.dernier_export ? `Dernier export complet : ${fmtDate(P.dernier_export)}.` : 'Aucun export complet n’a encore été fait.'}
      <span class="muted">Une copie lisible sans l’application protège contre toute panne.</span></div>
      <div class="bbtn"><a class="btn small primary" href="#/parametres">Exporter…</a><button class="btn small" id="rappel-plus">Plus tard</button></div></div>` : ''}
    <div class="head"><div><h1>Patients</h1><div class="sub" id="count"></div></div>
      <div class="headbtns">${exportBtn('patients', '/api/export/patients.csv')}<button class="btn primary" id="new">+ Nouveau patient</button></div></div>
    <div class="toolbar"><input type="search" id="q" placeholder="Rechercher un patient…">
      <div class="chips" id="chips"></div></div>
    <div class="card list patients" id="list" style="padding:0"></div>`;
  const draw = () => {
    // Les archivés sont masqués sauf dans leur filtre ; quand on cherche un nom, on cherche partout
    const visible = p => filtre === 'archives' ? !!p.archive_le
      : !p.archive_le && (filtre === 'tous' || (filtre === 'actifs' ? p.statut === 'suivi en cours' : p.statut === filtre));
    const rows = patients.filter(p => p.nom.toLowerCase().includes(q.toLowerCase()) && (q || visible(p)));
    $('#count').textContent = `${rows.length} patient${rows.length > 1 ? 's' : ''}`;
    $('#chips').innerHTML = [['actifs', 'En cours'], ['en pause', 'En pause'], ['terminé', 'Terminés'], ['proche', 'Proches'], ['archives', 'Archivés'], ['tous', 'Tous']]
      .map(([k, l]) => `<span class="chip ${filtre === k ? 'on' : ''}" data-f="${k}">${l}</span>`).join('');
    $('#list').innerHTML = rows.length
      ? `<div class="row listhead"><span>Patient</span><span>Dernière séance</span><span>Prochaine séance</span><span></span></div>` +
        rows.map(p => `<div class="row" data-id="${p.id}">
          <div><span class="name">${esc(p.nom)}</span>${idPerso(p, false) ? ` <span class="${HOMO.has(p.id) ? 'homo' : 'muted tiny'}">${esc(idPerso(p, false))}</span>` : HOMO.has(p.id) ? ' <span class="homo" title="Un autre patient porte le même nom : renseignez la date de naissance ou une précision">(homonyme)</span>' : ''} ${p.type === 'mineur' ? '<span class="badge blue">Mineur</span>' : ''}</div>
          <div class="muted">${p.derniere ? fmtDate(p.derniere) : '—'}</div>
          <div>${p.prochaine ? fmtDate(p.prochaine) : '<span class="muted">—</span>'}</div>
          <div class="badges">${p.impayees ? `<span class="badge warn">${p.impayees} à régler</span>` : ''}${etatBadge(p)}</div></div>`).join('')
      : `<div class="empty">Aucun patient ici pour le moment.</div>`;
    document.querySelectorAll('#list .row[data-id]').forEach(r => r.onclick = () => location.hash = '#/patient/' + r.dataset.id);
    document.querySelectorAll('#chips .chip').forEach(c => c.onclick = () => { filtre = c.dataset.f; draw(); });
  };
  $('#q').oninput = e => { q = e.target.value; draw(); };
  $('#new').onclick = () => patientModal();
  if ($('#rappel-plus')) $('#rappel-plus').onclick = async () => { await api('POST', '/api/parametres/rappel-repousse'); $('#rappel').remove(); };
  draw();
}

function patientModal(p) {
  const v = p || { nom_famille: '', prenom: '', civilite: '', date_naissance: '', type: 'adulte', statut: 'suivi en cours', contact: '', email: '', telephone: '', complement: '' };
  modal(p ? 'Modifier le patient' : 'Nouveau patient', `
    <div id="dblbox"></div>
    <div class="fields id3">
      <div class="field"><label>Civilité</label><select name="civilite"><option value="">Non renseigné</option>
        <option value="M" ${v.civilite === 'M' ? 'selected' : ''}>M.</option><option value="Mme" ${v.civilite === 'Mme' ? 'selected' : ''}>Mme</option></select></div>
      <div class="field"><label>Nom</label><input name="nom_famille" required value="${esc(v.nom_famille)}"></div>
      <div class="field"><label>Prénom</label><input name="prenom" value="${esc(v.prenom)}"></div>
    </div>
    <div class="fields">
      <div class="field"><label>Date de naissance</label><input name="date_naissance" type="date" max="${today()}" value="${esc(v.date_naissance || '')}"></div>
      <div class="field"><label>Âge</label><div class="agebox" id="agetxt">${esc((ageInfo(v.date_naissance) || {}).texte || '—')}</div></div>
    </div>
    <div class="fields">
      <div class="field"><label>Type</label><select name="type"><option value="adulte" ${v.type === 'adulte' ? 'selected' : ''}>Adulte</option><option value="mineur" ${v.type === 'mineur' ? 'selected' : ''}>Mineur</option></select></div>
      <div class="field"><label>Statut</label><select name="statut">${STATUTS_PATIENT.map(s => `<option value="${s}" ${s === v.statut ? 'selected' : ''}>${esc(STATUT_LABEL[s] || s)}</option>`).join('')}</select></div>
    </div>
    <div class="fields">
      <div class="field"><label>Téléphone</label><input name="telephone" type="tel" autocomplete="off" value="${esc(v.telephone)}"></div>
      <div class="field"><label>E-mail</label><input name="email" type="email" autocomplete="off" value="${esc(v.email)}"></div>
    </div>
    <div class="field"><label>Précision <span class="muted tiny">(pour distinguer deux homonymes, ex. « fille de Marie »)</span></label><input name="complement" maxlength="80" value="${esc(v.complement || '')}"></div>
    <div class="field"><label>Autres coordonnées <span class="muted tiny">(adresse, précisions…)</span></label><input name="contact" value="${esc(v.contact)}"></div>`,
    async fd => {
      const body = Object.fromEntries(fd);
      await dbl.maintenant();                         // dernière vérification avec ce qui est réellement saisi
      if (!dbl.pret()) throw new Error('doublon');
      if (dbl.aDesCandidats()) body.confirme_doublon = true;
      try {
        if (p) { await api('PUT', '/api/patients/' + p.id, body); render(); }
        else { const n = await api('POST', '/api/patients', body); location.hash = '#/patient/' + n.id; }
        refreshDoublons();
      } catch (e) {
        if (e.data && e.data.doublons) { dbl.afficher(e.data.doublons); toast('Vérifiez cette ressemblance, puis enregistrez de nouveau'); }
        throw e;
      }
    }, 'Enregistrer', false, 'wide');
  const champ = n => $(`[name=${n}]`);
  imposerFormats($('.modal'));
  const dbl = doublonsBox($('#dblbox'), { exclureId: p ? p.id : 0,
    payload: () => ({ nom_famille: champ('nom_famille').value, prenom: champ('prenom').value, date_naissance: champ('date_naissance').value, telephone: champ('telephone').value, email: champ('email').value }) });
  ['nom_famille', 'prenom', 'date_naissance', 'telephone', 'email'].forEach(n => champ(n).addEventListener('input', () => dbl.planifier()));
  // L'âge se met à jour pendant la saisie ; on propose Mineur / Adulte d'après l'âge (modifiable ensuite)
  const dn = $('input[name=date_naissance]');
  dn.addEventListener('input', () => {
    const a = ageInfo(dn.value);
    $('#agetxt').textContent = a ? a.texte : '—';
    if (a) $('select[name=type]').value = a.annees < 18 ? 'mineur' : 'adulte';
  });
}

// ---------- Vue : fiche patient ----------
async function viewPatient(m) {
  const id = Number(m[1]);
  const p = await api('GET', '/api/patients/' + id);
  const realisees = p.consultations.filter(c => c.statut === 'réalisée');
  const du = realisees.filter(c => !c.paye).reduce((s, c) => s + (c.tarif || 0), 0);
  app.innerHTML = `
    <a class="crumb" href="#/patients">← Patients</a>
    <div class="head"><div><h1>${esc(p.nom)}</h1>
      <div class="sub">${HOMO.has(id) ? `<span class="badge warn" title="Un autre patient porte le même nom">homonyme</span> ` : ''}${p.complement ? `<span class="homo">${esc(p.complement)}</span> · ` : ''}${etatBadge(p)}${p.archive_le ? ` <span class="muted">depuis le ${fmtDate(p.archive_le)}</span>` : ''} ${p.type === 'mineur' ? '<span class="badge blue">Mineur</span>' : ''}
        ${p.age_texte ? ' · ' + esc(p.age_texte) : ''} · ${realisees.length} séance${realisees.length > 1 ? 's' : ''} réalisée${realisees.length > 1 ? 's' : ''}${du ? ` · <span style="color:var(--warn)">${euro(du)} à régler</span>` : ''}</div></div>
      <div class="headbtns">${exportBtn('patient', `/api/patients/${id}/export`)}<button class="btn" id="edit">Modifier</button> ${p.archive_le ? '<button class="btn primary" id="unarchive">Désarchiver</button>' : '<button class="btn primary" id="newc">+ Nouvelle séance</button>'}</div></div>
    <div class="grid2">
      <div class="card"><h2>Consultations</h2><div class="timeline" id="tl">
        ${(() => {
          // Ses propres séances + celles où il / elle accompagnait quelqu'un d'autre (repérées par une pastille et une couleur), par ordre chronologique inverse
          const acc = (p.accompagnements || []).map(c => ({ ...c, acc: true }));
          const tout = [...p.consultations, ...acc].sort((x, y) => (y.date + y.heure).localeCompare(x.date + x.heure));
          if (!tout.length) return '<div class="empty">Aucune consultation pour l’instant.</div>';
          return (acc.length ? `<div class="acclegend"><span class="badge acc">Accompagnant</span> séance faite pour une autre personne : ${esc(p.prenom || p.nom)} était présent(e) mais n’était pas le patient.</div>` : '')
            + tout.map(c => c.acc ? `
          <div class="item acc" data-id="${c.id}" title="Séance de ${esc(c.pour_nom)} : ${esc(p.nom)} accompagnait">
            <div class="date">${fmtDate(c.date)}</div>
            <div style="min-width:0"><div class="meta">${esc(c.heure)} · ${esc(c.mode)}</div>
              <div class="accfor"><span class="badge acc">Accompagnant</span> pour <a href="#/patient/${c.pour_id}" data-stop>${esc(c.pour_nom)}</a></div></div>
            <div class="badges">${statutBadge(c.statut)}</div>
          </div>` : `
          <div class="item" data-id="${c.id}">
            <div class="date">${fmtDate(c.date)}</div>
            <div style="min-width:0"><div class="meta">${esc(c.heure)} · ${esc(c.mode)}${c.autres_presents.length ? ' · avec ' + esc(c.autres_presents.join(', ')) : ''}</div>
              ${strip(c.contenu) ? `<div class="snip">${esc(strip(c.contenu))}</div>` : ''}</div>
            <div class="badges">${c.statut === 'réalisée' && !c.paye ? '<span class="badge warn">À régler</span>' : ''}${statutBadge(c.statut)}</div>
          </div>`).join('');
        })()}
      </div></div>
      <div>
        <div class="card" style="margin-bottom:18px"><h2>Informations</h2>
          <div class="field"><label>Téléphone</label>${p.telephone ? `<a href="tel:${esc(p.telephone.replace(/[^\d+]/g, ''))}">${esc(p.telephone)}</a>` : '<span class="muted">—</span>'}</div>
          <div class="field"><label>E-mail</label>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : '<span class="muted">—</span>'}</div>
          ${p.contact ? `<div class="field"><label>Autres coordonnées</label>${esc(p.contact)}</div>` : ''}
          ${p.complement ? `<div class="field"><label>Précision</label>${esc(p.complement)}</div>` : ''}
          <div class="field"><label>Civilité</label>${p.civilite ? esc(p.civilite === 'M' ? 'M.' : 'Mme') : '<span class="muted">Non renseignée</span>'}</div>
          <div class="field"><label>Naissance</label>${p.date_naissance ? `${fmtDate(p.date_naissance)} · ${esc(p.age_texte)}` : '<span class="muted">Non renseignée</span>'}</div>
          <div class="field"><label>Notes pratiques</label><textarea id="pnotes" rows="4" placeholder="Disponibilités, préférences de contact…">${esc(p.notes)}</textarea></div>
        </div>
        <div class="card" style="margin-bottom:18px"><h2>Ressources</h2><div id="res-p"></div></div>
        <div class="card"><h2>Liens familiaux</h2>
          ${['parent', 'enfant'].map(sens => { const L = p.liens.filter(l => l.sens === sens); return L.length ? `
            <div class="field" style="margin-bottom:6px"><label>${sens === 'parent' ? 'Parents et responsables' : 'Enfants et ados'}</label></div>
            ${L.map(l => `<div class="proche"><a href="#/patient/${l.autre_id}" style="min-width:0"><div class="name">${esc(l.autre_nom)}</div>
              <div class="muted tiny">${esc(sens === 'parent' ? l.role : 'en tant que ' + l.role)}${l.autre_statut === 'proche' ? ' · non suivi' : ''}</div></a>
              <button class="x" data-unlink="${l.lien_id}" title="Retirer ce lien">×</button></div>`).join('')}` : ''; }).join('')
            || ''}
          ${p.liens.length ? '' : '<div class="muted">Aucun lien. Reliez un ado à ses parents ou responsables légaux.</div>'}
          <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn small" id="addparent">+ Parent / responsable</button><button class="btn small" id="addenfant">+ Enfant / ado</button></div>
        </div>
        <div class="card" style="margin-top:18px"><h2>Gestion du dossier</h2>
          <p class="muted tiny" style="margin:0 0 10px"><b>Archiver</b> : le patient ne vient plus mais peut revenir. Son dossier est conservé, il disparaît simplement des listes.<br>
            <b>Supprimer</b> : efface tout, pour une erreur de saisie ou un rendez-vous non honoré.<br>
            <b>Fusionner</b> : regroupe deux fiches de la même personne (doublon) en une seule.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${p.archive_le ? '' : '<button class="btn small" id="archive">Archiver</button>'}<button class="btn small" id="fusionner">Fusionner avec une autre fiche…</button><button class="btn small danger" id="delpatient">Supprimer…</button></div>
        </div>
      </div>
    </div>`;
  $('#edit').onclick = () => patientModal(p);
  mountRessources($('#res-p'), 'patients', id, p.ressources);
  document.querySelectorAll('#tl .item').forEach(i => i.onclick = e => { if (e.target.closest('[data-stop]')) return; location.hash = '#/consultation/' + i.dataset.id; });
  $('#pnotes').onchange = e => api('PUT', '/api/patients/' + id, { notes: e.target.value }).then(() => toast('Notes enregistrées'));
  document.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async () => { await api('DELETE', '/api/liens/' + b.dataset.unlink); render(); });
  $('#addparent').onclick = () => lierPersonne(p, 'parent');
  $('#addenfant').onclick = () => lierPersonne(p, 'enfant');
  if ($('#newc')) $('#newc').onclick = () => newConsultationModal(p);
  if ($('#unarchive')) $('#unarchive').onclick = async () => { await api('POST', `/api/patients/${id}/desarchiver`); toast('Patient désarchivé'); render(); };
  if ($('#archive')) $('#archive').onclick = () => archiveModal(p);
  $('#delpatient').onclick = () => deleteModal(p);
  $('#fusionner').onclick = async () => {
    const tous = (await api('GET', '/api/patients')).filter(x => x.id !== id);
    const autre = await choisirPatient(tous, { titre: 'Fusionner « ' + p.nom + ' » avec…', statut: 'tous' });
    if (autre) fusionModal(p, await api('GET', '/api/patients/' + autre.id));
  };
}

// ---------- Fusion de deux fiches ----------
// a = fiche CONSERVÉE, b = fiche ABSORBÉE (séances, liens, ressources et notes passent sur a ; b va 30 jours à la corbeille). Deux objets « patient complet ».
function fusionModal(a, b) {
  const CH = [['nom', 'Nom', x => x.nom_famille], ['prenom', 'Prénom', x => x.prenom], ['civilite', 'Civilité', x => x.civilite === 'M' ? 'M.' : x.civilite],
    ['date_naissance', 'Naissance', x => x.date_naissance && fmtDate(x.date_naissance)], ['type', 'Type', x => x.type], ['statut', 'Statut', x => STATUT_LABEL[x.statut] || x.statut],
    ['telephone', 'Téléphone', x => x.telephone], ['email', 'E-mail', x => x.email], ['contact', 'Autres coordonnées', x => x.contact], ['complement', 'Précision', x => x.complement]];
  const vide = v => v === null || v === undefined || String(v).trim() === '';
  const raw = (k, x) => k === 'nom' ? x.nom_famille : x[k];
  // Un choix n'est demandé que si les deux fiches ont une valeur différente (sinon on garde la valeur renseignée). Statut : « proche » cède toujours la place.
  const conflits = CH.filter(([k, , f]) => !vide(raw(k, a)) && !vide(raw(k, b)) && raw(k, a) !== raw(k, b) && !(k === 'statut' && (a.statut === 'proche' || b.statut === 'proche')));
  const sa = a.consultations.length, sb = b.consultations.length;
  const reliees = a.liens.some(l => l.autre_id === b.id);
  const entete = x => `<b>${esc(x.nom)}</b><div class="muted tiny">${esc([idPerso(x), x.telephone].filter(Boolean).join(' · ') || 'pas de coordonnées')}</div>`;
  modal('Fusionner deux fiches', `
    ${reliees ? '<div class="dbl fort"><div class="dbl-t">⚠ Ces deux fiches sont reliées (parent / enfant)</div><div class="muted tiny">Il s’agit sans doute de deux personnes différentes. Fusionnez seulement s’il s’agit bien de la même personne.</div></div>' : ''}
    <div class="fus-cols"><div class="fus-col keep"><div class="tiny muted">Fiche conservée</div>${entete(a)}<div class="tiny">${plurFr(sa, 'séance')}</div></div>
      <button type="button" class="btn small" id="swap" title="Inverser : conserver l’autre fiche">⇄</button>
      <div class="fus-col drop"><div class="tiny muted">Fiche absorbée</div>${entete(b)}<div class="tiny">${plurFr(sb, 'séance')}</div></div></div>
    ${conflits.length ? `<div class="field"><label>Les deux fiches ne sont pas d’accord : quelle valeur garder ?</label>
      <table class="fus">${conflits.map(([k, l, f]) => `<tr><th>${l}</th>
        <td><label class="radio"><input type="radio" name="f_${k}" value="garde" checked> ${esc(f(a))}</label></td>
        <td><label class="radio"><input type="radio" name="f_${k}" value="autre"> ${esc(f(b))}</label></td></tr>`).join('')}</table></div>` : '<p class="muted tiny" style="margin-top:0">Aucune information contradictoire : les champs vides seront complétés avec ceux de l’autre fiche.</p>'}
    <p class="tiny" style="margin:8px 0 0">Seront ajoutés à <b>${esc(a.nom)}</b> : ${plurFr(sb, 'séance')}, ${plurFr(b.liens.length, 'lien familial', 'liens familiaux')}, ${plurFr(b.ressources.length, 'ressource')} et les notes pratiques.
      La fiche « ${esc(b.nom)} » ira dans la <b>corbeille</b> pendant 30 jours ; une copie de sécurité complète est faite avant.</p>`,
    async fd => {
      const champs = {}; conflits.forEach(([k]) => { champs[k] = fd.get('f_' + k); });
      await api('POST', `/api/patients/${a.id}/fusion`, { avec: b.id, champs });
      toast('Fiches fusionnées'); refreshTrash(); refreshDoublons();
      if (location.hash === '#/patient/' + a.id || location.hash === '#/doublons') render(); else location.hash = '#/patient/' + a.id;
    }, 'Fusionner', true);
  $('#swap').onclick = () => fusionModal(b, a);
}
const plurFr = (n, mot, pluriel) => n ? `${n} ${n > 1 ? (pluriel || mot + 's') : mot}` : `${['séance', 'ressource'].includes(mot) ? 'aucune' : 'aucun'} ${mot}`;

// ---------- Vue : paramètres (nom, mot de passe, export) ----------
function afficherCle(cle) {
  modal('Clé de secours', `<p style="margin-top:0">Si vous oubliez votre mot de passe, cette clé permet d’en définir un nouveau. <b>Sans elle, il n’existe aucun moyen de le récupérer.</b></p>
    <div class="cle" id="cle">${esc(cle)}</div>
    <p class="muted tiny">Notez-la sur papier ou dans un gestionnaire de mots de passe, hors de cet ordinateur. Elle ne sera plus affichée. Changer le mot de passe génère une nouvelle clé.</p>
    <label class="check"><input type="checkbox" required> J’ai noté cette clé en lieu sûr</label>`, async () => {}, 'C’est noté');
}
async function viewParametres() {
  const [P, MAJ] = await Promise.all([api('GET', '/api/parametres'), api('GET', '/api/mise-a-jour')]);
  auth.protege = P.protege; auth.delai = P.delai_min; majBoutonVerrou();
  const mdpChamps = (actuel, nouveau) => `${actuel ? '<div class="field"><label>Mot de passe actuel</label><input type="password" name="actuel" autocomplete="current-password" required></div>' : ''}
    ${nouveau ? `<div class="field"><label>Nouveau mot de passe <span class="muted tiny">(8 caractères minimum)</span></label><input type="password" name="mdp" minlength="8" autocomplete="new-password" required></div>
    <div class="field"><label>Confirmer</label><input type="password" name="mdp2" minlength="8" autocomplete="new-password" required></div>` : ''}`;
  app.innerHTML = `<div class="head"><div><h1>Paramètres</h1></div></div>
    <div class="card pcard"><h2>Nom de l’application</h2>
      <p class="muted tiny" style="margin-top:0">Affiché à côté du logo et dans le titre de la fenêtre.</p>
      <form id="nomform" class="inl"><input id="nomcab" maxlength="40" value="${esc(P.nom_cabinet)}" aria-label="Nom de l’application"><button class="btn primary">Enregistrer</button>
        ${P.nom_cabinet !== P.nom_defaut ? '<button type="button" class="btn" id="nomdef">Valeur d’origine</button>' : ''}</form></div>
    <div class="card pcard"><h2>Mot de passe</h2>
      ${P.protege ? `<p style="margin-top:0">🔒 L’accès à l’application est protégé par un mot de passe.</p>
        <div class="field"><label>Verrouillage automatique</label><select id="delai">${[[0, 'Jamais'], [5, 'Après 5 minutes d’inactivité'], [10, 'Après 10 minutes'], [15, 'Après 15 minutes'], [30, 'Après 30 minutes'], [60, 'Après 1 heure']]
          .map(([v, l]) => `<option value="${v}" ${v === P.delai_min ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="btnrow"><button class="btn" id="lockno">Verrouiller maintenant</button><button class="btn" id="chg">Changer le mot de passe…</button><button class="btn danger" id="ret">Retirer le mot de passe…</button></div>`
        : `<p style="margin-top:0">Aucun mot de passe : l’application s’ouvre directement. Un mot de passe est facultatif (un seul utilisateur).</p>
        <div class="btnrow"><button class="btn primary" id="act">Activer un mot de passe…</button></div>`}
      <p class="muted tiny" style="margin-bottom:0">Le mot de passe empêche d’ouvrir l’application, mais <b>ne chiffre pas le fichier de données</b>. Pour protéger aussi le fichier (vol de l’ordinateur), chiffrez le disque ou le volume qui le contient.</p></div>
    <div class="card pcard"><h2>Mise à jour de l’application</h2>
      <p style="margin-top:0">Version installée : <b>${esc(MAJ.version)}</b></p>
      ${MAJ.auto ? '<div class="btnrow"><button class="btn primary" id="majbtn">Rechercher une mise à jour</button></div><p class="muted tiny" id="majmsg" style="margin-bottom:0">Vérification automatique à chaque ouverture. Vos données ne sont jamais touchées.</p>'
        : '<p class="muted tiny" style="margin-bottom:0">Mise à jour automatique : application Windows installée uniquement. Sur Mac : <code>Mettre-a-jour-Mac.command</code>.</p>'}</div>
    <div class="card pcard"><h2>Dossier des données</h2>
      <p style="margin-top:0">Les patients et les séances sont enregistrés ici :<br><code>${esc(P.dossier_donnees)}</code></p>
      ${P.dossier_modifiable ? '<div class="btnrow"><button class="btn" id="dirbtn">Changer le dossier…</button></div><p class="muted tiny" id="dirmsg" style="margin-bottom:0">Pour un volume chiffré (VeraCrypt), montez-le d’abord. Les données sont copiées dans le nouveau dossier, puis l’application redémarre. L’ancien dossier n’est pas effacé.</p>'
        : '<p class="muted tiny" style="margin-bottom:0">Le changement de dossier se fait dans l’application de bureau (Windows/Mac).</p>'}</div>
    <div class="card pcard"><h2>Sauvegarde et export</h2>
      <p style="margin-top:0">Dernier export complet : <b>${P.dernier_export ? fmtDate(P.dernier_export) : 'jamais'}</b></p>
      <div class="btnrow"><a class="btn primary" href="/api/export/complet" id="expfull">Exporter toutes les données (zip)</a><a class="btn" href="/api/sauvegarde">Sauvegarder la base (cabinet.db)</a></div>
      <p class="muted tiny"><b>Export complet</b> : un dossier lisible sans l’application (tableurs Excel, un fichier Word par patient, copie JSON, description de la base). À ranger sur un support chiffré, jamais par e-mail.<br>
        <b>Sauvegarde de la base</b> : copie exacte du fichier de données, pour tout restaurer dans l’application.</p>
      <p class="muted tiny" style="margin-bottom:0">Dossier des données : <code>${esc(P.dossier_donnees)}</code> · Version ${esc(P.version)}</p></div>`;
  $('#nomform').onsubmit = async e => {
    e.preventDefault();
    const r = await api('PUT', '/api/parametres', { nom_cabinet: $('#nomcab').value });
    appliquerNom(r.nom_cabinet); toast('Nom enregistré'); render();
  };
  if ($('#nomdef')) $('#nomdef').onclick = async () => { const r = await api('PUT', '/api/parametres', { nom_cabinet: '' }); appliquerNom(r.nom_cabinet); toast('Nom d’origine rétabli'); render(); };
  const mdpIdentiques = fd => { if (fd.get('mdp') !== fd.get('mdp2')) { toast('Les deux mots de passe sont différents'); throw new Error('mdp'); } };
  if ($('#act')) $('#act').onclick = () => modal('Activer un mot de passe', mdpChamps(false, true), async fd => {
    mdpIdentiques(fd);
    const r = await api('POST', '/api/auth/definir', { mdp: fd.get('mdp') });
    auth.protege = true; majBoutonVerrou(); armerInactivite(); setTimeout(() => { afficherCle(r.cle_secours); render(); }, 0);
  }, 'Activer');
  if ($('#chg')) $('#chg').onclick = () => modal('Changer le mot de passe', mdpChamps(true, true), async fd => {
    mdpIdentiques(fd);
    const r = await api('POST', '/api/auth/definir', { actuel: fd.get('actuel'), mdp: fd.get('mdp') });
    setTimeout(() => afficherCle(r.cle_secours), 0);
  }, 'Changer');
  if ($('#ret')) $('#ret').onclick = () => modal('Retirer le mot de passe', '<p style="margin-top:0">L’application s’ouvrira de nouveau sans mot de passe.</p>' + mdpChamps(true, false), async fd => {
    await api('POST', '/api/auth/retirer', { actuel: fd.get('actuel') });
    auth.protege = false; majBoutonVerrou(); clearTimeout(idleT); toast('Mot de passe retiré'); render();
  }, 'Retirer', true);
  if ($('#lockno')) $('#lockno').onclick = verrouillerMaintenant;
  if ($('#delai')) $('#delai').onchange = async e => { const r = await api('POST', '/api/auth/delai', { minutes: Number(e.target.value) }); auth.delai = r.delai_min; armerInactivite(); toast('Enregistré'); };
  if ($('#majbtn')) $('#majbtn').onclick = async () => {
    const b = $('#majbtn'); b.disabled = true; $('#majmsg').textContent = 'Vérification…';
    try { const r = await api('POST', '/api/mise-a-jour/verifier'); $('#majmsg').textContent = r.message || ''; } catch { $('#majmsg').textContent = 'Vérification impossible.'; }
    b.disabled = false;
  };
  if ($('#dirbtn')) $('#dirbtn').onclick = async () => {
    const b = $('#dirbtn'); b.disabled = true;
    try {
      const r = await api('POST', '/api/dossier-donnees/changer');
      if (r.etat === 'redemarrage') { $('#dirmsg').textContent = 'Données copiées. Redémarrage de l’application… (si elle ne se rouvre pas, relancez-la à la main)'; return; }
      if (r.etat === 'erreur') $('#dirmsg').textContent = r.message;
    } catch (e) { $('#dirmsg').textContent = (e && e.message) || 'Changement impossible.'; }
    b.disabled = false;
  };
  if ($('#expfull')) $('#expfull').onclick = () => setTimeout(() => toast('Export en cours…'), 50);
}

// ---------- Vue : doublons possibles ----------
async function refreshDoublons() {
  try { const n = (await (await fetch('/api/doublons')).json()).length; const b = $('#dbl-count'); b.textContent = n || ''; b.hidden = !n; } catch { /* sans importance */ }
}
async function viewDoublons() {
  const liste = await api('GET', '/api/doublons');
  app.innerHTML = `<div class="head"><div><h1>Doublons possibles</h1><div class="sub">${liste.length ? `${liste.length} paire${liste.length > 1 ? 's' : ''} de fiches qui se ressemblent` : 'Aucune ressemblance détectée'}</div></div></div>
    ${liste.length ? '<p class="muted" style="margin-top:0">Comparaison des noms (accents, ordre et petites fautes de frappe ignorés), des téléphones et des e-mails. Deux homonymes dont les dates de naissance diffèrent ne sont jamais signalés.</p>' : '<div class="empty">Tout est en ordre : aucune fiche ne ressemble à une autre.</div>'}
    ${liste.length > 1 ? '<div class="toolbar" style="margin-bottom:12px"><input type="search" id="dbl-q" placeholder="Rechercher un nom, un téléphone, un e-mail…" autocomplete="off"></div><div class="muted tiny" id="dbl-n" style="margin:-4px 0 10px"></div>' : ''}
    <div id="dbl-list">${liste.map((x, i) => `<div class="card dblpair" data-i="${i}" data-t="${esc(normTxt([x.a.nom, x.a.telephone, x.a.email, x.b.nom, x.b.telephone, x.b.email].join(' ')))}">
      <div class="dbl-t ${x.niveau === 'fort' ? 'fortc' : ''}">${x.niveau === 'fort' ? '⚠ Très probablement la même personne' : 'ℹ À vérifier'} <span class="muted tiny" style="font-weight:400">· ${esc(x.raisons.join(' · '))}</span></div>
      <div class="fus-cols">${[x.a, x.b].map(y => `<div class="fus-col"><a href="#/patient/${y.id}" class="name">${esc(y.nom)}</a>
        <div class="muted tiny">${esc([idPerso(y) || 'âge inconnu', y.telephone, y.email].filter(Boolean).join(' · '))}</div><div style="margin-top:4px">${etatBadge(y)}</div></div>`).join('<div></div>')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn small primary" data-fus="${i}">Fusionner…</button><button class="btn small" data-non="${i}">Ce sont deux personnes différentes</button></div></div>`).join('')}</div>`;
  const rq = $('#dbl-q');
  if (rq) rq.oninput = () => {
    const ws = normTxt(rq.value).split(/\s+/).filter(Boolean); let n = 0;
    document.querySelectorAll('.dblpair').forEach(c => { const ok = ws.every(w => c.dataset.t.includes(w)); c.hidden = !ok; if (ok) n++; });
    $('#dbl-n').textContent = ws.length ? (n ? `${n} paire${n > 1 ? 's' : ''} sur ${liste.length}` : 'Aucune paire ne correspond.') : '';
  };
  document.querySelectorAll('[data-non]').forEach(b => b.onclick = async () => { const x = liste[Number(b.dataset.non)]; await api('POST', '/api/doublons/ignorer', { a: x.a.id, b: x.b.id }); toast('Noté : on ne vous le proposera plus'); refreshDoublons(); render(); });
  document.querySelectorAll('[data-fus]').forEach(b => b.onclick = async () => {
    const x = liste[Number(b.dataset.fus)];
    const [A, B] = await Promise.all([api('GET', '/api/patients/' + x.a.id), api('GET', '/api/patients/' + x.b.id)]);
    // On garde par défaut la fiche qui a le plus de séances (à égalité : la plus ancienne)
    if (B.consultations.length > A.consultations.length) fusionModal(B, A); else fusionModal(A, B);
  });
}

function archiveModal(p) {
  const futures = p.consultations.filter(c => c.statut === 'planifiée' && c.date >= today()).length;
  modal(`Archiver ${p.nom} ?`, `<p class="muted" style="margin-top:0">Le patient disparaît des listes et du choix de patients. Tout son dossier (séances, notes, liens) est conservé, et vous pourrez le désarchiver s'il revient.</p>
    ${futures ? `<div class="field"><label class="check"><input type="checkbox" name="annuler" checked> Annuler ses ${futures} séance${futures > 1 ? 's' : ''} planifiée${futures > 1 ? 's' : ''} à venir</label></div>` : ''}`,
    async fd => { await api('POST', `/api/patients/${p.id}/archiver`, { annuler_futures: fd.get('annuler') === 'on' }); toast('Patient archivé'); location.hash = '#/patients'; }, 'Archiver');
}

async function deleteModal(p) {
  const a = await api('GET', `/api/patients/${p.id}/suppression`);
  const pl = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  modal(`Supprimer ${p.nom} ?`, `
    <p style="margin-top:0">${a.nb_consultations
      ? `Le patient et ses <b>${pl(a.nb_consultations, 'séance')}</b> (dont ${a.nb_realisees} réalisée${a.nb_realisees > 1 ? 's' : ''}) seront placés dans la <b>corbeille</b>.`
      : 'Le patient sera placé dans la <b>corbeille</b>.'}${a.nb_ressources ? ` Ses <b>${pl(a.nb_ressources, 'lien')}</b> suivent.` : ''}</p>
    <p class="muted">Vous pourrez le restaurer pendant 30 jours, après quoi il sera effacé définitivement. Si ce patient ne vient plus mais peut revenir, utilisez plutôt <b>Archiver</b>.</p>
    ${a.orphelins.length ? `<div class="field"><label>Proches non suivis reliés uniquement à lui</label>${a.orphelins.map(o => `<label class="check"><input type="checkbox" name="orph" value="${o.id}" checked> Mettre aussi ${esc(o.nom)} à la corbeille</label>`).join('')}</div>` : ''}`,
    async fd => {
      await api('POST', `/api/patients/${p.id}/supprimer`, { orphelins: fd.getAll('orph').map(Number) });
      toast('Patient placé dans la corbeille'); location.hash = '#/patients';
    }, 'Mettre à la corbeille', true);
}


// Personnes présentes proposées : le patient, les personnes qui lui sont liées (parents, responsables, proches, enfants), puis « Autre ».
// Les anciennes valeurs génériques (« Un parent »…) ne s'affichent que si une ancienne séance les contient.
function chipsPresents(p, presents) {
  const on = k => presents.includes(k) ? 'on' : '';
  const puces = [['patient', 'Le patient'], ...p.liens.map(l => ['p:' + l.autre_id, `${l.autre_nom} · ${l.sens === 'parent' ? l.role : 'enfant / ado'}`]), ['autre', 'Autre personne']];
  for (const [k, l] of [['parent', 'Un parent (ancien)'], ['responsable légal', 'Responsable légal (ancien)']]) if (presents.includes(k)) puces.push([k, l]);
  return puces.map(([k, l]) => `<span class="chip ${on(k)}" data-p="${esc(k)}">${esc(l)}</span>`).join('');
}

// ---------- Vue : consultations (liste + agenda) ----------
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => new Date(s + 'T12:00:00');
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (s, n) => { const d = parseISO(s); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); };
const mondayOf = s => { const d = parseISO(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const toMin = h => { const m = /^(\d{1,2}):(\d{2})/.exec(h || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const JOURS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
const HH = 52;                       // hauteur d'une heure dans la grille semaine (px)

// L'état de l'agenda est gardé en mémoire : on retrouve la même vue en revenant d'une séance
const agenda = { vue: 'calendrier', mode: 'semaine', ref: today(), onglet: 'avenir', periode: 'tout' };

async function viewConsultations() {
  const all = await api('GET', '/api/consultations');
  app.innerHTML = `<div class="head"><div><h1>Consultations</h1><div class="sub" id="count"></div></div>
      <div class="headbtns">${exportBtn('seances', '/api/export/consultations.csv')}<div class="seg" id="seg-vue"><button data-v="calendrier">Calendrier</button><button data-v="liste">Liste</button></div>
      <button class="btn primary" id="newc">+ Nouvelle consultation</button></div></div>
    <div id="body"></div>`;
  $('#newc').onclick = () => newConsultationModal(null);
  const drawAll = () => {
    document.querySelectorAll('#seg-vue button').forEach(b => b.classList.toggle('on', b.dataset.v === agenda.vue));
    agenda.vue === 'calendrier' ? drawCalendar(all) : drawList(all);
  };
  document.querySelectorAll('#seg-vue button').forEach(b => b.onclick = () => { agenda.vue = b.dataset.v; drawAll(); });
  drawAll();
}

function drawList(all) {
  const t = today();
  const lun = mondayOf(t), dim = addDays(lun, 6), mois = t.slice(0, 7);
  $('#body').innerHTML = `<div class="toolbar"><div class="chips" id="chips"></div><span class="muted">·</span><div class="chips" id="per"></div></div>
    <div class="card list consults" id="list" style="padding:0"></div>`;
  const draw = () => {
    const f = {
      avenir: c => c.statut === 'planifiée' && c.date >= t,
      passees: c => c.statut !== 'planifiée' || c.date < t,
      impayees: c => c.statut === 'réalisée' && !c.paye,
    }[agenda.onglet];
    const per = { tout: () => true, semaine: c => c.date >= lun && c.date <= dim, mois: c => c.date.startsWith(mois) }[agenda.periode];
    let rows = all.filter(c => f(c) && per(c));
    if (agenda.onglet === 'avenir') rows = rows.slice().reverse();
    $('#count').textContent = `${rows.length} résultat${rows.length > 1 ? 's' : ''}`;
    $('#chips').innerHTML = [['avenir', 'À venir'], ['passees', 'Passées'], ['impayees', 'À régler']]
      .map(([k, l]) => `<span class="chip ${agenda.onglet === k ? 'on' : ''}" data-f="${k}">${l}</span>`).join('');
    $('#per').innerHTML = [['tout', 'Toutes dates'], ['semaine', 'Cette semaine'], ['mois', 'Ce mois']]
      .map(([k, l]) => `<span class="chip ${agenda.periode === k ? 'on' : ''}" data-p="${k}">${l}</span>`).join('');
    $('#list').innerHTML = rows.length ? rows.map(c => `<div class="row" data-id="${c.id}">
      <div class="name">${fmtDate(c.date)}</div><div>${nomHtml(c.patient_id, c.patient_nom, c.patient_dn, c.patient_complement)}</div>
      <div class="muted">${esc(c.heure)} · ${esc(c.mode)}${c.facture_a ? ' · facturé à ' + esc(c.facture_a) : ''}</div>
      <div class="badges">${c.statut === 'réalisée' ? (c.paye ? `<span class="badge ok">Payée${c.mode_paiement ? ' · ' + esc(c.mode_paiement) : ''}</span>` : `<span class="badge warn">${euro(c.tarif)} à régler</span>`) : ''}${statutBadge(c.statut)}</div></div>`).join('')
      : '<div class="empty">Rien ici.</div>';
    document.querySelectorAll('#list .row').forEach(r => r.onclick = () => location.hash = '#/consultation/' + r.dataset.id);
    document.querySelectorAll('#chips .chip').forEach(c => c.onclick = () => { agenda.onglet = c.dataset.f; draw(); });
    document.querySelectorAll('#per .chip').forEach(c => c.onclick = () => { agenda.periode = c.dataset.p; draw(); });
  };
  draw();
}

const evClass = c => 'ev ev-' + ({ 'planifiée': 'plan', 'réalisée': 'ok', 'annulée': 'off', 'absence': 'abs' }[c.statut] || 'plan');
const evTitle = c => `${c.heure || ''} ${c.patient_nom}${HOMO.has(c.patient_id) ? ' (' + [(ageInfo(c.patient_dn) || {}).texte, c.patient_complement].filter(Boolean).join(' · ') + ')' : ''} · ${c.statut}${c.statut === 'réalisée' && !c.paye ? ' · à régler' : ''}`.trim();
const dueDot = c => c.statut === 'réalisée' && !c.paye ? '<i class="due" title="À régler"></i>' : '';

function drawCalendar(all) {
  const t = today();
  const byDay = {};
  all.forEach(c => (byDay[c.date] = byDay[c.date] || []).push(c));
  Object.values(byDay).forEach(l => l.sort((a, b) => (a.heure || '').localeCompare(b.heure || '')));

  const lun = mondayOf(agenda.ref);
  const mois = agenda.ref.slice(0, 7);
  const titre = agenda.mode === 'semaine'
    ? `${parseISO(lun).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${parseISO(addDays(lun, 6)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : cap(parseISO(agenda.ref).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }));
  const inPeriod = agenda.mode === 'semaine'
    ? all.filter(c => c.date >= lun && c.date <= addDays(lun, 6))
    : all.filter(c => c.date.startsWith(mois));
  $('#count').textContent = `${inPeriod.length} séance${inPeriod.length > 1 ? 's' : ''} sur la période`;

  $('#body').innerHTML = `<div class="toolbar calbar">
      <div class="seg" id="seg-mode"><button data-m="semaine">Semaine</button><button data-m="mois">Mois</button></div>
      <div class="nav"><button class="btn small" id="prev" aria-label="Précédent">‹</button><button class="btn small" id="todaybtn">Aujourd’hui</button><button class="btn small" id="next" aria-label="Suivant">›</button></div>
      <div class="caltitle">${esc(titre)}</div>
      <div class="legend"><span><i class="lg plan"></i>Planifiée</span><span><i class="lg ok"></i>Réalisée</span><span><i class="lg abs"></i>Absence</span><span><i class="lg off"></i>Annulée</span></div></div>
    <div class="card" style="padding:0;overflow:hidden" id="cal"></div>`;
  document.querySelectorAll('#seg-mode button').forEach(b => { b.classList.toggle('on', b.dataset.m === agenda.mode); b.onclick = () => { agenda.mode = b.dataset.m; drawCalendar(all); }; });
  const step = n => { agenda.ref = agenda.mode === 'semaine' ? addDays(agenda.ref, 7 * n) : addMonths(agenda.ref, n); drawCalendar(all); };
  $('#prev').onclick = () => step(-1); $('#next').onclick = () => step(1);
  $('#todaybtn').onclick = () => { agenda.ref = today(); drawCalendar(all); };

  const open = id => location.hash = '#/consultation/' + id;
  if (agenda.mode === 'mois') {
    const first = mondayOf(mois + '-01');
    const last = addDays(mondayOf(addDays(addMonths(agenda.ref, 1), -1)), 6);   // dimanche de la dernière semaine
    const days = []; for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
    $('#cal').innerHTML = `<div class="mo-head">${JOURS.map(j => `<div>${j}</div>`).join('')}</div>
      <div class="mo-grid">${days.map(d => {
        const L = byDay[d] || [];
        const shown = L.slice(0, 3);
        return `<div class="mo-cell ${d.startsWith(mois) ? '' : 'other'} ${d === t ? 'today' : ''}" data-day="${d}">
          <div class="mo-num">${Number(d.slice(8))}</div>
          ${shown.map(c => `<a class="${evClass(c)}" data-id="${c.id}" title="${esc(evTitle(c))}">${dueDot(c)}<b>${esc(c.heure || '')}</b> ${esc(c.patient_nom)}</a>`).join('')}
          ${L.length > 3 ? `<a class="more" data-week="${d}">+ ${L.length - 3} autre${L.length - 3 > 1 ? 's' : ''}</a>` : ''}</div>`; }).join('')}</div>`;
    document.querySelectorAll('.mo-cell').forEach(cell => cell.onclick = e => {
      const ev = e.target.closest('[data-id]'), more = e.target.closest('[data-week]');
      if (ev) return open(ev.dataset.id);
      if (more) { agenda.ref = more.dataset.week; agenda.mode = 'semaine'; return drawCalendar(all); }
      newConsultationModal(null, { date: cell.dataset.day });
    });
    return;
  }

  // ----- Semaine : grille horaire -----
  const days = Array.from({ length: 7 }, (_, i) => addDays(lun, i));
  let h0 = 8, h1 = 20;                                    // plage par défaut, élargie si une séance sort de la plage
  days.forEach(d => (byDay[d] || []).forEach(c => {
    const m = toMin(c.heure); if (m === null) return;
    h0 = Math.min(h0, Math.floor(m / 60)); h1 = Math.max(h1, Math.ceil((m + (c.duree || 50)) / 60));
  }));
  const H = h1 - h0;
  const sansHeure = days.map(d => (byDay[d] || []).filter(c => toMin(c.heure) === null));
  const colHtml = d => {
    // séances qui se chevauchent : affichées en cascade (décalées de 16 px), chacune garde son nom lisible
    const L = (byDay[d] || []).filter(c => toMin(c.heure) !== null).map(c => ({ c, s: toMin(c.heure), e: toMin(c.heure) + (c.duree || 50) }));
    let cluster = [], clusterEnd = -1; const out = [];
    const flush = () => { const n = Math.max(1, ...cluster.map(x => x.lane + 1)); cluster.forEach(x => out.push({ ...x, n })); cluster = []; };
    L.forEach(x => {
      if (x.s >= clusterEnd) { flush(); clusterEnd = -1; }
      const used = cluster.filter(y => y.e > x.s).map(y => y.lane);
      x.lane = 0; while (used.includes(x.lane)) x.lane++;
      cluster.push(x); clusterEnd = Math.max(clusterEnd, x.e);
    });
    flush();
    return out.map(x => `<a class="${evClass(x.c)} blk" data-id="${x.c.id}" title="${esc(evTitle(x.c))}"
      style="top:${(x.s - h0 * 60) / 60 * HH}px;height:${Math.max(22, (x.e - x.s) / 60 * HH - 2)}px;left:${x.lane * 16 + 2}px;width:calc(100% - ${(x.n - 1) * 16 + 4}px);z-index:${x.lane + 1}">
      ${dueDot(x.c)}<b>${esc(x.c.heure)}</b> ${esc(x.c.patient_nom)}</a>`).join('');
  };
  $('#cal').innerHTML = `<div class="wk-head"><div></div>${days.map((d, i) => `<div class="${d === t ? 'today' : ''}"><span>${JOURS[i]}</span> <b>${Number(d.slice(8))}</b></div>`).join('')}</div>
    ${sansHeure.some(l => l.length) ? `<div class="wk-allday"><div class="hl">sans heure</div>${sansHeure.map(l => `<div>${l.map(c => `<a class="${evClass(c)}" data-id="${c.id}">${dueDot(c)}${esc(c.patient_nom)}</a>`).join('')}</div>`).join('')}</div>` : ''}
    <div class="wk-body" style="height:${H * HH}px"><div class="hours">${Array.from({ length: H }, (_, i) => `<div style="height:${HH}px"><span>${pad(h0 + i)}h</span></div>`).join('')}</div>
      ${days.map(d => `<div class="wk-col ${d === t ? 'today' : ''}" data-day="${d}" style="background-size:100% ${HH}px">${colHtml(d)}</div>`).join('')}</div>`;
  document.querySelectorAll('.wk-col').forEach(col => col.onclick = e => {
    const ev = e.target.closest('[data-id]'); if (ev) return open(ev.dataset.id);
    const y = e.clientY - col.getBoundingClientRect().top;
    const min = Math.round((h0 * 60 + y / HH * 60) / 30) * 30;            // arrondi à la demi-heure
    newConsultationModal(null, { date: col.dataset.day, heure: `${pad(Math.floor(min / 60))}:${pad(min % 60)}` });
  });
  document.querySelectorAll('.wk-allday [data-id]').forEach(a => a.onclick = () => open(a.dataset.id));
}

// Pastille ronde « H / F / NR » (couleur selon la civilité) : on voit au premier coup d'œil de quel patient il s'agit
function pastilleSexe(p) {
  const [l, cls, nom] = p.civilite === 'M' ? ['H', 'h', 'Homme'] : p.civilite === 'Mme' ? ['F', 'f', 'Femme'] : ['NR', 'nr', 'Non renseigné'];
  return `<span class="sexe ${cls}" title="${nom}" aria-label="${nom}">${l}</span>`;
}
// ---------- Vue : une consultation ----------
async function viewConsultation(m) {
  const id = Number(m[1]);
  const c = await api('GET', '/api/consultations/' + id);
  const p = await api('GET', '/api/patients/' + c.patient_id);
  const payeurs = ['', p.nom, ...p.liens.map(l => l.autre_nom)];
  if (c.facture_a && !payeurs.includes(c.facture_a)) payeurs.push(c.facture_a);
  app.innerHTML = `
    <a class="crumb" href="#/patient/${p.id}">← ${esc(p.nom)}</a>
    <div class="head idhead"><div><h1 class="idname">${nomHtml(p.id, p.nom, p.date_naissance, p.complement)}</h1>
        <div class="sub idsub">Séance du ${fmtDate(c.date)}${c.heure ? ' à ' + esc(c.heure) : ''}${p.age_texte ? ` · ${esc(p.age_texte)}` : ''}${p.type === 'mineur' ? ' · <span class="badge blue">Mineur</span>' : ''}</div></div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><span class="savestate" id="ss">Enregistré</span><button class="btn small" id="hist">Historique</button>${exportBtn('seance', `/api/consultations/${id}/export`)}<button class="btn danger small" id="del">Supprimer</button>${pastilleSexe(p)}</div></div>
    <div class="card" style="margin-bottom:18px"><div class="fields">
      <div class="field"><label>Date</label><input type="date" data-k="date" value="${esc(c.date)}"></div>
      <div class="field"><label>Heure</label><input type="time" data-k="heure" value="${esc(c.heure)}"></div>
      <div class="field"><label>Durée (min)</label><input type="number" data-k="duree" min="5" step="5" value="${esc(c.duree)}"></div>
      <div class="field"><label>Mode</label><select data-k="mode">${MODES.map(x => `<option ${x === c.mode ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Statut</label><select data-k="statut">${STATUTS_CONSULT.map(x => `<option ${x === c.statut ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Tarif (€)</label><input type="number" data-k="tarif" min="0" step="1" value="${esc(c.tarif)}"></div>
      <div class="field"><label>Facturé à</label><select data-k="facture_a">${payeurs.map(x => `<option value="${esc(x)}" ${x === c.facture_a ? 'selected' : ''}>${x ? esc(x) : '—'}</option>`).join('')}</select></div>
      <div class="field"><label>Règlement</label><label class="check"><input type="checkbox" data-k="paye" ${c.paye ? 'checked' : ''}> Payée</label></div>
      <div class="field"><label>Mode de paiement</label><select data-k="mode_paiement" ${c.paye ? '' : 'disabled'}><option value="">—</option>${MODES_PAIEMENT.map(x => `<option ${x === c.mode_paiement ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field" style="margin:8px 0 0"><label>Personnes présentes</label>
      <div class="pills" id="pres">${chipsPresents(p, c.presents)}<button type="button" class="chip addchip" id="linkp">+ Lier une personne</button></div></div></div>
    <div class="card" style="margin-bottom:18px"><h2>Ressources de la séance</h2><div id="res-c"></div></div>
    ${editorHtml(c.contenu)}`;
  mountRessources($('#res-c'), 'consultations', id, c.ressources);

  const state = { presents: [...c.presents] };
  let timer, pending = null;
  const collect = () => {
    const body = { contenu: $('#editor').innerHTML, presents: state.presents };
    document.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      body[k] = el.type === 'checkbox' ? el.checked : (['duree', 'tarif'].includes(k) ? Number(el.value) || 0 : el.value);
    });
    return body;
  };
  const save = async () => {
    const body = pending; pending = null;
    if (!body || !body.date) return;
    const ss = $('#ss');
    try { await api('PUT', '/api/consultations/' + id, body); if (ss) ss.textContent = 'Enregistré'; } catch { if (ss) ss.textContent = 'Erreur'; }
  };
  const queue = () => { pending = collect(); $('#ss').textContent = 'Modifications…'; clearTimeout(timer); timer = setTimeout(save, 600); };
  document.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', queue));
  // Le mode de paiement n'a de sens que si la séance est payée
  const payeEl = $('[data-k=paye]'), modeEl = $('[data-k=mode_paiement]');
  payeEl.addEventListener('change', () => { modeEl.disabled = !payeEl.checked; if (!payeEl.checked) modeEl.value = ''; queue(); });
  document.querySelectorAll('#pres .chip[data-p]').forEach(ch => ch.onclick = () => {
    const k = ch.dataset.p;
    state.presents = state.presents.includes(k) ? state.presents.filter(x => x !== k) : [...state.presents, k];
    ch.classList.toggle('on'); queue();
  });
  // « Lier une personne » : crée (ou relie) un proche du patient, le coche comme présent, puis recharge la page avec la saisie déjà enregistrée
  $('#linkp').onclick = () => lierPersonne(p, 'parent', async idPers => {
    state.presents = [...new Set([...state.presents, 'p:' + idPers])];
    pending = collect(); clearTimeout(timer); await save(); render();
  });
  wireEditor(queue);
  exportHook = async () => { clearTimeout(timer); if (pending) await save(); };
  // Quitter la page avec une modification en attente : on l'envoie quand même
  window.addEventListener('hashchange', () => { clearTimeout(timer); save(); }, { once: true });
  window.addEventListener('beforeunload', () => { if (pending) navigator.sendBeacon && fetch('/api/consultations/' + id, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) }); }, { once: true });
  $('#hist').onclick = async () => {
    clearTimeout(timer); if (pending) await save();                  // le texte en cours est d'abord enregistré
    historiqueNotes(id, () => { pending = null; render(); });
  };
  $('#del').onclick = () => modal('Supprimer cette séance ?', '<p class="muted">La séance sera placée dans la corbeille. Vous pourrez la restaurer pendant 30 jours.</p>',
    async () => { clearTimeout(timer); pending = null; await api('DELETE', '/api/consultations/' + id); toast('Séance placée dans la corbeille'); location.hash = '#/patient/' + p.id; }, 'Mettre à la corbeille', true);
}

// ---------- Historique des notes d'une séance ----------
const texteDeHtml = html => new DOMParser().parseFromString(String(html || '').replace(/<\/(p|h\d|li|div)>|<br\s*\/?>/gi, '$&\n'), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim();
// Différences mot à mot : [type, texte] avec type = '=' (inchangé), '-' (présent avant, absent aujourd'hui), '+' (ajouté depuis)
function diffMots(avant, apres) {
  const a = avant.split(/(\s+)/).filter(Boolean), b = apres.split(/(\s+)/).filter(Boolean);
  let d = 0; while (d < a.length && d < b.length && a[d] === b[d]) d++;
  let f = 0; while (f < a.length - d && f < b.length - d && a[a.length - 1 - f] === b[b.length - 1 - f]) f++;
  const A = a.slice(d, a.length - f), B = b.slice(d, b.length - f), out = [];
  if (d) out.push(['=', a.slice(0, d).join('')]);
  if (A.length * B.length > 4e6) { if (A.length) out.push(['-', A.join('')]); if (B.length) out.push(['+', B.join('')]); }
  else {
    const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0; const push = (t, x) => { if (out.length && out[out.length - 1][0] === t) out[out.length - 1][1] += x; else out.push([t, x]); };
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) { push('=', A[i]); i++; j++; }
      else if (j < B.length && (i === A.length || L[i][j + 1] >= L[i + 1][j])) { push('+', B[j]); j++; }
      else { push('-', A[i]); i++; }
    }
  }
  if (f) out.push(['=', a.slice(a.length - f).join('')]);
  return out;
}
async function historiqueNotes(id, apresRestauration) {
  const root = $('#modal-root');
  const [versions, cur] = await Promise.all([api('GET', `/api/consultations/${id}/versions`), api('GET', '/api/consultations/' + id)]);
  const quand = v => new Date(v.enregistre_le).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const close = () => root.innerHTML = '';
  root.innerHTML = `<div class="overlay"><div class="modal histo"><h2>Historique des notes</h2>
    <p class="muted">Les anciennes versions du texte sont conservées automatiquement (environ toutes les 10 minutes de saisie, et dès qu’une grande partie du texte disparaît). Restaurer une version ne détruit rien : le texte actuel est lui aussi mis de côté.</p>
    ${versions.length ? `<div class="hlist">${versions.map(v => `<div class="hrow" data-v="${v.id}">
        <div class="hmeta"><b>${esc(quand(v))}</b>${v.origine === 'avant-restauration' ? ' <span class="chip">avant une restauration</span>' : ''}<span class="muted"> · ${v.taille} caractères</span>
          <div class="muted hap">${esc(v.apercu)}${v.taille > 120 ? '…' : ''}</div></div>
        <div class="hbtn"><button type="button" class="btn small" data-cmp="${v.id}">Comparer</button></div></div>`).join('')}</div>`
      : '<p class="muted">Aucune ancienne version pour l’instant : elles apparaissent dès que le texte est modifié.</p>'}
    <div id="hview"></div>
    <div class="actions"><button type="button" class="btn" data-close>Fermer</button></div></div></div>`;
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.overlay').addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) close(); });
  const vue = $('#hview');
  root.querySelectorAll('[data-cmp]').forEach(btn => btn.onclick = async () => {
    const vid = btn.dataset.cmp, v = await api('GET', `/api/consultations/${id}/versions/${vid}`);
    root.querySelectorAll('.hrow').forEach(r => r.classList.toggle('sel', r.dataset.v === vid));
    const ancien = texteDeHtml(v.contenu), actuel = texteDeHtml(cur.contenu), diff = diffMots(ancien, actuel);
    const semblable = ancien === actuel;
    vue.innerHTML = `<div class="hcmp"><div class="hlegend">Version du ${esc(quand(v))} comparée au texte actuel — <del>rouge</del> : présent dans cette version, absent aujourd’hui ; <ins>vert</ins> : ajouté depuis.</div>
      ${semblable ? '<p class="muted">Le texte est identique (seule la mise en forme diffère).</p>' : `<div class="hdiff">${diff.map(([t, x]) => t === '=' ? esc(x) : t === '-' ? `<del>${esc(x)}</del>` : `<ins>${esc(x)}</ins>`).join('')}</div>`}
      <details><summary>Voir le texte de cette version</summary><div class="hdiff">${esc(ancien)}</div></details>
      <div class="actions" style="justify-content:flex-start"><button type="button" class="btn primary" id="hrest">Restaurer cette version</button></div></div>`;
    $('#hrest').onclick = async () => {
      const ok = $('#hrest'); if (ok.disabled) return; ok.disabled = true;
      try { await api('POST', `/api/consultations/${id}/versions/${vid}/restaurer`); close(); toast('Version restaurée — le texte précédent reste dans l’historique'); apresRestauration(); } catch { ok.disabled = false; }
    };
    vue.scrollIntoView({ block: 'nearest' });
  });
}

// ---------- Vue : modèles de séance ----------
async function viewModeles(m) {
  const list = await api('GET', '/api/modeles');
  const sel = list.find(t => String(t.id) === m[1]) || list[0];
  app.innerHTML = `<div class="head"><div><h1>Modèles de séance</h1>
      <div class="sub">Un modèle prérempli une nouvelle séance. Les séances déjà écrites ne changent pas.</div></div>
      <button class="btn primary" id="newt">+ Nouveau modèle</button></div>
    <div class="tpl-layout"><div class="card list tpl-list" style="padding:0">${list.map(t => `<div class="row ${sel && t.id === sel.id ? 'on' : ''}" data-id="${t.id}">${esc(t.nom)}</div>`).join('') || '<div class="empty">Aucun modèle.</div>'}</div>
    <div>${sel ? `<div class="card"><div class="field"><label>Nom du modèle</label><input id="tname" value="${esc(sel.nom)}"></div>
      ${editorHtml(sel.contenu)}<div class="actions" style="justify-content:space-between"><button class="btn danger small" id="tdel">Supprimer</button><button class="btn primary" id="tsave">Enregistrer le modèle</button></div></div>` : ''}</div></div>`;
  document.querySelectorAll('.tpl-list .row[data-id]').forEach(r => r.onclick = () => location.hash = '#/modeles/' + r.dataset.id);
  $('#newt').onclick = () => modal('Nouveau modèle', '<div class="field"><label>Nom</label><input name="nom" required></div>',
    async fd => { const t = await api('POST', '/api/modeles', { nom: fd.get('nom'), contenu: '<h3>Titre de section</h3><p></p>' }); location.hash = '#/modeles/' + t.id; }, 'Créer');
  if (sel) {
    wireEditor(() => {});
    $('#tsave').onclick = async () => { await api('PUT', '/api/modeles/' + sel.id, { nom: $('#tname').value, contenu: $('#editor').innerHTML }); toast('Modèle enregistré'); render(); };
    $('#tdel').onclick = () => modal('Supprimer ce modèle ?', '<p class="muted">Le modèle sera placé dans la corbeille (restaurable pendant 30 jours). Les séances déjà créées ne sont pas affectées.</p>',
      async () => { await api('DELETE', '/api/modeles/' + sel.id); toast('Modèle placé dans la corbeille'); location.hash = '#/modeles'; }, 'Mettre à la corbeille', true);
  }
}

fetch('/api/version').then(r => r.json()).then(j => { $('#ver').textContent = 'Version ' + j.version; }).catch(() => {});

// ---------- Corbeille ----------
async function refreshTrash() {
  try { const n = (await (await fetch('/api/corbeille')).json()).length; const b = $('#trash-count'); b.textContent = n || ''; b.hidden = !n; } catch { /* sans importance */ }
}

async function viewCorbeille() {
  const items = await api('GET', '/api/corbeille');
  const TYPE = { patient: ['Patient', 'blue'], consultation: ['Séance', 'ok'], modele: ['Modèle', ''], ressource: ['Lien', 'warn'] };
  app.innerHTML = `<div class="head"><div><h1>Corbeille</h1>
      <div class="sub">Les éléments supprimés sont conservés 30 jours, puis effacés définitivement.</div></div>
      ${items.length ? '<button class="btn danger" id="empty">Vider la corbeille</button>' : ''}</div>
    <div class="card list" style="padding:0">${items.length ? items.map(it => `
      <div class="trow" data-id="${it.id}">
        <div><span class="badge ${TYPE[it.type][1]}">${TYPE[it.type][0]}</span></div>
        <div style="min-width:0"><div class="name">${esc(it.libelle)}</div><div class="muted tiny">${esc(it.detail)} · supprimé le ${fmtDate(it.supprime_le.slice(0, 10))}</div></div>
        <div class="${it.jours_restants <= 3 ? 'warntxt' : 'muted'} tiny">${it.jours_restants <= 0 ? 'effacement imminent' : `effacé dans ${it.jours_restants} jour${it.jours_restants > 1 ? 's' : ''}`}</div>
        <div class="badges"><button class="btn small" data-restore="${it.id}">Restaurer</button><button class="btn small danger" data-purge="${it.id}">Effacer</button></div>
      </div>`).join('') : '<div class="empty">La corbeille est vide.</div>'}</div>`;
  document.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    const r = await api('POST', `/api/corbeille/${b.dataset.restore}/restaurer`);
    toast(`« ${r.libelle} » restauré`); render();
  });
  document.querySelectorAll('[data-purge]').forEach(b => b.onclick = () => {
    const it = items.find(x => String(x.id) === b.dataset.purge);
    modal('Effacer définitivement ?', `<p style="margin-top:0"><b>${esc(it.libelle)}</b> sera effacé pour toujours. Cette action est irréversible.</p>`,
      async () => { await api('DELETE', '/api/corbeille/' + it.id); toast('Effacé définitivement'); render(); }, 'Effacer définitivement', true);
  });
  const empty = $('#empty');
  if (empty) empty.onclick = () => modal('Vider la corbeille ?', `<p style="margin-top:0"><b>${items.length} élément${items.length > 1 ? 's' : ''}</b> seront effacés pour toujours. Cette action est irréversible.</p>`,
    async () => { await api('POST', '/api/corbeille/vider'); toast('Corbeille vidée'); render(); }, 'Vider la corbeille', true);
}


// ---------- Recherche globale (Ctrl/Cmd + K) ----------
const searchState = { ouvert: false };
function ouvrirRecherche() {
  if (auth.verrouille) return;
  const root = $('#search-root');
  if (searchState.ouvert) { $('#sq').focus(); return; }
  searchState.ouvert = true;
  root.innerHTML = `<div class="overlay top"><div class="palette" role="dialog" aria-label="Recherche">
    <input id="sq" type="search" placeholder="Rechercher un patient, une séance, un lien, un modèle…" autocomplete="off" spellcheck="false">
    <div id="sres" class="sres"><div class="empty">Tapez au moins 2 lettres. Les accents et majuscules n’ont pas d’importance.</div></div>
    <div class="shint muted tiny"><span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span><span><kbd>Entrée</kbd> ouvrir</span><span><kbd>Échap</kbd> fermer</span></div></div></div>`;
  const input = $('#sq'); input.focus();
  let items = [], sel = 0, timer, seq = 0, q = '';
  const fermer = () => { searchState.ouvert = false; root.innerHTML = ''; document.removeEventListener('keydown', clavier, true); };
  const surligner = t => {
    let h = esc(t);
    for (const w of q.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter(x => x.length > 1)) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[aeiouycn]/g, c => ({ a: '[aàâä]', e: '[eéèêë]', i: '[iîï]', o: '[oôö]', u: '[uùûü]', y: '[yÿ]', c: '[cç]', n: 'n' }[c])), 'gi');
      h = h.replace(re, m => `<mark>${m}</mark>`);
    }
    return h;
  };
  const draw = r => {
    const G = [['patients', 'Patients', x => '#/patient/' + x.id], ['consultations', 'Séances', x => '#/consultation/' + x.id],
               ['ressources', 'Ressources', x => x.cible], ['modeles', 'Modèles de séance', x => '#/modeles/' + x.id]];
    items = []; let html = '';
    for (const [k, titre, href] of G) {
      if (!r[k].length) continue;
      html += `<div class="sgrp">${titre}</div>` + r[k].map(x => { items.push(href(x)); return `<a class="sitem" data-i="${items.length - 1}" href="${href(x)}">
        <div class="stitre">${surligner(x.titre)}</div>${x.sous ? `<div class="ssous muted tiny">${surligner(x.sous)}</div>` : ''}</a>`; }).join('');
    }
    $('#sres').innerHTML = html || '<div class="empty">Aucun résultat.</div>';
    sel = 0; marquer();
    $('#sres').querySelectorAll('.sitem').forEach(a => { a.onclick = e => { e.preventDefault(); aller(Number(a.dataset.i)); }; a.onmousemove = () => { sel = Number(a.dataset.i); marquer(false); }; });
  };
  const marquer = (scroll = true) => document.querySelectorAll('#sres .sitem').forEach(a => {
    const on = Number(a.dataset.i) === sel; a.classList.toggle('on', on); if (on && scroll) a.scrollIntoView({ block: 'nearest' });
  });
  const aller = i => { const h = items[i]; if (!h) return; fermer(); if (location.hash === h) render(); else location.hash = h; };
  const chercher = async () => {
    q = input.value.trim(); const mine = ++seq;
    if (q.length < 2) { $('#sres').innerHTML = '<div class="empty">Tapez au moins 2 lettres. Les accents et majuscules n’ont pas d’importance.</div>'; items = []; return; }
    try { const r = await (await fetch('/api/recherche?q=' + encodeURIComponent(q))).json(); if (mine === seq) draw(r); } catch { /* ignoré */ }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(chercher, 120); };
  const clavier = e => {
    if (e.key === 'Escape') { e.preventDefault(); fermer(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; marquer(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; marquer(); } }
    else if (e.key === 'Enter') { e.preventDefault(); aller(sel); }
  };
  document.addEventListener('keydown', clavier, true);
  root.querySelector('.overlay').addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) fermer(); });
}
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if ($('#picker-root').firstChild) return; searchState.ouvert ? $('#search-root').querySelector('.overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) : ouvrirRecherche(); }
});
$('#searchbtn').onclick = ouvrirRecherche;
$('#kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
