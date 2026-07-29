<!-- gg:init:start -->
# pew2

A mobile remote control for **desktop coding agents**. The agent (Claude Code, Codex,
Gemini CLI, GG Coder, or your own app) keeps running on your own machine; the phone is
just a client that watches the same session, sends prompts, and answers the agent's
permission requests.

It is not a chat app with a model behind it, and it is not an agent. It is a
**transport + UI** for agents that already exist on your machine, reached over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

## Packages

- `packages/protocol` — Zod schemas for the provider manifest and the daemon↔relay↔app wire envelope. Single source of truth for both.
- `packages/daemon` — runs on the user's machine. Spawns agent processes, speaks ACP over stdio, owns the session event log, fans out to every connected client.
- `packages/relay` — Cloudflare Worker + Durable Object. One DO per pairing; routes opaque messages between `daemon` and `app` roles and persists events in DO SQLite for replay.
- `packages/app` — Expo/React Native client (iOS + Android).
- `providers/*.json` — one manifest per connectable app. Adding a file is the entire integration; no code change, no restart.
- `schemas/provider.schema.json` — editor autocomplete only. The Zod schema in `protocol` is authoritative; keep them in sync by hand.

## Data flow

App `session.prompt` → relay → daemon → ACP `session/prompt` on the child process.
Agent `session/update` → daemon `onUpdate` → `SessionLog.append()` stamps a gapless
`seq` → broadcast to *all* clients. The daemon, not the agent, is the fan-out point:
ACP is one-client-to-one-agent, so a phone and a desktop can only share a session
because the daemon owns the log.

## Gotchas

- **The daemon owns a seq'd event log because ACP won't replay it.** ACP v1 does not re-send messages emitted while a client was disconnected. Reconnecting clients send a cursor and get only what they missed. Do not "simplify" this away.
- **`session.event` and `session.idle` must be filtered against the current session.** The daemon broadcasts every session to every client; an abandoned session still streaming will otherwise render into the conversation now on screen.
- **Turn ids are `${sessionId}:${seq}`.** `seq` restarts at 0 per session, so seq alone collides across sessions and React merges unrelated turns.
- **Register the permission resolver *before* notifying the UI.** A caller that answers synchronously finds no pending entry and the agent hangs forever — this is the "tap Approve, nothing happens" bug.
- **A child process needs `error`/`spawn` listeners.** An unresolvable command emits `error` asynchronously; unhandled, it kills the whole daemon and every other session with it. Providers are also PATH-checked at load so a missing binary shows as unavailable instead of crashing at spawn.
- **`useDaemon` keeps `sessionRef`/`providerRef` mirrors.** React may invoke a `setState` updater twice, so updaters must stay pure — never send a message or assign a ref inside one.
- **Relay must use `ctx.acceptWebSocket()`, not `server.accept()`.** Only the former permits the Hibernation API, which is what makes idle sessions cost nothing.
- **Pairing token is a bearer secret with a 32-char floor and no auth.** It is not authentication and there is no E2EE yet. Do not expose a relay publicly and assume it is safe.
- **iOS puts the whole leading above glyphs in a multiline `TextInput`.** Composer subtracts `HALF_LEADING` so single-line text is optically centred; remove it and the placeholder sits ~2pt low.
- **The conversation pane needs `zIndex: 1`.** The drawer is absolutely positioned; without it the drawer paints over the pane and swallows its touches.
- **`theme.gutter` and `theme.headerInset` are shared rails.** The drawer header and the conversation top bar must use both, or the title and the hamburger it replaces drift apart as the drawer slides.

## Workflows

- **Runtime is Bun** (`engines: bun >=1.2.0`, `bun.lock`).
- **`npm run daemon` is not the server.** It runs `index.ts`, which only prints JSON to stdout. The WebSocket server the app talks to is:
  `PEW2_EXPERIMENTAL=1 bun run packages/daemon/src/server.ts` (port 8787, override with `PEW2_PORT`).
  `PEW2_EXPERIMENTAL=1` reveals the `echo` provider — a real ACP agent needing no API key or network, and the only way to exercise the pipeline offline.
- **Live app loop:** start that daemon first, then `cd packages/app && npx expo start --ios`. The app hardcodes `ws://localhost:8787`, so it is **simulator-only** until pairing exists.
- **`providers validate` proves nothing but that the JSON parses.** `providers verify <id>` spawns the process, does the ACP handshake, sends a real prompt and counts updates. Always finish with `verify`.
- **`packages/app` is typechecked by nobody.** The root `tsconfig.json` excludes it and the app has no typecheck script. After changing app code run `cd packages/app && npx tsc --noEmit` by hand.
- **`packages/relay` typechecks separately** against `@cloudflare/workers-types`, whose globals conflict with Node's. `npm run typecheck` runs both configs.
- **Two integration checks need a server already running**, and neither is in `npm test`:
  - `npm run relay:dev` then `npm run relay:check`
  - daemon running, then `bun run packages/daemon/src/testing/e2e-check.mjs`
- **Expo Go caches aggressively.** If an edit doesn't appear, terminate the app and re-open `exp://127.0.0.1:8081` — a stale bundle looks exactly like a failed fix.
<!-- gg:init:end -->
