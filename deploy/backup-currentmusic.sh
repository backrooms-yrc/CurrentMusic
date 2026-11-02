#!/usr/bin/env bash
# Daily full backup for a self-hosted CurrentMusic backend.
#
# Contents:
#   - consistent SQLite snapshot of CM_DATA_DIR/cm.db
#   - every other entry in CM_DATA_DIR except:
#       cast/          (regenerable audio cache)
#       cm.db*         (old/rotated DB copies; the fresh snapshot is included)
#   - releases / releases-x / avatars / decorations / chat / share / app / www
#
# Retention: keep the newest CM_BACKUP_KEEP archives (default 3). A new daily
# archive therefore rotates out the oldest one, which is the "three days" policy.
#
# Environment:
#   CM_DATA_DIR    default /srv/currentmusic/data
#   CM_BACKUP_DIR  default /var/backups/currentmusic
#   CM_BACKUP_KEEP default 3
set -euo pipefail
umask 077

DATA_DIR="${CM_DATA_DIR:-/srv/currentmusic/data}"
BACKUP_DIR="${CM_BACKUP_DIR:-/var/backups/currentmusic}"
KEEP="${CM_BACKUP_KEEP:-3}"
DB="$DATA_DIR/cm.db"
STAMP="$(date +%F)"
ARCHIVE="$BACKUP_DIR/currentmusic-$STAMP.tar.gz"
TMP="$ARCHIVE.tmp"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

if [[ ! -f "$DB" ]]; then
  log "ERROR database not found: $DB"
  exit 1
fi
case "$KEEP" in
  ''|*[!0-9]*|0) log "ERROR invalid CM_BACKUP_KEEP=$KEEP"; exit 1 ;;
esac

install -d -m 700 "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.lock"
if ! flock -n 9; then
  log "another backup is already running; skip"
  exit 0
fi

# Do not start a backup that cannot fit alongside the retained copies.
AVAIL_KB="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [[ -n "$AVAIL_KB" && "$AVAIL_KB" -lt 2097152 ]]; then
  log "ERROR less than 2 GiB free on backup volume ($AVAIL_KB KiB)"
  exit 1
fi

STAGE="$(mktemp -d "$BACKUP_DIR/.stage-XXXXXX")"
cleanup() { rm -rf "$STAGE" "$TMP"; }
trap cleanup EXIT

log "backup start: data=$DATA_DIR archive=$ARCHIVE"
sqlite3 "$DB" ".backup '$STAGE/cm.db'"
if [[ "$(sqlite3 "$STAGE/cm.db" 'PRAGMA integrity_check;')" != "ok" ]]; then
  log "ERROR SQLite snapshot integrity check failed"
  exit 1
fi

# Full data payload, minus the audio cache and rotated/old DB copies.
find "$DATA_DIR" -mindepth 1 -maxdepth 1 \
  ! -name 'cm.db' ! -name 'cm.db-*' ! -name 'cm.db.*' ! -name 'cast' \
  -exec cp -a {} "$STAGE/" \;

nice -n 10 tar -czf "$TMP" -C "$STAGE" .
mv -f "$TMP" "$ARCHIVE"
chmod 600 "$ARCHIVE"
log "archive written: $(du -h "$ARCHIVE" | awk '{print $1}')"

# Keep the newest KEEP archives; remove older ones after a successful archive.
mapfile -t OLD < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'currentmusic-*.tar.gz' \
    -printf '%T@ %p\n' | sort -n | head -n "-$KEEP" | cut -d' ' -f2-
)
for f in "${OLD[@]}"; do
  [[ -n "$f" ]] || continue
  rm -f -- "$f"
  log "removed old archive: $(basename "$f")"
done

log "backup done; retained $(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'currentmusic-*.tar.gz' | wc -l) archive(s)"
