#!/usr/bin/env bash
#
# Capture App Store screenshots from a booted simulator.
#
# Apple wants one set at 6.9" (1320x2868), which is what an iPhone 16 Pro Max
# simulator produces natively, and accepts a 6.5" set (1284x2778) alongside it.
# Shooting native and downscaling is the right order: the reverse upscales and
# looks soft next to every other app on the page.
#
# Usage:
#   ./scripts/screenshots.sh <name>     capture one shot under that name
#   ./scripts/screenshots.sh --resize   build the 6.5" set from what was captured
#
set -euo pipefail

SIM="${PEW2_SIM:-A76FCF1B-9ABD-4205-B180-DCE721E12143}"
OUT="${PEW2_SHOTS:-$HOME/Desktop/pew2-screenshots}"
BIG="$OUT/6.9-inch"
SMALL="$OUT/6.5-inch"

mkdir -p "$BIG" "$SMALL"

if [ "${1:-}" = "--resize" ]; then
  count=0
  for f in "$BIG"/*.png; do
    [ -e "$f" ] || continue
    # 1284x2778 is a different aspect to 1320x2868, so a plain resize would
    # squash it. Fit to width, then crop the extra height from the bottom,
    # which is dead space on these screens rather than content.
    sips -Z 1284 "$f" --out "$SMALL/$(basename "$f")" >/dev/null
    sips -c 2778 1284 "$SMALL/$(basename "$f")" >/dev/null
    count=$((count + 1))
  done
  echo "wrote $count file(s) to $SMALL"
  exit 0
fi

name="${1:-shot}"
# The status bar is part of the picture, so it gets pinned rather than left to
# show whatever the clock and battery happen to be doing.
xcrun simctl status_bar "$SIM" override \
  --time "9:41" --wifiBars 3 --cellularBars 4 \
  --batteryState charged --batteryLevel 100 >/dev/null 2>&1 || true

xcrun simctl io "$SIM" screenshot "$BIG/$name.png" >/dev/null 2>&1
echo "$BIG/$name.png"
