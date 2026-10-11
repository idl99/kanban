#!/usr/bin/env bash
# ckanban installer (macOS).
#   curl -fsSL https://raw.githubusercontent.com/leoawesome/kanban/main/install.sh | bash
# Env: CKANBAN_VERSION=0.1.0 (default: latest)  CKANBAN_BIN_DIR=~/.local/bin  CKANBAN_NO_DAEMON=1 (skip launchd)
# The binary is checked against the release's SHA256SUMS before it is installed
# (CKANBAN_DOWNLOAD_URL / CKANBAN_SUMS_URL override both URLs, e.g. for testing).
set -euo pipefail

REPO="leoawesome/kanban"
BIN_DIR="${CKANBAN_BIN_DIR:-$HOME/.local/bin}"
VERSION="${CKANBAN_VERSION:-latest}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "ckanban currently supports macOS only."
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac

ASSET="ckanban-darwin-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION#v}/${ASSET}"
fi

URL="${CKANBAN_DOWNLOAD_URL:-$URL}"
SUMS_URL="${CKANBAN_SUMS_URL:-${URL%/*}/SHA256SUMS}"
bold "Installing ckanban (${VERSION}, darwin-${ARCH})"
mkdir -p "$BIN_DIR"
TMP="$(mktemp -t ckanban)"
SUMS="$(mktemp -t ckanban-sums)"
trap 'rm -f "$TMP" "$SUMS"' EXIT
curl -fL --progress-bar -o "$TMP" "$URL" || die "Download failed: $URL"
curl -fsSL -o "$SUMS" "$SUMS_URL" || die "Couldn't download the checksums ($SUMS_URL), so the binary can't be verified. Nothing was installed."
WANT="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$SUMS")"
[ -n "$WANT" ] || die "SHA256SUMS has no entry for $ASSET. Nothing was installed."
GOT="$(shasum -a 256 "$TMP" | awk '{ print $1 }')"
[ "$GOT" = "$WANT" ] || die "Checksum mismatch for $ASSET: expected $WANT, got $GOT. The download may be corrupt or tampered with. Nothing was installed."
echo "✓ Checksum verified"
chmod 755 "$TMP"
xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
mv "$TMP" "$BIN_DIR/ckanban"
rm -f "$SUMS"
trap - EXIT
echo "✓ Installed $BIN_DIR/ckanban ($("$BIN_DIR/ckanban" --version))"

missing=0
command -v claude >/dev/null 2>&1 || { warn "claude CLI not found. Install Claude Code: https://claude.com/claude-code"; missing=1; }
command -v git >/dev/null 2>&1 || { warn "git not found (xcode-select --install)"; missing=1; }
command -v gh >/dev/null 2>&1 || warn "gh CLI not found: PR features disabled (brew install gh && gh auth login)"

if [ -z "${CKANBAN_NO_DAEMON:-}" ]; then
  "$BIN_DIR/ckanban" install
  sleep 1
  open "http://localhost:7777" 2>/dev/null || true
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to ~/.zshrc:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
bold "Done. Board: http://localhost:7777"
echo "Update later with: ckanban update"
[ "$missing" = 0 ] || warn "Install the missing tools above, then run: ckanban restart"
