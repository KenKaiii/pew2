# pew2

A remote control for your coding agents. Run Claude Code, Codex, Gemini CLI — or
your own app — on your machine, and drive them from your phone.

> **Status: early.** Daemon, provider system, relay and the phone app work and
> are tested, including over the internet via your own relay.
>
> **Run it for yourself, on your own relay — not for other people.** Your
> pairing token is a bearer secret with no expiry, and the relay sees plaintext.
> Anyone holding that token can start agents and read files on your machine, so
> treat it like an SSH key: never paste it anywhere, and `pew2 pair --rotate` if
> you ever do. See [Known gaps](#known-gaps).

## Install

```bash
bun install
cd packages/daemon && bun link     # puts `pew2` on your PATH
```

Then, from anywhere:

```bash
pew2 setup             # find agents, verify them, report what is missing
pew2 service install   # keep the daemon running across reboots
pew2 pair              # QR + link for the phone, then waits and confirms the scan
```

Pairing is one time per phone. The daemon is what must keep running, which is
what `service install` handles.

## The idea

Rather than integrating each agent one by one, pew2 speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). Any ACP agent
works — and there are already ~40, including Claude, Codex, Gemini, Copilot,
Cursor, Goose, OpenCode and OpenHands.

**You do not have to add them by hand.** `registry sync` pulls the public ACP
registry, so a newly published agent is available without a release of pew2:

```bash
pew2 detect                          # configure agents already on your PATH
pew2 registry sync                   # add every agent in the public ACP registry
pew2 registry sync --dry-run         # ...or just see what it would add
```

Sync never downloads anything executable — agents distributed as platform
binaries are added as manifests that light up once you install the agent its own
way. It also never overwrites a manifest it did not write; `--force` if you want
it to.

**Adding your own agent is one JSON file.** No code, no rebuild:

```bash
npm run providers:validate           # check every manifest
pew2 providers add my-agent
pew2 providers verify my-agent
```

`verify` is not a lint — it spawns the process, does the ACP handshake, sends a
real prompt and counts what came back. See [docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md).

## Architecture

```
Phone  ──ws──▶  Relay (Cloudflare Durable Object)  ◀──ws──  Daemon (your machine)
                                                              ├─ ACP ▶ Claude Code
                                                              ├─ ACP ▶ Codex
                                                              └─ ACP ▶ your own app
```

- **Daemon** — spawns agents over stdio and owns an append-only, sequence-numbered
  event log per session. It is the fan-out point: ACP is one client to one agent,
  so the daemon is what lets a phone and a desktop watch the same session.
- **Relay** — a Durable Object per pairing. Both sides dial out, so neither needs a
  public address. Hibernation keeps idle sockets connected at no compute cost, and
  the DO's built-in SQLite stores the event log, so there is no separate database.

## Getting the app on your phone

pew2 is not on any store, and does not need to be. You build it yourself and
install it on your own device — which is also what makes forking it useful:
change anything, rebuild, and it is on your phone.

```bash
cd packages/app
npx eas init                                           # once, links YOUR Expo account
npx eas build --profile apk       --platform android   # APK, install it, done
npx eas build --profile device    --platform ios       # signed for your own device
npx eas build --profile simulator --platform ios       # no signing, no account
```

Builds run on Expo's machines, so a local Xcode/NDK toolchain is not required.

`eas init` comes first because no one's Expo account is committed here. Put the
account and project id it gives you in `packages/app/eas-project.json`, which is
gitignored:

```json
{ "owner": "your-expo-username", "projectId": "the-uuid-from-eas-init" }
```

So a fork builds under its own account, and pulling upstream never fights you over
whose it is. CI can set `EAS_OWNER` and `EAS_PROJECT_ID` instead of the file.

**Android needs no developer account, ever.** A signed APK installs once and
keeps working. Nothing expires.

**iOS is where Apple charges rent.** Not for building — the $99/year Developer
Program buys *distribution*, and you can install on your own device without it.
What the free tier costs you is a **7-day signature**: a free ("personal team")
provisioning profile expires a week after it is issued, and you are capped at 3
sideloaded apps. That is Apple policy, not a pew2 limitation, and no tool removes
it. Two ways out:

| | Cost | What you do |
| --- | --- | --- |
| **Free + auto-refresh** | £0 | [AltStore](https://altstore.io) or [SideStore](https://sidestore.io) re-signs in the background, on a schedule. Set up once. |
| **Paid** | $99/yr | 1-year profile. Rebuild annually. |

Auto-refresh normally has a catch — it wants a computer awake on your network at
the moment the certificate expires. **pew2 already requires exactly that**: the
daemon runs on your machine under `service install`. The cost is already paid.

Forking? Nothing here is tied to an account, so a fork needs four things of its
own — none of which are inherited:

1. **Identity.** `name`, `slug`, `ios.bundleIdentifier` and `android.package` in
   `packages/app/app.json`. An identifier is unique per store, so a fork keeping
   the original's cannot be submitted alongside it.
2. **A relay.** `npm run relay:deploy`, then `pew2 relay wss://<your-worker>`.
   The URL is never committed; without this a fork is same-Wi-Fi only.
3. **An EAS project**, if you build with it: `npx eas init`.
4. **A pairing token**, minted per machine on first run. Yours never leaves your
   own `~/.pew2`.

## Layout

| Path | What |
| --- | --- |
| `packages/protocol` | Manifest + wire schemas (zod) |
| `packages/daemon` | Provider registry, ACP client, session log, CLI |
| `packages/relay` | Cloudflare Worker + Durable Object |
| `packages/app` | Expo app (iOS + Android) |
| `providers/` | One JSON manifest per agent |

## Develop

```bash
bun install
npm run typecheck        # daemon + protocol, and relay separately
npm test                 # pipeline tests against a local echo ACP agent
npm run relay:dev        # relay on :8799
npm run relay:check      # integration check against a running relay
```

`providers/echo.json` is a working ACP agent needing no API key and no network,
so the whole pipeline is testable anywhere.

## Known gaps

1. **No E2EE.** The token is a bearer secret and the relay sees plaintext. Run
   your own relay. Not safe for real users yet.

   The relay does enforce what it can without being able to authenticate anyone:
   a token must be hex and at least 32 characters before it names a room, a
   device is refused unless a daemon is actually connected (so `pew2 pair
   --rotate` takes effect immediately), the newest daemon connection replaces
   any older one, and a room is capped at 16 sockets. None of that helps if the
   token itself leaks — rotate it.
2. **`pty` transport is reserved but unimplemented.** `verify` skips it.

## Licence

MIT
