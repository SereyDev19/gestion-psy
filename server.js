// Gestion Psy : serveur local, aucune dépendance (Node 22+ : SQLite intégré)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const X = require('./export');

const PORT = Number(process.env.PORT || 4173);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'cabinet.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');

// ---------- Schéma et migrations ----------
// Règle d'or : on n'édite JAMAIS une migration déjà publiée. Pour faire évoluer la structure,
// on AJOUTE une migration à la fin de la liste. La base mémorise sa version (PRAGMA user_version),
// et au démarrage seules les migrations manquantes sont appliquées, sur les données existantes.
const MIGRATIONS = [
  // v1 : structure initiale
  `CREATE TABLE IF NOT EXISTS patients (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     nom TEXT NOT NULL,                   -- nom affiché (prénom, initiales ou pseudo)
     type TEXT NOT NULL DEFAULT 'adulte', -- adulte | mineur
     statut TEXT NOT NULL DEFAULT 'suivi en cours',
     contact TEXT DEFAULT '',
     tarif_defaut REAL DEFAULT 60,
     notes TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now'))
   );
   CREATE TABLE IF NOT EXISTS proches (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
     nom TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'parent',
     contact TEXT DEFAULT ''
   );
   CREATE TABLE IF NOT EXISTS modeles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     nom TEXT NOT NULL,
     contenu TEXT DEFAULT ''
   );
   CREATE TABLE IF NOT EXISTS consultations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
     date TEXT NOT NULL,
     heure TEXT DEFAULT '',
     duree INTEGER DEFAULT 50,
     mode TEXT DEFAULT 'cabinet',
     statut TEXT DEFAULT 'planifiée',
     tarif REAL DEFAULT 0,
     paye INTEGER DEFAULT 0,
     presents TEXT DEFAULT '[]',
     facture_a TEXT DEFAULT '',
     contenu TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS idx_consult_patient ON consultations(patient_id, date);`,
  // v2 : les proches deviennent de vrais patients, reliés par une table de liens (un seul enregistrement,
  //      visible des deux côtés). Les anciens « proches » sont convertis sans perte (statut « proche »).
  (d) => {
    d.exec(`CREATE TABLE liens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,  -- l'enfant / l'ado
      proche_id  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,  -- le parent / responsable
      role TEXT NOT NULL DEFAULT 'parent',                                    -- parent | responsable légal | autre proche
      UNIQUE (patient_id, proche_id),
      CHECK (patient_id <> proche_id)
    );
    CREATE INDEX idx_liens_proche ON liens(proche_id);`);
    const ins = d.prepare("INSERT INTO patients (nom,type,statut,contact) VALUES (?,?,?,?)");
    const lien = d.prepare('INSERT INTO liens (patient_id,proche_id,role) VALUES (?,?,?)');
    for (const r of d.prepare('SELECT * FROM proches').all()) {
      const id = ins.run(r.nom, 'adulte', 'proche', r.contact || '').lastInsertRowid;
      lien.run(r.patient_id, id, r.role === 'autre' ? 'autre proche' : r.role);
    }
    // l'ancienne table « proches » est conservée (inutilisée) : une migration n'efface jamais de données
  },
  // v3 : mode de paiement des séances + archivage des patients (date d'archivage, vide = actif)
  `ALTER TABLE consultations ADD COLUMN mode_paiement TEXT DEFAULT '';
   ALTER TABLE patients ADD COLUMN archive_le TEXT;`,
  // v4 : identité du patient (civilité, prénom, date de naissance). `nom` devient le nom de famille.
  //      Le tarif n'est plus porté par le patient mais par chaque séance (la colonne tarif_defaut reste, inutilisée).
  `ALTER TABLE patients ADD COLUMN civilite TEXT DEFAULT '';
   ALTER TABLE patients ADD COLUMN prenom TEXT DEFAULT '';
   ALTER TABLE patients ADD COLUMN date_naissance TEXT;`,
  // v5 : corbeille. Un élément supprimé est mis de côté en entier (avec ses séances, liens…) pendant 30 jours.
  `CREATE TABLE corbeille (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL,            -- patient | consultation | modele
     libelle TEXT NOT NULL,         -- ce que l'on voit dans la corbeille
     detail TEXT DEFAULT '',
     donnees TEXT NOT NULL,         -- contenu supprimé (JSON), utilisé pour la restauration
     supprime_le TEXT NOT NULL DEFAULT (datetime('now')),
     expire_le TEXT NOT NULL        -- supprime_le + 30 jours ; ensuite effacé définitivement
   );`,
  // v6 : e-mail et téléphone des patients ; documents joints (remplacés en v8 par des liens) (au patient ou à une séance) ; documents en corbeille.
  //      Les fichiers sont stockés dans la base elle-même : une seule sauvegarde, une seule suppression, tout suit.
  (d) => {
    d.exec(`
      ALTER TABLE patients ADD COLUMN email TEXT DEFAULT '';
      ALTER TABLE patients ADD COLUMN telephone TEXT DEFAULT '';
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        consultation_id INTEGER REFERENCES consultations(id) ON DELETE CASCADE,   -- vide : document du patient
        nom TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT 'application/octet-stream',
        taille INTEGER NOT NULL,
        contenu BLOB NOT NULL,
        ajoute_le TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_docs_patient ON documents(patient_id);
      CREATE INDEX idx_docs_consult ON documents(consultation_id);
      CREATE TABLE corbeille_docs (       -- fichiers des éléments en corbeille (effacés avec eux)
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corbeille_id INTEGER NOT NULL REFERENCES corbeille(id) ON DELETE CASCADE,
        id_origine INTEGER NOT NULL, patient_id INTEGER NOT NULL, consultation_id INTEGER,
        nom TEXT NOT NULL, mime TEXT NOT NULL, taille INTEGER NOT NULL, contenu BLOB NOT NULL, ajoute_le TEXT NOT NULL
      );
      CREATE INDEX idx_cdocs ON corbeille_docs(corbeille_id);`);
    // L'ancien champ « contact » : on range dans les nouveaux champs ce qui est évidemment un e-mail ou un téléphone
    const maj = d.prepare('UPDATE patients SET email=?, telephone=?, contact=? WHERE id=?');
    for (const p of d.prepare("SELECT id, contact FROM patients WHERE contact IS NOT NULL AND contact <> ''").all()) {
      let reste = p.contact, email = '', tel = '';
      const em = reste.match(/[^\s,;/|]+@[^\s,;/|]+\.[^\s,;/|]+/);
      if (em) { email = em[0]; reste = reste.replace(em[0], ''); }
      const net = reste.replace(/^[\s,;/|-]+|[\s,;/|-]+$/g, '');
      const chiffres = net.replace(/\D/g, '');
      if (/^\+?[\d\s.()-]+$/.test(net) && chiffres.length >= 8 && chiffres.length <= 15) { tel = net; reste = ''; }
      else reste = em ? net : p.contact;
      if (email || tel) maj.run(email, tel, reste, p.id);
    }
  },
  // v7 : table de réglages (clé / valeur). Aujourd'hui inutilisée mais CONSERVÉE : des bases existantes sont déjà en v7 et une migration publiée ne se retire jamais.
  `CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);`,
  // v8 : les fichiers joints sont remplacés par de simples LIENS (ressources). Les anciens fichiers (et leur copie en corbeille) sont supprimés ;
  //      la copie de sécurité faite automatiquement avant la migration les conserve en cas de regret.
  (d) => {
    d.exec(`
      CREATE TABLE ressources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        consultation_id INTEGER REFERENCES consultations(id) ON DELETE CASCADE,   -- vide : lien du patient
        titre TEXT NOT NULL,
        url TEXT NOT NULL,
        ajoute_le TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_res_patient ON ressources(patient_id);
      CREATE INDEX idx_res_consult ON ressources(consultation_id);
      CREATE TABLE corbeille_ressources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        corbeille_id INTEGER NOT NULL REFERENCES corbeille(id) ON DELETE CASCADE,
        id_origine INTEGER NOT NULL, patient_id INTEGER NOT NULL, consultation_id INTEGER,
        titre TEXT NOT NULL, url TEXT NOT NULL, ajoute_le TEXT NOT NULL
      );
      CREATE INDEX idx_cres ON corbeille_ressources(corbeille_id);
      DROP TABLE corbeille_docs;
      DROP TABLE documents;
      DELETE FROM corbeille WHERE type = 'document';`);
  },
  // v9 : gestion des doublons / homonymes. « complement » = précision libre pour distinguer deux homonymes (ex. « la fille de Marie »),
  //      doublons_ignores = paires de fiches que la praticienne a confirmées comme étant deux personnes différentes (a < b).
  `ALTER TABLE patients ADD COLUMN complement TEXT DEFAULT '';
   CREATE TABLE doublons_ignores (
     a INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
     b INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
     PRIMARY KEY (a, b)
   );`,
  // v10 : historique des notes de séance. Avant chaque modification importante du texte, l'ancienne version est conservée ici
  //       (supprimée avec la séance ; copiée dans la corbeille avec elle).
  `CREATE TABLE consultation_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     consultation_id INTEGER NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
     contenu TEXT NOT NULL,
     enregistre_le TEXT NOT NULL DEFAULT (datetime('now')),   -- heure UTC
     origine TEXT NOT NULL DEFAULT 'modification'             -- modification | avant-restauration
   );
   CREATE INDEX idx_cv ON consultation_versions(consultation_id, id);`,
  // v11, v12… : ajouter ici, par exemple :
  // `ALTER TABLE consultations ADD COLUMN lieu TEXT DEFAULT ''`,
];
if (process.env.EXTRA_MIGRATION) MIGRATIONS.push(process.env.EXTRA_MIGRATION); // réservé aux tests

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length)
    throw new Error(`Cette base (v${current}) est plus récente que l'application (v${MIGRATIONS.length}). Installez la dernière version de l'application.`);
  if (current === MIGRATIONS.length) return;
  // Filet de sécurité : copie complète de la base AVANT toute modification (sauf toute première création)
  const hasData = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='patients'").get().n > 0;
  if (hasData) {
    const dir = path.join(DATA_DIR, 'sauvegardes');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `avant-migration-v${current}-vers-v${MIGRATIONS.length}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    console.log('Sauvegarde avant mise à jour :', out);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db); else db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`Échec de la migration v${v + 1} (base inchangée) : ${e.message}`); }
  }
  console.log(`Base mise à jour : v${current} → v${MIGRATIONS.length}`);
}
migrate();

// ---------- Utilitaires ----------
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const pick = (obj, keys) => keys.map(k => (obj[k] === undefined ? null : obj[k]));

const PATIENT_F = ['nom', 'prenom', 'civilite', 'date_naissance', 'type', 'statut', 'email', 'telephone', 'contact', 'notes', 'complement'];

// Nom affiché partout : « Prénom Nom » (calculé, jamais stocké)
const NOMC = a => `TRIM(COALESCE(${a}.prenom,'') || ' ' || ${a}.nom)`;

// Âge calculé à partir de la date de naissance (en années ; en mois avant 2 ans)
function ageInfo(dn, now = new Date()) {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dn || '');
  if (!mt) return { age: null, age_texte: '' };
  const [y, mo, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  let mois = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - mo);
  if (now.getDate() < d) mois--;
  if (mois < 0) return { age: null, age_texte: '' };
  const ans = Math.floor(mois / 12);
  return { age: ans, age_texte: ans >= 2 ? `${ans} ans` : mois >= 1 ? `${mois} mois` : 'moins d’un mois' };
}

// Sortie API : `nom` = nom affiché, `nom_famille` = nom de famille brut ; le tarif n'existe plus ici
function patOut(p) {
  if (!p) return p;
  const { tarif_defaut, ...r } = p;
  return { ...r, nom_famille: r.nom, nom: `${(r.prenom || '').trim()} ${r.nom}`.trim(), ...ageInfo(r.date_naissance) };
}
// Format IMPOSÉ pour le téléphone et l'e-mail (champs facultatifs, mais s'ils sont remplis ils doivent être valides) :
//  - téléphone français : 10 chiffres commençant par 0, enregistré « 06 12 34 56 78 » ; « +33 6 12 34 56 78 » et « 0033… » sont convertis
//  - téléphone étranger : « + » suivi de 8 à 15 chiffres (ex. +32 470 12 34 56 est enregistré « +32470123456 »)
//  - e-mail : adresse complète (nom@domaine.ext), enregistrée en minuscules
const MSG_TEL = 'Téléphone invalide : 10 chiffres (ex. 06 12 34 56 78) ou numéro international (ex. +32 470 12 34 56)';
function formaterTelephone(brut) {
  let t = String(brut ?? '').trim();
  if (!t) return '';
  if (/[^\d\s.()+-]/.test(t)) return null;
  t = t.replace(/[\s.()-]/g, '').replace(/^00/, '+');
  if (/^\+330?\d{9}$/.test(t)) t = '0' + t.slice(-9);
  if (/^0[1-9]\d{8}$/.test(t)) return t.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5');
  if (/^\+[1-9]\d{7,14}$/.test(t)) return t;
  return null;
}
const formaterEmail = brut => { const e = String(brut ?? '').trim().toLowerCase(); return !e ? '' : /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null; };
// Valide et normalise les champs d'identité reçus. « ancien » : fiche actuelle ; un téléphone / e-mail inchangé n'est pas revérifié
// (une ancienne fiche mal renseignée ne bloque pas les autres modifications).
function identite(b, ancien = null) {
  if (b.civilite !== undefined && b.civilite !== null && !['', 'M', 'Mme'].includes(b.civilite)) throw httpErr(400, 'Civilité invalide');
  if (b.email !== undefined && b.email !== null && !(ancien && b.email === ancien.email)) {
    const e = formaterEmail(b.email); if (e === null) throw httpErr(400, 'E-mail invalide : adresse complète attendue (ex. nom@exemple.fr)'); b.email = e;
  }
  if (b.telephone !== undefined && b.telephone !== null && !(ancien && b.telephone === ancien.telephone)) {
    const t = formaterTelephone(b.telephone); if (t === null) throw httpErr(400, MSG_TEL); b.telephone = t;
  }
  if (b.date_naissance === '') b.date_naissance = null;
  if (b.date_naissance) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date_naissance) || isNaN(new Date(b.date_naissance + 'T12:00:00'))) throw httpErr(400, 'Date de naissance invalide');
    if (b.date_naissance > new Date().toISOString().slice(0, 10) || b.date_naissance < '1900-01-01') throw httpErr(400, 'Date de naissance improbable');
  }
  return b;
}

// Tarif proposé à la création d'une séance : celui de la dernière séance du patient, sinon le dernier tarif saisi, sinon 60
function tarifSuggere(patientId) {
  const r = (patientId && get('SELECT tarif FROM consultations WHERE patient_id=? ORDER BY date DESC, id DESC LIMIT 1', patientId))
         || get('SELECT tarif FROM consultations ORDER BY id DESC LIMIT 1');
  return r ? r.tarif : 60;
}
const CONSULT_F = ['patient_id', 'date', 'heure', 'duree', 'mode', 'statut', 'tarif', 'paye', 'mode_paiement', 'presents', 'facture_a', 'contenu'];
const MODES_PAIEMENT = ['chèque', 'espèces', 'virement', 'CB'];

// « presents » : liste de repères. 'patient', 'autre', (anciens : 'parent', 'responsable légal') ou 'p:<id>' = une personne liée, retrouvée par son identifiant
// (elle suit donc les changements de nom, et disparaît si elle est supprimée). « autres_presents » : les libellés lisibles, hors patient.
const LIB_PRESENT = { parent: 'un parent', 'responsable légal': 'responsable légal', autre: 'autre personne' };
function libellesPresents(liste) {
  return liste.filter(x => x !== 'patient').map(x => {
    const m = /^p:(\d+)$/.exec(x);
    if (!m) return LIB_PRESENT[x] || x;
    const p = get(`SELECT ${NOMC('p')} AS n FROM patients p WHERE id=?`, Number(m[1]));
    return p ? p.n : null;
  }).filter(Boolean);
}
const presentsTxt = c => (c.presents || []).includes('patient') ? ['le patient', ...(c.autres_presents || [])].join(', ') : (c.autres_presents || []).join(', ');
function consultOut(c) {
  if (!c) return c;
  const presents = JSON.parse(c.presents || '[]');
  return { ...c, paye: !!c.paye, presents, autres_presents: libellesPresents(presents) };
}
function consultIn(b) {
  const o = { ...b };
  if (Array.isArray(o.presents)) o.presents = JSON.stringify([...new Set(o.presents.filter(x => /^(patient|autre|parent|responsable légal|p:\d+)$/.test(x)))]);
  if (typeof o.paye === 'boolean') o.paye = o.paye ? 1 : 0;
  return o;
}
function validateConsult(b) {
  if (!b.patient_id || !get('SELECT 1 FROM patients WHERE id=?', b.patient_id)) return 'Patient inconnu';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return 'Date invalide (AAAA-MM-JJ)';
  if (b.mode_paiement && !MODES_PAIEMENT.includes(b.mode_paiement)) return 'Mode de paiement invalide';
  if (!b.paye) b.mode_paiement = '';          // pas de mode de paiement tant que la séance n'est pas payée
  return null;
}

// ---------- Routes ----------
const routes = [];
const route = (method, pattern, fn) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), fn });

route('GET', '/api/version', () => ({ version: require('./package.json').version }));

route('GET', '/api/tarif-suggere', ({ url }) => ({ tarif: tarifSuggere(Number(url.searchParams.get('patient')) || null) }));

route('GET', '/api/patients', () =>
  all(`SELECT p.*,
        (SELECT COUNT(*) FROM consultations c WHERE c.patient_id=p.id AND c.statut='réalisée') AS nb_seances,
        (SELECT MAX(date) FROM consultations c WHERE c.patient_id=p.id AND c.statut='réalisée') AS derniere,
        (SELECT MIN(date) FROM consultations c WHERE c.patient_id=p.id AND c.statut='planifiée' AND c.date>=date('now','localtime')) AS prochaine,
        (SELECT COUNT(*) FROM consultations c WHERE c.patient_id=p.id AND c.statut='réalisée' AND c.paye=0) AS impayees,
        (SELECT tarif FROM consultations c WHERE c.patient_id=p.id ORDER BY c.date DESC, c.id DESC LIMIT 1) AS dernier_tarif
       FROM patients p ORDER BY p.nom COLLATE NOCASE, p.prenom COLLATE NOCASE`).map(patOut));

// ---------- Doublons et homonymes ----------
// On ne bloque jamais : on compare les fiches (sans accents ni majuscules, prénom/nom dans n'importe quel ordre, une faute de frappe tolérée,
// téléphone et e-mail normalisés) et on demande confirmation. « fort » = presque sûrement la même personne, « possible » = à vérifier.
const jetons = (prenom, nom) => norm(`${prenom || ''} ${nom || ''}`).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort();
const telChiffres = t => { let d = String(t || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); return d.length >= 9 ? d.slice(-9) : ''; };
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const empreinte = p => ({ p, tk: jetons(p.prenom, p.nom), cle: jetons(p.prenom, p.nom).join(' '), famille: norm(p.nom).replace(/[^a-z0-9]+/g, ''),
  prenomVide: !String(p.prenom || '').trim(), tel: telChiffres(p.telephone), mail: String(p.email || '').trim().toLowerCase(), dn: p.date_naissance || '' });
function comparer(a, b) {
  const egal = !!a.cle && a.cle === b.cle;
  // Faute de frappe : un seul mot diffère, d'une seule lettre, et il a au moins 5 lettres (« Léa » et « Léo » = deux prénoms, pas une faute)
  const proche = !egal && a.tk.length > 0 && a.tk.length === b.tk.length &&
    a.tk.filter((t, i) => t !== b.tk[i]).length === 1 && a.tk.every((t, i) => t === b.tk[i] || (t.length >= 5 && b.tk[i].length >= 5 && lev(t, b.tk[i]) <= 1));
  const nom = egal || proche;
  const memeNaiss = !!a.dn && a.dn === b.dn, naissDiff = !!a.dn && !!b.dn && a.dn !== b.dn;
  const memeTel = !!a.tel && a.tel === b.tel, memeMail = !!a.mail && a.mail === b.mail;
  const contact = memeMail ? 'e-mail' : memeTel ? 'téléphone' : '';
  const sansPrenom = !!a.famille && a.famille === b.famille && (a.prenomVide || b.prenomVide);
  if (nom && memeNaiss) return { niveau: 'fort', raisons: [(egal ? 'Même nom' : 'Nom très proche') + ' et même date de naissance'] };
  if (nom && !naissDiff && contact) return { niveau: 'fort', raisons: [(egal ? 'Même nom' : 'Nom très proche') + ' et même ' + contact] };
  if (nom && !naissDiff) return { niveau: 'possible', raisons: [egal ? 'Même nom (homonyme ou doublon ?)' : 'Nom très proche (faute de frappe ?)'] };
  if (contact) return { niveau: 'possible', raisons: [`Même ${contact} — peut-être un proche de la même famille`] };
  if (sansPrenom && !naissDiff) return { niveau: 'possible', raisons: ['Même nom de famille, prénom manquant'] };
  return null;
}
const ordre = { fort: 0, possible: 1 };
function chercherDoublons(b, exclureId = 0) {
  const moi = empreinte(b), out = [];
  const ign = exclureId ? new Set(all('SELECT a,b FROM doublons_ignores WHERE a=? OR b=?', exclureId, exclureId).map(r => r.a === exclureId ? r.b : r.a)) : new Set();
  for (const p of all('SELECT * FROM patients WHERE id<>?', exclureId)) {
    if (ign.has(p.id)) continue;
    const r = comparer(moi, empreinte(p));
    if (r) { const { notes, ...pub } = patOut(p); out.push({ ...pub, ...r }); }
  }
  return out.sort((x, y) => ordre[x.niveau] - ordre[y.niveau]).slice(0, 5);
}
const paire = (x, y) => x < y ? [x, y] : [y, x];
const ignorerPaires = (id, cands) => cands.forEach(c => run('INSERT OR IGNORE INTO doublons_ignores (a,b) VALUES (?,?)', ...paire(id, c.id)));
// À appeler avant une création/modification : lève un 409 « doublon » tant que la praticienne n'a pas confirmé (confirme_doublon)
function verifierDoublons(b, exclureId, confirme) {
  const c = chercherDoublons(b, exclureId);
  if (c.length && !confirme) throw Object.assign(httpErr(409, 'Cette personne existe peut-être déjà'), { extra: { doublons: c } });
  return c;
}
route('POST', '/api/patients/doublons', ({ body }) => {
  const b = identite({ nom: '', prenom: '', date_naissance: null, email: '', telephone: '', ...body });
  b.nom = String(b.nom_famille ?? b.nom ?? '').trim();
  if (!b.nom && !String(b.telephone || '').trim() && !String(b.email || '').trim()) return { doublons: [] };
  return { doublons: chercherDoublons(b, Number(body.id) || 0) };
});
// Toutes les paires suspectes du carnet (hors paires déjà marquées « deux personnes différentes »)
route('GET', '/api/doublons', () => {
  const ign = new Set(all('SELECT a,b FROM doublons_ignores').map(r => r.a + '-' + r.b));
  // Deux personnes déjà reliées (parent / enfant) qui partagent un téléphone ou un e-mail, c'est normal : on ne les signale pas
  all('SELECT patient_id, proche_id FROM liens').forEach(l => ign.add(paire(l.patient_id, l.proche_id).join('-')));
  const E = all('SELECT * FROM patients').map(empreinte), out = [];
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    const [x, y] = paire(E[i].p.id, E[j].p.id);
    if (ign.has(x + '-' + y)) continue;
    const r = comparer(E[i], E[j]);
    if (r) out.push({ a: patOut(E[i].p), b: patOut(E[j].p), ...r });
  }
  return out.sort((p, q) => ordre[p.niveau] - ordre[q.niveau]).slice(0, 200);
});
// Identifiants des patients qui ont un homonyme (même prénom + nom) : l'interface y ajoute l'âge / la précision pour les distinguer
route('GET', '/api/homonymes', () => {
  const g = new Map();
  for (const p of all('SELECT id, prenom, nom FROM patients')) { const k = jetons(p.prenom, p.nom).join(' '); if (k) (g.get(k) || g.set(k, []).get(k)).push(p.id); }
  return [...g.values()].filter(l => l.length > 1).flat();
});
route('POST', '/api/doublons/ignorer', ({ body }) => {
  const [a, b] = paire(Number(body.a), Number(body.b));
  if (!get('SELECT 1 FROM patients WHERE id=?', a) || !get('SELECT 1 FROM patients WHERE id=?', b) || a === b) throw httpErr(400, 'Fiches invalides');
  run('INSERT OR IGNORE INTO doublons_ignores (a,b) VALUES (?,?)', a, b);
  return { ok: true };
});

// Fusion : la fiche « :id » est conservée, la fiche « avec » est absorbée (ses séances, liens, ressources et notes passent sur la fiche conservée)
// puis placée dans la corbeille 30 jours. Une copie de sécurité complète est faite avant.
route('POST', '/api/patients/:id/fusion', ({ m, body }) => {
  const idA = Number(m[1]), idB = Number(body.avec);
  const A = get('SELECT * FROM patients WHERE id=?', idA), B = get('SELECT * FROM patients WHERE id=?', idB);
  if (!A || !B) throw httpErr(404, 'Patient introuvable');
  if (idA === idB) throw httpErr(400, 'Choisissez deux fiches différentes');
  const choix = body.champs || {};
  const vide = v => v === null || v === undefined || String(v).trim() === '';
  const val = f => choix[f] === 'autre' ? B[f] : (choix[f] === 'garde' ? A[f] : (vide(A[f]) ? B[f] : A[f]));
  const fin = {};
  ['civilite', 'prenom', 'nom', 'date_naissance', 'type', 'email', 'telephone', 'contact', 'complement'].forEach(f => { fin[f] = val(f) ?? ''; });
  if (!fin.date_naissance) fin.date_naissance = null;
  fin.statut = choix.statut ? val('statut') : (A.statut === 'proche' && B.statut !== 'proche' ? B.statut : A.statut);
  const nomB = `${B.prenom || ''} ${B.nom}`.trim(), nomA = `${A.prenom || ''} ${A.nom}`.trim();
  fin.notes = vide(B.notes) || B.notes === A.notes ? A.notes : vide(A.notes) ? B.notes : `${A.notes}\n\n— Notes de la fiche fusionnée « ${nomB} » —\n${B.notes}`;
  const archive = A.archive_le && B.archive_le ? A.archive_le : null;
  const liensDe = pid => all('SELECT * FROM liens WHERE patient_id=? OR proche_id=?', pid, pid);
  const nbSeances = get('SELECT COUNT(*) n FROM consultations WHERE patient_id=?', idB).n;
  snapshot('avant-fusion');
  const bundle = { patient: B, consultations: [], liens: liensDe(idB), orphelins: [] };
  versCorbeille('patient', nomB, `Fusionné dans « ${nomA} » · ${plur(nbSeances, 'séance')} déplacée${nbSeances > 1 ? 's' : ''}`, bundle, () => {
    run('UPDATE consultations SET patient_id=? WHERE patient_id=?', idA, idB);
    run('UPDATE ressources SET patient_id=? WHERE patient_id=?', idA, idB);
    for (const l of liensDe(idB)) {
      run('DELETE FROM liens WHERE id=?', l.id);
      const e = l.patient_id === idB ? idA : l.patient_id, p = l.proche_id === idB ? idA : l.proche_id;
      if (e !== p) run('INSERT OR IGNORE INTO liens (patient_id,proche_id,role) VALUES (?,?,?)', e, p, l.role);
    }
    // les « personnes présentes » qui pointaient vers la fiche absorbée pointent vers la fiche conservée
    for (const c of all(`SELECT id, patient_id, presents FROM consultations WHERE presents LIKE ? OR presents LIKE ?`, `%"p:${idB}"%`, `%"p:${idA}"%`)) {
      const pr = JSON.parse(c.presents || '[]').map(t => t === `p:${idB}` ? `p:${idA}` : t)
        .map(t => t === `p:${idA}` && c.patient_id === idA ? 'patient' : t);
      run('UPDATE consultations SET presents=? WHERE id=?', JSON.stringify([...new Set(pr)]), c.id);
    }
    run('DELETE FROM doublons_ignores WHERE a=? OR b=?', idB, idB);
    run(`UPDATE patients SET ${['civilite', 'prenom', 'nom', 'date_naissance', 'type', 'statut', 'email', 'telephone', 'contact', 'complement', 'notes'].map(k => k + '=?').join(',')}, archive_le=? WHERE id=?`,
      ...['civilite', 'prenom', 'nom', 'date_naissance', 'type', 'statut', 'email', 'telephone', 'contact', 'complement', 'notes'].map(k => fin[k]), archive, idA);
    run('DELETE FROM patients WHERE id=?', idB);
  });
  return { ok: true, patient: patientComplet(idA), seances_deplacees: nbSeances };
});

route('POST', '/api/patients', ({ body }) => {
  const b = identite({ type: 'adulte', statut: 'suivi en cours', contact: '', email: '', telephone: '', notes: '', civilite: '', prenom: '', complement: '', date_naissance: null, ...body });
  b.nom = String(b.nom_famille ?? b.nom ?? '').trim();
  if (!b.nom) throw httpErr(400, 'Nom requis');
  b.prenom = String(b.prenom || '').trim();
  const cands = verifierDoublons(b, 0, body.confirme_doublon);
  const r = run(`INSERT INTO patients (${PATIENT_F.join(',')}) VALUES (${PATIENT_F.map(() => '?').join(',')})`, ...pick(b, PATIENT_F));
  ignorerPaires(Number(r.lastInsertRowid), cands);   // « c'est une autre personne » : on ne le reproposera pas dans la liste des doublons
  return patOut(get('SELECT * FROM patients WHERE id=?', r.lastInsertRowid));
});

// Fiche patient : la relation inverse est ici, les consultations viennent d'elles-mêmes
const patientComplet = id => {
  const row = get('SELECT * FROM patients WHERE id=?', id);
  if (!row) throw httpErr(404, 'Patient introuvable');
  const p = patOut(row);
  // Une seule ligne dans « liens », lue des deux côtés : c'est la relation bidirectionnelle
  p.liens = all(`SELECT l.id AS lien_id, 'parent' AS sens, l.role, o.id AS autre_id, ${NOMC('o')} AS autre_nom, o.statut AS autre_statut, o.type AS autre_type
                   FROM liens l JOIN patients o ON o.id = l.proche_id WHERE l.patient_id = ?
                 UNION ALL
                 SELECT l.id, 'enfant', l.role, o.id, ${NOMC('o')}, o.statut, o.type
                   FROM liens l JOIN patients o ON o.id = l.patient_id WHERE l.proche_id = ?
                 ORDER BY 2, 5 COLLATE NOCASE`, p.id, p.id);
  p.consultations = all('SELECT * FROM consultations WHERE patient_id=? ORDER BY date DESC, heure DESC', p.id).map(consultOut);
  // Séances d'AUTRES patients où cette personne est notée « présente » (elle accompagnait) : sans les notes ni les montants de l'autre patient
  p.accompagnements = all(`SELECT c.id, c.date, c.heure, c.duree, c.mode, c.statut, c.patient_id AS pour_id, ${NOMC('o')} AS pour_nom
                           FROM consultations c JOIN patients o ON o.id = c.patient_id
                           WHERE c.patient_id <> ? AND c.presents LIKE ? ORDER BY c.date DESC, c.heure DESC`, p.id, `%"p:${p.id}"%`);
  p.ressources = ressourcesDuPatient(p.id);
  p.dernier_tarif = p.consultations.length ? all('SELECT tarif FROM consultations WHERE patient_id=? ORDER BY date DESC, id DESC LIMIT 1', p.id)[0].tarif : null;
  return p;
};
route('GET', '/api/patients/:id', ({ m }) => patientComplet(m[1]));

route('PUT', '/api/patients/:id', ({ m, body }) => {
  const cur = get('SELECT * FROM patients WHERE id=?', m[1]);
  if (!cur) throw httpErr(404, 'Patient introuvable');
  const merged = identite({ ...cur, ...body, nom: body.nom_famille !== undefined ? String(body.nom_famille).trim() : cur.nom }, cur);
  if (!merged.nom) throw httpErr(400, 'Nom requis');
  merged.prenom = String(merged.prenom || '').trim();
  const cle = p => [jetons(p.prenom, p.nom).join(' '), telChiffres(p.telephone), String(p.email || '').trim().toLowerCase(), p.date_naissance || ''].join('|');
  if (cle(merged) !== cle(cur)) ignorerPaires(Number(m[1]), verifierDoublons(merged, Number(m[1]), body.confirme_doublon));
  run(`UPDATE patients SET ${PATIENT_F.map(k => k + '=?').join(',')} WHERE id=?`, ...pick(merged, PATIENT_F), m[1]);
  return patOut(get('SELECT * FROM patients WHERE id=?', m[1]));
});

// Copie de sécurité avant une opération irréversible (on garde les 30 plus récentes de chaque type)
function snapshot(prefix) {
  const dir = path.join(DATA_DIR, 'sauvegardes');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  fs.readdirSync(dir).filter(f => f.startsWith(prefix + '-')).sort().slice(0, -30).forEach(f => fs.unlinkSync(path.join(dir, f)));
}

// Ce qu'une suppression emporterait : séances, et proches non suivis qui ne servent qu'à ce patient
function apercuSuppression(id) {
  const p = get(`SELECT id, ${NOMC('patients')} AS nom FROM patients WHERE id=?`, id);
  if (!p) throw httpErr(404, 'Patient introuvable');
  const n = get(`SELECT COUNT(*) AS total, COALESCE(SUM(statut='réalisée'),0) AS realisees FROM consultations WHERE patient_id=?`, id);
  const orphelins = all(`SELECT o.id, ${NOMC('o')} AS nom FROM patients o
      WHERE o.statut = 'proche'
        AND o.id IN (SELECT proche_id FROM liens WHERE patient_id = ? UNION SELECT patient_id FROM liens WHERE proche_id = ?)
        AND NOT EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM ressources x WHERE x.patient_id = o.id)
        AND (SELECT COUNT(*) FROM liens l WHERE l.patient_id = o.id OR l.proche_id = o.id) = 1`, id, id);
  return { id: p.id, nom: p.nom, nb_consultations: n.total, nb_realisees: n.realisees, nb_ressources: nbRessources('patient_id = ?', id), orphelins };
}
route('GET', '/api/patients/:id/suppression', ({ m }) => apercuSuppression(Number(m[1])));

const frDate = d => String(d).split('-').reverse().join('/');

// Met de côté les fichiers d'un élément supprimé (avant leur suppression par cascade)
const copierRessources = (corbeilleId, where, params) =>
  run(`INSERT INTO corbeille_ressources (corbeille_id, id_origine, patient_id, consultation_id, titre, url, ajoute_le)
       SELECT ?, id, patient_id, consultation_id, titre, url, ajoute_le FROM ressources WHERE ${where}`, corbeilleId, ...params);
const nbRessources = (where, ...params) => get(`SELECT COUNT(*) n FROM ressources WHERE ${where}`, ...params).n;
const plur = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

// Met un élément dans la corbeille ET le supprime, en une seule transaction (tout ou rien)
function versCorbeille(type, libelle, detail, donnees, supprimer) {
  db.exec('BEGIN');
  try {
    const r = run(`INSERT INTO corbeille (type, libelle, detail, donnees, expire_le) VALUES (?,?,?,?, datetime('now','+30 days'))`,
      type, libelle, detail, JSON.stringify(donnees));
    supprimer(Number(r.lastInsertRowid));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

route('POST', '/api/patients/:id/supprimer', ({ m, body }) => {
  const id = Number(m[1]);
  const a = apercuSuppression(id);
  const orphIds = (body.orphelins || []).map(Number).filter(x => a.orphelins.some(o => o.id === x));
  const liensDe = pid => all('SELECT * FROM liens WHERE patient_id=? OR proche_id=?', pid, pid);
  const bundle = {
    patient: get('SELECT * FROM patients WHERE id=?', id),
    consultations: all('SELECT * FROM consultations WHERE patient_id=?', id),
    versions: all('SELECT v.* FROM consultation_versions v JOIN consultations c ON c.id = v.consultation_id WHERE c.patient_id=?', id),
    liens: liensDe(id),
    orphelins: orphIds.map(o => ({ patient: get('SELECT * FROM patients WHERE id=?', o), liens: liensDe(o) })),
  };
  const detail = [a.nb_consultations ? plur(a.nb_consultations, 'séance') : 'aucune séance',
                  a.nb_ressources ? plur(a.nb_ressources, 'lien') : '',
                  orphIds.length ? `+ ${plur(orphIds.length, 'proche')}` : ''].filter(Boolean).join(' · ');
  versCorbeille('patient', a.nom, detail, bundle, cid => {
    copierRessources(cid, 'patient_id = ?', [id]);
    [id, ...orphIds].forEach(x => run('DELETE FROM patients WHERE id=?', x));
  });
  return { ok: true, supprimes: 1 + orphIds.length };
});

route('POST', '/api/patients/:id/archiver', ({ m, body }) => {
  const p = get('SELECT * FROM patients WHERE id=?', m[1]);
  if (!p) throw httpErr(404, 'Patient introuvable');
  if (p.archive_le) throw httpErr(409, 'Patient déjà archivé');
  if (body.annuler_futures)
    run(`UPDATE consultations SET statut='annulée' WHERE patient_id=? AND statut='planifiée' AND date >= date('now','localtime')`, m[1]);
  run(`UPDATE patients SET archive_le = date('now','localtime') WHERE id=?`, m[1]);
  return patOut(get('SELECT * FROM patients WHERE id=?', m[1]));
});
route('POST', '/api/patients/:id/desarchiver', ({ m }) => {
  if (!get('SELECT 1 FROM patients WHERE id=?', m[1])) throw httpErr(404, 'Patient introuvable');
  run('UPDATE patients SET archive_le = NULL WHERE id=?', m[1]);
  return patOut(get('SELECT * FROM patients WHERE id=?', m[1]));
});

route('POST', '/api/liens', ({ body }) => {
  const enfant = Number(body.patient_id), parent = Number(body.proche_id);
  if (!enfant || !parent || enfant === parent) throw httpErr(400, 'Deux personnes différentes sont nécessaires');
  if (!get('SELECT 1 FROM patients WHERE id=?', enfant) || !get('SELECT 1 FROM patients WHERE id=?', parent)) throw httpErr(404, 'Patient introuvable');
  if (get('SELECT 1 FROM liens WHERE (patient_id=? AND proche_id=?) OR (patient_id=? AND proche_id=?)', enfant, parent, parent, enfant)) throw httpErr(409, 'Ce lien existe déjà');
  const role = ['parent', 'responsable légal', 'autre proche'].includes(body.role) ? body.role : 'parent';
  const r = run('INSERT INTO liens (patient_id,proche_id,role) VALUES (?,?,?)', enfant, parent, role);
  return get('SELECT * FROM liens WHERE id=?', r.lastInsertRowid);
});
route('DELETE', '/api/liens/:id', ({ m }) => { run('DELETE FROM liens WHERE id=?', m[1]); return { ok: true }; });

route('GET', '/api/consultations', () =>
  all(`SELECT c.*, ${NOMC('p')} AS patient_nom, p.date_naissance AS patient_dn, p.complement AS patient_complement FROM consultations c JOIN patients p ON p.id=c.patient_id
       ORDER BY c.date DESC, c.heure DESC`).map(consultOut));

route('GET', '/api/consultations/:id', ({ m }) => {
  const c = get(`SELECT c.*, ${NOMC('p')} AS patient_nom, p.date_naissance AS patient_dn, p.complement AS patient_complement FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=?`, m[1]);
  if (!c) throw httpErr(404, 'Consultation introuvable');
  const out = consultOut(c);
  out.ressources = ressourcesDeLaSeance(c.id);
  return out;
});

// Séances déjà prévues le même jour : même patient (doublon probable) ou autre patient à un horaire qui se chevauche. Les séances annulées sont ignorées.
function conflitsSeance(b, ignorerId = 0) {
  const minutes = h => /^\d{1,2}:\d{2}$/.test(h || '') ? Number(h.split(':')[0]) * 60 + Number(h.split(':')[1]) : null;
  const debut = minutes(b.heure), fin = debut === null ? null : debut + (Number(b.duree) || 50);
  const out = [];
  for (const c of all(`SELECT c.id, c.patient_id, c.heure, c.duree, c.statut, ${NOMC('p')} AS patient_nom FROM consultations c JOIN patients p ON p.id=c.patient_id
                       WHERE c.date=? AND c.statut<>'annulée' AND c.id<>?`, b.date, ignorerId)) {
    const d2 = minutes(c.heure), f2 = d2 === null ? null : d2 + (Number(c.duree) || 50);
    const meme = Number(c.patient_id) === Number(b.patient_id);
    const chevauche = debut !== null && d2 !== null && debut < f2 && d2 < fin;
    if (meme && (chevauche || debut === null || d2 === null)) out.push({ id: c.id, patient_nom: c.patient_nom, heure: c.heure, type: 'meme' });
    else if (!meme && chevauche) out.push({ id: c.id, patient_nom: c.patient_nom, heure: c.heure, type: 'chevauche' });
  }
  return out;
}

route('POST', '/api/consultations', ({ body }) => {
  const b = consultIn({ heure: '', duree: 50, mode: 'cabinet', statut: 'planifiée', paye: 0, presents: '[]', facture_a: '', contenu: '', mode_paiement: '', ...body });
  const err = validateConsult(b); if (err) throw httpErr(400, err);
  if (get('SELECT archive_le FROM patients WHERE id=?', b.patient_id).archive_le) throw httpErr(409, 'Patient archivé : désarchivez-le avant de créer une séance');
  if (b.tarif === undefined || b.tarif === null || b.tarif === '') b.tarif = tarifSuggere(b.patient_id);
  if (!(Number(b.tarif) >= 0)) throw httpErr(400, 'Tarif invalide');
  const conflits = conflitsSeance(b);
  if (conflits.length && !body.confirme_doublon) throw Object.assign(httpErr(409, 'Conflit d’horaire'), { extra: { conflits } });
  const r = run(`INSERT INTO consultations (${CONSULT_F.join(',')}) VALUES (${CONSULT_F.map(() => '?').join(',')})`, ...pick(b, CONSULT_F));
  return consultOut(get('SELECT * FROM consultations WHERE id=?', r.lastInsertRowid));
});

route('PUT', '/api/consultations/:id', ({ m, body }) => {
  const cur = get('SELECT * FROM consultations WHERE id=?', m[1]);
  if (!cur) throw httpErr(404, 'Consultation introuvable');
  const b = { ...cur, ...consultIn(body) };
  const err = validateConsult(b); if (err) throw httpErr(400, err);
  if (typeof b.contenu === 'string' && b.contenu !== cur.contenu) garderVersion(cur, b.contenu);
  run(`UPDATE consultations SET ${CONSULT_F.map(k => k + '=?').join(',')} WHERE id=?`, ...pick(b, CONSULT_F), m[1]);
  return consultOut(get('SELECT * FROM consultations WHERE id=?', m[1]));
});

// ---- Historique des notes ----
// Une version est gardée au plus toutes les VERSION_DELAI_MIN minutes de saisie (sinon l'historique se remplirait de versions quasi identiques),
// et TOUJOURS quand plus de la moitié d'un texte substantiel disparaît d'un coup (fausse manipulation).
const VERSION_DELAI_MIN = Number(process.env.VERSION_DELAI_MIN ?? 10);
function garderVersion(cur, nouveau, origine = 'modification', forcer = false) {
  const ancienTxt = texteDe(cur.contenu);
  if (!ancienTxt) return;                                                        // rien à conserver
  if (!forcer && all('SELECT contenu FROM modeles').some(t => texteDe(t.contenu) === ancienTxt)) return;   // simple modèle non rempli
  const der = get('SELECT contenu, enregistre_le FROM consultation_versions WHERE consultation_id=? ORDER BY id DESC LIMIT 1', cur.id);
  if (der && der.contenu === cur.contenu) return;                                // déjà conservée
  const trop = der && (Date.now() - Date.parse(der.enregistre_le.replace(' ', 'T') + 'Z')) < VERSION_DELAI_MIN * 60000;
  const grosseSuppression = ancienTxt.length >= 200 && texteDe(nouveau).length < ancienTxt.length / 2;
  if (forcer || !trop || grosseSuppression)
    run('INSERT INTO consultation_versions (consultation_id, contenu, origine) VALUES (?,?,?)', cur.id, cur.contenu, origine);
}
const iso = d => String(d).replace(' ', 'T') + 'Z';
route('GET', '/api/consultations/:id/versions', ({ m }) => {
  if (!get('SELECT 1 FROM consultations WHERE id=?', m[1])) throw httpErr(404, 'Consultation introuvable');
  return all('SELECT id, enregistre_le, origine, contenu FROM consultation_versions WHERE consultation_id=? ORDER BY id DESC', m[1])
    .map(v => { const t = texteDe(v.contenu); return { id: v.id, enregistre_le: iso(v.enregistre_le), origine: v.origine, taille: t.length, apercu: t.slice(0, 120) }; });
});
route('GET', '/api/consultations/:id/versions/:id', ({ m }) => {
  const v = get('SELECT * FROM consultation_versions WHERE id=? AND consultation_id=?', m[2], m[1]);
  if (!v) throw httpErr(404, 'Version introuvable');
  return { ...v, enregistre_le: iso(v.enregistre_le) };
});
route('POST', '/api/consultations/:id/versions/:id/restaurer', ({ m }) => {
  const cur = get('SELECT * FROM consultations WHERE id=?', m[1]);
  const v = get('SELECT * FROM consultation_versions WHERE id=? AND consultation_id=?', m[2], m[1]);
  if (!cur || !v) throw httpErr(404, 'Version introuvable');
  db.exec('BEGIN');
  try {
    garderVersion(cur, v.contenu, 'avant-restauration', true);                   // le texte actuel est mis de côté : on peut revenir en arrière
    run('UPDATE consultations SET contenu=? WHERE id=?', v.contenu, m[1]);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return consultOut(get('SELECT * FROM consultations WHERE id=?', m[1]));
});
route('DELETE', '/api/consultations/:id', ({ m }) => {
  const c = get(`SELECT c.*, ${NOMC('p')} AS patient_nom, p.date_naissance AS patient_dn, p.complement AS patient_complement FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=?`, m[1]);
  if (!c) throw httpErr(404, 'Consultation introuvable');
  const { patient_nom, ...row } = c;
  const nd = nbRessources('consultation_id = ?', m[1]);
  const versions = all('SELECT * FROM consultation_versions WHERE consultation_id=?', m[1]);
  versCorbeille('consultation', `Séance du ${frDate(c.date)} · ${patient_nom}`, c.statut + (nd ? ` · ${plur(nd, 'lien')}` : ''), { consultation: row, versions }, cid => {
    copierRessources(cid, 'consultation_id = ?', [m[1]]);
    run('DELETE FROM consultations WHERE id=?', m[1]);
  });
  return { ok: true };
});

route('GET', '/api/modeles', () => all('SELECT * FROM modeles ORDER BY nom COLLATE NOCASE'));
route('POST', '/api/modeles', ({ body }) => {
  if (!body.nom) throw httpErr(400, 'Nom requis');
  const r = run('INSERT INTO modeles (nom,contenu) VALUES (?,?)', body.nom, body.contenu || '');
  return get('SELECT * FROM modeles WHERE id=?', r.lastInsertRowid);
});
route('PUT', '/api/modeles/:id', ({ m, body }) => {
  const cur = get('SELECT * FROM modeles WHERE id=?', m[1]);
  if (!cur) throw httpErr(404, 'Modèle introuvable');
  const b = { ...cur, ...body };
  run('UPDATE modeles SET nom=?, contenu=? WHERE id=?', b.nom, b.contenu, m[1]);
  return get('SELECT * FROM modeles WHERE id=?', m[1]);
});
route('DELETE', '/api/modeles/:id', ({ m }) => {
  const t = get('SELECT * FROM modeles WHERE id=?', m[1]);
  if (!t) throw httpErr(404, 'Modèle introuvable');
  versCorbeille('modele', t.nom, 'modèle de séance', { modele: t }, () => run('DELETE FROM modeles WHERE id=?', m[1]));
  return { ok: true };
});

// ---------- Ressources (liens) ----------
const RES_META = 'r.id, r.patient_id, r.consultation_id, r.titre, r.url, r.ajoute_le';
const ressourcesDuPatient = pid => all(`SELECT ${RES_META}, c.date AS seance_date FROM ressources r LEFT JOIN consultations c ON c.id = r.consultation_id
                                        WHERE r.patient_id = ? ORDER BY r.ajoute_le DESC, r.id DESC`, pid);
const ressourcesDeLaSeance = cid => all(`SELECT ${RES_META} FROM ressources r WHERE r.consultation_id = ? ORDER BY r.ajoute_le DESC, r.id DESC`, cid);

// Deux sortes de liens : les liens web (http / https) et les liens LOCAUX (fichier ou dossier de cet ordinateur ou du réseau :
// C:\Dossier\fichier.pdf, \\serveur\partage\doc.docx, /Users/…/doc.pdf, file:///…). Jamais de « javascript: » ni d'autre protocole.
const estLocal = u => /^[a-z]:[\\/]/i.test(u) || /^\\\\/.test(u) || /^\/(?!\/)/.test(u) || /^~[\\/]/.test(u) || /^file:\/\//i.test(u);
function lienValide(brut) {
  let u = String(brut || '').trim().replace(/^"(.*)"$/, '$1');                 // « Copier comme chemin » (Windows) ajoute des guillemets
  if (!u) throw httpErr(400, 'Indiquez l’adresse du lien');
  if (u.length > 2000) throw httpErr(400, 'Adresse trop longue');
  if (estLocal(u)) { if (/[\u0000-\u001f]/.test(u)) throw httpErr(400, 'Chemin invalide'); return u; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  let p; try { p = new URL(u); } catch { throw httpErr(400, 'Adresse de lien invalide'); }
  if (!['http:', 'https:'].includes(p.protocol) || !p.hostname.includes('.')) throw httpErr(400, 'Indiquez un lien web (http / https) ou le chemin d’un fichier ou dossier de cet ordinateur');
  return p.href;
}
const nomLocal = u => { const t = u.replace(/^file:\/\/\/?/i, '').replace(/[\\/]+$/, ''); return decodeURIComponent(t.split(/[\\/]/).pop() || t); };
const titreLien = (t, url) => String(t || '').trim().slice(0, 200) || (estLocal(url) ? nomLocal(url) : new URL(url).hostname.replace(/^www\./, ''));
// Chemin réel sur le disque pour un lien local
function cheminLocal(u) {
  if (/^file:\/\//i.test(u)) { try { return require('node:url').fileURLToPath(u); } catch { return null; } }
  if (/^~[\\/]/.test(u)) return path.join(require('node:os').homedir(), u.slice(2));
  return u;
}
// Ouvre un lien LOCAL déjà enregistré (jamais un chemin envoyé par la page) avec le programme par défaut de l'ordinateur
route('POST', '/api/ressources/:id/ouvrir', async ({ m }) => {
  const r = get('SELECT url FROM ressources WHERE id=?', m[1]);
  if (!r) throw httpErr(404, 'Lien introuvable');
  if (!estLocal(r.url)) throw httpErr(400, 'Ce lien est un lien web');
  const chemin = cheminLocal(r.url);
  if (!chemin || !fs.existsSync(chemin)) throw httpErr(404, 'Fichier ou dossier introuvable : le disque ou le volume chiffré est-il bien monté ?');
  let erreur = '';
  if (process.versions.electron) erreur = await require('electron').shell.openPath(chemin);
  else await new Promise(ok => require('node:child_process').execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [chemin], { windowsHide: true }, () => ok()));
  if (erreur) throw httpErr(500, 'Impossible d’ouvrir : ' + erreur);
  return { ok: true };
});

function ajouterRessource(pid, cid, body) {
  if (!get('SELECT 1 FROM patients WHERE id=?', pid)) throw httpErr(404, 'Patient introuvable');
  const url = lienValide(body.url);
  const r = run('INSERT INTO ressources (patient_id, consultation_id, titre, url) VALUES (?,?,?,?)', pid, cid, titreLien(body.titre, url), url);
  return get(`SELECT ${RES_META} FROM ressources r WHERE r.id=?`, r.lastInsertRowid);
}
route('GET', '/api/patients/:id/ressources', ({ m }) => ressourcesDuPatient(m[1]));
route('GET', '/api/consultations/:id/ressources', ({ m }) => ressourcesDeLaSeance(m[1]));
route('POST', '/api/patients/:id/ressources', ({ m, body }) => ajouterRessource(Number(m[1]), null, body));
route('POST', '/api/consultations/:id/ressources', ({ m, body }) => {
  const c = get('SELECT patient_id FROM consultations WHERE id=?', m[1]);
  if (!c) throw httpErr(404, 'Consultation introuvable');
  return ajouterRessource(c.patient_id, Number(m[1]), body);
});
route('PUT', '/api/ressources/:id', ({ m, body }) => {
  if (!get('SELECT 1 FROM ressources WHERE id=?', m[1])) throw httpErr(404, 'Lien introuvable');
  const url = lienValide(body.url);
  run('UPDATE ressources SET titre=?, url=? WHERE id=?', titreLien(body.titre, url), url, m[1]);
  return get(`SELECT ${RES_META} FROM ressources r WHERE r.id=?`, m[1]);
});
route('DELETE', '/api/ressources/:id', ({ m }) => {
  const d = get(`SELECT ${RES_META}, ${NOMC('p')} AS patient_nom FROM ressources r JOIN patients p ON p.id = r.patient_id WHERE r.id=?`, m[1]);
  if (!d) throw httpErr(404, 'Lien introuvable');
  const { patient_nom, ...meta } = d;
  versCorbeille('ressource', d.titre, `Lien · ${patient_nom}`, { ressource: meta }, cid => {
    copierRessources(cid, 'id = ?', [m[1]]);
    run('DELETE FROM ressources WHERE id=?', m[1]);
  });
  return { ok: true };
});

// ---------- Recherche globale ----------
const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();   // sans accents ni majuscules
const texteDe = html => String(html || '').replace(/<\/(p|h\d|li|div)>|<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
function extrait(texte, mots) {
  const n = norm(texte); let i = -1;
  for (const w of mots) { i = n.indexOf(w); if (i >= 0) break; }
  if (i < 0) return '';
  const d = Math.max(0, i - 40), f = Math.min(texte.length, i + 90);
  return (d > 0 ? '… ' : '') + texte.slice(d, f) + (f < texte.length ? ' …' : '');
}
const rechercher = q => {
  const mots = norm(q).split(/\s+/).filter(Boolean);
  const res = { patients: [], consultations: [], ressources: [], modeles: [] };
  if (!mots.length || mots.join('').length < 2) return res;
  const tout = (...champs) => { const n = norm(champs.join(' ')); return mots.every(w => n.includes(w)); };
  const MAX = 8;
  for (const p of all(`SELECT p.*, ${NOMC('p')} AS nomc FROM patients p ORDER BY (p.archive_le IS NOT NULL), p.nom COLLATE NOCASE`)) {
    if (res.patients.length >= MAX) break;
    if (!tout(p.prenom, p.nom, p.email, p.telephone.replace(/[\s.-]/g, ''), p.telephone, p.contact, p.notes)) continue;
    res.patients.push({ id: p.id, titre: p.nomc, sous: [p.archive_le ? 'archivé' : p.statut === 'proche' ? 'proche' : '', ageInfo(p.date_naissance).age_texte, p.complement, p.telephone, p.email].filter(Boolean).join(' · ') });
  }
  for (const c of all(`SELECT c.id, c.date, c.heure, c.contenu, ${NOMC('p')} AS patient FROM consultations c JOIN patients p ON p.id = c.patient_id ORDER BY c.date DESC, c.heure DESC`)) {
    if (res.consultations.length >= MAX) break;
    const txt = texteDe(c.contenu);
    if (!tout(c.patient, c.date, frDate(c.date), txt)) continue;
    res.consultations.push({ id: c.id, titre: `Séance du ${frDate(c.date)} · ${c.patient}`, sous: extrait(txt, mots) });
  }
  for (const d of all(`SELECT r.id, r.patient_id, r.consultation_id, r.titre, r.url, ${NOMC('p')} AS patient FROM ressources r JOIN patients p ON p.id = r.patient_id ORDER BY r.ajoute_le DESC`)) {
    if (res.ressources.length >= MAX) break;
    if (!tout(d.titre, d.url, d.patient)) continue;
    res.ressources.push({ id: d.id, titre: d.titre, sous: `${d.patient} · ${d.url}`, cible: d.consultation_id ? '#/consultation/' + d.consultation_id : '#/patient/' + d.patient_id });
  }
  for (const m of all('SELECT id, nom, contenu FROM modeles ORDER BY nom COLLATE NOCASE')) {
    if (res.modeles.length >= MAX) break;
    const txt = texteDe(m.contenu);
    if (!tout(m.nom, txt)) continue;
    res.modeles.push({ id: m.id, titre: m.nom, sous: norm(m.nom).includes(mots[0]) ? '' : extrait(txt, mots) });
  }
  return res;
};
route('GET', '/api/recherche', ({ url }) => rechercher(url.searchParams.get('q')));

// ---------- Exports (CSV, Word, PDF) ----------
const FORMATS = ['csv', 'docx', 'pdf', 'md'];
const STATUTS_SEANCE = ['planifiée', 'réalisée', 'absence', 'annulée'];
const slug = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
const aujourdhui = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fichier = (buf, type, nom, inline) => ({ __raw: buf, type, headers: { 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${nom}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
  ...(inline ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'" } : {}) } });

// Options d'export, lues dans l'adresse : ?format=pdf&du=2026-01-01&au=2026-06-30&statuts=réalisée,absence&inclure=infos,notes
// Sans « inclure », tout est inclus ; avec « inclure= » (vide), rien d'optionnel.
function optionsExport(url) {
  const q = url.searchParams, date = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
  const liste = (k, tous) => q.has(k) ? q.get(k).split(',').filter(x => tous.includes(x)) : tous;
  return { format: q.get('format'), du: date(q.get('du')), au: date(q.get('au')), statuts: liste('statuts', STATUTS_SEANCE),
    inclure: new Set(liste('inclure', ['infos', 'liens', 'ressources', 'notes', 'finances'])) };
}
const filtreSeances = (liste, o) => liste.filter(c => o.statuts.includes(c.statut) && (!o.du || c.date >= o.du) && (!o.au || c.date <= o.au));
const periodeTxt = o => o.du || o.au ? `${o.du ? 'du ' + frDate(o.du) : ''}${o.du && o.au ? ' ' : ''}${o.au ? 'au ' + frDate(o.au) : ''}` : '';
const filtreTxt = o => [periodeTxt(o), o.statuts.length < STATUTS_SEANCE.length ? 'séances ' + o.statuts.join(', ') : ''].filter(Boolean).join(' · ');

const sortie = (format, nom, entetes, lignes, titre, blocs) => {
  if (!FORMATS.includes(format)) throw httpErr(400, 'Format inconnu (csv, docx, md ou pdf)');
  if (format === 'csv') return fichier(X.csv(entetes, lignes), 'text/csv; charset=utf-8', nom + '.csv');
  if (format === 'md') return fichier(X.markdown(titre, blocs), 'text/markdown; charset=utf-8', nom + '.md');
  if (format === 'docx') return fichier(X.docx(titre, blocs), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', nom + '.docx');
  return fichier(Buffer.from(X.pageHtml(titre, blocs)), 'text/html; charset=utf-8', nom + '.html', true);
};
const oui = b => b ? 'Oui' : 'Non';

// Colonnes : [clé d'option | null (toujours), en-tête]. Les colonnes dont l'option est décochée disparaissent du CSV.
const COL_PATIENT = [[null, 'Patient n°'], ['infos', 'Civilité'], [null, 'Nom'], [null, 'Prénom'], ['infos', 'Date de naissance'], ['infos', 'Âge'], ['infos', 'Type'], ['infos', 'Statut'], ['infos', 'Archivé le'],
  ['infos', 'Téléphone'], ['infos', 'E-mail'], ['infos', 'Autres coordonnées'], ['infos', 'Notes pratiques'], ['liens', 'Parents / responsables'], ['liens', 'Enfants / ados']];
const COL_SEANCE = [[null, 'Séance n°'], [null, 'Date'], [null, 'Heure'], [null, 'Durée (min)'], [null, 'Mode'], [null, 'Statut de la séance'], ['finances', 'Tarif (€)'], ['finances', 'Payée'], ['finances', 'Mode de paiement'], ['finances', 'Facturé à'],
  [null, 'Personnes présentes'], ['notes', 'Contenu de la séance']];
const gardees = (cols, o) => cols.map(([k]) => !k || o.inclure.has(k));
const garder = (vals, garde) => vals.filter((_, i) => garde[i]);
const enTetes = (cols, o) => garder(cols.map(c => c[1]), gardees(cols, o));
const valsSeance = c => [c.id, c.date, c.heure, c.duree, c.mode, c.statut, c.tarif, oui(c.paye), c.mode_paiement || '', c.facture_a || '', presentsTxt(c), X.texteBrut(c.contenu)];
const valsIdentite = p => [p.id, p.civilite === 'M' ? 'M.' : p.civilite, p.nom_famille, p.prenom, p.date_naissance || '', p.age_texte || '', p.type, p.statut, p.archive_le || '', p.telephone, p.email, p.contact, p.notes,
  (p.liens || []).filter(l => l.sens === 'parent').map(l => `${l.autre_nom} (${l.role})`).join(', '), (p.liens || []).filter(l => l.sens === 'enfant').map(l => `${l.autre_nom} (${l.role})`).join(', ')];
const resumeSeance = (c, o) => [c.mode, c.duree ? c.duree + ' min' : '', c.statut,
  ...(o.inclure.has('finances') ? [c.tarif ? `${c.tarif} €` : '', c.paye ? 'payée' + (c.mode_paiement ? ' (' + c.mode_paiement + ')' : '') : (c.statut === 'réalisée' ? 'à régler' : '')] : []),
  presentsTxt(c) ? 'présents : ' + presentsTxt(c) : '', o.inclure.has('finances') && c.facture_a ? 'facturé à ' + c.facture_a : ''].filter(Boolean).join(' · ');
const blocSeance = (c, titre, o) => [{ k: 'h3', t: titre }, { k: 'meta', t: resumeSeance(c, o) },
  ...(!o.inclure.has('notes') ? [] : X.texteBrut(c.contenu) ? [{ k: 'rich', html: c.contenu }] : [{ k: 'p', t: 'Aucune note.' }])];

// Contenu du dossier d'un patient (réutilisé par l'export d'un patient et par l'export complet)
function dossierPatient(p, o) {
  const seances = filtreSeances([...p.consultations], o).sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure));
  const gP = gardees(COL_PATIENT, o), gS = gardees(COL_SEANCE, o);
  const entetes = [...enTetes(COL_PATIENT, o), ...enTetes(COL_SEANCE, o)];
  const ident = garder(valsIdentite(p), gP);
  const lignes = seances.length ? seances.map(c => [...ident, ...garder(valsSeance(c), gS)]) : [[...ident, ...garder(COL_SEANCE.map(() => ''), gS)]];
  const blocs = [{ k: 'h1', t: p.nom }, { k: 'meta', t: `Dossier exporté le ${frDate(aujourdhui())}${filtreTxt(o) ? ' · ' + filtreTxt(o) : ''}` }];
  if (o.inclure.has('infos')) blocs.push({ k: 'h2', t: 'Informations' }, { k: 'kv', rows: [['Civilité', p.civilite === 'M' ? 'M.' : p.civilite === 'Mme' ? 'Mme' : ''], ['Date de naissance', p.date_naissance ? `${frDate(p.date_naissance)} (${p.age_texte})` : ''], ['Type', p.type],
    ['Statut', p.archive_le ? `archivé depuis le ${frDate(p.archive_le.slice(0, 10))}` : p.statut], ['Précision', p.complement], ['Téléphone', p.telephone], ['E-mail', p.email], ['Autres coordonnées', p.contact], ['Notes pratiques', p.notes]].filter(r => r[1]) });
  if (o.inclure.has('liens') && p.liens.length) blocs.push({ k: 'h2', t: 'Liens familiaux' }, { k: 'list', items: p.liens.map(l => l.sens === 'parent' ? `${l.role} : ${l.autre_nom}` : `Enfant / ado : ${l.autre_nom} (${l.role})`) });
  if (o.inclure.has('ressources') && p.ressources.length) blocs.push({ k: 'h2', t: 'Ressources (liens)' }, { k: 'list', items: p.ressources.map(d => `${d.titre} — ${d.url}` + (d.consultation_id ? ` (séance du ${frDate(d.seance_date)})` : '')) });
  if (o.inclure.has('liens') && p.accompagnements && p.accompagnements.length) {
    const acc = filtreSeances(p.accompagnements, o);
    if (acc.length) blocs.push({ k: 'h2', t: 'Séances en tant qu’accompagnant' }, { k: 'list', items: acc.map(c => `${frDate(c.date)} à ${c.heure} : accompagnait ${c.pour_nom} (${c.statut})`) });
  }
  blocs.push({ k: 'h2', t: `Séances (${seances.length})` });
  if (!seances.length) blocs.push({ k: 'p', t: 'Aucune séance pour ces critères.' });
  for (const c of seances) blocs.push(...blocSeance(c, `Séance du ${frDate(c.date)} à ${c.heure}`, o));
  return { entetes, lignes, blocs };
}
route('GET', '/api/patients/:id/export', ({ m, url }) => {
  const o = optionsExport(url), p = patientComplet(m[1]);
  const d = dossierPatient(p, o);
  return sortie(o.format, `Dossier-${slug(p.nom)}-${aujourdhui()}`, d.entetes, d.lignes, `Dossier ${p.nom}`, d.blocs);
});

route('GET', '/api/consultations/:id/export', ({ m, url }) => {
  const o = optionsExport(url);
  const c = get(`SELECT c.*, ${NOMC('p')} AS patient_nom, p.date_naissance AS patient_dn, p.complement AS patient_complement FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=?`, m[1]);
  if (!c) throw httpErr(404, 'Consultation introuvable');
  const cc = consultOut(c), liens = ressourcesDeLaSeance(cc.id), fin = o.inclure.has('finances');
  const blocs = [{ k: 'h1', t: `Séance du ${frDate(cc.date)}` }, { k: 'meta', t: `${c.patient_nom} · exportée le ${frDate(aujourdhui())}` },
    { k: 'kv', rows: [['Patient', c.patient_nom], ['Date', `${frDate(cc.date)} à ${cc.heure}`], ['Durée', cc.duree ? cc.duree + ' min' : ''], ['Mode', cc.mode], ['Statut', cc.statut],
      ...(fin ? [['Tarif', cc.tarif ? cc.tarif + ' €' : ''], ['Règlement', cc.paye ? 'payée' + (cc.mode_paiement ? ' (' + cc.mode_paiement + ')' : '') : 'non payée'], ['Facturé à', cc.facture_a]] : []),
      ['Personnes présentes', presentsTxt(cc)]].filter(r => r[1]) }];
  if (o.inclure.has('ressources') && liens.length) blocs.push({ k: 'h2', t: 'Ressources (liens)' }, { k: 'list', items: liens.map(d => `${d.titre} — ${d.url}`) });
  if (o.inclure.has('notes')) blocs.push({ k: 'h2', t: 'Notes de séance' }, X.texteBrut(cc.contenu) ? { k: 'rich', html: cc.contenu } : { k: 'p', t: 'Aucune note.' });
  const cols = [[null, 'Patient'], ...COL_SEANCE], g = gardees(cols, o);
  return sortie(o.format, `Seance-${slug(c.patient_nom)}-${cc.date}`, garder(cols.map(x => x[1]), g), [garder([c.patient_nom, ...valsSeance(cc)], g)], `Séance du ${frDate(cc.date)} – ${c.patient_nom}`, blocs);
});

// Tableaux complets (comptabilité, archivage) : tous les patients / toutes les séances, avec les mêmes options
route('GET', '/api/export/patients.csv', ({ url }) => {
  const o = optionsExport(url), gP = gardees(COL_PATIENT, o), fin = o.inclure.has('finances');
  const lignes = all('SELECT id FROM patients ORDER BY (archive_le IS NOT NULL), nom COLLATE NOCASE, prenom COLLATE NOCASE').map(({ id }) => {
    const p = patientComplet(id), r = filtreSeances(p.consultations, { ...o, statuts: ['réalisée'] });
    return [...garder(valsIdentite(p), gP), r.length, r[0] ? r[0].date : '', ...(fin ? [r.filter(c => !c.paye).reduce((t, c) => t + (c.tarif || 0), 0)] : [])];
  });
  return fichier(X.csv([...enTetes(COL_PATIENT, o), 'Séances réalisées', 'Dernière séance', ...(fin ? ['Reste à régler (€)'] : [])], lignes), 'text/csv; charset=utf-8', `Patients-${aujourdhui()}.csv`);
});
route('GET', '/api/export/consultations.csv', ({ url }) => {
  const o = optionsExport(url), g = gardees([[null, 'Patient'], ...COL_SEANCE], o);
  const lignes = filtreSeances(all(`SELECT c.*, ${NOMC('p')} AS patient_nom, p.date_naissance AS patient_dn, p.complement AS patient_complement FROM consultations c JOIN patients p ON p.id=c.patient_id ORDER BY c.date, c.heure`).map(c => ({ ...consultOut(c), patient_nom: c.patient_nom })), o)
    .map(c => garder([c.patient_nom, ...valsSeance(c)], g));
  return fichier(X.csv(garder(['Patient', ...COL_SEANCE.map(c => c[1])], g), lignes), 'text/csv; charset=utf-8', `Seances-${aujourdhui()}.csv`);
});

// ---------- Corbeille ----------
const purgerCorbeille = () => run(`DELETE FROM corbeille WHERE expire_le <= datetime('now')`);

route('GET', '/api/corbeille', () => {
  purgerCorbeille();
  return all('SELECT id, type, libelle, detail, supprime_le, expire_le FROM corbeille ORDER BY supprime_le DESC, id DESC').map(r => ({
    ...r, jours_restants: Math.max(0, Math.ceil((new Date(r.expire_le.replace(' ', 'T') + 'Z') - Date.now()) / 864e5)),
  }));
});

function restaurer(item) {
  const d = JSON.parse(item.donnees);
  const colonnes = t => all(`PRAGMA table_info(${t})`).map(c => c.name);
  const inserer = (t, row, ignore = false) => {
    const ok = colonnes(t), ks = Object.keys(row).filter(k => ok.includes(k));
    run(`INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${t} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ...ks.map(k => row[k]));
  };
  const existe = id => !!get('SELECT 1 FROM patients WHERE id=?', id);
  // un lien n'est recréé que si les deux personnes existent à nouveau
  const relier = liens => liens.forEach(l => { if (existe(l.patient_id) && existe(l.proche_id)) inserer('liens', l, true); });
  // Les fichiers ne reviennent que si leur patient (et leur séance) existent à nouveau
  const restaurerRessources = () => run(`INSERT INTO ressources (id, patient_id, consultation_id, titre, url, ajoute_le)
      SELECT id_origine, patient_id, consultation_id, titre, url, ajoute_le FROM corbeille_ressources cr
      WHERE corbeille_id = ?
        AND EXISTS (SELECT 1 FROM patients p WHERE p.id = cr.patient_id)
        AND (cr.consultation_id IS NULL OR EXISTS (SELECT 1 FROM consultations c WHERE c.id = cr.consultation_id))`, item.id);
  let cible;
  if (item.type === 'patient') {
    if (existe(d.patient.id)) throw httpErr(409, 'Ce patient existe déjà');
    inserer('patients', d.patient);
    d.consultations.forEach(c => inserer('consultations', c));
    (d.versions || []).forEach(v => inserer('consultation_versions', v, true));
    d.orphelins.forEach(o => { if (!existe(o.patient.id)) inserer('patients', o.patient); });
    relier(d.liens); d.orphelins.forEach(o => relier(o.liens));
    restaurerRessources();
    cible = '#/patient/' + d.patient.id;
  } else if (item.type === 'consultation') {
    if (!existe(d.consultation.patient_id)) throw httpErr(409, 'Le patient de cette séance n’existe plus : restaurez d’abord le patient depuis la corbeille.');
    inserer('consultations', d.consultation);
    (d.versions || []).forEach(v => inserer('consultation_versions', v, true));
    restaurerRessources();
    cible = '#/consultation/' + d.consultation.id;
  } else if (item.type === 'ressource') {
    if (!existe(d.ressource.patient_id)) throw httpErr(409, 'Le patient de ce lien n’existe plus : restaurez d’abord le patient depuis la corbeille.');
    if (d.ressource.consultation_id && !get('SELECT 1 FROM consultations WHERE id=?', d.ressource.consultation_id))
      throw httpErr(409, 'La séance de ce lien n’existe plus (ou est dans la corbeille) : restaurez d’abord la séance.');
    restaurerRessources();
    cible = d.ressource.consultation_id ? '#/consultation/' + d.ressource.consultation_id : '#/patient/' + d.ressource.patient_id;
  } else {
    inserer('modeles', d.modele);
    cible = '#/modeles/' + d.modele.id;
  }
  run('DELETE FROM corbeille WHERE id=?', item.id);
  return cible;
}
route('POST', '/api/corbeille/:id/restaurer', ({ m }) => {
  const item = get('SELECT * FROM corbeille WHERE id=?', m[1]);
  if (!item) throw httpErr(404, 'Élément introuvable (déjà restauré ou expiré)');
  db.exec('BEGIN');
  try { const cible = restaurer(item); db.exec('COMMIT'); return { ok: true, libelle: item.libelle, type: item.type, cible }; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
});
// Effacement définitif (irréversible) : copie de sécurité juste avant
route('DELETE', '/api/corbeille/:id', ({ m }) => {
  if (!get('SELECT 1 FROM corbeille WHERE id=?', m[1])) throw httpErr(404, 'Élément introuvable');
  snapshot('avant-effacement-definitif');
  run('DELETE FROM corbeille WHERE id=?', m[1]);
  return { ok: true };
});
route('POST', '/api/corbeille/vider', () => {
  const n = get('SELECT COUNT(*) n FROM corbeille').n;
  if (n) { snapshot('avant-effacement-definitif'); run('DELETE FROM corbeille'); }
  return { ok: true, supprimes: n };
});

// Sauvegarde : copie cohérente du fichier de base
route('GET', '/api/sauvegarde', () => {
  const out = path.join(DATA_DIR, `.sauvegarde-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(out); fs.unlinkSync(out);
  return { __raw: buf, type: 'application/octet-stream',
    headers: { 'Content-Disposition': `attachment; filename="cabinet-${new Date().toISOString().slice(0, 10)}.db"` } };
});

// Copie complète des données vers un autre dossier (appelée par l'enveloppe Electron, base ouverte) : instantané cohérent + dossier sauvegardes, puis vérification
global.gestionPsyCopier = vers => {
  fs.mkdirSync(vers, { recursive: true });
  const cible = path.join(vers, 'cabinet.db');
  if (fs.existsSync(cible)) throw new Error('Le dossier de destination contient déjà une base.');
  db.exec(`VACUUM INTO '${cible.replace(/'/g, "''")}'`);
  const src = path.join(DATA_DIR, 'sauvegardes');
  if (fs.existsSync(src)) fs.cpSync(src, path.join(vers, 'sauvegardes'), { recursive: true });
  const copie = new DatabaseSync(cible);
  try {
    const n = t => copie.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, m = t => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    for (const t of ['patients', 'consultations']) if (n(t) !== m(t)) throw new Error(`Vérification échouée (${t}).`);
    return { patients: n('patients'), consultations: n('consultations') };
  } finally { copie.close(); }
};

function httpErr(status, message) { return Object.assign(new Error(message), { status }); }


// ---------- Réglages, mot de passe, export complet, documentation des données ----------
const reglage = (k, d = '') => { const r = get('SELECT valeur FROM reglages WHERE cle=?', k); return r ? r.valeur : d; };
const setReglage = (k, v) => run('INSERT INTO reglages (cle, valeur) VALUES (?,?) ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur', k, String(v));
const delReglage = k => run('DELETE FROM reglages WHERE cle=?', k);
const NOM_DEFAUT = 'Gestion Psy';
const nomCabinet = () => reglage('nom_cabinet') || NOM_DEFAUT;

// Mot de passe facultatif (un seul utilisateur). Il verrouille l'ACCÈS à l'appli ; il ne chiffre pas le fichier de données (pour cela : chiffrement du disque).
// Le mot de passe et la clé de secours ne sont jamais stockés en clair (scrypt + sel).
const sessions = new Map();                       // jeton -> dernière activité (ms) ; en mémoire : tout est reverrouillé au redémarrage de l'appli
const COOKIE = `gp_${PORT}`;
const AUTH_LIBRES = ['/api/version', '/api/auth/etat', '/api/auth/connexion', '/api/auth/secours', '/api/auth/verrouiller'];
const protege = () => !!reglage('mdp');
const delaiMin = () => Number(reglage('verrou_min', '15')) || 0;              // 0 = pas de verrouillage automatique
const jetonDe = req => { const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(COOKIE + '=')); return c ? c.slice(COOKIE.length + 1) : ''; };
function sessionValide(req, toucher = true) {
  if (!protege()) return true;
  const j = jetonDe(req), t = sessions.get(j);
  if (!t) return false;
  const d = delaiMin();
  if (d && Date.now() - t > d * 60000) { sessions.delete(j); return false; }
  if (toucher) sessions.set(j, Date.now());
  return true;
}
const hacher = (s, sel = crypto.randomBytes(16).toString('hex')) => sel + ':' + crypto.scryptSync(String(s), sel, 64).toString('hex');
const verifierHash = (s, h) => {
  const [sel, hex] = String(h || '').split(':');
  if (!sel || !hex) return false;
  const a = crypto.scryptSync(String(s), sel, 64), b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normCle = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const nouvelleCle = () => Array.from({ length: 4 }, () => crypto.randomBytes(3).toString('hex').toUpperCase()).join('-');
const essais = { n: 0, jusqua: 0 };               // freine les essais répétés
const limiter = () => { if (Date.now() < essais.jusqua) throw httpErr(429, `Trop d’essais : patientez ${Math.ceil((essais.jusqua - Date.now()) / 1000)} s`); };
const echec = () => { essais.n++; if (essais.n >= 5) essais.jusqua = Date.now() + Math.min(300, 15 * 2 ** (essais.n - 5)) * 1000; };
const MDP_MIN = 8;
const controleMdp = m => { if (typeof m !== 'string' || m.length < MDP_MIN) throw httpErr(400, `Le mot de passe doit faire au moins ${MDP_MIN} caractères`); };
const ouvrirSession = () => {
  const j = crypto.randomBytes(24).toString('hex'); sessions.set(j, Date.now());
  return `${COOKIE}=${j}; HttpOnly; SameSite=Strict; Path=/`;
};
const reponse = (obj, cookie) => ({ __raw: JSON.stringify(obj), type: 'application/json; charset=utf-8', headers: cookie ? { 'Set-Cookie': cookie } : {} });
function definirMdp(mdp) {
  controleMdp(mdp);
  const cle = nouvelleCle();
  setReglage('mdp', hacher(mdp)); setReglage('cle_secours', hacher(normCle(cle)));
  return cle;
}

route('GET', '/api/auth/etat', ({ req }) => ({ protege: protege(), verrouille: protege() && !sessionValide(req, false), nom: nomCabinet(), delai_min: delaiMin() }));
route('POST', '/api/auth/connexion', ({ body }) => {
  if (!protege()) return { ok: true };
  limiter();
  if (!verifierHash(body.mdp, reglage('mdp'))) { echec(); throw httpErr(401, 'Mot de passe incorrect'); }
  essais.n = 0; essais.jusqua = 0;
  return reponse({ ok: true }, ouvrirSession());
});
route('POST', '/api/auth/verrouiller', ({ req }) => { sessions.delete(jetonDe(req)); return reponse({ ok: true }, `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); });
route('POST', '/api/auth/definir', ({ req, body }) => {            // activer ou changer le mot de passe (changer : « actuel » obligatoire)
  if (protege()) { limiter(); if (!verifierHash(body.actuel, reglage('mdp'))) { echec(); throw httpErr(401, 'Mot de passe actuel incorrect'); } essais.n = 0; }
  const cle = definirMdp(body.mdp);
  const ck = sessionValide(req) && jetonDe(req) && sessions.has(jetonDe(req)) ? null : ouvrirSession();
  return reponse({ ok: true, cle_secours: cle }, ck);
});
route('POST', '/api/auth/retirer', ({ body }) => {
  limiter();
  if (!verifierHash(body.actuel, reglage('mdp'))) { echec(); throw httpErr(401, 'Mot de passe incorrect'); }
  essais.n = 0; delReglage('mdp'); delReglage('cle_secours'); sessions.clear();
  return { ok: true };
});
route('POST', '/api/auth/secours', ({ body }) => {                // mot de passe oublié : la clé de secours (affichée à l'activation) permet d'en définir un nouveau
  if (!protege()) return { ok: true };
  limiter();
  if (!verifierHash(normCle(body.cle), reglage('cle_secours'))) { echec(); throw httpErr(401, 'Clé de secours incorrecte'); }
  essais.n = 0; essais.jusqua = 0;
  const cle = definirMdp(body.mdp);
  return reponse({ ok: true, cle_secours: cle }, ouvrirSession());
});
route('POST', '/api/auth/delai', ({ body }) => {
  const m = Math.round(Number(body.minutes));
  if (!(m >= 0 && m <= 240)) throw httpErr(400, 'Délai invalide');
  setReglage('verrou_min', m); return { ok: true, delai_min: m };
});

route('GET', '/api/parametres', () => {
  const dernier = reglage('dernier_export'), repousse = reglage('rappel_repousse');
  const premier = get('SELECT MIN(created_at) d FROM patients').d;
  const jours = d => (Date.now() - new Date(String(d).replace(' ', 'T') + (String(d).length <= 10 ? 'T12:00:00' : 'Z')).getTime()) / 864e5;
  const rappel = !!premier && !(repousse && repousse > aujourdhui()) && (dernier ? jours(dernier) > 30 : jours(premier) > 7);
  return { nom_cabinet: nomCabinet(), nom_defaut: NOM_DEFAUT, dernier_export: dernier || null, rappel_export: rappel, protege: protege(), delai_min: delaiMin(),
    dossier_donnees: DATA_DIR, dossier_modifiable: !!global.gestionPsyDossier, version: require('./package.json').version };
});
route('PUT', '/api/parametres', ({ body }) => {
  if (body.nom_cabinet !== undefined) {
    const n = String(body.nom_cabinet).trim().replace(/\s+/g, ' ');
    if (n.length > 40) throw httpErr(400, 'Nom trop long (40 caractères au maximum)');
    if (!n || n === NOM_DEFAUT) delReglage('nom_cabinet'); else setReglage('nom_cabinet', n);
  }
  return { ok: true, nom_cabinet: nomCabinet() };
});
route('POST', '/api/parametres/rappel-repousse', () => { setReglage('rappel_repousse', new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)); return { ok: true }; });

// Mise à jour de l'application (Windows installé) : le programme Electron enregistre global.gestionPsyMaj ; en mode web / Mac / développement, c'est indisponible.
route('POST', '/api/dossier-donnees/changer', () => {
  if (!global.gestionPsyDossier) throw httpErr(400, 'Disponible dans l’application de bureau uniquement.');
  return global.gestionPsyDossier.changer();
});
route('GET', '/api/mise-a-jour', () => ({ version: require('./package.json').version, auto: !!(global.gestionPsyMaj && global.gestionPsyMaj.actif) }));
route('POST', '/api/mise-a-jour/verifier', async () => global.gestionPsyMaj ? global.gestionPsyMaj.verifier(true)
  : { etat: 'indisponible', message: 'La mise à jour automatique n’existe que dans l’application Windows installée.' });

// Documentation de la base, générée à partir de la base elle-même (toujours à jour) : rangée à côté des données et incluse dans l'export complet
const DOC_TABLES = {
  patients: 'Une ligne par personne : patients suivis, mais aussi parents / proches non suivis (statut « proche »).',
  consultations: 'Une ligne par séance. Les notes sont dans « contenu » (HTML : titres, gras, listes).',
  liens: 'Liens familiaux : patient_id = l’enfant / l’ado, proche_id = le parent / responsable, role = nature du lien.',
  ressources: 'Liens web joints à un patient (consultation_id vide) ou à une séance.',
  modeles: 'Modèles de page de séance (contenu en HTML).',
  consultation_versions: 'Historique des notes de séance : anciennes versions du texte (HTML), de la plus ancienne à la plus récente (id croissant). Heure en UTC.',
  corbeille: 'Éléments supprimés, conservés 30 jours (donnees = copie JSON de l’élément).',
  corbeille_ressources: 'Liens web des éléments en corbeille.',
  reglages: 'Réglages (nom affiché, mot de passe haché, dates…). Ne pas modifier à la main.',
  doublons_ignores: 'Paires de fiches que l’utilisatrice a confirmées comme étant deux personnes différentes.',
  proches: 'Ancienne table (avant la version 2), conservée mais inutilisée.',
};
const DOC_COLS = {
  'patients.nom': 'nom de famille', 'patients.prenom': 'prénom', 'patients.civilite': 'M, Mme ou vide', 'patients.date_naissance': 'AAAA-MM-JJ',
  'patients.type': 'adulte ou mineur', 'patients.statut': 'suivi en cours, en pause, terminé ou proche', 'patients.archive_le': 'date d’archivage (vide = actif)',
  'patients.complement': 'précision pour distinguer des homonymes', 'patients.contact': 'autres coordonnées (texte libre)', 'patients.notes': 'notes pratiques',
  'consultations.patient_id': 'renvoie à patients.id', 'consultations.date': 'AAAA-MM-JJ', 'consultations.heure': 'HH:MM', 'consultations.duree': 'minutes',
  'consultations.mode': 'cabinet, visio, téléphone ou domicile', 'consultations.statut': 'planifiée, réalisée, absence ou annulée', 'consultations.tarif': 'euros',
  'consultations.paye': '0 = non, 1 = oui', 'consultations.mode_paiement': 'chèque, espèces, virement ou CB', 'consultations.facture_a': 'nom de la personne facturée',
  'consultations.presents': 'JSON : "patient", "autre" ou "p:<id>" (une personne liée, id de patients)', 'consultations.contenu': 'notes de séance, en HTML',
};
function docSchema() {
  const L = [`DOCUMENTATION DES DONNÉES — ${nomCabinet()}`, '='.repeat(40), '',
    'Les données sont dans un fichier unique : cabinet.db (base SQLite 3). SQLite est un format ouvert, gratuit et très répandu, lisible sans cette application.',
    'Pour l’ouvrir : « DB Browser for SQLite » (gratuit, interface graphique), ou Python (module sqlite3), ou la commande « sqlite3 cabinet.db ».',
    'Fermer l’application avant de copier le fichier à la main (sinon copier aussi cabinet.db-wal et cabinet.db-shm). Le fichier n’est PAS chiffré : le disque doit l’être.',
    `Version de l’application : ${require('./package.json').version} ; version du schéma : ${db.prepare('PRAGMA user_version').get().user_version}.`, '',
    'Exemple (séances d’un patient) :', '  SELECT c.date, c.heure, c.statut, c.contenu FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE p.nom = \'Dupont\' ORDER BY c.date;', ''];
  for (const t of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name)) {
    const n = get(`SELECT COUNT(*) n FROM "${t}"`).n;
    L.push(`TABLE ${t} (${n} ligne${n > 1 ? 's' : ''})`, '  ' + (DOC_TABLES[t] || ''));
    for (const c of all(`PRAGMA table_info("${t}")`)) L.push(`  - ${c.name} (${c.type || '?'})${DOC_COLS[t + '.' + c.name] ? ' : ' + DOC_COLS[t + '.' + c.name] : ''}`);
    L.push('');
  }
  return L.join('\r\n');
}

route('GET', '/api/export/complet', () => {
  const o = { format: 'docx', du: null, au: null, statuts: STATUTS_SEANCE, inclure: new Set(['infos', 'liens', 'ressources', 'notes', 'finances']) };
  const dossiers = [], fichiers = [], add = (nom, data) => fichiers.push([nom, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')]);
  const ids = all('SELECT id FROM patients ORDER BY (archive_le IS NOT NULL), nom COLLATE NOCASE, prenom COLLATE NOCASE').map(r => r.id);
  const patients = ids.map(id => patientComplet(id));
  const gP = gardees(COL_PATIENT, o), gS = gardees(COL_SEANCE, o);
  const dateJ = aujourdhui();
  add('LISEZ-MOI.txt', ['EXPORT COMPLET — ' + nomCabinet(), `Exporté le ${frDate(dateJ)} (application version ${require('./package.json').version}).`, '',
    'Ce dossier contient TOUTES les données, dans des formats lisibles sans l’application :', '',
    '  patients.csv                  Tous les patients et proches (à ouvrir avec Excel).',
    '  seances.csv                   Toutes les séances avec leurs notes (à ouvrir avec Excel).',
    '  historique-notes.csv          Anciennes versions des notes de séance (texte brut), au cas où une correction serait à reprendre.',
    '  donnees-completes.json        Copie intégrale et structurée (patients, liens, séances en HTML, historique des notes, ressources, modèles) pour un autre logiciel.',
    '  dossiers/                     Un fichier Word (.docx) et un fichier texte Markdown (.md) par patient : coordonnées, liens, séances et notes.',
    '  SCHEMA-BASE-DE-DONNEES.txt    Description de la base cabinet.db, pour la réutiliser ailleurs.', '',
    'ATTENTION : ces fichiers contiennent des données de santé non chiffrées. Les ranger sur un support chiffré, et ne pas les envoyer par e-mail.', ''].join('\r\n'));
  add('SCHEMA-BASE-DE-DONNEES.txt', docSchema());
  add('patients.csv', X.csv([...enTetes(COL_PATIENT, o), 'Séances réalisées', 'Dernière séance', 'Reste à régler (€)'],
    patients.map(p => { const r = filtreSeances(p.consultations, { ...o, statuts: ['réalisée'] });
      return [...garder(valsIdentite(p), gP), r.length, r[0] ? r[0].date : '', r.filter(c => !c.paye).reduce((t, c) => t + (c.tarif || 0), 0)]; })));
  const seances = all(`SELECT c.*, ${NOMC('p')} AS patient_nom FROM consultations c JOIN patients p ON p.id=c.patient_id ORDER BY c.date, c.heure`).map(c => ({ ...consultOut(c), patient_nom: c.patient_nom }));
  add('seances.csv', X.csv(['Patient', ...COL_SEANCE.map(c => c[1])], seances.map(c => [c.patient_nom, ...valsSeance(c)])));
  add('historique-notes.csv', X.csv(['Patient', 'Date de la séance', 'Version enregistrée le (UTC)', 'Origine', 'Texte'],
    all(`SELECT v.*, c.date, ${NOMC('p')} AS patient_nom FROM consultation_versions v JOIN consultations c ON c.id=v.consultation_id JOIN patients p ON p.id=c.patient_id ORDER BY c.date, v.id`)
      .map(v => [v.patient_nom, v.date, v.enregistre_le, v.origine, X.texteBrut(v.contenu)])));
  add('donnees-completes.json', JSON.stringify({ exporte_le: dateJ, application: nomCabinet(), version: require('./package.json').version,
    patients: all('SELECT * FROM patients ORDER BY id'), liens: all('SELECT * FROM liens ORDER BY id'),
    consultations: all('SELECT * FROM consultations ORDER BY id').map(c => ({ ...c, presents: JSON.parse(c.presents || '[]') })),
    historique_notes: all('SELECT * FROM consultation_versions ORDER BY id'),
    ressources: all('SELECT * FROM ressources ORDER BY id'), modeles: all('SELECT * FROM modeles ORDER BY id') }, null, 1));
  const pris = new Set();
  for (const p of patients) {
    let n = `dossiers/${slug(p.nom)}`; if (pris.has(n)) n += '-' + p.id; pris.add(n);
    const blocsP = dossierPatient(p, o).blocs;
    add(n + '.docx', X.docx(`Dossier ${p.nom}`, blocsP));
    add(n + '.md', X.markdown(`Dossier ${p.nom}`, blocsP));
  }
  setReglage('dernier_export', dateJ);
  return fichier(X.zip(fichiers), 'application/zip', `Export-complet-${slug(nomCabinet())}-${dateJ}.zip`);
});

// ---------- Serveur HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) { reject(httpErr(413, 'Trop volumineux')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(httpErr(400, 'JSON invalide')); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Sécurité : n'accepter que les requêtes venant de la machine elle-même
  const host = (req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end('Interdit'); }
  // Une autre page web ouverte dans le navigateur ne doit pas pouvoir piloter l'appli (lire, modifier, supprimer) :
  // on refuse toute requête dont l'origine déclarée par le navigateur n'est pas l'appli elle-même.
  const origine = req.headers.origin, site = req.headers['sec-fetch-site'];
  if ((origine && origine !== `http://localhost:${PORT}` && origine !== `http://127.0.0.1:${PORT}`) || (site && site !== 'same-origin' && site !== 'none')) {
    res.writeHead(403); return res.end('Interdit');
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      if (!AUTH_LIBRES.includes(url.pathname) && !sessionValide(req)) throw Object.assign(httpErr(401, 'Verrouillé : saisissez le mot de passe'), { extra: { verrouille: true } });
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = await r.fn({ m, body, url, req });
        if (out && out.__raw) { res.writeHead(200, { 'Content-Type': out.type, ...out.headers }); return res.end(out.__raw); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(out));
      }
      throw httpErr(404, 'Route inconnue');
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message, ...(e.extra || {}) }));
    }
  }

  const file = path.normalize(path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Introuvable');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---------- Modèles par défaut + données fictives ----------
if (get('SELECT COUNT(*) n FROM modeles').n === 0) {
  run('INSERT INTO modeles (nom,contenu) VALUES (?,?)', 'Première séance',
    '<h3>Motif de consultation</h3><p></p><h3>Contexte et histoire</h3><p></p><h3>Attentes et objectifs</h3><p></p><h3>Premières impressions</h3><p></p><h3>À reprendre la prochaine fois</h3><p></p>');
  run('INSERT INTO modeles (nom,contenu) VALUES (?,?)', 'Séance de suivi',
    '<h3>Depuis la dernière séance</h3><p></p><h3>Thèmes abordés</h3><p></p><h3>Observations</h3><p></p><h3>À reprendre la prochaine fois</h3><p></p>');
  run('INSERT INTO modeles (nom,contenu) VALUES (?,?)', 'Séance avec la famille',
    '<h3>Personnes présentes</h3><p></p><h3>Demande de chacun</h3><p></p><h3>Dynamique observée</h3><p></p><h3>Suites à donner</h3><p></p>');
}
if (process.env.DEMO && get('SELECT COUNT(*) n FROM patients').n === 0) {
  const mk = (nom, type, statut, civ, naiss) => run('INSERT INTO patients (nom,type,statut,civilite,date_naissance) VALUES (?,?,?,?,?)', nom, type, statut, civ, naiss).lastInsertRowid;
  const a = mk('Patient A', 'adulte', 'suivi en cours', 'Mme', '1987-05-14');
  const b = mk('Patient B', 'mineur', 'suivi en cours', 'M', '2011-09-03');
  const c = mk('Patient C', 'adulte', 'en pause', 'M', '1992-01-22');
  const p1 = run('INSERT INTO patients (nom,type,statut,contact,civilite,date_naissance) VALUES (?,?,?,?,?,?)', 'Parent 1', 'adulte', 'suivi en cours', '06 00 00 00 01', 'Mme', '1980-02-11').lastInsertRowid;
  const rl = run('INSERT INTO patients (nom,type,statut,contact) VALUES (?,?,?,?)', 'Responsable légal', 'adulte', 'proche', '06 00 00 00 02').lastInsertRowid;
  run('INSERT INTO liens (patient_id,proche_id,role) VALUES (?,?,?)', b, p1, 'parent');
  run('INSERT INTO liens (patient_id,proche_id,role) VALUES (?,?,?)', b, rl, 'responsable légal');
  const add = (pid, date, heure, statut, paye, presents, fa, contenu) =>
    run(`INSERT INTO consultations (patient_id,date,heure,duree,mode,statut,tarif,paye,presents,facture_a,contenu) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      pid, date, heure, 50, 'cabinet', statut, 60, paye, JSON.stringify(presents), fa, contenu);
  add(a, '2026-10-06', '14:00', 'réalisée', 1, [], '', '<h3>Motif de consultation</h3><p>Exemple fictif.</p>');
  add(a, '2026-10-20', '14:00', 'réalisée', 0, [], '', '<h3>Thèmes abordés</h3><p>Exemple fictif.</p>');
  add(a, '2026-11-03', '14:00', 'planifiée', 0, [], '', '');
  add(b, '2026-10-13', '17:00', 'réalisée', 1, ['patient', 'parent'], 'Parent 1', '<h3>Personnes présentes</h3><p>Le patient et un parent.</p>');
  add(b, '2026-10-27', '17:00', 'réalisée', 1, ['patient'], 'Parent 1', '');
  add(b, '2026-11-10', '17:00', 'planifiée', 0, ['patient', 'parent', 'responsable légal'], 'Responsable légal', '');
  add(c, '2026-09-15', '10:00', 'réalisée', 1, [], '', '');
  run(`UPDATE patients SET email='alice@exemple.fr', telephone='06 12 34 56 78' WHERE id=?`, a);
  run(`UPDATE patients SET email='parent1@exemple.fr', telephone='06 00 00 00 01', contact='' WHERE id=?`, p1);
  run(`UPDATE patients SET telephone='06 00 00 00 02', contact='' WHERE id=?`, rl);
  run(`INSERT INTO ressources (patient_id, titre, url) VALUES (?,?,?)`, a, 'Échelle d’anxiété (exemple)', 'https://www.example.org/echelle-anxiete');
  const e = run('INSERT INTO patients (nom,type,statut,archive_le) VALUES (?,?,?,?)', 'Patient E', 'adulte', 'terminé', '2026-09-30').lastInsertRowid;
  add(e, '2026-06-10', '11:00', 'réalisée', 1, [], '', '');
  run(`UPDATE consultations SET mode_paiement='chèque' WHERE paye=1 AND id%3=0`);
  run(`UPDATE consultations SET mode_paiement='CB' WHERE paye=1 AND id%3=1`);
  run(`UPDATE consultations SET mode_paiement='espèces' WHERE paye=1 AND id%3=2`);
  add(p1, '2026-10-22', '18:00', 'réalisée', 0, ['patient'], '', '<h3>Thèmes abordés</h3><p>Séance du parent seul (exemple fictif).</p>');
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n⚠ Le port ${PORT} est déjà utilisé : une autre instance de l'appli tourne sans doute encore.\n  Fermez-la (Ctrl+C dans son Terminal) ou tapez :  lsof -ti :${PORT} | xargs kill\n  puis relancez.\n`);
    process.exit(1);
  }
  throw e;
});
purgerCorbeille();
setInterval(purgerCorbeille, 3600 * 1000).unref();

try { fs.writeFileSync(path.join(DATA_DIR, 'LISEZ-MOI-DONNEES.txt'), docSchema()); } catch { /* dossier en lecture seule : sans importance */ }
server.listen(PORT, '127.0.0.1', () => console.log(`Gestion Psy (v${require('./package.json').version}) prêt : http://localhost:${PORT}`));
