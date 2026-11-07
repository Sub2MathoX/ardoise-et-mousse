#!/bin/sh
set -eu
umask 077
mkdir -p /backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/backups/ardoise-$stamp-$$.dump"
temporary="$target.tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$temporary"
mv "$temporary" "$target"
# Conservation locale de trente jours, uniquement après une sauvegarde réussie.
find /backups -maxdepth 1 -type f -name 'ardoise-*.dump' -mtime +30 -delete
printf 'Sauvegarde créée : %s\n' "$target"
