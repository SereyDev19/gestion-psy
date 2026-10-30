# Gestion Psy

Application de bureau locale de gestion des patients et des consultations (Electron + Node, base SQLite, aucune dépendance web).
Toutes les données restent sur l'ordinateur, **hors de ce dépôt** : ne jamais y ajouter de base (`.db`), de sauvegarde ni d'export.

Voir `LISEZMOI.md` pour les fonctions et l'utilisation.

## Développement

```bash
npm install
npm start          # serveur seul sur http://localhost:4173 (Node 22+)
npm run electron   # application de bureau
```

## Publier une version

1. Modifier, tester, puis augmenter `version` dans `package.json` (ex. `0.22.1`).
2. `git add . && git commit -m "Description" && git push`
3. `git tag v0.22.1 && git push origin v0.22.1` : GitHub Actions construit l'installateur Windows et l'application Mac, puis les publie dans **Releases**.
4. L'application Windows installée propose la mise à jour à l'ouverture (Paramètres > Rechercher une mise à jour). Sur Mac : `Mettre-a-jour-Mac.command`.

L'étiquette doit être exactement `v` + la version de `package.json`, sinon la construction s'arrête.
