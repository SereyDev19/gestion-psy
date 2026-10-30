#!/bin/bash
# Double-clic sur Mac : démarre l'appli et ouvre le navigateur
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  osascript -e 'display dialog "Node.js (version 22.13 ou plus) est nécessaire pour ce prototype. Installez-le depuis nodejs.org puis relancez." buttons {"OK"}'
  exit 1
fi
[ -d data ] || DEMO=1   # premier lancement : quelques patients fictifs pour essayer
export DEMO
if lsof -ti :4173 >/dev/null 2>&1; then
  echo "⚠ Le port 4173 est déjà utilisé : une ancienne instance de l'appli tourne encore."
  read -p "Appuyez sur Entrée pour l'arrêter et démarrer la nouvelle version (ou fermez cette fenêtre pour annuler)… "
  lsof -ti :4173 | xargs kill; sleep 1
fi
( sleep 1.5; open "http://localhost:4173" ) &
node --no-warnings server.js
