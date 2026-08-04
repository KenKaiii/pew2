#!/bin/sh
#
# pew2 installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh
#
# Downloads one self-contained binary. No Node, no Bun, no git clone. The
# runtime is compiled into the executable, which is the whole point: someone who
# installed the phone app should not have to set up a development environment.
#
# Deliberately short and readable. Piping a script from the internet into a
# shell is a real trust ask, and the only honest answer is a script you can read
# in a minute.
#
# The layout is the same vertical rail `pew2 setup` uses, so the two read as one
# product rather than two tools that happen to ship together. Every line hangs
# off the rail at the same column; nothing is indented by eye.

set -eu

REPO="KenKaiii/pew2"
# ~/.local/bin rather than /usr/local/bin: no sudo, and it is on PATH by default
# on most systems. PEW2_INSTALL_DIR overrides for anyone who wants elsewhere.
INSTALL_DIR="${PEW2_INSTALL_DIR:-$HOME/.local/bin}"

# Colour and box drawing only when writing to a terminal. Piped into a file or a
# CI log, escape codes are noise and the glyphs are mojibake.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
  ACCENT=$(printf '\033[38;5;209m'); GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m')
  BAR="│"; OPEN="◆"; STEP="◇"; END="└"; TICK="✓"; CROSS="✗"
else
  B=''; D=''; R=''; ACCENT=''; GREEN=''; RED=''
  BAR="|"; OPEN="*"; STEP="o"; END="\`"; TICK="+"; CROSS="x"
fi

# One prefix for every line, so alignment is structural rather than counted out
# by hand. This is what the old version got wrong: text landed at column 2 or 4
# depending on whether it had a glyph in front of it.
bar()  { printf '%s%s%s\n' "$D" "$BAR" "$R"; }
line() { printf '%s%s%s  %s\n' "$D" "$BAR" "$R" "$1"; }
step() { bar; printf '%s%s%s  %s%s%s\n' "$ACCENT" "$STEP" "$R" "$B" "$1" "$R"; }
die() {
  bar
  printf '%s%s%s  %s%s%s\n' "$RED" "$CROSS" "$R" "$B" "$1" "$R" >&2
  [ $# -gt 1 ] && printf '   %s%s%s\n' "$D" "$2" "$R" >&2
  printf '\n' >&2
  exit 1
}

printf '\n%s%s%s  %spew2%s\n' "$ACCENT" "$OPEN" "$R" "$B" "$R"
line "${D}your coding agents, on your phone${R}"

# --- which build ------------------------------------------------------------

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) os_name="darwin" ;;
  Linux)  os_name="linux" ;;
  *) die "No build for $os yet." "On Windows, use the PowerShell installer instead." ;;
esac

case "$arch" in
  arm64|aarch64) arch_name="arm64" ;;
  x86_64|amd64)  arch_name="x64" ;;
  *) die "No build for $arch." "Open an issue and say what machine this is." ;;
esac

asset="pew2-${os_name}-${arch_name}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

# --- download ---------------------------------------------------------------

step "Downloading  ${D}${os_name} ${arch_name}${R}"
bar

tmp=$(mktemp -d)
# Cleans up on failure too, so a half-downloaded binary is never left behind.
trap 'rm -rf "$tmp"' EXIT INT TERM

# The binary is around 60MB, which is long enough on a slow connection that a
# silent wait reads as a hang. `--progress-bar` is curl's own meter: it writes
# to stderr, redraws in place, and costs nothing.
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --progress-bar --output "$tmp/pew2" "$url" \
    || die "Download failed." "Check your connection, or grab it from github.com/${REPO}/releases"
  curl -fsSL "$url.sha256" -o "$tmp/pew2.sha256" 2>/dev/null || true
elif command -v wget >/dev/null 2>&1; then
  wget --show-progress -qO "$tmp/pew2" "$url" \
    || die "Download failed." "Check your connection, or grab it from github.com/${REPO}/releases"
  wget -qO "$tmp/pew2.sha256" "$url.sha256" 2>/dev/null || true
else
  die "Need curl or wget." "Install one and run this again."
fi

# A truncated download produces a file that exists and cannot run, which fails
# later in a way that looks like a bug in pew2 rather than a bad transfer.
[ -s "$tmp/pew2" ] || die "The download came out empty." "Try again."

bar

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
    die "That download does not match its checksum." "Not installing it. Try again, and report it if it keeps happening."
  fi
  [ -n "$actual" ] && line "${GREEN}${TICK}${R} Checksum verified"
fi

# --- install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/pew2"
mv "$tmp/pew2" "$INSTALL_DIR/pew2" \
  || die "Could not write to $INSTALL_DIR." "Set PEW2_INSTALL_DIR to somewhere you can write."

line "${GREEN}${TICK}${R} Installed to ${D}${INSTALL_DIR}/pew2${R}"

# macOS quarantines anything downloaded, and the first run dies with a Gatekeeper
# dialog that says nothing useful. Stripping the flag turns that into a working
# command; the binary is still unsigned, which the README says plainly.
if [ "$os_name" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/pew2" 2>/dev/null || true
fi

# --- PATH -------------------------------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*) on_path=1 ;;
  *) on_path=0 ;;
esac

if [ "$on_path" = "0" ]; then
  case "${SHELL:-}" in
    */zsh)  hint="echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc" ;;
    */bash) hint="echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc" ;;
    */fish) hint="fish_add_path $INSTALL_DIR" ;;
    *)      hint="add $INSTALL_DIR to your PATH" ;;
  esac
  step "One thing first"
  bar
  line "${INSTALL_DIR} is not on your PATH yet. Paste this:"
  line ""
  line "${B}${hint}${R}"
  line ""
  line "${D}then open a new terminal.${R}"
fi

# --- done -------------------------------------------------------------------

bar
printf '%s%s%s  %sRun %spew2 setup%s to finish.%s\n\n' \
  "$ACCENT" "$END" "$R" "$D" "$B" "$R$D" "$R"
