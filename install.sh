#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
BUN_ROOT="$DATA_HOME/mr-orchestrator/toolchains/bun"
BUN="$BUN_ROOT/bin/bun"
BUN_VERSION="1.2.21"

if [ ! -x "$BUN" ]; then
  command -v curl >/dev/null 2>&1 || { printf '%s\n' "curl is required to install Bun." >&2; exit 1; }
  command -v unzip >/dev/null 2>&1 || { printf '%s\n' "unzip is required to install Bun." >&2; exit 1; }
  printf '%s\n' "Installing isolated Bun $BUN_VERSION in $BUN_ROOT"
  # SHELL is deliberately unsupported so Bun's installer cannot edit shell rc files.
  curl -fsSL https://bun.com/install | BUN_INSTALL="$BUN_ROOT" SHELL=/bin/false bash -s -- "bun-v$BUN_VERSION"
fi

"$BUN" install --registry https://registry.npmjs.org --frozen-lockfile
"$BUN" run build
exec "$BUN" "$SCRIPT_DIR/dist/src/cli.js" install "$@"
