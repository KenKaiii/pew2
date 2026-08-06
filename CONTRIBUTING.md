# Contributing

pew2 runs coding agents on someone's real machine, with their real files, and a
phone anywhere in the world can talk to it. That is the whole reason the bar here
is where it is — not ceremony, consequence.

## Getting it running

```bash
bun install
bun run typecheck
bun test packages
bun run lint
```

Then, in one terminal:

```bash
bun packages/daemon/src/cli/index.ts pair     # prints a QR code
bun packages/daemon/src/cli/index.ts start
```

and in another:

```bash
cd packages/app && bun start
```

Bun is the runtime and the test runner. The `npm run …` scripts are the same
scripts by another entry point — CI uses those — so either works; what is not
tested is running the daemon itself on Node.

## Before you open a pull request

- `bun run typecheck`, `bun test packages`, `bun run lint` — all three clean.
- New behaviour comes with a test that fails without it. A test that passes
  against the old code is describing a hope, not a change.
- Security fixes come with an *adversarial* test: the attack, executed, refused.
  `packages/protocol/src/channel.test.ts` is the shape to copy.

Some suites spawn a real agent process (the ACP pipeline, the workspace tests). A
sandbox that blocks `exec` will fail those and only those — worth checking before
concluding the tree is broken.

## Comments

Read a few files before writing any. The convention is unusual and deliberate:
comments explain **why**, and specifically what went wrong when it was done the
other way. `// increment counter` is noise. "Touched only after the tag verifies,
so an unauthenticated frame can neither advance a window nor reorder eviction"
(`channel.ts`) is the reason nobody re-breaks it in six months.

If a comment states a rationale that the code no longer supports, it is worse
than no comment — it argues, convincingly, for the bug. Fix it in the same commit
as the code it describes.

## Commits

One change per commit, subject written as an instruction in the imperative, no
prefixes or tags:

```
Stop a replay frame clearing the clock on a turn already running
Cap how many conversations may hold an agent at once
```

## Versions

Exactly one number ships: the `pew2` binary's, in `packages/daemon/package.json`,
tagged `vX.Y.Z`. The release workflow builds from that tag and publishes a
`.sha256` beside every binary — the installer now refuses a download without one,
so a release that skips them installs nowhere.

The phone app has a separate store version in `packages/app/app.json`, which store
rules forbid moving backwards, and which `expo-updates` pins each update to. That
file is the authority; the matching number in the app's `package.json` is left
alone because Expo's tooling expects one, so move both together.

`protocol` and `relay` are internal and carry no version at all — nothing
installs them separately, and a number nobody reads only drifts. What an app and
a daemon must agree on is `WIRE_VERSION`, checked on every connection.

## Adding an agent

Drop a manifest in `providers/`. That is the whole integration — if it needs a
code change, the manifest schema is probably the thing to fix.

## Security

Do not open an issue for a vulnerability. `SECURITY.md` explains private
reporting, and describes what pew2 does and does not defend against — read the
threat model before reporting something it deliberately does not cover.
