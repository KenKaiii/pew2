# Changelog

What changed, in the words of someone running it rather than someone writing it.

One version number ships: the `pew2` binary, tagged in this repository and
published in [Releases](https://github.com/KenKaiii/pew2/releases). The phone app
carries its own store version, which store rules forbid moving backwards. The
`protocol` and `relay` packages are internal and now carry none at all — nothing
installs them separately, and what an app and a daemon must agree on is
`WIRE_VERSION`, which is checked on every connection.

Dates are the day the tag was cut.

## 0.9.11 — 2026-08-07

### Security

- **A sealed frame is only accepted from a device that proved it holds the key.**
  The sender label on a relayed frame is chosen by whoever opened the socket, and
  it decided which replay window a frame was checked against — so a captured
  frame replayed under a new name was accepted, including a `session.permission`
  that re-approved a tool call you had approved once.
- **A `hello` no longer clears a device's replay protection before its proof is
  checked**, and a proof is accepted once: replaying one captured inside its
  two-minute window is refused.
- **A `cwd` from a client is honoured only for a project this daemon itself
  offered.** `session.start`, `session.resume` and `provider.sessions` took the
  path at face value, so a message could start an agent anywhere on disk — and
  make the whole filesystem readable through `image.fetch`, which trusts that
  same directory as its root. Starting and listing now refuse an unrecognised
  path outright; resuming falls back to the agent's own last project instead,
  because it is sent during reconnect before the daemon has finished working out
  which projects it knows.
- **A daemon that is still answering keepalives keeps its place in a relay room.**
  Eviction was by arrival, and the room id is not the key, so anyone who learned
  one could keep the real machine permanently offline. The cost is that a laptop
  which changes network may take up to 90 seconds to reclaim its room, rather
  than the second it used to, since the socket it left behind has to look dead
  first.
- **`PEW2_TOKEN` is refused below 32 characters.** It is a single hash away from
  being the encryption key, with no salt and no stretching, so a short one can be
  brute-forced offline against a room id the relay already knows.
- **Attachments and cached transcripts are written owner-only.** They landed at
  0644 in a shared temp directory, at a predictable path, and `image.fetch`
  allows that directory as a root.
- **An image is opened once and read from that descriptor.** Resolving, checking,
  then re-opening by name let a file be swapped for a symlink in between.
- **The installer refuses a download whose checksum is missing.** The check was
  skipped when the `.sha256` was absent, so whoever served the binary could turn
  it off by serving one file less.
- **GitHub Actions are pinned to commit SHAs.** A tag can be moved to different
  code by whoever owns the action.

### Fixed

- Preferences are written atomically: a crash mid-write left a truncated file,
  which reads as "nothing was ever chosen" for every provider at once.
- The relay no longer wakes from hibernation to answer a keepalive, and sweeps
  sockets whose far end vanished without closing — sixteen of those and a room
  turns away the machines that belong in it.
- The relay's event log is gone. Nothing read it back (the app discards any frame
  that is not a sealed envelope, and the relay has no key to seal one with),
  while anyone holding a room id could fill it.
- Inbound messages are validated against the published wire schemas at one place,
  instead of each case re-checking a hand-written shape.
- The app caps a conversation's turns in memory, matching the daemon's transcript
  cache. It was the only unbounded store in the system, on the device with the
  least memory in it.

### Added

- Crash reporting, on-device only: a fatal error outside a render — the kind that
  ends the process with no error boundary to catch it — is recorded on the way
  down and shown on the next launch, with nothing sent anywhere.

Two of these are groundwork rather than working features, and are listed so the
next person does not assume otherwise:

- `expo-updates` is installed and pinned to the app version, which is what a
  future update must not cross. It cannot deliver anything yet: that needs an
  `updates.url` from an EAS project this repository does not have.
- The `pew2://` URL scheme is registered, which a build has to do before any link
  can reach the app. Nothing routes an incoming link yet — pairing is still
  camera-only — and a link that paired on arrival would let any app that can open
  a URL point your phone at someone else's daemon, so that handler needs a
  confirmation step designed first.

## 0.9.10 — 2026-08-07

- Idle agents are given back after fifteen minutes rather than an hour.

## 0.9.9 — 2026-08-07

- A reconnecting phone no longer asks an agent to resend a conversation already
  on screen.

## 0.9.8 — 2026-08-07

- Capped how many conversations may hold an agent process at once.

## 0.9.7 — 2026-08-07

- Idle agent processes are given back instead of held for the life of the daemon.

## 0.9.6 — 2026-08-06

- The agent count the phone is promised no longer includes test fixtures.
- The dock knows both its heights in advance, so opening the composer no longer
  reflows the thread.

## Earlier

Releases before 0.9.6 predate this file. `git log` and the
[Releases](https://github.com/KenKaiii/pew2/releases) page are the record.
