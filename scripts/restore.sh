#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo 'Usage : sh scripts/restore.sh backups/ardoise-YYYYMMDDTHHMMSSZ-PID.dump' >&2
  exit 1
fi
printf 'Cette restauration remplace les comptes actuels. Saisir RESTAURER : '
read -r answer
[ "$answer" = RESTAURER ] || exit 1
# Vérifier le format avant d'arrêter le service.
docker compose exec -T db pg_restore --list < "$1" > /dev/null
docker compose stop app backup
if docker compose exec -T db pg_restore -U ardoise -d ardoise --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error < "$1"; then
  docker compose start app backup
  echo 'Restauration terminée.'
else
  echo 'Échec : transaction annulée. Application et sauvegardes arrêtées pour vérification.' >&2
  exit 1
fi
