// Gestion Psy : enveloppe « application de bureau » (Electron). Aucune logique métier ici : on choisit le dossier des données, on démarre le serveur local
// (server.js) sur un port libre, puis on l'affiche dans une fenêtre unique.
// Les données sont rangées HORS de l'application, dans un dossier au choix (par défaut le dossier de l'utilisateur ; ex. un volume chiffré D:\Cabinet).
// L'appli ne crée JAMAIS de base vide en silence quand le dossier habituel est introuvable (volume chiffré pas monté, disque débranché) : elle le dit et demande quoi faire.
const { app, BrowserWindow, Menu, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const cfgPkg = require('./package.json').cabinet || {};
let fenetre = null, dataDir = null;

// Boîtes de dialogue (remplaçables par un script en test : CABINET_TEST_SCRIPT = liste JSON de réponses, dans l'ordre des questions)
const script = process.env.CABINET_TEST_SCRIPT ? JSON.parse(process.env.CABINET_TEST_SCRIPT) : null;
const reponseScript = () => (script && script.length ? { v: script.shift() } : null);
const ui = {
  boite: o => { const r = reponseScript(); return r ? r.v : dialog.showMessageBoxSync(o); },
  dossier: o => { const r = reponseScript(); return r ? r.v : ((dialog.showOpenDialogSync(o) || [])[0] || null); },
};

// ----- Configuration (petit fichier dans le dossier de l'application, jamais les données elles-mêmes) -----
const fichierConfig = () => path.join(app.getPath('userData'), 'config.json');
const lireConfig = () => { try { return JSON.parse(fs.readFileSync(fichierConfig(), 'utf8')); } catch { return {}; } };
const ecrireConfig = c => { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(fichierConfig(), JSON.stringify(c, null, 2)); };
const aUneBase = d => { try { return fs.existsSync(path.join(d, 'cabinet.db')); } catch { return false; } };
const inscriptible = d => {
  try { fs.mkdirSync(d, { recursive: true }); const t = path.join(d, '.test-ecriture'); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; } catch { return false; }
};
// Dossier choisi par l'utilisatrice -> dossier réellement utilisé : une base existante est reprise telle quelle ; un dossier vide sert directement ;
// sinon (racine d'un disque, dossier plein de fichiers) on crée un sous-dossier « Gestion Psy ».
function dossierPour(choisi) {
  if (aUneBase(choisi)) return choisi;
  for (const n of ['Gestion Psy', 'Cabinet']) if (aUneBase(path.join(choisi, n))) return path.join(choisi, n);
  try { if (!fs.existsSync(choisi) || fs.readdirSync(choisi).length === 0) return choisi; } catch { /* illisible : sous-dossier */ }
  return path.join(choisi, 'Gestion Psy');
}
function choisirDossier(titre) {
  for (;;) {
    const p = ui.dossier({ title: titre, properties: ['openDirectory', 'createDirectory'] });
    if (!p) return null;
    const d = dossierPour(p);
    if (inscriptible(d)) return d;
    ui.boite({ type: 'error', message: 'Dossier inutilisable', detail: `Impossible d'écrire dans :\n${d}\nChoisissez un autre dossier.`, buttons: ['OK'] });
  }
}

// ----- Où sont les données ? -----
function trouverDossier() {
  if (process.env.DATA_DIR) return { dir: process.env.DATA_DIR, premier: !aUneBase(process.env.DATA_DIR) };
  const cfg = lireConfig();

  // Déplacement demandé depuis le menu : fait ici, AVANT d'ouvrir la base (copie complète, l'ancien dossier n'est pas touché)
  if (cfg.deplacement) {
    const { de, vers } = cfg.deplacement; delete cfg.deplacement;
    try {
      fs.mkdirSync(vers, { recursive: true });
      fs.cpSync(de, vers, { recursive: true });
      if (!aUneBase(vers)) throw new Error('la base n’a pas été retrouvée après la copie');
      cfg.dataDir = vers;
    } catch (e) {
      ui.boite({ type: 'error', message: 'Le déplacement des données a échoué', detail: `${e.message}\nVos données n'ont pas bougé : elles restent dans\n${de}`, buttons: ['OK'] });
    }
    ecrireConfig(cfg);
  }

  // Tout premier lancement : on demande où ranger les données
  if (!cfg.dataDir) {
    const defaut = path.join(app.getPath('userData'), 'data');
    for (;;) {
      const r = ui.boite({ type: 'question', message: 'Où ranger les données de Gestion Psy ?',
        detail: `Les patients et les séances seront enregistrés dans un dossier séparé de l'application.\n\nVous pouvez choisir un disque ou un volume chiffré (par exemple D:\\).\n\nPar défaut :\n${defaut}`,
        buttons: ['Dossier par défaut', 'Choisir un dossier…', 'Quitter'], defaultId: 0, cancelId: 2 });
      if (r === 2) return null;
      if (r === 0) { if (!inscriptible(defaut)) { ui.boite({ type: 'error', message: 'Dossier inutilisable', detail: defaut, buttons: ['OK'] }); continue; } cfg.dataDir = defaut; break; }
      const d = choisirDossier('Choisir le dossier des données');
      if (d) { cfg.dataDir = d; break; }
    }
    cfg.initialise = aUneBase(cfg.dataDir);
    ecrireConfig(cfg);
  }

  // Chaque lancement : le dossier est-il là ? (volume chiffré pas monté…)
  for (;;) {
    const d = cfg.dataDir;
    let r;
    if (fs.existsSync(d)) {
      if (aUneBase(d) || !cfg.initialise) break;
      r = ui.boite({ type: 'warning', message: 'Aucune base de données dans ce dossier',
        detail: `${d}\n\nVos patients ne s'y trouvent pas. Le bon volume est peut-être monté sous une autre lettre, ou le dossier a été vidé.\nContinuer créerait une base VIDE.`,
        buttons: ['Réessayer', 'Choisir un autre dossier…', 'Créer une base vide ici', 'Quitter'], defaultId: 0, cancelId: 3 });
      if (r === 2) { cfg.initialise = false; ecrireConfig(cfg); break; }
    } else {
      r = ui.boite({ type: 'warning', message: 'Dossier des données introuvable',
        detail: `${d}\n\nSi les données sont sur un volume chiffré ou un disque externe, montez-le d'abord, puis cliquez sur « Réessayer ».`,
        buttons: ['Réessayer', 'Choisir un autre dossier…', 'Quitter'], defaultId: 0, cancelId: 2 });
      if (r === 2) r = 3;
    }
    if (r === 3) return null;
    if (r === 1) { const n = choisirDossier('Choisir le dossier des données'); if (n) { cfg.dataDir = n; cfg.initialise = aUneBase(n); ecrireConfig(cfg); } }
  }
  return { dir: cfg.dataDir, premier: !aUneBase(cfg.dataDir), cfg };
}

// Menu Aide > Changer le dossier des données : la copie est faite au redémarrage suivant (base fermée, donc cohérente)
// Renvoie { etat: 'annule' | 'identique' | 'erreur' | 'redemarrage', message } (appelée aussi depuis Paramètres, via global.gestionPsyDossier)
// La copie se fait tout de suite, base ouverte (instantané cohérent), avec vérification : en cas d'échec l'erreur est affichée et rien ne change.
function changerDossier() {
  const p = choisirDossier('Nouveau dossier des données');
  if (!p) return { etat: 'annule' };
  if (path.resolve(p) === path.resolve(dataDir)) { ui.boite({ message: 'C’est déjà le dossier utilisé.', buttons: ['OK'] }); return { etat: 'identique' }; }
  const existante = aUneBase(p);
  const r = ui.boite({ type: 'question', buttons: ['Continuer', 'Annuler'], defaultId: 0, cancelId: 1,
    message: existante ? 'Ce dossier contient déjà une base de données' : 'Déplacer les données ?',
    detail: existante
      ? `Gestion Psy utilisera telle quelle la base trouvée dans :\n${p}\n\nLa base actuelle (${dataDir}) n'est pas modifiée.`
      : `Vos données seront copiées dans :\n${p}\n\nGestion Psy redémarre ensuite. L'ancien dossier n'est PAS effacé : il contient encore les données des patients. Supprimez-le vous-même une fois que tout fonctionne.` });
  if (r !== 0) return { etat: 'annule' };
  const cfg = lireConfig();
  if (!existante) {
    try { global.gestionPsyCopier(p); }
    catch (e) {
      ui.boite({ type: 'error', message: 'La copie des données a échoué', detail: `${e.message}\n\nVos données n'ont pas bougé : elles restent dans\n${dataDir}`, buttons: ['OK'] });
      return { etat: 'erreur', message: `La copie a échoué : ${e.message}` };
    }
  }
  cfg.dataDir = p; cfg.initialise = true; delete cfg.deplacement;
  ecrireConfig(cfg);
  setTimeout(() => { delete process.env.DATA_DIR; app.releaseSingleInstanceLock(); app.relaunch(); app.exit(0); }, 600);   // DATA_DIR est posée par nous au démarrage : la retirer, sinon la nouvelle instance l'hérite et ignore config.json   // laisse partir la réponse à la page Paramètres
  return { etat: 'redemarrage' };
}

// Si le dossier disparaît pendant l'utilisation (volume démonté de force, disque débranché) : on le dit et on ferme, plutôt que d'écrire dans le vide
function surveillerDossier() {
  let echecs = 0;
  setInterval(() => {
    if (aUneBase(dataDir)) { echecs = 0; return; }
    if (++echecs < 2) return;
    ui.boite({ type: 'error', message: 'Le dossier des données n’est plus accessible', detail: `${dataDir}\n\nGestion Psy va se fermer. Remontez le volume ou rebranchez le disque, puis relancez l'application.`, buttons: ['Fermer'] });
    app.exit(1);
  }, Number(process.env.CABINET_GARDE_MS) || 5000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();                                   // une seule copie de l'appli à la fois (sinon deux fenêtres écriraient dans la même base)
} else {
  app.on('second-instance', () => { if (fenetre) { if (fenetre.isMinimized()) fenetre.restore(); fenetre.focus(); } });
  app.whenReady().then(demarrer).catch(erreur);
  app.on('window-all-closed', () => app.quit());
}

function portLibre() {
  return new Promise((ok, ko) => {
    const s = net.createServer();
    s.once('error', ko);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

async function attendreServeur(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/auth/etat`); if (r.ok) return; } catch { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Le serveur local ne démarre pas.');
}

async function demarrer() {
  const t = trouverDossier();
  if (!t) { app.quit(); return; }
  dataDir = t.dir;
  if (t.premier && cfgPkg.demoAuPremierLancement) process.env.DEMO = '1';      // version d'essai : quelques patients fictifs quand la base est neuve
  const port = await portLibre();
  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  require('./server.js');
  await attendreServeur(port);
  if (t.cfg && !t.cfg.initialise) { t.cfg.initialise = true; ecrireConfig(t.cfg); }   // dès qu'une base existe, son absence future sera signalée
  surveillerDossier();
  global.gestionPsyMaj = require('./electron-maj.js')(() => fenetre);
  global.gestionPsyDossier = { changer: changerDossier };
  const origine = `http://localhost:${port}`;

  // Rien n'est autorisé par défaut (caméra, micro, géolocalisation…)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  fenetre = new BrowserWindow({
    width: 1320, height: 880, minWidth: 920, minHeight: 600, title: 'Gestion Psy', backgroundColor: '#f5f4f6',
    icon: path.join(__dirname, 'public', 'logo-256.png'), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  fenetre.on('closed', () => { fenetre = null; });
  fenetre.loadURL(origine + '/');

  const interne = u => u.startsWith(origine + '/') || u === origine;
  // Liens vers le web (ressources) : dans le navigateur habituel. Pages de l'appli (aperçu PDF à imprimer) : dans une petite fenêtre.
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (interne(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 920, height: 900, autoHideMenuBar: true, title: 'Gestion Psy' } };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenetre.webContents.on('will-navigate', (e, url) => {
    if (interne(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },                       // indispensable : sans lui, copier / coller ne marche pas sur Mac
    { label: 'Affichage', submenu: [{ role: 'reload', label: 'Recharger' }, { role: 'resetZoom', label: 'Taille normale' }, { role: 'zoomIn', label: 'Agrandir' }, { role: 'zoomOut', label: 'Réduire' }, { role: 'togglefullscreen', label: 'Plein écran' }] },
    { role: 'windowMenu' },
    { label: 'Aide', submenu: [
      { label: 'Dossier des données : ' + dataDir, enabled: false },
      { label: 'Ouvrir le dossier des données', click: () => shell.openPath(dataDir) },
      { id: 'changer', label: 'Changer le dossier des données…', click: () => { changerDossier(); } },
      { type: 'separator' },
      { label: 'Rechercher une mise à jour…', click: async () => { const r = await global.gestionPsyMaj.verifier(true); if (r.etat !== 'installation' && r.etat !== 'reporte') dialog.showMessageBox(fenetre || undefined, { type: r.etat === 'erreur' ? 'warning' : 'info', message: 'Gestion Psy', detail: r.message }); } },
    ] },
  ]));
}

function erreur(e) {
  dialog.showErrorBox('Gestion Psy ne peut pas démarrer', String(e && e.message || e));
  app.quit();
}
