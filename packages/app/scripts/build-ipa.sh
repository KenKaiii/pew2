#!/usr/bin/env bash
#
# Build a store-signed .ipa on this Mac and leave it on the Desktop, ready to
# drag into Transporter.
#
# `eas build --platform ios` without `--local` queues the same work on Expo's
# macOS runners, which is metered: the free tier is a handful of iOS builds a
# month and a queue that can be hours long at the end of one. `--local` runs the
# identical pipeline here, costs nothing, and takes about three minutes. That is
# the whole reason this script exists — everything else it does is bookkeeping
# around one command.
#
# It is *not* the same as `release-to-device.sh` beside it. That one signs with
# the development certificate to reproduce Release behaviour on a phone you have
# plugged in; the result cannot be uploaded. This produces a distribution-signed
# archive Apple will accept.
#
#   ./scripts/build-ipa.sh
#
# Needs: an Expo login (`npx eas-cli login`), and a distribution certificate and
# App Store provisioning profile on the Expo account. EAS creates both on first
# use and reuses them after; nothing here has to be configured by hand.
set -euo pipefail

cd "$(dirname "$0")/.."

# CocoaPods refuses to run under a non-UTF-8 locale and fails inside Ruby's
# unicode normalisation rather than anywhere that names the cause. A shell that
# inherits one from the environment takes the pod install step down with it.
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# Pinned rather than `latest`: `npx eas-cli@latest` re-resolves on every run, and
# a CLI release between two builds is a variable nobody asked for on the day
# something breaks. Raise this deliberately.
EAS="npx -y eas-cli@21.7.0"

DESKTOP="$HOME/Desktop"
STAGE="$(mktemp -d)/pew2.ipa"

# `appVersionSource: remote` in eas.json means the build number lives on Expo's
# servers and `autoIncrement` in the production profile bumps it there. So this
# needs a login even though nothing is uploaded: without one the version cannot
# be resolved and the build stops after the pods are already installed.
if ! $EAS whoami >/dev/null 2>&1; then
  echo "Not logged in to Expo. Run: npx eas-cli login" >&2
  exit 1
fi

echo "Building iOS release locally. Around three minutes."
$EAS build --local --platform ios --profile production --output "$STAGE"

# Read the build number back out of the archive rather than predicting it. The
# increment happens server-side during the build, so the only authority on what
# was actually built is the thing that was built.
WORK="$(mktemp -d)"
unzip -q "$STAGE" -d "$WORK"
PLIST="$WORK/Payload/pew2.app/Info.plist"
BUILD=$(plutil -extract CFBundleVersion raw "$PLIST")
VERSION=$(plutil -extract CFBundleShortVersionString raw "$PLIST")

# An .ipa signed for development uploads fine and is then rejected by App Store
# Connect minutes later, by email, naming nothing useful. The distinguishing
# mark is `get-task-allow`: true means a debugger may attach, which is exactly
# what the store forbids. Checked here, where the answer is one line, rather
# than discovered after Transporter has finished.
if codesign -d --entitlements - --xml "$WORK/Payload/pew2.app" 2>/dev/null \
  | plutil -convert xml1 -o - - 2>/dev/null \
  | grep -A1 -i "get-task-allow" | grep -qi "<true/>"; then
  echo "Built with a development profile; the App Store will reject it." >&2
  echo "Check the credentials on the Expo account: npx eas-cli credentials" >&2
  exit 1
fi

# Only now is the old one removed. Deleting first and building second leaves the
# Desktop with nothing to upload if the build fails.
rm -f "$DESKTOP"/pew2-build*.ipa
FINAL="$DESKTOP/pew2-build$BUILD.ipa"
mv "$STAGE" "$FINAL"
rm -rf "$WORK"

echo
echo "$FINAL"
echo "Version $VERSION, build $BUILD, signed for the App Store."
echo "Open Transporter, sign in, drag it in, Deliver."
