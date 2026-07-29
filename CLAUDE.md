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
- **Agent failures arrive twice, and the useful half is in `data`.** An agent streams its error as ordinary message text and *then* rejects the turn, so the same sentence lands as both agent output and an `error` frame. `humanError()` (`daemon/src/errors.ts`) normalises every failure at the one point all transports and providers share: never a JSON blob, never a bare "Internal error" — the real reason sits in the JSON-RPC `data.details`, sometimes double-encoded. Unwrapping a `RequestError` with `.message` alone is what throws the explanation away. The app then *promotes* the copy already on screen to the error role instead of appending a second one, because only the client knows what is rendered.
- **A clean agent exit is not an error.** Closing a session kills the child, so `kind: "exit"` fires with a null or zero code on every normal finish. Only a non-zero code is rendered.
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
- **Live app loop:** start that daemon first, then `cd packages/app && npx expo start --ios`. The daemon prints a QR at startup; scan or paste it into the app's pairing screen.
- **Two transports, one handler.** `handler.ts` owns every message case; `server.ts` (LAN) and `relay-client.ts` (remote) only supply `reply`/`broadcast`. Never add a case to one transport — local and remote would drift immediately.
- **Remote needs a relay; without one it is same-Wi-Fi only.** `pew2 relay <url>` stores it, the daemon then dials out on start, and `pew2 pair` prints a `wss://` link instead of a LAN one. `PEW2_RELAY` overrides for one run.
- **`wrangler dev --local` silently breaks WebSocket upgrades.** Requests never reach the Worker and `relay:check` hangs with no output. `npm run relay:dev` no longer passes it.
- **The relay requires `deviceId` on `/connect`** and answers 400 without it — which surfaces as a socket that just never opens. The app injects its own stable id in `parsePairing`.
- **The relay must forward `hello` after replaying cursors, not return.** It is the only signal the daemon gets that an app joined; without it the daemon never re-announces and the phone shows an empty app list forever.
- **The daemon rejects unpaired sockets at the HTTP upgrade**, not in the first message, so a wrong token never establishes a connection. `/health` stays open so `doctor` can tell "not running" from "running but unpaired".
- **`PEW2_TOKEN` overrides the stored token and is never written to disk.** This is how tests and containers run without touching a real home directory; `PEW2_HOME` relocates `~/.pew2` for the same reason.
- **`pew2 setup --json` / `doctor --json` are the agent-facing surface.** `ok` is the stop condition, every problem carries a stable `id` and a runnable `fix`, and the exit code mirrors `ok`. Missing secrets and LAN-only are `warning`, never `error` — an agent cannot supply a secret or make a product decision, and must not loop forever on one.
- **App pairing logic lives in `pairingLink.ts`, deliberately free of Expo imports.** `pairing.ts` adds the keychain. Importing `expo-secure-store` into the pure module breaks `bun test`, which cannot parse React Native's Flow syntax.
- **`providers validate` proves nothing but that the JSON parses.** `providers verify <id>` spawns the process, does the ACP handshake, sends a real prompt and counts updates. Always finish with `verify`.
- **`npm run typecheck` runs three separate passes.** The root `tsconfig.json` excludes `packages/app`, the relay needs `@cloudflare/workers-types` (whose globals conflict with Node's), and the app needs React Native's own config. One project cannot cover all three, so the script chains them; CI runs the same command.
- **Haptics: `hapticsPolicy.ts` is pure, `ui/haptics.ts` binds Expo.** Same split as `pairingLink`/`pairing`, and for the same reason — importing `expo-haptics` into a tested module breaks `bun test`. Feedback is named by meaning (`sent`, `failed`, `finished`), never by waveform, and every pulse is throttled: a failed turn emits an error *and* goes idle milliseconds apart, which would otherwise be felt as one mushy double-buzz. `controls.tsx` pulses for every button in the app, so call sites only opt in when a press means something other than a tap.
- **Two integration checks need a server already running**, and neither is in `npm test`:
  - `npm run relay:dev` then `npm run relay:check`
  - daemon running, then `bun run packages/daemon/src/testing/e2e-check.mjs`
- **Expo Go caches aggressively.** If an edit doesn't appear, terminate the app and re-open `exp://127.0.0.1:8081` — a stale bundle looks exactly like a failed fix.
- **The app scans QR codes, never generates them.** The token is minted on the desktop, so only that side has anything to publish. `expo-camera` is iOS/Android only; the scan button is hidden elsewhere.
- **`useDaemon` tracks per-session cursors and replays through its own `onmessage`.** Replayed events go down the same path as live ones, so there is no second rendering path. Events at or below the cursor are dropped, because replay and the live stream overlap.
- **`pew2` is not on PATH until you `bun link`.** `packages/daemon` is private with a `bin` entry, so `cd packages/daemon && bun link` is what makes `pew2 pair` work from anywhere. Without it the app's pairing screen names a command the user does not have.
- **launchd starts the daemon with almost no environment and no working directory.** The plist must state `PATH` explicitly (including bun's own dir, or `npx` providers all appear missing), and any manifest arg that is a local script must be `./`-relative so the registry can resolve it against the manifest. `pew2 service install|uninstall`; logs in `~/.pew2/logs/`.
- **An agent's cwd under launchd is `/`, and agents treat cwd as project root.** GG Coder died with `mkdir '/.gg'` and its sessions silently never reached the phone. `resolveWorkspace()` (`daemon/src/workspace.ts`) is the single default: explicit request → `PEW2_WORKSPACE` → daemon cwd when usable → home. Session start *and* the capability probe both go through it; adding a third spawn path without it reintroduces the bug.
<!-- gg:init:end -->