# Changelog

What changed, in the words of someone running it rather than someone writing it.

One version number ships: the `pew2` binary, tagged in this repository and
published in [Releases](https://github.com/KenKaiii/pew2/releases). The phone app
carries its own store version, which store rules forbid moving backwards. The
`protocol` and `relay` packages are internal and now carry none at all — nothing
installs them separately, and what an app and a daemon must agree on is
`WIRE_VERSION`, which is checked on every connection.

Dates are the day the tag was cut.

## Unreleased

### Fixed

- **Holding Ken launches a goal on Android.** On the last step of a new goal,
  holding Ken did nothing at all: no ring, no caption change, and Close and
  Back did not respond either. The launch effect drawn over the screen was
  taking every touch, which only happens on Android. The calling glow and the
  home screen's burst use the same layer and are fixed the same way. Needs the
  new phone app.

## 0.9.29 — 2026-10-22

### Added

- **Call traces in the log.** With the matching app build, each voice call
  writes a short `[diag]` trace to the daemon log: audio route changes, the
  microphone opening and closing, and Pew starting and stopping speaking. No
  words from the call are recorded.

## 0.9.28 — 2026-10-22

### Fixed

- **A callback picks up where you asked for it.** Answered from the lock
  screen, a "call me back" asked from one project opened by asking what you
  wanted to do in your home folder. Pew now remembers which chat or project
  the callback was asked from and starts the callback there.

## 0.9.27 — 2026-10-22

### Changed

- **The daemon log says when.** Every `[relay]`, `[push]`, `[voice]` and other
  tagged line now starts with the local time, so a dropped connection or a
  missed notification can be placed against what you were doing. The startup
  banner and pairing QR code are unchanged.
- **Every notification is logged with its outcome**: accepted, rejected by
  Expo (with the reason), refused, or not sent at all. A phone signing up for
  banners is logged too (`[push] '<device>' will get banners`). Tokens are
  never written to the log.

## 0.9.26 — 2026-10-21

### Fixed

- **Notifications keep coming after the daemon restarts.** The phones to notify
  were held only in memory, so after a self-update, a crash or a reboot the
  daemon knew no phone at all, and finished turns and approvals went
  unannounced until the app was next opened. They are now saved in
  `~/.pew2/push-targets.json` (owner-only, tied to the pairing — `pew2 pair
  --rotate` forgets them). Connect the phone once after updating to save it.
- **The daemon answers the app's liveness check on the local network**, as the
  relay already does, so a phone reopened on the same Wi-Fi can confirm its
  connection instead of rebuilding it. Needs the matching app update to matter.

## 0.9.25 — 2026-10-20

### Changed

- **`pew2 pair` shows the QR code and nothing secret.** The pairing link (which
  holds the token and the encryption key) is no longer printed under the code,
  the token row and its fingerprint are gone, and so is the *copy link* key. The
  screen is now the code, one line saying to scan it with pew2, and one status
  line. A screenshot of it gives nothing away. `pew2 pair --json` still returns
  the link for agents that drive setup.
- **`pew2 setup` no longer lists the built-in test agent** as "not starting" on
  every run. It is hidden exactly as the daemon hides it, unless
  `PEW2_EXPERIMENTAL=1`.

## 0.9.24 — 2026-10-20

### Added

- **Call Pew.** The phone app can now call a voice assistant, Pew, about the
  agents on this computer: ask what's going on, pass an agent a message, answer
  its approval or question, or open a past chat and start a new one, all by
  voice. Pew runs on the OpenAI login an agent already has (GG Coder or Codex),
  so there's nothing to set up. Approving by voice is always read back first.
- **Pew can ring you.** Turn on *Ring me* in the app and, while it's on, a chat
  stuck waiting on you rings your phone like a call (CallKit), paced so it
  never rings non-stop. "Call me back in ten minutes" and "call me when billing
  is done" ring once, when asked.
- **Calls carry on.** The last 20 back-and-forths of your calls about each chat
  are kept on this computer (`voice-threads.json`, owner-only, deleted after 30
  days or with *Forget call history*), so calling again picks up where you left
  off. Nothing in it is ever treated as an instruction.

### Fixed

- **Back online at once after a restart.** After a network blip or a restart,
  the relay still held the old connection and turned this computer away for up
  to 90 seconds; it now proves it is the same machine and is let straight back
  in, and a phone reconnects within about two seconds.
- **GG Goals no longer stops with "stopped by SIGTERM".** Loading goals while
  the phone reconnected could close the GG Coder process the list was running
  on.

## 0.9.23 — 2026-10-17

### Added

- **Your phone is told when an agent needs you, not only when it finishes.**
  An approval waiting, a question from the agent, or a turn that failed now
  sends a notification too, and the app icon's badge counts the conversations
  stopped on an answer from you. A finished turn clears a badge left by an
  approval you have since given.

### Fixed

- **GG Goals no longer fails with "ACP connection closed".** pew2 reused a
  GG Coder process kept ready in the background without checking it was still
  running, so after that process exited, opening GG Goals failed until pew2
  happened to clear it. It now starts a fresh one instead.

## 0.9.22 — 2026-10-14

### Fixed

- **Starting a new goal from the phone works.** GG Coder reports a brand-new
  goal with no conversation yet, and pew2 read that as a broken answer, so
  every new goal failed and the phone sat on "Launching". If your computer
  does not answer within 20 seconds, the phone now says so and lets you try
  again.

## 0.9.21 — 2026-10-13

### Changed

- **A new look for the installer and every `pew2` command.** The install line,
  `pew2 setup`, `doctor`, `pair`, `providers` and `registry sync` share one
  style that matches the phone app: a dot-matrix mark opens each screen, its
  title is set in spaced capitals, and each line is marked done, worth a look,
  or stopped. `pew2 --help` groups its commands into Setup, Run and Agents.
- **Choosing a folder for a goal no longer sets off a run of macOS "Allow"
  prompts.** Suggestions now come only from folders you have already added, in
  GG Coder or in pew2, instead of a search through your whole home folder.
  Browsing to any other folder still works, and macOS asks only when you open it.

## 0.9.20 — 2026-10-13

### Added

- **GG Goals works from the phone.** You can see your goals, start a new one
  with a name, the goal itself, folders and files, and standing instructions,
  and change those instructions later from the goal's settings. Goals run on
  the computer exactly as they do from the desktop app.
- **Files from your phone can go into a goal.** Pick them with the phone's own
  file picker. pew2 saves a copy in its own folder on the computer
  (`~/.pew2/goal-files`), not in your project, so they never end up in Git.
  An older pew2 can't receive them yet; the phone then tells you the goal was
  made without its files, rather than leaving that out silently.

### Fixed

- **Goal folders no longer show up as ordinary projects** in GG Coder's list,
  or as the place a new GG Coder chat opens.
- **The phone no longer shows the relay's address.** Its status line and the
  connection settings name the computer instead.
- **Autopilot's messages come back when you reopen a conversation**, in the
  same place they were written.

## 0.9.14 — 2026-08-08

### Fixed

- **The model pill always names the model that will answer.** Reopening an old
  conversation and then starting a new one showed the old one's model, while the
  prompt actually ran on the one you last chose — and the pill only corrected
  itself after you had sent something. A new conversation opens with your
  remembered choice; a reopened one comes back with whatever it was last used
  with. Those are two different answers, and the pill was showing whichever had
  arrived most recently.

  It now shows nothing at all for the moment while a conversation is still
  loading, rather than guessing. Changing a model in one conversation also
  updates what the next one will open with, on every device you have paired.

- Cold launch, streaming and idle battery cost are all down. Long replies
  re-parsed the entire message on every chunk that arrived, blurred surfaces were
  rebuilt rather than reused, and animations kept running while the app was in
  the background.
- The model dropdown could open transparent on its first use, and looked right
  the next time. Fading a blurred surface is what did it; the card is scaled now
  and never faded.
- A notification banner is shown even when the computer could not register for
  remote push — the local one was being suppressed by the failure of the remote
  one, so a refused token meant no notification at all rather than the one that
  still worked.
- "Can't reach your computer" clears itself when the app comes back and the
  connection succeeds, instead of staying on screen over a working session.

### Added

- **Finished turns notify you while the app is closed.** Until now a reply that
  landed while you were in another app was silent until you opened it again.

## 0.9.13 — 2026-08-08

### Fixed

- **`pew2 pair` can always pair again.** A pairing admits one device, so once a
  phone had claimed it the printed code could not onboard anyone: the phone
  holding it never needs to scan again, and everyone else is refused — including
  that same phone after reinstalling the app, which clears its identity. The
  command now mints a fresh code in that situation rather than printing one
  nothing can use, and names the phone it just unpaired.

  A code nobody has claimed is still printed unchanged, so running the command
  twice while walking to your phone does not invalidate the QR you are halfway
  through scanning. `--rotate` remains for the case this cannot see: a code that
  leaked before it was ever used looks untouched, and still has to be replaced.

  This closes a loop. The app's own refusal tells you to run `pew2 pair` on the
  machine, which until now handed back the same code that had just been refused.

## 0.9.12 — 2026-08-08

### Security

- **A pairing link now admits one device.** The link never expires, which is what
  lets a phone reconnect after a reboot without scanning anything — but it also
  meant a code caught on camera stayed usable forever. The first device to
  complete a handshake claims the pairing; every later one is refused. Your phone
  keeps reconnecting as before, and a QR that appears in a screenshot or a video
  is worthless once it has.

  Rotation is still the only revocation, and it is still all-or-nothing: run
  `pew2 pair --rotate` to move a pairing to a different phone. A link that leaked
  *before* it was ever used must be rotated, not merely re-scanned — whoever
  claims it first, wins.

- **Every phone used to call itself `phone`.** `pew2 pair` prints a link
  containing `deviceId=phone` so the URL is valid on its own, and the app kept
  that name instead of using its own. Devices were indistinguishable, which would
  have made the claim above decorative. The app now always substitutes its own
  identifier, drawn from the system's secure random source rather than
  `Math.random`.

- **A refusal is addressed to the device it refuses.** The relay forwards
  cleartext to every app in a room, so an unaddressed refusal reached the phone
  that owned the pairing too — and it treats one as final. Left alone, that handed
  anyone holding a leaked link a single frame that would knock the real device
  offline.

### Fixed

- **A dead pairing code says so instead of hanging.** Scanning a rotated or
  retired code checked only that the link was well-formed, then moved on to the
  main screen and sat on "Connecting to your machine..." indefinitely — the one
  state that looks like a slow network and is actually permanent. Both refusals
  happen below the socket and send nothing back, so the app now completes a real
  handshake before it accepts a code, and stays put with the reason if it fails.
- **A machine that cannot be reached stops claiming it is nearly there.** After
  about fifteen seconds the app says so plainly and names what to check, while
  continuing to retry in the background — a sleeping laptop and a retired token
  are indistinguishable from the phone, and one of them comes back on its own.
- **`pew2 pair` warns before you scan** when a pairing already belongs to a
  device, rather than leaving you to discover it as a refusal on the phone.

### Upgrading

Nothing to do. A phone paired before this release keeps working, and claims the
pairing properly the first time it connects from an updated app.

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
- Sheets open the moment you tap, instead of a beat later. Every one of them
  waited to be measured before it would move, which cost three passes over the
  whole screen before the first frame; the new chat sheet also stuttered on its
  way to the project list, because resizing the card was making the screen
  redraw on every frame of its own animation. The menu is the same story: it was
  dragged from the same place the conversation arrives, so it stalled while an
  agent was replying, which is exactly when you reach for it.

### Added

- Sheets and the menu can be thrown. Drag a sheet down by its top edge to send
  it away, or the menu across from either side; let go part way and it goes back
  where it came from, at the speed you let go at.
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
