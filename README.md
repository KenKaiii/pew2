# pew2

A remote control for your coding agents. Run Claude Code, Codex, Gemini CLI — or
your own app — on your machine, and drive them from your phone.

> **Status: early scaffold.** The daemon, provider system and relay work and are
> tested. There is no mobile app yet, and no authentication or end-to-end
> encryption — **do not expose this to the internet.** See [Known gaps](#known-gaps).

## The idea

Rather than integrating each agent one by one, pew2 speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). Any ACP agent
works — and there are already ~40, including Claude, Codex, Gemini, Copilot,
Cursor, Goose, OpenCode and OpenHands.

**Adding an agent is one JSON file.** No code, no rebuild:

```bash
npm run providers:validate           # check every manifest
bun run packages/daemon/src/cli/index.ts providers add my-agent
bun run packages/daemon/src/cli/index.ts providers verify my-agent
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

## Layout

| Path | What |
| --- | --- |
| `packages/protocol` | Manifest + wire schemas (zod) |
| `packages/daemon` | Provider registry, ACP client, session log, CLI |
| `packages/relay` | Cloudflare Worker + Durable Object |
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

1. **No auth, no E2EE.** The pairing token is a bearer secret; anyone holding it
   joins the room. Not safe for real users yet.
2. **`pty` transport is reserved but unimplemented.** `verify` skips it.
3. **Daemon↔relay socket not wired.** Both sides are tested independently.
4. **No mobile app yet.**

## Licence

MIT
