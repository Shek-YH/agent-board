#!/usr/bin/env sh
set -eu

STACK_DIR="${STACK_DIR:-$(pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/agent-board/config}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/agent_board_config_${timestamp}.tar.gz"

test -f "$STACK_DIR/compose.yaml"
test -f "$STACK_DIR/prisma/schema.prisma"
umask 077
mkdir -p -- "$BACKUP_DIR"
tar -czf "$archive" -C "$STACK_DIR" \
  compose.yaml Dockerfile apps/admin/Dockerfile prisma/schema.prisma prisma/migrations
test -s "$archive"
printf '%s\n' "$archive"
