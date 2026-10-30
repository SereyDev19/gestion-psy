#!/bin/bash
# Double-clic sur Mac : fabrique l'application « Gestion Psy » (dossier dist/). Nécessite Node.js et une connexion internet (téléchargement d'Electron la première fois).
cd "$(dirname "$0")"
if ! command -v npm >/dev/null; then
  osascript -e 'display dialog "Node.js (version 22 ou plus) est nécessaire. Installez-le depuis nodejs.org puis relancez." buttons {"OK"}'
  exit 1
fi
npm install && npm run dist:mac && open dist
echo; echo "Terminé. L'application est dans le dossier « dist » (fichier .dmg : glissez Gestion Psy dans Applications)."
read -p "Appuyez sur Entrée pour fermer… "
