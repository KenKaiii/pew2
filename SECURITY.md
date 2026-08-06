# Security

## Reporting a vulnerability

Please report privately, through GitHub's
[private vulnerability reporting](https://github.com/KenKaiii/pew2/security/advisories/new),
rather than opening an issue. pew2 runs coding agents on a real machine, so a
working exploit in a public issue is usable against every person running it
before there is anything to upgrade to.

No bounty, and no formal response window — this is a spare-time project. What
you will get is an honest reply and, if the report holds, a fix and credit.

## What pew2 assumes

The threat model is deliberately narrow, and worth reading before deciding
whether to run this.

**The pairing key is the whole of the authentication.** It is a bearer secret:
anyone holding it can start agents, send prompts, read files the agent can read,
and browse directories under your home. There is no expiry, no per-device
revocation and no rate limiting. Treat it exactly like an SSH private key.
`pew2 pair --rotate` invalidates it and every paired device at once.

The key never leaves the two endpoints. It reaches the phone in the QR link's
*fragment*, which is not transmitted to a server, and the relay is given only a
room id derived from it by a one-way hash.

**The relay cannot read your traffic, but it can see its shape.** Message
contents — prompts, replies, file paths, provider names, images — are encrypted
with XChaCha20-Poly1305 under keys the relay never holds. Session ids, sequence
numbers, message sizes and timing are visible to it, because they ride on the
outside of a frame so it can route and order one. It keeps no copy: a room
forwards and forgets, and a reconnecting phone catches up from the daemon.
Deploy your own relay anyway: `npm run relay:deploy`.

**There is no forward secrecy.** One key lasts the life of a pairing, so traffic
captured today can be decrypted by a key leaked tomorrow. Rotate if you have any
reason to think it has been exposed.

**The daemon trusts its own machine.** It runs agents as your user, with your
files and your credentials. That is what it is for. Do not run it on a machine
you share, or as a user with more access than you would give the agent directly.

### What is enforced

Within those limits, the parts that can be checked are:

- Every message except the handshake is sealed with an AEAD, keyed separately
  per direction, so a captured frame cannot be replayed back at its own sender.
- A connection must prove it holds the key before the daemon will serve it.
  Knowing the relay room id — which is all the relay itself has — is not enough.
- Replay is rejected per device, and only devices that have proved they hold the
  key have a replay window at all — so a captured frame cannot be replayed by
  presenting it under a different name. The proof itself is accepted once per
  device, since a proof is what lets a reconnecting device's counters restart.
- The readable routing fields are bound into each frame's tag, so the relay can
  read them but not alter them.
- Room ids must be at least 32 hex characters before they name a relay room, so
  an arbitrary string cannot allocate one.
- A device is refused unless a daemon is actually connected, which is what makes
  rotation take effect immediately rather than eventually. A daemon still
  answering keepalives cannot be displaced by a newcomer, so knowing a room id
  is not enough to keep someone's machine offline.
- A working directory named by a client is honoured only if this daemon already
  offered that path — anything else is refused, or falls back to a directory the
  daemon picked itself. So a message cannot start an agent somewhere of its own
  choosing, and cannot choose the root that image serving is then checked against.
- Directory browsing refuses anything outside `$HOME`, extended only by
  `PEW2_BROWSE_ROOTS`.
- Image serving is narrower still: the session's own working directory and the
  temp directory, extended only by `PEW2_IMAGE_ROOTS`.
- Both resolve symlinks *before* checking containment, so a link inside an
  allowed root pointing outside it is refused rather than followed. An image is
  then opened once and measured and read through that one descriptor, so a file
  swapped for a link after the check is not followed either. A refusal never says
  why, so it cannot be used to probe what exists.
- Relay rooms are capped at 16 sockets.

### Out of scope

- Anything requiring a valid pairing token. That is authentication working.
- Anything requiring local access to the machine running the daemon.
- The agents themselves. pew2 launches Claude Code, Codex and others as
  subprocesses; report issues in those to their own projects.
