#!/bin/bash
# Double-clic sur Mac : fabrique la nouvelle version de « Gestion Psy » ET la met à la place de l'ancienne dans Applications.
# Les données ne sont pas touchées (elles sont dans leur propre dossier) ; elles sont migrées automatiquement au prochain lancement,
# avec une copie de sécurité avant.
cd "$(dirname "$0")"
if ! command -v npm >/dev/null; then
  osascript -e 'display dialog "Node.js (version 22 ou plus) est nécessaire. Installez-le depuis nodejs.org puis relancez." buttons {"OK"}'
  exit 1
fi
echo "1/3  Fabrication de la nouvelle version (quelques minutes)…"
npm install && npm run dist:mac || { echo "La fabrication a échoué."; read -p "Entrée pour fermer… "; exit 1; }
APP=$(ls -d dist/mac*/"Gestion Psy.app" 2>/dev/null | head -1)
if [ -z "$APP" ]; then echo "Application introuvable dans dist/."; read -p "Entrée pour fermer… "; exit 1; fi
echo "2/3  Fermeture de l'ancienne version…"
osascript -e 'tell application "Gestion Psy" to quit' >/dev/null 2>&1
sleep 2; pkill -x "Gestion Psy" >/dev/null 2>&1
echo "3/3  Remplacement dans Applications…"
rm -rf "/Applications/Gestion Psy.app"
cp -R "$APP" "/Applications/Gestion Psy.app" || { echo "Copie impossible."; read -p "Entrée pour fermer… "; exit 1; }
xattr -dr com.apple.quarantine "/Applications/Gestion Psy.app" >/dev/null 2>&1
open "/Applications/Gestion Psy.app"
echo; echo "Terminé : Gestion Psy $(node -p "require('./package.json').version") est installée dans Applications."
read -p "Appuyez sur Entrée pour fermer… "
