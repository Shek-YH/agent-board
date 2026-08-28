#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be provided by the server environment}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/agent-board/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

case "$RETENTION_DAYS" in
  ''|*[!0-9]*) echo 'RETENTION_DAYS must be a non-negative integer' >&2; exit 2 ;;
esac

umask 077
mkdir -p -- "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/agent_board_${timestamp}.dump"

pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > "$target"
test -s "$target"
pg_restore --list "$target" >/dev/null

find "$BACKUP_DIR" -type f -name 'agent_board_*.dump' -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$target"
