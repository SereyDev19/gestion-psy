# Gestion Psy : application locale (patients / consultations)

## Lancer (Mac)
1. Node.js 22.13 ou plus doit être installé (nodejs.org, version LTS).
2. Double-cliquer sur `Lancer.command` (la première fois : clic droit, Ouvrir).
   Ou dans un terminal : `DEMO=1 node server.js` puis ouvrir http://localhost:4173
3. Au tout premier lancement, 3 patients fictifs sont créés pour essayer.
   Pour partir de zéro : arrêter l'appli, supprimer le dossier `data/`, relancer avec `node server.js` (sans DEMO).

## Ce que le prototype fait
- Fiche patient : ses consultations apparaissent d'elles-mêmes (relation dans les deux sens, une seule donnée).
- Liens familiaux : un parent ou responsable légal est un vrai patient, relié à l'ado par UN lien visible depuis les deux fiches
  (l'ado voit ses parents, le parent voit ses enfants). Un parent non suivi a le statut « proche (non suivi) » :
  il n'encombre pas la liste « En cours » et passe en « suivi en cours » dès qu'il consulte lui-même.
- Séances : personnes présentes (patient, parent, responsable légal…) et « facturé à » (le patient ou une personne liée).
- Modèles de séance : choisis à la création d'une séance ; modifiables dans « Modèles de séance ».
  Modifier un modèle ne change pas les séances déjà écrites (comme partout).
- Onglet Consultations : vue **Calendrier** (Semaine avec grille horaire, ou Mois) et vue **Liste**.
  Flèches ‹ › et « Aujourd'hui » pour naviguer. Un clic sur une séance l'ouvre, un clic sur un créneau
  ou un jour vide crée une séance à cette date (et à cette heure en vue semaine).
  La liste a aussi un filtre de période : Toutes dates / Cette semaine / Ce mois.
- Paiement : case « Payée » puis mode de paiement (chèque, espèces, virement, CB), affiché dans la liste des consultations.
- Fiche patient : civilité (M. / Mme / non renseigné), nom, prénom, date de naissance et âge calculé automatiquement
  (en années, en mois avant 2 ans). Saisir une date de naissance propose Mineur ou Adulte (modifiable).
- Tarif : il se choisit à chaque séance (proposé d'après la dernière séance du patient, sinon le dernier tarif saisi).
  Il n'existe plus de tarif au niveau du patient.
- Archiver ≠ supprimer. **Archiver** : le patient ne vient plus mais peut revenir ; il disparaît des listes
  (filtre « Archivés » pour le retrouver, ou recherche par nom), son dossier est intact, on peut le désarchiver.
  **Supprimer** : erreur de saisie, rendez-vous non honoré. L'élément part à la **corbeille**.
- Coordonnées : téléphone et e-mail (cliquables) en plus d'un champ libre « Autres coordonnées ».
- Recherche globale : Ctrl+K (⌘K sur Mac) ou le bouton « Rechercher » de la barre de gauche. Cherche dans les patients (nom, téléphone, e-mail, notes), le texte des séances, les liens et les modèles ; sans tenir compte des accents ni des majuscules.
- Export : bouton « Exporter… » sur chaque fiche patient (dossier complet) et chaque séance, en PDF, Word (.docx) ou CSV (Excel).
  Une fenêtre d'options permet de choisir : la **période** des séances, leurs **statuts**, et le contenu (infos du patient, liens familiaux, ressources, notes, tarifs et paiements).
  Le PDF s'ouvre dans une page prête à imprimer : choisir « Enregistrer au format PDF » comme imprimante.
  Les listes Patients et Consultations proposent aussi un CSV de l'ensemble, avec les mêmes options.
- Choix du patient (nouvelle séance depuis l'onglet Consultations) : fenêtre centrale avec recherche instantanée (nom, prénom, téléphone, e-mail ; sans accents ni majuscules), filtres par statut, âge (adultes / mineurs) et « Récents ». Fait pour des centaines de patients : 50 résultats affichés à la fois, navigation au clavier (↑ ↓ Entrée).
- Personnes présentes (page d'une séance) : on coche le patient et les **personnes qui lui sont liées** (parents, responsables, proches, enfants), plus « Autre personne ».
  Le bouton « + Lier une personne » crée une nouvelle personne (enregistrée comme **proche, non suivi**) ou relie quelqu'un déjà enregistré (qui garde son statut), et la coche comme présente.
- Fiche d'un proche : les séances où il était présent comme **accompagnant** d'un autre patient apparaissent dans sa chronologie avec une étiquette violette « Accompagnant » et le nom de la personne accompagnée (lien cliquable). Aucune note de l'autre patient n'est affichée. Ses propres séances restent affichées normalement.
- Ressources : on joint des **liens web** (un ou plusieurs) à un patient ou à une séance (pas de fichiers : rien n'est stocké dans l'appli).
- **Doublons et homonymes** : en créant ou modifiant une fiche (et en « Lier une personne »), l'appli compare avec les fiches existantes (accents, majuscules, ordre prénom/nom et petite faute de frappe ignorés ; téléphone et e-mail normalisés).
  - *Ressemblance simple* (même nom) : un message d'information, on enregistre normalement (les homonymes sont autorisés).
  - *Très probable* (même nom + même téléphone / e-mail / date de naissance) : il faut cocher « Je confirme que c'est une autre personne ».
  - Deux homonymes dont les dates de naissance diffèrent ne sont jamais signalés. Les homonymes affichent leur âge et leur « Précision » (champ libre, ex. « fille de Marie ») dans les listes, la recherche et les séances.
  - En reliant un parent, on peut choisir la fiche existante (« C'est cette personne ») au lieu d'en créer une seconde.
- **Historique des notes** (bouton **Historique** dans une séance) : les anciennes versions du texte sont conservées automatiquement (environ toutes les 10 minutes de saisie, et immédiatement si une grande partie du texte disparaît d'un coup). On peut les comparer au texte actuel (rouge = supprimé, vert = ajouté) et en **restaurer** une ; le texte actuel est alors mis de côté lui aussi, donc rien n'est jamais perdu. L'historique suit la séance : corbeille, restauration, fusion de fiches, et effacement définitif. Il est inclus dans l'export complet (`historique-notes.csv`, `donnees-completes.json`).
- **Liens locaux** : dans les ressources, un lien peut aussi être le chemin d'un fichier ou d'un dossier de l'ordinateur ou du réseau (`C:\Patients\bilan.pdf`, `/Users/…/bilan.pdf`, `\\serveur\partage\doc.docx`). Un clic l'ouvre avec le programme habituel ; si le disque ou le volume chiffré n'est pas monté, l'appli le dit.
- **Notes de séance** : gras, italique, **souligné** et **couleur du texte** (couleurs de la charte, puis couleurs courantes). Les couleurs et le souligné se retrouvent dans les exports Word et PDF.
- **Identité en haut de chaque séance** : nom et prénom en grand, âge, et une pastille ronde colorée **H** (bleu), **F** (rose) ou **NR** (gris) pour ne jamais se tromper de patient.
- **Export anonyme** : dans la fenêtre d'export (dossier, séance, tous les patients, toutes les séances), décocher **Identité et coordonnées du patient** (ou « Nom du patient ») produit un export anonyme : plus de nom, prénom, téléphone, e-mail, date de naissance ni adresse ; le patient devient « patient n° X », ses proches un simple rôle (« parent », « 1 autre personne »), la personne facturée « un tiers », et le nom de fichier ne contient plus de nom. Restent les dates, durées, statuts, tarifs, notes et ressources selon les cases cochées. **Attention** : les notes et les ressources peuvent contenir des noms ou des chemins de fichiers : les décocher aussi pour un export totalement anonyme.
- **Export Markdown (.md)** du dossier d'un patient ou d'une séance (texte brut lisible partout) ; l'export complet contient aussi un `.md` par patient.
- **N° du patient** : un badge « N° 12 » en haut de chaque fiche patient affiche l'identifiant unique (celui utilisé dans les exports anonymes).
- **Page d'accueil** (ouverte au lancement ; boutons « + Nouveau patient » et « + Nouvelle consultation ») : séances du jour, prochaines séances, séances passées encore « planifiées » (à compléter), montant à régler, patients à revoir (en suivi, sans séance depuis 6 semaines et sans rendez-vous prévu), patients en suivi et séances du mois. Le menu indique le nombre de séances du jour à côté de « Consultations ».
- **Calendrier** : on **glisse-dépose** une séance planifiée vers un autre jour (vue Mois : l'heure est conservée) ou un autre jour et une autre heure, au quart d'heure près (vue Semaine). Si l'horaire est déjà pris, l'appli le signale et demande confirmation. **Séries** : dans « Nouvelle séance », « Répétition » crée chaque semaine ou toutes les 2 semaines (2 à 52 séances) ; les conflits sont signalés avant toute création.
- **Sauvegarde automatique** : une copie cohérente de la base chaque jour, à l'ouverture, dans `sauvegardes/` à côté des données (30 conservées). **Paramètres > Sauvegardes automatiques** montre la taille de la base, le nombre et le poids des sauvegardes, et permet de ne garder que les 7 plus récentes. Elles sont dans le même volume que les données : elles ne remplacent pas la copie du conteneur chiffré sur un support externe.
- **Affichage** (Paramètres) : taille du texte (normale, grande, très grande) et thème clair, sombre ou automatique ; réglages propres à chaque ordinateur.
- **Doublons** : un champ de recherche filtre les paires par nom, téléphone ou e-mail.
- **Mise à jour de l'application** : Windows, relancer le nouvel installateur `Gestion-Psy-Setup-X.Y.Z.exe` (il remplace l'ancienne version, les données restent en place) ; Mac, double-clic sur `Mettre-a-jour-Mac.command` (fabrique la nouvelle version et la remplace dans Applications).
- **Format imposé** pour le téléphone et l'e-mail (facultatifs, mais valides s'ils sont remplis) : numéro français à 10 chiffres mis en forme automatiquement (`06 12 34 56 78`, les `+33` sont convertis) ou numéro international (`+32 470 12 34 56`) ; e-mail complet, enregistré en minuscules. Un champ mal rempli est signalé en rouge et bloque l'enregistrement ; une ancienne fiche déjà mal renseignée ne bloque pas les autres modifications.
- **Fusionner deux fiches** (fiche patient > Gestion du dossier, ou écran **Doublons** du menu Réglages, qui liste aussi les paires suspectes) : séances, liens familiaux, ressources et notes passent sur la fiche conservée ; en cas de désaccord on choisit la valeur à garder ; la fiche absorbée va 30 jours à la corbeille ; copie de sécurité automatique avant.
- Création d'une séance : avertissement si le patient a déjà une séance ce jour-là, ou si l'horaire chevauche celui d'un autre patient (on peut créer quand même). Les boutons « Enregistrer » se bloquent après un clic (pas de double création).
  Ils se modifient, passent par la corbeille, et sont retrouvés par la recherche. Seules les adresses http / https sont acceptées.
- Corbeille (menu Réglages) : patients (avec leurs séances et liens), séances et modèles supprimés y restent
  **30 jours**, restaurables en un clic, puis sont effacés définitivement (et réellement effacés du fichier de données).
  On peut aussi effacer un élément ou vider la corbeille à la main. Une séance dont le patient est dans la corbeille
  ne se restaure qu'après lui.
  **Effacement définitif manuel** : le contenu est écrasé dans le fichier de données, et une case (cochée par défaut)
  propose de **supprimer aussi les sauvegardes** qui contiennent encore ces données ; une sauvegarde saine est refaite
  aussitôt. Les copies faites hors du dossier des données (exports, conteneur chiffré recopié, clé USB) ne sont pas touchées.
  L'effacement automatique après 30 jours ne touche pas aux sauvegardes : elles se renouvellent seules (30 jours au plus).
- Enregistrement automatique des notes.
- Sauvegarde en un clic (bouton en bas à gauche) : fichier `.db` à conserver sur un support chiffré.

## Paramètres, mot de passe et export complet (menu Réglages > Paramètres)
- **Nom de l'application** : le nom affiché à côté du logo (et dans le titre de la fenêtre) se change dans Paramètres ; « Valeur d'origine » rétablit « Gestion Psy ».
- **Mot de passe (facultatif, un seul utilisateur)** : à l'activation, une **clé de secours** est affichée une seule fois (à noter hors de l'ordinateur) ; elle permet de définir un nouveau mot de passe si on l'oublie. Sans la clé, il n'y a aucun moyen de récupérer le mot de passe.
  - Verrouillage automatique après 5 / 10 / 15 / 30 / 60 minutes d'inactivité (ou jamais), bouton « Verrouiller » dans le menu, et verrouillage à chaque redémarrage de l'application.
  - Après 5 essais ratés, l'appli impose une attente croissante. Le mot de passe et la clé sont stockés hachés (scrypt), jamais en clair.
  - **Limite importante** : le mot de passe verrouille l'*accès à l'application*, il ne *chiffre pas* `cabinet.db`. Pour protéger le fichier lui-même (vol de l'ordinateur), chiffrer le disque ou le volume (BitLocker, VeraCrypt…).
- **Export complet (zip)** : tableurs `patients.csv` et `seances.csv`, un fichier Word par patient (`dossiers/`), `donnees-completes.json` (copie intégrale structurée), `SCHEMA-BASE-DE-DONNEES.txt` (description des tables) et un `LISEZ-MOI.txt`. Lisible sans l'application : c'est la garantie de ne rien perdre si l'application n'est plus maintenue.
- **Rappel d'export** : un bandeau sur la page Patients apparaît si aucun export complet n'a été fait depuis plus de 30 jours (« Plus tard » le repousse de 7 jours).
- Un fichier `LISEZ-MOI-DONNEES.txt` (description des tables, générée automatiquement) est aussi rangé à côté de `cabinet.db`, dans le dossier des données.

## Application de bureau (Mac / Windows)
Le prototype peut être emballé en vraie application (fenêtre unique, sans navigateur, sans Node à installer pour l'utilisateur final) avec Electron.
- **Mac** : double-clic sur `Construire-Mac.command` (Node.js 22+ et internet requis la 1re fois). Le résultat est dans `dist/` : un `.dmg` à ouvrir, puis glisser **Gestion Psy** dans Applications.
  L'application n'est pas signée : au 1er lancement, clic droit sur Gestion Psy > **Ouvrir** (ou Réglages Système > Confidentialité et sécurité > « Ouvrir quand même »).
- **Windows** : `npm install` puis `npm run dist:win` (fonctionne aussi depuis un Mac) : installateur `.exe` dans `dist/`. Windows affichera l'avertissement SmartScreen (non signé) : « Informations complémentaires » > « Exécuter quand même ».
- **Dossier des données au choix** : au tout premier lancement, l'appli demande où ranger les données (dossier par défaut, ou « Choisir un dossier… », par exemple `D:\` sur un volume chiffré VeraCrypt). Le choix est mémorisé (petit fichier `config.json` dans le dossier de l'application : Mac `~/Library/Application Support/Gestion Psy/`, Windows `%APPDATA%\Gestion Psy\`). Une mise à jour de l'application ne touche pas aux données.
  - Si le dossier est introuvable au lancement (volume pas monté, disque débranché), l'appli **ne crée jamais de base vide en silence** : elle propose Réessayer / Choisir un autre dossier / Quitter.
  - Si le dossier existe mais ne contient plus la base, elle prévient avant de créer une base vide.
  - Si le dossier disparaît pendant l'utilisation, l'appli se ferme après un message. Fermer l'appli **avant** de démonter un volume.
  - **Paramètres > Dossier des données > Changer le dossier…** (ou menu **Aide > Changer le dossier des données…**) : copie les données vers un nouveau dossier (ou reprend une base qui s'y trouve déjà) puis redémarre. L'ancien dossier n'est pas effacé : le supprimer soi-même une fois que tout fonctionne.
  - Menu **Aide > Ouvrir le dossier des données**.
- L'installateur Windows propose aussi de choisir le dossier d'installation du programme (distinct des données).
- Au tout premier lancement, quelques patients fictifs sont créés (réglage `demoAuPremierLancement` dans `package.json`, à passer à `false` pour la version de Claire).
- Les anciennes données du lanceur Node (`data/` dans ce dossier) ne sont pas reprises automatiquement : copier `cabinet.db` dans le dossier des données ci-dessus, application fermée.

## Données
Tout est dans `data/cabinet.db` (SQLite). L'appli n'écoute que sur cet ordinateur (127.0.0.1).
Aucune donnée n'est envoyée sur internet.

## Mettre à jour l'application sans rien perdre
1. Fermer l'appli. Cliquer sur « Sauvegarder les données » avant, par habitude.
2. Remplacer les fichiers de l'application par ceux de la nouvelle version, **sauf le dossier `data/`** qui contient les patients, les séances et les modèles.
3. Relancer. Si la structure a évolué, l'appli copie d'abord la base dans `data/sauvegardes/`, puis applique la mise à jour sur les données existantes.
- Une mise à jour qui échoue est annulée en bloc : la base reste exactement comme avant.
- Une ancienne version refuse d'ouvrir une base plus récente (pas de dégâts possibles).
- Les modèles de séance sont dans la base : ils ne sont jamais écrasés par une mise à jour.

## Pas encore fait (à décider ensemble)
Champs personnalisés,
chiffrement du fichier de données, impression d'une facture / attestation.
