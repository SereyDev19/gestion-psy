// Mise à jour automatique (Windows, application installée) : l'appli vérifie les « Releases » du dépôt GitHub.
// Rien n'est installé sans l'accord de l'utilisatrice. Les données ne sont jamais touchées (elles sont hors de l'application).
// Sur Mac (appli non signée) et en développement : désactivé ; voir Mettre-a-jour-Mac.command.
const { app, dialog } = require('electron');

module.exports = function installerMaj(getFenetre) {
  const indispo = message => ({ actif: false, verifier: async () => ({ etat: 'indisponible', message }) });
  if (!app.isPackaged) return indispo('La mise à jour automatique n’existe que dans l’application installée.');
  if (process.platform !== 'win32') return indispo('Sur Mac, la mise à jour se fait avec Mettre-a-jour-Mac.command (ou en installant le .dmg de la dernière version).');

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  let occupe = false;

  async function verifier(manuel) {
    if (occupe) return { etat: 'occupe', message: 'Une vérification est déjà en cours.' };
    occupe = true;
    try {
      const r = await autoUpdater.checkForUpdates();
      if (!r || !r.isUpdateAvailable) return { etat: 'a-jour', message: `Gestion Psy est à jour (version ${app.getVersion()}).` };
      const v = r.updateInfo.version, fen = getFenetre();
      const choix = dialog.showMessageBoxSync(fen || undefined, {
        type: 'question', buttons: ['Installer maintenant', 'Plus tard'], defaultId: 0, cancelId: 1, title: 'Gestion Psy',
        message: `Une nouvelle version est disponible : ${v}`,
        detail: `Vous utilisez la version ${app.getVersion()}.\nVos données ne sont pas touchées (une copie de sécurité est faite avant toute évolution de leur structure).\nL’application va se fermer puis se rouvrir toute seule.`,
      });
      if (choix !== 0) return { etat: 'reporte', message: `Version ${v} disponible : installation reportée.` };
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall(true, true);              // installation silencieuse, puis relance
      return { etat: 'installation', message: 'Installation en cours…' };
    } catch (e) {
      return manuel ? { etat: 'erreur', message: 'Impossible de vérifier les mises à jour (connexion internet ?). ' + String(e && e.message || e).split('\n')[0] } : { etat: 'silence' };
    } finally { occupe = false; }
  }
  setTimeout(() => verifier(false), 20000).unref();        // vérification discrète, 20 s après l'ouverture
  return { actif: true, verifier };
};
