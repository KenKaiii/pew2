#!/bin/sh
#
# pew2 installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh
#
# Downloads one self-contained binary. No Node, no Bun, no git clone. The
# runtime is compiled into the executable, which is the whole point: someone who
# installed the phone app should not have to set up a development environment to
# use it.
#
# Deliberately short and readable. Piping a script from the internet into a
# shell is a real trust ask, and the only honest answer to it is a script you
# can read in a minute.

set -eu

REPO="KenKaiii/pew2"
# ~/.local/bin rather than /usr/local/bin: no sudo, and it is on PATH by default
# on most systems. PEW2_INSTALL_DIR overrides for anyone who wants elsewhere.
INSTALL_DIR="${PEW2_INSTALL_DIR:-$HOME/.local/bin}"

# Colour only when writing to a terminal. Piped into a file or a log, escape
# codes are noise.
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; GREEN=''; RED=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }
ok()   { printf '  %s%s%s %s\n' "$GREEN" "✓" "$RESET" "$*"; }
die()  { printf '\n  %s%s%s %s\n\n' "$RED" "✗" "$RESET" "$*" >&2; exit 1; }

say ""
say "  ${BOLD}pew2${RESET}"
say "  ${DIM}your coding agents, on your phone${RESET}"
say ""

# --- which build ------------------------------------------------------------

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os_name="darwin" ;;
  Linux)  os_name="linux" ;;
  *) die "pew2 does not have a build for $os yet. On Windows, use the PowerShell installer instead." ;;
esac

case "$arch" in
  arm64|aarch64) arch_name="arm64" ;;
  x86_64|amd64)  arch_name="x64" ;;
  *) die "No build for $arch. If you think there should be, open an issue and say what machine this is." ;;
esac

asset="pew2-${os_name}-${arch_name}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

step "${DIM}Downloading for ${os_name} ${arch_name}...${RESET}"

# --- download ---------------------------------------------------------------

tmp=$(mktemp -d)
# Cleans up on failure too, so a half-downloaded binary is never left behind.
trap 'rm -rf "$tmp"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/pew2" || die "Download failed. Check your connection, or grab it by hand from github.com/${REPO}/releases"
  curl -fsSL "$url.sha256" -o "$tmp/pew2.sha256" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/pew2" "$url" || die "Download failed. Check your connection, or grab it by hand from github.com/${REPO}/releases"
  wget -qO "$tmp/pew2.sha256" "$url.sha256" 2>/dev/null || true
else
  die "Need curl or wget to download. Install one and run this again."
fi

# A truncated download produces a file that exists and cannot run, which fails
# later in a way that looks like a bug in pew2 rather than a bad transfer.
[ -s "$tmp/pew2" ] || die "The download came out empty. Try again."

# --- verify -----------------------------------------------------------------

# Best effort: not every platform ships the same checksum tool, and refusing to
# install because `sha256sum` is missing would be worse than the check itself.
if [ -s "$tmp/pew2.sha256" ]; then
  expected=$(awk '{print $1}' "$tmp/pew2.sha256")
  actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/pew2" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp/pew2" | awk '{print $1}')
  fi
  if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
    die "The download does not match its checksum. Not installing it. Try again, and if it keeps happening, report it."
  fi
  [ -n "$actual" ] && ok "Checksum verified"
fi

# --- install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/pew2"
mv "$tmp/pew2" "$INSTALL_DIR/pew2" || die "Could not write to $INSTALL_DIR. Set PEW2_INSTALL_DIR to somewhere you can write."

ok "Installed to ${INSTALL_DIR}/pew2"

# macOS quarantines anything downloaded, and the first run dies with a Gatekeeper
# dialog that says nothing useful. Stripping the flag here turns that into a
# working command; the binary is still unsigned, which the README says plainly.
if [ "$os_name" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/pew2" 2>/dev/null || true
fi

# --- PATH -------------------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

if [ "$on_path" = "0" ]; then
  say ""
  say "  ${BOLD}One more thing:${RESET} ${INSTALL_DIR} is not on your PATH."
  say "  ${DIM}Paste this, then reopen your terminal:${RESET}"
  say ""
  case "${SHELL:-}" in
    */zsh)  rc="~/.zshrc" ;;
    */bash) rc="~/.bashrc" ;;
    */fish) rc="~/.config/fish/config.fish" ;;
    *)      rc="your shell's startup file" ;;
  esac
  if [ "${rc}" = "~/.config/fish/config.fish" ]; then
    say "    ${BOLD}fish_add_path $INSTALL_DIR${RESET}"
  else
    say "    ${BOLD}echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $rc${RESET}"
  fi
  say ""
fi

say ""
say "  ${BOLD}Done.${RESET} Next, run:"
say ""
say "    ${BOLD}pew2 setup${RESET}"
say ""
say "  ${DIM}It finds your coding agents, gets them running, and shows the${RESET}"
say "  ${DIM}code you scan with the app.${RESET}"
say ""
