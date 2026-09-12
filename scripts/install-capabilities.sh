#!/bin/sh
set -eu

BUN=${1:?"usage: install-capabilities.sh /absolute/path/to/bun"}
shift
SELECTED=" $* "
[ "$#" -gt 0 ] || SELECTED=" i-have-adhd codebase-memory codegraph context7 engram github jira figma-live "
DATA_HOME=${XDG_DATA_HOME:-"$HOME/.local/share"}
ROOT="$DATA_HOME/mr-orchestrator/capabilities"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/mr-capabilities.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

command -v curl >/dev/null 2>&1 || { printf '%s\n' "curl is required to install recommended capabilities." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' "tar is required to install recommended capabilities." >&2; exit 1; }

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else printf '%s\n' "shasum or sha256sum is required." >&2; exit 1; fi
}

download_verified() {
  url=$1 expected=$2 output=$3
  curl -fsSL --retry 3 --retry-delay 1 -o "$output" "$url"
  actual=$(sha256_file "$output")
  [ "$actual" = "$expected" ] || {
    printf '%s\n' "Checksum mismatch for $url" >&2
    exit 1
  }
}

want() { case "$SELECTED" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS/$ARCH" in
  Darwin/arm64)
    CBM_ASSET=codebase-memory-mcp-darwin-arm64.tar.gz
    CBM_SHA=9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07
    CODEGRAPH_ASSET=codegraph-darwin-arm64.tar.gz
    CODEGRAPH_SHA=1c73033512d55f67be04717e81532e8beaf7be6fb8531f51a179fa23064ad480
    ENGRAM_ASSET=engram_1.20.0_darwin_arm64.tar.gz
    ENGRAM_SHA=2363d5012f23e58878f86c3ddcc1f63cfe9dcf3eec7f413e70eaafcbb9d394cc
    ;;
  Darwin/x86_64)
    CBM_ASSET=codebase-memory-mcp-darwin-amd64.tar.gz
    CBM_SHA=2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4
    CODEGRAPH_ASSET=codegraph-darwin-x64.tar.gz
    CODEGRAPH_SHA=cb86a2b62ee676b62a56bf8423600e7d867e752e57f323cdc98c0f6236efd908
    ENGRAM_ASSET=engram_1.20.0_darwin_amd64.tar.gz
    ENGRAM_SHA=3b9015dcfcdd9f823eb7ad0b590b1dbc4c25bb5d81dda3f84e623709815afe80
    ;;
  Linux/aarch64|Linux/arm64)
    CBM_ASSET=codebase-memory-mcp-linux-arm64-portable.tar.gz
    CBM_SHA=5697d986d9716c913163b4bff7b3a294287f3b843e993bc1ff71e78dcdc21781
    CODEGRAPH_ASSET=codegraph-linux-arm64.tar.gz
    CODEGRAPH_SHA=6dc935a7b8f1a61e688a578b98ea34680eb2e36d7b91db079d64f4011f1a668f
    ENGRAM_ASSET=engram_1.20.0_linux_arm64.tar.gz
    ENGRAM_SHA=7eb815910a76ae6cfa9a5d0161d3701e293dcca71f7743cffa62e236e5af59af
    ;;
  Linux/x86_64)
    CBM_ASSET=codebase-memory-mcp-linux-amd64-portable.tar.gz
    CBM_SHA=6eef49652bc0c7820f43114125044d40bf7f4d97c11b2592f6b0f6a307702325
    CODEGRAPH_ASSET=codegraph-linux-x64.tar.gz
    CODEGRAPH_SHA=de3391f79ed42622d937e6cd5b7642a7ea8bb7d1473607e80b879ba73ef216b0
    ENGRAM_ASSET=engram_1.20.0_linux_amd64.tar.gz
    ENGRAM_SHA=7dc3003318e303bee269a4772144f3ce01c8ec700bfd524aaec76770acd389ca
    ;;
  *) printf '%s\n' "Unsupported capability platform: $OS/$ARCH" >&2; exit 1 ;;
esac

mkdir -p "$ROOT"

CBM_DIR="$ROOT/codebase-memory/v0.10.8"
if want codebase-memory && [ ! -x "$CBM_DIR/codebase-memory-mcp" ]; then
  printf '%s\n' "Installing codebase-memory v0.10.8"
  download_verified "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.10.8/$CBM_ASSET" "$CBM_SHA" "$TMP/cbm.tar.gz"
  rm -rf "$CBM_DIR" && mkdir -p "$CBM_DIR"
  tar -xzf "$TMP/cbm.tar.gz" -C "$CBM_DIR"
  chmod 755 "$CBM_DIR/codebase-memory-mcp"
fi

CODEGRAPH_DIR="$ROOT/codegraph/v1.6.0"
if want codegraph && [ ! -x "$CODEGRAPH_DIR/bin/codegraph" ]; then
  printf '%s\n' "Installing CodeGraph v1.6.0"
  download_verified "https://github.com/colbymchenry/codegraph/releases/download/v1.6.0/$CODEGRAPH_ASSET" "$CODEGRAPH_SHA" "$TMP/codegraph.tar.gz"
  rm -rf "$CODEGRAPH_DIR" && mkdir -p "$CODEGRAPH_DIR"
  tar -xzf "$TMP/codegraph.tar.gz" --strip-components=1 -C "$CODEGRAPH_DIR"
  chmod 755 "$CODEGRAPH_DIR/bin/codegraph"
fi

ENGRAM_DIR="$ROOT/engram/v1.20.0"
if want engram && [ ! -x "$ENGRAM_DIR/engram" ]; then
  printf '%s\n' "Installing Engram v1.20.0"
  download_verified "https://github.com/Gentleman-Programming/engram/releases/download/v1.20.0/$ENGRAM_ASSET" "$ENGRAM_SHA" "$TMP/engram.tar.gz"
  rm -rf "$ENGRAM_DIR" && mkdir -p "$ENGRAM_DIR"
  tar -xzf "$TMP/engram.tar.gz" -C "$ENGRAM_DIR"
  chmod 755 "$ENGRAM_DIR/engram"
fi

ADHD_REF=6f1f982d0a47c65899af3c5a7450b7098bc65325
ADHD_DIR="$ROOT/i-have-adhd/$ADHD_REF"
if want i-have-adhd && [ ! -f "$ADHD_DIR/skills/i-have-adhd/SKILL.md" ]; then
  printf '%s\n' "Installing i-have-adhd skill at $ADHD_REF"
  download_verified "https://github.com/ayghri/i-have-adhd/archive/$ADHD_REF.tar.gz" 6e600a79a56d76d87748486f2220299c28ef676b69c649f04d215a8b3df60c61 "$TMP/adhd.tar.gz"
  rm -rf "$ADHD_DIR" && mkdir -p "$ADHD_DIR"
  tar -xzf "$TMP/adhd.tar.gz" --strip-components=1 -C "$ADHD_DIR"
fi

FIGMA_REF=942c719a0ebd2afa9c8076ea0ae1ae61f01b7626
FIGMA_DIR="$ROOT/figma-live-mcp/$FIGMA_REF"
if want figma-live && [ ! -x "$FIGMA_DIR/dist/figma-live-mcp" ]; then
  printf '%s\n' "Building figma-live-mcp at $FIGMA_REF"
  download_verified "https://github.com/marioccarloss/figma-live-mcp/archive/$FIGMA_REF.tar.gz" 2d27fe285d68dd948383d99c5192123a65d5f0bf3f043d78de44fd779c06928c "$TMP/figma.tar.gz"
  rm -rf "$FIGMA_DIR" && mkdir -p "$FIGMA_DIR"
  tar -xzf "$TMP/figma.tar.gz" --strip-components=1 -C "$FIGMA_DIR"
  # figma-live-mcp's text lockfile is produced by a newer Bun generation than
  # the isolated 1.2 runtime. The source archive itself is SHA-pinned; allow
  # Bun to normalize the lockfile locally before compiling the standalone binary.
  "$BUN" install --cwd "$FIGMA_DIR" --registry https://registry.npmjs.org
  "$BUN" run --cwd "$FIGMA_DIR" build
  "$BUN" run --cwd "$FIGMA_DIR" compile
  chmod 755 "$FIGMA_DIR/dist/figma-live-mcp"
fi

cat > "$ROOT/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "codebaseMemory": "v0.10.8",
  "codegraph": "v1.6.0",
  "engram": "v1.20.0",
  "iHaveAdhd": "$ADHD_REF",
  "figmaLive": "$FIGMA_REF",
  "selected": "$(printf '%s' "$SELECTED" | sed 's/^ *//; s/ *$//')"
}
EOF

printf '%s\n' "Recommended capabilities installed."
if want figma-live; then printf '%s\n' "Figma manual step: import $FIGMA_DIR/packages/figma-plugin/manifest.json"; fi
if want github || want jira; then printf '%s\n' "GitHub and Jira authentication remains user-controlled in the MCP client."; fi
