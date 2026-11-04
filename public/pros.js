// Gestion Psy : professionnels (annuaire) et réunions avec eux.
// Ce fichier est chargé AVANT app.js : il ne fait que déclarer des fonctions et des constantes ; tout ce qui vient d'app.js ($, api, modal, esc, render…) n'est utilisé qu'à l'appel.

const FORMATS_REU = ['téléphone', 'e-mail', 'visio', 'présentiel', 'autre'];
const STATUTS_REU = ['planifiée', 'réalisée', 'annulée'];
const agendaReu = { vue: 'calendrier', mode: 'semaine', ref: null, onglet: 'avenir', periode: 'tout' };     // ref : date du jour, posée à l'affichage
const nrm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const ongletsPro = actif => `<div class="subtabs"><a href="#/professionnels" class="${actif === 'annuaire' ? 'on' : ''}">Annuaire</a><a href="#/reunions" class="${actif === 'reunions' ? 'on' : ''}">Réunions</a></div>`;
const catBadges = (liste, max = 99) => (liste || []).slice(0, max).map(c => `<span class="badge blue">${esc(c)}</span>`).join(' ') + (liste && liste.length > max ? ` <span class="muted tiny">+${liste.length - max}</span>` : '');
const lienTel = t => t ? `<a href="tel:${esc(String(t).replace(/[^\d+]/g, ''))}">${esc(t)}</a>` : '';
const lienMail = e => e ? `<a href="mailto:${esc(e)}">${esc(e)}</a>` : '';

// ---------- Sélecteur à choix multiple (catégories, professionnels d'une réunion) ----------
// options : [{ k, l }] ; selected : liste de clés ; creer(texte) : crée un nouvel élément et renvoie { k, l } (ou null)
function multiPicker(host, { options, selected, creer = null, placeholder = 'Rechercher…', onChange = () => {} }) {
  const sel = [];
  selected.forEach(k => { const o = options.find(x => x.k === k); if (o) sel.push(o); });
  host.innerHTML = `<div class="mp"><div class="mp-chips"></div><div class="mp-box"><input type="text" class="mp-in" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><div class="mp-dd" hidden></div></div></div>`;
  const chips = host.querySelector('.mp-chips'), input = host.querySelector('.mp-in'), dd = host.querySelector('.mp-dd');
  let items = [], cur = 0;
  const dessinerChips = () => {
    chips.innerHTML = sel.map(o => `<span class="mp-chip">${esc(o.l)}<button type="button" class="mp-x" data-k="${esc(String(o.k))}" aria-label="Retirer ${esc(o.l)}">×</button></span>`).join('');
    chips.hidden = !sel.length;
    chips.querySelectorAll('.mp-x').forEach(b => b.onclick = () => { const i = sel.findIndex(o => String(o.k) === b.dataset.k); if (i >= 0) { sel.splice(i, 1); dessinerChips(); onChange(); } });
  };
  const ajouter = o => { if (!o || sel.some(x => x.k === o.k)) return; sel.push(o); input.value = ''; fermer(); dessinerChips(); onChange(); };
  const fermer = () => { dd.hidden = true; items = []; };
  const ouvrir = () => {
    const q = nrm(input.value);
    const libres = options.filter(o => !sel.some(x => x.k === o.k));
    const trouves = (q ? libres.filter(o => nrm(o.l).includes(q)) : libres).slice(0, 8);
    items = trouves.map(o => ({ o }));
    const exact = options.some(o => nrm(o.l) === q) || sel.some(o => nrm(o.l) === q);
    if (creer && q && !exact) items.push({ creer: input.value.trim() });
    if (!items.length) { dd.innerHTML = `<div class="mp-vide muted tiny">${q ? 'Aucun résultat.' : 'Tout est déjà sélectionné.'}</div>`; dd.hidden = false; return; }
    cur = 0;
    dd.innerHTML = items.map((x, i) => `<div class="mp-opt ${i === 0 ? 'on' : ''}" data-i="${i}">${x.creer !== undefined ? `+ Créer « ${esc(x.creer)} »` : esc(x.o.l)}</div>`).join('');
    dd.hidden = false;
    dd.querySelectorAll('.mp-opt').forEach(el => { el.onmousedown = e => { e.preventDefault(); choisir(Number(el.dataset.i)); }; el.onmousemove = () => { cur = Number(el.dataset.i); marquer(); }; });
  };
  const marquer = () => dd.querySelectorAll('.mp-opt').forEach((el, i) => el.classList.toggle('on', i === cur));
  const choisir = async i => {
    const x = items[i]; if (!x) return;
    if (x.creer !== undefined) { try { const o = await creer(x.creer); if (o) { if (!options.some(y => y.k === o.k)) options.push(o); ajouter(o); } } catch { /* message déjà affiché */ } }
    else ajouter(x.o);
  };
  input.addEventListener('input', ouvrir);
  input.addEventListener('focus', ouvrir);
  input.addEventListener('blur', () => setTimeout(fermer, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!dd.hidden && items.length) choisir(cur); }      // jamais d'envoi du formulaire depuis ce champ
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (dd.hidden) ouvrir(); else if (items.length) { cur = (cur + 1) % items.length; marquer(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { cur = (cur - 1 + items.length) % items.length; marquer(); } }
    else if (e.key === 'Escape' && !dd.hidden) { e.preventDefault(); e.stopPropagation(); fermer(); }
    else if (e.key === 'Backspace' && !input.value && sel.length) { sel.pop(); dessinerChips(); onChange(); }
  });
  dessinerChips();
  return { get: () => sel.map(o => o.k), noms: () => sel.map(o => ({ k: o.k, l: o.l })) };
}

// Un professionnel en une ligne pour les sélecteurs : « Prénom Nom · première catégorie »
const optionPro = p => ({ k: p.id, l: p.nom_complet + (p.categories && p.categories.length ? ' · ' + p.categories[0] : '') + (p.archive_le ? ' (archivé)' : '') });
// Création rapide d'une fiche depuis une réunion : « Julie Martin » -> prénom Julie, nom Martin (un seul mot = nom). Complétable ensuite depuis la fiche.
async function creerProRapide(texte) {
  const mots = String(texte).trim().split(/\s+/).filter(Boolean);
  if (!mots.length) return null;
  const nom = mots.length === 1 ? mots[0] : mots[mots.length - 1], prenom = mots.length === 1 ? '' : mots.slice(0, -1).join(' ');
  let p;
  try { p = await api('POST', '/api/professionnels', { nom, prenom }); }
  catch (e) {
    if (e.data && e.data.doublons && e.data.doublons[0]) { const d = e.data.doublons[0]; toast(`« ${d.nom} » existait déjà : fiche reprise`); return { k: d.id, l: d.nom }; }
    throw e;
  }
  toast(`Fiche créée : ${p.nom_complet} (à compléter depuis l’onglet Professionnels)`);
  return optionPro(p);
}

// ---------- Fenêtre : créer / modifier un professionnel ----------
async function proModal(p, apres) {
  const cats = await api('GET', '/api/categories-pro');
  const v = p || { nom: '', prenom: '', structure: '', telephone: '', email: '', adresse: '', site_web: '', notes: '', categories: [] };
  let confirme = false, picker;
  modal(p ? 'Modifier le professionnel' : 'Nouveau professionnel', `
    <div id="dblpro"></div>
    <div class="fields">
      <div class="field"><label>Nom</label><input name="nom" value="${esc(v.nom)}"></div>
      <div class="field"><label>Prénom</label><input name="prenom" value="${esc(v.prenom)}"></div>
    </div>
    <div class="field"><label>Catégories <span class="muted tiny">(plusieurs possibles ; tapez pour en créer une nouvelle)</span></label><div id="mp-cats"></div></div>
    <div class="field"><label>Structure <span class="muted tiny">(cabinet, hôpital, école, CMP…)</span></label><input name="structure" value="${esc(v.structure)}"></div>
    <div class="fields">
      <div class="field"><label>Téléphone</label><input name="telephone" type="tel" autocomplete="off" value="${esc(v.telephone)}"></div>
      <div class="field"><label>E-mail</label><input name="email" type="email" autocomplete="off" value="${esc(v.email)}"></div>
    </div>
    <div class="field"><label>Adresse</label><input name="adresse" value="${esc(v.adresse)}"></div>
    <div class="field"><label>Site web</label><input name="site_web" value="${esc(v.site_web)}" placeholder="https://"></div>
    <div class="field"><label>Notes</label><textarea name="notes" rows="3">${esc(v.notes)}</textarea></div>`,
    async fd => {
      const body = Object.fromEntries(fd);
      if (!String(body.nom || '').trim() && !String(body.prenom || '').trim()) { toast('Un nom ou un prénom est requis'); throw new Error('nom'); }
      body.categories = picker.get();
      if (confirme) body.confirme_doublon = true;
      try {
        const r = p ? await api('PUT', '/api/professionnels/' + p.id, body) : await api('POST', '/api/professionnels', body);
        if (apres) apres(r); else render();
      } catch (e) {
        if (e.data && e.data.doublons) {
          confirme = true;
          $('#dblpro').innerHTML = `<div class="dbl"><div class="dbl-t">Un professionnel porte déjà ce nom</div>${e.data.doublons.map(d => `<div class="dbl-c"><div><b>${esc(d.nom)}</b></div><a class="btn small" href="#/professionnel/${d.id}" onclick="$('#modal-root').innerHTML=''">Voir la fiche</a></div>`).join('')}
            <div class="muted tiny" style="margin-top:6px">C’est peut-être la même personne. Si c’est bien quelqu’un d’autre, enregistrez de nouveau pour confirmer.</div></div>`;
        }
        throw e;
      }
    }, 'Enregistrer', false, 'wide');
  imposerFormats($('.modal'));
  picker = multiPicker($('#mp-cats'), { options: cats.map(c => ({ k: c.nom, l: c.nom })), selected: v.categories || [],
    creer: async t => { const nom = t.trim().slice(0, 60); return nom ? { k: nom, l: nom } : null; }, placeholder: 'Ajouter une catégorie…' });
}

// ---------- Vue : annuaire des professionnels ----------
async function viewProfessionnels() {
  const [pros, cats] = await Promise.all([api('GET', '/api/professionnels'), api('GET', '/api/categories-pro')]);
  let q = '', filtre = 'actifs', cat = '';
  app.innerHTML = `<div class="head"><div><h1>Professionnels</h1><div class="sub" id="count"></div></div>
      <div class="headbtns"><a class="btn" href="/api/export/professionnels.csv">Exporter (.csv)</a><button class="btn primary" id="newpro">+ Nouveau professionnel</button></div></div>
    ${ongletsPro('annuaire')}
    <div class="toolbar"><input type="search" id="q" placeholder="Rechercher un professionnel…">
      <select id="catf" style="max-width:220px" aria-label="Catégorie"><option value="">Toutes les catégories</option>${cats.filter(c => c.nb).map(c => `<option value="${esc(c.nom)}">${esc(c.nom)} (${c.nb})</option>`).join('')}</select>
      <div class="chips" id="chips"></div></div>
    <div class="card list pros" id="list" style="padding:0"></div>`;
  const draw = () => {
    const visible = p => filtre === 'tous' || (filtre === 'archives' ? !!p.archive_le : !p.archive_le);
    const rows = pros.filter(p => (q || visible(p)) && (!cat || p.categories.includes(cat))
      && nrm([p.nom_complet, p.structure, p.email, p.telephone, p.categories.join(' ')].join(' ')).includes(nrm(q)));
    $('#count').textContent = `${rows.length} professionnel${rows.length > 1 ? 's' : ''}`;
    $('#chips').innerHTML = [['actifs', 'Actifs'], ['archives', 'Archivés'], ['tous', 'Tous']].map(([k, l]) => `<span class="chip ${filtre === k ? 'on' : ''}" data-f="${k}">${l}</span>`).join('');
    $('#list').innerHTML = rows.length
      ? `<div class="row listhead"><span>Professionnel</span><span>Catégories</span><span>Contact</span><span>Dernière réunion</span></div>` +
        rows.map(p => `<div class="row" data-id="${p.id}">
          <div style="min-width:0"><span class="name">${esc(p.nom_complet)}</span>${p.archive_le ? ' <span class="badge">Archivé</span>' : ''}${p.structure ? `<div class="muted tiny">${esc(p.structure)}</div>` : ''}</div>
          <div>${catBadges(p.categories, 3) || '<span class="muted">—</span>'}</div>
          <div class="muted tiny" style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(p.telephone || '')}${p.telephone && p.email ? '<br>' : ''}${esc(p.email || '')}${!p.telephone && !p.email ? '—' : ''}</div>
          <div class="muted">${p.derniere ? fmtDate(p.derniere) : '—'}${p.prochaine ? `<div class="tiny" style="color:var(--accent)">à venir : ${fmtDate(p.prochaine)}</div>` : ''}</div></div>`).join('')
      : `<div class="empty"><div class="empty-t">${pros.length ? 'Aucun résultat' : 'Aucun professionnel pour le moment'}</div>${pros.length ? 'Essayez un autre mot ou une autre catégorie.' : 'Ajoutez les professionnels avec qui vous échangez (médecins, infirmières, enseignants…) avec « + Nouveau professionnel ».'}</div>`;
    document.querySelectorAll('#list .row[data-id]').forEach(r => r.onclick = () => location.hash = '#/professionnel/' + r.dataset.id);
    document.querySelectorAll('#chips .chip').forEach(c => c.onclick = () => { filtre = c.dataset.f; draw(); });
  };
  $('#q').oninput = e => { q = e.target.value; draw(); };
  $('#catf').onchange = e => { cat = e.target.value; draw(); };
  $('#newpro').onclick = () => proModal(null, r => { location.hash = '#/professionnel/' + r.id; });
  draw();
}

// ---------- Vue : fiche d'un professionnel ----------
async function viewProfessionnel(m) {
  const id = Number(m[1]);
  const p = await api('GET', '/api/professionnels/' + id);
  const ligne = (l, v) => v ? `<div class="kv"><span class="muted">${l}</span><span>${v}</span></div>` : '';
  const site = p.site_web ? `<a href="${esc(p.site_web)}" target="_blank" rel="noopener noreferrer">${esc(p.site_web.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : '';
  app.innerHTML = `
    <a class="crumb" href="#/professionnels">← Professionnels</a>
    <div class="head"><div><h1>${esc(p.nom_complet)}</h1>
      <div class="sub">${catBadges(p.categories) || '<span class="muted">Aucune catégorie</span>'}${p.archive_le ? ` <span class="badge">Archivé</span> <span class="muted">depuis le ${fmtDate(p.archive_le)}</span>` : ''}
        · ${p.nb_reunions} réunion${p.nb_reunions > 1 ? 's' : ''} réalisée${p.nb_reunions > 1 ? 's' : ''}</div></div>
      <div class="headbtns"><button class="btn" id="edit">Modifier</button>${p.archive_le ? '<button class="btn" id="unarch">Désarchiver</button>' : '<button class="btn" id="arch">Archiver</button>'}<button class="btn primary" id="newr">+ Nouvelle réunion</button></div></div>
    <div class="grid2">
      <div class="card"><h2>Réunions</h2>
        ${p.reunions.length ? `<div class="timeline">${p.reunions.map(r => `<div class="item" data-id="${r.id}">
            <div class="date">${fmtDate(r.date)}</div>
            <div style="min-width:0"><div class="meta">${esc(r.heure || 'sans heure')} · ${esc(r.format)}${r.pros.length > 1 ? ' · avec ' + esc(r.pros.filter(x => x.id !== id).map(x => x.nom).join(', ')) : ''}</div>
              ${r.objet ? `<div class="snip">${esc(r.objet)}</div>` : ''}</div>
            <div class="badges">${statutBadge(r.statut)}</div></div>`).join('')}</div>`
          : '<div class="empty"><div class="empty-t">Aucune réunion pour l’instant</div>Utilisez « + Nouvelle réunion » pour en noter une avec ce professionnel.</div>'}</div>
      <div>
        <div class="card"><h2>Coordonnées</h2>
          ${ligne('Téléphone', lienTel(p.telephone))}${ligne('E-mail', lienMail(p.email))}${ligne('Structure', esc(p.structure))}${ligne('Adresse', esc(p.adresse))}${ligne('Site web', site)}
          ${!(p.telephone || p.email || p.structure || p.adresse || p.site_web) ? '<p class="muted" style="margin:0">Aucune coordonnée renseignée. Utilisez « Modifier » pour en ajouter.</p>' : ''}</div>
        ${p.notes ? `<div class="card" style="margin-top:22px"><h2>Notes</h2><p style="margin:0;white-space:pre-wrap">${esc(p.notes)}</p></div>` : ''}
        <div style="margin-top:22px"><button class="btn danger small" id="delpro">Supprimer ce professionnel</button></div>
      </div></div>`;
  $('#edit').onclick = () => proModal(p);
  $('#newr').onclick = () => reunionModal({ pros: [id] });
  if ($('#arch')) $('#arch').onclick = async () => { await api('POST', `/api/professionnels/${id}/archiver`); toast('Professionnel archivé'); render(); };
  if ($('#unarch')) $('#unarch').onclick = async () => { await api('POST', `/api/professionnels/${id}/desarchiver`); toast('Professionnel désarchivé'); render(); };
  document.querySelectorAll('.timeline .item[data-id]').forEach(i => i.onclick = () => location.hash = '#/reunion/' + i.dataset.id);
  $('#delpro').onclick = async () => {
    const a = await api('GET', `/api/professionnels/${id}/suppression`);
    modal('Supprimer ce professionnel ?', `<p style="margin-top:0"><b>${esc(a.nom)}</b> sera placé dans la corbeille (30 jours).</p>
      <p class="muted">${a.reunions_supprimees ? `${a.reunions_supprimees} réunion${a.reunions_supprimees > 1 ? 's' : ''} où il ou elle est seul(e) partira avec lui. ` : 'Aucune réunion ne sera supprimée. '}${a.reunions_partagees ? `${a.reunions_partagees} réunion${a.reunions_partagees > 1 ? 's' : ''} avec d’autres professionnels ${a.reunions_partagees > 1 ? 'seront conservées' : 'sera conservée'} (son nom en sera simplement retiré).` : ''}</p>`,
      async () => { await api('DELETE', '/api/professionnels/' + id); toast('Professionnel placé dans la corbeille'); location.hash = '#/professionnels'; }, 'Mettre à la corbeille', true);
  };
}

// ---------- Fenêtre : nouvelle réunion ----------
async function reunionModal(def = {}) {
  const pros = await api('GET', '/api/professionnels');
  let confirme = false, picker;
  const v = { date: today(), heure: '', duree: 30, format: 'téléphone', statut: 'planifiée', objet: '', pros: [], ...def };
  modal('Nouvelle réunion', `
    <div id="cfbox"></div>
    <div class="field"><label>Professionnel(s) <span class="muted tiny">(plusieurs possibles ; tapez un nom pour créer une fiche)</span></label><div id="mp-pros"></div></div>
    <div class="fields">
      <div class="field"><label>Date</label><input type="date" name="date" required value="${esc(v.date)}"></div>
      <div class="field"><label>Heure</label><input type="time" name="heure" value="${esc(v.heure)}"></div>
      <div class="field"><label>Durée (min)</label><input type="number" name="duree" min="5" step="5" value="${esc(v.duree)}"></div>
    </div>
    <div class="fields">
      <div class="field"><label>Format</label><select name="format">${FORMATS_REU.map(x => `<option ${x === v.format ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Statut</label><select name="statut">${STATUTS_REU.map(x => `<option ${x === v.statut ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Objet <span class="muted tiny">(facultatif)</span></label><input name="objet" maxlength="300" value="${esc(v.objet)}" placeholder="ex. orientation, bilan, coordination…"></div>`,
    async fd => {
      const ids = picker.get();
      if (!ids.length) { toast('Choisissez au moins un professionnel'); throw new Error('pros'); }
      const body = { ...Object.fromEntries(fd), duree: Number(fd.get('duree')) || 30, pros: ids };
      if (confirme) body.confirme_doublon = true;
      try {
        const r = await api('POST', '/api/reunions', body);
        location.hash = '#/reunion/' + r.id;
      } catch (e) {
        if (e.data && e.data.conflits) {
          confirme = true;
          $('#cfbox').innerHTML = `<div class="dbl"><div class="dbl-t">Cet horaire est déjà occupé</div>${e.data.conflits.map(x => `<div class="dbl-c"><div><b>${esc(x.libelle)}</b> <span class="muted tiny">${esc(x.heure || '')}</span></div></div>`).join('')}
            <div class="muted tiny" style="margin-top:6px">Enregistrez de nouveau pour créer la réunion quand même.</div></div>`;
        }
        throw e;
      }
    }, 'Créer la réunion', false, 'wide');
  picker = multiPicker($('#mp-pros'), { options: pros.map(optionPro), selected: v.pros, creer: creerProRapide, placeholder: 'Rechercher ou créer un professionnel…' });
  // le champ de recherche reçoit le focus d'emblée quand aucun professionnel n'est encore choisi
  if (!v.pros.length) $('#mp-pros .mp-in').focus();
}

// ---------- Vue : réunions (liste et calendrier) ----------
function calReunions() {
  return {
    etat: agendaReu, unite: 'réunion', defDuree: 30, api: '/api/reunions', deplace: 'Réunion déplacée',
    libelle: r => r.pros_noms || 'Réunion',
    titre: r => `${r.heure || ''} ${r.pros_noms} · ${r.format} · ${r.statut}${r.objet ? ' · ' + r.objet : ''}`.trim(),
    classe: evClass, glissable: r => r.statut === 'planifiée' ? 'draggable="true"' : '', point: () => '',
    legende: '<span><i class="lg plan"></i>Planifiée</span><span><i class="lg ok"></i>Réalisée</span><span><i class="lg off"></i>Annulée</span>',
    ouvrir: id => location.hash = '#/reunion/' + id,
    creer: opts => reunionModal(opts),
    conflits: (r, date, heure, liste) => `<p style="margin-top:0"><b>${esc(r.pros_noms)}</b> → ${esc(fmtDate(date))}${heure ? ' à ' + esc(heure) : ''}</p>${liste.map(x => `<div class="dbl-c"><div><b>${esc(x.libelle)}</b> <span class="muted tiny">${esc(x.heure || 'sans heure')}</span>
      <div class="dbl-r tiny">${x.type === 'seance' ? 'Chevauche une séance' : 'Chevauche une autre réunion'}</div></div></div>`).join('')}`,
  };
}
async function viewReunions() {
  if (!agendaReu.ref) agendaReu.ref = today();
  const tout = await api('GET', '/api/reunions');
  app.innerHTML = `<div class="head"><div><h1>Professionnels</h1><div class="sub" id="count"></div></div>
      <div class="headbtns"><a class="btn" href="/api/export/reunions.csv">Exporter (.csv)</a><div class="seg" id="seg-vue"><button data-v="calendrier">Calendrier</button><button data-v="liste">Liste</button></div>
      <button class="btn primary" id="newr">+ Nouvelle réunion</button></div></div>
    ${ongletsPro('reunions')}
    <div id="body"></div>`;
  $('#newr').onclick = () => reunionModal({});
  const draw = () => {
    document.querySelectorAll('#seg-vue button').forEach(b => b.classList.toggle('on', b.dataset.v === agendaReu.vue));
    agendaReu.vue === 'calendrier' ? drawCalendar(tout, calReunions()) : drawListeReunions(tout);
  };
  document.querySelectorAll('#seg-vue button').forEach(b => b.onclick = () => { agendaReu.vue = b.dataset.v; draw(); });
  draw();
}
function drawListeReunions(tout) {
  const t = today(), lun = mondayOf(t), dim = addDays(lun, 6), mois = t.slice(0, 7);
  $('#body').innerHTML = `<div class="toolbar"><div class="chips" id="chips"></div><span class="muted">·</span><div class="chips" id="per"></div></div>
    <div class="card list reunions" id="list" style="padding:0"></div>`;
  const draw = () => {
    const f = { avenir: r => r.statut === 'planifiée' && r.date >= t, passees: r => r.statut !== 'planifiée' || r.date < t }[agendaReu.onglet];
    const per = { tout: () => true, semaine: r => r.date >= lun && r.date <= dim, mois: r => r.date.startsWith(mois) }[agendaReu.periode];
    let rows = tout.filter(r => f(r) && per(r));
    if (agendaReu.onglet === 'avenir') rows = rows.slice().reverse();
    $('#count').textContent = `${rows.length} réunion${rows.length > 1 ? 's' : ''}`;
    $('#chips').innerHTML = [['avenir', 'À venir'], ['passees', 'Passées']].map(([k, l]) => `<span class="chip ${agendaReu.onglet === k ? 'on' : ''}" data-f="${k}">${l}</span>`).join('');
    $('#per').innerHTML = [['tout', 'Toutes dates'], ['semaine', 'Cette semaine'], ['mois', 'Ce mois']].map(([k, l]) => `<span class="chip ${agendaReu.periode === k ? 'on' : ''}" data-p="${k}">${l}</span>`).join('');
    $('#list').innerHTML = rows.length ? rows.map(r => `<div class="row" data-id="${r.id}">
        <div class="name">${fmtDate(r.date)}</div><div>${esc(r.pros_noms)}</div>
        <div class="muted" style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(r.heure || 'sans heure')} · ${esc(r.format)}${r.objet ? ' · ' + esc(r.objet) : ''}</div>
        <div class="badges">${statutBadge(r.statut)}</div></div>`).join('')
      : `<div class="empty"><div class="empty-t">${agendaReu.onglet === 'avenir' ? 'Aucune réunion à venir' : 'Aucune réunion passée'}</div>${agendaReu.onglet === 'avenir' ? 'Planifiez une réunion avec « + Nouvelle réunion », ou depuis le calendrier.' : 'Les réunions terminées apparaîtront ici.'}</div>`;
    document.querySelectorAll('#list .row').forEach(r => r.onclick = () => location.hash = '#/reunion/' + r.dataset.id);
    document.querySelectorAll('#chips .chip').forEach(c => c.onclick = () => { agendaReu.onglet = c.dataset.f; draw(); });
    document.querySelectorAll('#per .chip').forEach(c => c.onclick = () => { agendaReu.periode = c.dataset.p; draw(); });
  };
  draw();
}

// ---------- Vue : une réunion ----------
async function viewReunion(m) {
  const id = Number(m[1]);
  const [r, pros] = await Promise.all([api('GET', '/api/reunions/' + id), api('GET', '/api/professionnels')]);
  const liens = liste => liste.map(p => `<a href="#/professionnel/${p.k !== undefined ? p.k : p.id}">${esc(p.l !== undefined ? p.l.split(' · ')[0] : p.nom)}</a>`).join(', ');
  app.innerHTML = `
    <a class="crumb" href="#/reunions">← Réunions</a>
    <div class="head idhead"><div><h1 class="idname">Réunion du ${fmtDate(r.date)}${r.heure ? ' à ' + esc(r.heure) : ''}</h1>
        <div class="sub" id="rsub">${liens(r.pros)}</div></div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><span class="savestate" id="ss">Enregistré</span><button class="btn small" id="hist">Historique</button><button class="btn danger small" id="del">Supprimer</button></div></div>
    <div class="card" style="margin-bottom:18px"><div class="fields">
      <div class="field"><label>Date</label><input type="date" data-k="date" value="${esc(r.date)}"></div>
      <div class="field"><label>Heure</label><input type="time" data-k="heure" value="${esc(r.heure)}"></div>
      <div class="field"><label>Durée (min)</label><input type="number" data-k="duree" min="5" step="5" value="${esc(r.duree)}"></div>
      <div class="field"><label>Format</label><select data-k="format">${FORMATS_REU.map(x => `<option ${x === r.format ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Statut</label><select data-k="statut">${STATUTS_REU.map(x => `<option ${x === r.statut ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field" style="margin:8px 0 0"><label>Objet</label><input data-k="objet" maxlength="300" value="${esc(r.objet)}" placeholder="ex. orientation, bilan, coordination…"></div>
    <div class="field" style="margin:12px 0 0"><label>Professionnel(s)</label><div id="mp-pros"></div></div></div>
    ${editorHtml(r.contenu)}`;
  let timer, pending = null, picker;
  const collect = () => {
    const body = { contenu: $('#editor').innerHTML, pros: picker.get() };
    document.querySelectorAll('[data-k]').forEach(el => { const k = el.dataset.k; body[k] = k === 'duree' ? Number(el.value) || 0 : el.value; });
    return body;
  };
  const save = async () => {
    const body = pending; pending = null;
    if (!body || !body.date) return;
    const ss = $('#ss');
    if (!body.pros.length) { if (ss) ss.textContent = 'Choisissez au moins un professionnel'; return; }
    try { await api('PUT', '/api/reunions/' + id, body); if (ss) ss.textContent = 'Enregistré'; } catch { if (ss) ss.textContent = 'Erreur'; }
  };
  const queue = () => { pending = collect(); $('#ss').textContent = 'Modifications…'; clearTimeout(timer); timer = setTimeout(save, 600); };
  picker = multiPicker($('#mp-pros'), { options: pros.map(optionPro), selected: r.pros.map(p => p.id), creer: creerProRapide, placeholder: 'Ajouter un professionnel…',
    onChange: () => { $('#rsub').innerHTML = liens(picker.noms()); queue(); } });
  document.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', queue));
  wireEditor(queue);
  exportHook = async () => { clearTimeout(timer); if (pending) await save(); };
  window.addEventListener('hashchange', () => { clearTimeout(timer); save(); }, { once: true });
  window.addEventListener('beforeunload', () => { if (pending && pending.pros.length) fetch('/api/reunions/' + id, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) }); }, { once: true });
  $('#hist').onclick = async () => {
    clearTimeout(timer); if (pending) await save();
    historiqueNotes(id, () => { pending = null; render(); }, 'reunion');
  };
  $('#del').onclick = () => modal('Supprimer cette réunion ?', '<p class="muted" style="margin-top:0">La réunion sera placée dans la corbeille. Vous pourrez la restaurer pendant 30 jours.</p>',
    async () => { clearTimeout(timer); pending = null; await api('DELETE', '/api/reunions/' + id); toast('Réunion placée dans la corbeille'); location.hash = '#/reunions'; }, 'Mettre à la corbeille', true);
}

// ---------- Page d'accueil : réunions du jour et à venir ----------
function accueilReunionsHtml(A) {
  const aj = A.reunions_aujourdhui || [], pr = A.reunions_prochaines || [];
  if (!aj.length && !pr.length) return '';
  const ligne = (r, avecDate) => `<div class="hr" data-reunion="${r.id}"><div class="t ${avecDate ? 'dt' : ''}">${avecDate ? esc(fmtDate(r.date)) + (r.heure ? ' · ' + esc(r.heure) : '') : esc(r.heure || 'sans heure')}</div>
    <div class="w"><span class="name">${esc(r.pros_noms)}</span> <span class="muted tiny">${esc(r.format)}${r.objet ? ' · ' + esc(r.objet) : ''}</span></div><div class="s">${statutBadge(r.statut)}</div></div>`;
  return `<div class="card hcard" style="margin-top:22px"><h2>Réunions avec des professionnels <a class="more" href="#/reunions">Tout voir</a></h2>
    ${aj.length ? `<div class="muted tiny" style="margin:-2px 0 4px">Aujourd’hui</div><div class="hrows">${aj.map(r => ligne(r, false)).join('')}</div>` : ''}
    ${pr.length ? `<div class="muted tiny" style="margin:${aj.length ? 12 : -2}px 0 4px">À venir</div><div class="hrows">${pr.map(r => ligne(r, true)).join('')}</div>` : ''}</div>`;
}

// ---------- Paramètres : listes modifiables (catégories de professionnels, provenances des patients) ----------
const LISTES_ED = {
  cat: { k: 'cat', card: 'catcard', api: '/api/categories-pro', titre: 'Catégories de professionnels', unite: 'fiche', nouveau: 'Nouvelle catégorie…',
    aide: 'La liste proposée dans la fiche d’un professionnel. Renommer une catégorie la change sur toutes les fiches ; la supprimer la retire des fiches (les fiches ne sont pas supprimées).',
    renTitre: 'Renommer la catégorie', ajoutee: 'Catégorie ajoutée', renommee: 'Catégorie renommée', supprimee: 'Catégorie supprimée', supTitre: 'Supprimer la catégorie ?',
    supTexte: (c, n) => `retirée ${n ? `des ${n} fiche${n > 1 ? 's' : ''} qui l’utilisent` : 'de la liste'}. Les fiches elles-mêmes ne sont pas supprimées.` },
  prov: { k: 'prov', card: 'provcard', api: '/api/provenances', titre: 'Provenance des patients', unite: 'patient', nouveau: 'Nouvelle source…',
    aide: 'Les choix proposés dans le champ « Provenance » d’une fiche patient (comment la personne est arrivée au cabinet). Renommer une source la change sur toutes les fiches ; la supprimer remet « non renseignée » sur les fiches concernées.',
    renTitre: 'Renommer la source', ajoutee: 'Source ajoutée', renommee: 'Source renommée', supprimee: 'Source supprimée', supTitre: 'Supprimer la source ?',
    supTexte: (c, n) => `retirée de la liste${n ? ` ; ${n} fiche${n > 1 ? 's' : ''} ${n > 1 ? 'repasseront' : 'repassera'} à « non renseignée »` : ''}. Aucun patient n’est supprimé.` },
};
const listeEdCard = (cfg, items) => `<div class="card pcard" id="${cfg.card}"><h2>${cfg.titre}</h2>
  <p class="muted tiny" style="margin-top:0">${cfg.aide}</p>
  <div class="catlist">${items.map(c => `<div class="catrow" data-id="${c.id}"><span>${esc(c.nom)}</span><span class="muted tiny">${c.nb ? c.nb + ' ' + cfg.unite + (c.nb > 1 ? 's' : '') : 'inutilisée'}</span>
    <span class="catbtn"><button class="btn small" data-ren="${c.id}">Renommer</button><button class="btn small danger" data-sup="${c.id}">Supprimer</button></span></div>`).join('')}</div>
  <form class="inl" id="${cfg.k}new" style="margin-top:12px"><input id="${cfg.k}nom" maxlength="80" placeholder="${cfg.nouveau}" aria-label="${cfg.nouveau}"><button class="btn primary">Ajouter</button></form></div>`;
function brancherListeEd(cfg, items) {
  const racine = $('#' + cfg.card);
  $('#' + cfg.k + 'new').onsubmit = async e => {
    e.preventDefault(); const nom = $('#' + cfg.k + 'nom').value.trim(); if (!nom) return;
    try { await api('POST', cfg.api, { nom }); toast(cfg.ajoutee); render(); } catch { /* message affiché */ }
  };
  racine.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
    const c = items.find(x => String(x.id) === b.dataset.ren);
    modal(cfg.renTitre, `<div class="field"><label>Nom</label><input name="nom" required maxlength="80" value="${esc(c.nom)}"></div>`,
      async fd => { await api('PUT', cfg.api + '/' + c.id, { nom: fd.get('nom') }); toast(cfg.renommee); render(); });
  });
  racine.querySelectorAll('[data-sup]').forEach(b => b.onclick = () => {
    const c = items.find(x => String(x.id) === b.dataset.sup);
    modal(cfg.supTitre, `<p style="margin-top:0"><b>${esc(c.nom)}</b> sera ${cfg.supTexte(c, c.nb)}</p>`,
      async () => { await api('DELETE', cfg.api + '/' + c.id); toast(cfg.supprimee); render(); }, 'Supprimer', true);
  });
}
const categoriesCardHtml = cats => listeEdCard(LISTES_ED.cat, cats);
const brancherCategories = cats => brancherListeEd(LISTES_ED.cat, cats);
const provenancesCardHtml = l => listeEdCard(LISTES_ED.prov, l);
const brancherProvenances = l => brancherListeEd(LISTES_ED.prov, l);
