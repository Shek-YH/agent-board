#!/usr/bin/env sh
set -eu

: "${BACKUP_FILE:?BACKUP_FILE must point to a verified pg_dump custom-format file}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL must be provided by the server environment}"
if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo 'Restore is destructive. Set CONFIRM_RESTORE=YES after verifying the target database.' >&2
  exit 2
fi

test -f "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$TARGET_DATABASE_URL" "$BACKUP_FILE"
