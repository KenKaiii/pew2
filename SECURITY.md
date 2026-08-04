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

**The pairing token is the whole of the authentication.** It is a bearer
secret: anyone holding it can start agents, send prompts, read files the agent
can read, and browse directories under your home. There is no expiry, no
per-device revocation and no rate limiting. Treat it exactly like an SSH private
key. `pew2 pair --rotate` invalidates it and every paired device at once.

**The relay sees plaintext.** There is no end-to-end encryption yet, so whoever
operates the relay can read everything passing through it. Deploy your own —
`npm run relay:deploy` — and do not use somebody else's.

**The daemon trusts its own machine.** It runs agents as your user, with your
files and your credentials. That is what it is for. Do not run it on a machine
you share, or as a user with more access than you would give the agent directly.

### What is enforced

Within those limits, the parts that can be checked are:

- Pairing tokens must be at least 32 hex characters before they name a relay
  room, so an arbitrary string cannot allocate one.
- A device is refused unless a daemon is actually connected, which is what makes
  rotation take effect immediately rather than eventually.
- Directory browsing refuses anything outside `$HOME`, extended only by
  `PEW2_BROWSE_ROOTS`.
- Image serving is narrower still: the session's own working directory and the
  temp directory, extended only by `PEW2_IMAGE_ROOTS`.
- Both resolve symlinks *before* checking containment, so a link inside an
  allowed root pointing outside it is refused rather than followed. A refusal
  never says why, so it cannot be used to probe what exists.
- Relay rooms are capped at 16 sockets.

### Out of scope

- Anything requiring a valid pairing token. That is authentication working.
- Anything requiring local access to the machine running the daemon.
- The agents themselves. pew2 launches Claude Code, Codex and others as
  subprocesses; report issues in those to their own projects.
