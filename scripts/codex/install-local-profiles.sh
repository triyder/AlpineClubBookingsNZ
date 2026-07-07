#!/usr/bin/env bash
set -euo pipefail

INSTALL=0
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/codex/install-local-profiles.sh [--dry-run] [--install] [--codex-home DIR]

Dry-run by default. With --install, copies docs/agents/codex/profiles/*.config.toml into
the Codex home directory. Review files before installing.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)
      INSTALL=1
      shift
      ;;
    --dry-run)
      INSTALL=0
      shift
      ;;
    --codex-home)
      CODEX_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-local-profiles: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

echo "Profile source: docs/agents/codex/profiles"
echo "Profile target: $CODEX_DIR"

if [[ "$INSTALL" -ne 1 ]]; then
  echo "Dry run only. Re-run with --install to copy profile examples."
  for file in docs/agents/codex/profiles/*.config.toml; do
    echo "would copy $file -> $CODEX_DIR/$(basename "$file")"
  done
  exit 0
fi

mkdir -p "$CODEX_DIR"
for file in docs/agents/codex/profiles/*.config.toml; do
  cp "$file" "$CODEX_DIR/$(basename "$file")"
  echo "installed $CODEX_DIR/$(basename "$file")"
done
