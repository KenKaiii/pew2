#!/usr/bin/env bash
#
# Build a Release app and put it on a connected iPhone, without EAS or TestFlight.
#
# The keyboard bug that produced this script only appeared in Release builds:
# every development build looked perfect, so each attempt at a fix cost a cloud
# build and a TestFlight round trip to disprove. This is the same configuration
# TestFlight ships, reachable in about two minutes, which is the difference
# between testing a hypothesis and guessing at one.
#
# What it is *not* is a distribution build: it signs with the local development
# certificate rather than an App Store one, so the binary Apple serves still has
# to come from `eas build`. What it reproduces is the compiler and the
# configuration, which is where release-only behaviour lives.
#
#   ./scripts/release-to-device.sh            # first connected device
#   ./scripts/release-to-device.sh <udid>     # a specific one
#
set -euo pipefail

cd "$(dirname "$0")/.."

# CocoaPods refuses to run under a non-UTF-8 locale, and a shell that inherits
# one from the environment fails inside Ruby's unicode normalisation rather than
# anywhere that names the cause.
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# `xcodebuild` wants the hardware UDID, which is the long form `xctrace` prints
# and *not* the UUID `devicectl` leads with; passing the latter fails with
# "no device matching", which reads like the phone is unplugged.
#
# Every lookup below is `|| true`: under `set -e` a `grep` that matches nothing
# ends the script on the spot, so the checks written to explain what is missing
# would never run and the whole thing would exit silently.
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID=$(xcrun xctrace list devices 2>/dev/null \
    | sed -n '/^== Devices ==/,/^== Simulators/p' \
    | grep -iE "iphone|ipad" \
    | grep -oE '\([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}\)$' \
    | tr -d '()' \
    | head -1 || true)
fi

if [ -z "$UDID" ]; then
  echo "No iPhone connected. Plug one in, unlock it, and trust this Mac." >&2
  exit 1
fi

# The signing team, taken from the provisioning profiles rather than from the
# signing certificate. `expo prebuild` cannot write one into the project and
# every regeneration would drop it again, so it is passed per build.
#
# Not read from the certificate because an "Apple Development" certificate
# carries whichever team issued it, and on a Mac that has ever built with a free
# account that is the *personal* team — which then fails with "No Account for
# Team", naming an ID that is genuinely in the keychain and genuinely useless.
# The profiles Xcode has already downloaded are the ones it can actually sign
# against, so a profile for this bundle is the strongest evidence available, and
# any profile is the fallback.
BUNDLE_ID="io.github.kenkaiii.pew2"
PROFILES="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"

team_of() {
  security cms -D -i "$1" 2>/dev/null | plutil -extract TeamIdentifier.0 raw - 2>/dev/null || true
}

TEAM="${DEVELOPMENT_TEAM:-}"
if [ -z "$TEAM" ] && [ -d "$PROFILES" ]; then
  for profile in "$PROFILES"/*.mobileprovision; do
    [ -e "$profile" ] || continue
    name=$(security cms -D -i "$profile" 2>/dev/null | plutil -extract Name raw - 2>/dev/null || true)
    case "$name" in
      *"$BUNDLE_ID"*) TEAM=$(team_of "$profile"); break ;;
    esac
    # Remembered as the fallback, but the loop keeps going: a wildcard profile
    # sorts before this bundle's own and would otherwise win on filename order.
    # `|| true` because a failed test is a non-zero status, which `set -e` reads
    # as the script failing.
    if [ -z "$TEAM" ]; then TEAM=$(team_of "$profile"); fi
  done
fi

if [ -z "$TEAM" ]; then
  echo "No signing team found." >&2
  echo "Xcode > Settings > Accounts > sign in, then build to a device once so" >&2
  echo "Xcode downloads a provisioning profile." >&2
  exit 1
fi

echo "Building Release for $UDID (team $TEAM)"

if [ ! -d ios ]; then
  npx expo prebuild --platform ios
fi

xcodebuild \
  -workspace ios/pew2.xcworkspace \
  -scheme pew2 \
  -configuration Release \
  -destination "id=$UDID" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -quiet \
  build

# Newest first: DerivedData accumulates a directory per project path, and an
# older one still holding a stale `pew2.app` would otherwise be installed in
# place of the build that just succeeded — which looks exactly like a fix that
# did not work.
APP=$(find ~/Library/Developer/Xcode/DerivedData/pew2-*/Build/Products/Release-iphoneos \
  -maxdepth 1 -name "pew2.app" -exec stat -f "%m %N" {} + 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2- || true)

if [ -z "$APP" ]; then
  echo "Build reported success but produced no pew2.app." >&2
  exit 1
fi

xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" io.github.kenkaiii.pew2

echo
echo "Release build running on device. This is what TestFlight ships."
