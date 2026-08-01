<!-- gg:init:start -->
# pew2

Mobile remote control for **desktop coding agents** (Claude Code, Codex, Gemini CLI, GG Coder).
The agent runs on the user's machine over the [Agent Client Protocol](https://agentclientprotocol.com);
the phone is a client that watches the same session, prompts it, and answers its permission
requests. **Transport + UI, not an agent.**

- `packages/protocol` — Zod schemas for provider manifests and the daemon↔relay↔app envelope; authoritative for both sides (`schemas/*.json` is autocomplete only, synced by hand).
- `packages/daemon` — spawns agents, speaks ACP over stdio, owns the seq'd session log, warm spares, probe cache, config prefs, and the `pew2` CLI.
- `packages/relay` — Cloudflare Worker + DO, one per pairing; routes opaque frames between `daemon`/`app` roles, persists events in DO SQLite for replay.
- `packages/app` — Expo/React Native client. `providers/*.json` — one manifest per agent; adding a file is the whole integration.

**Flow:** app `session.prompt` → relay → daemon → ACP `session/prompt`. Agent `session/update` →
`SessionLog.append()` stamps a gapless `seq` → broadcast to **all** clients. ACP is
one-client-to-one-agent, so a phone and a desktop share a session only because the daemon owns
the log — and reconnecting clients replay from a cursor because **ACP never re-sends**. Do not
"simplify" that away.

## Gotchas — daemon

- **Register the permission resolver *before* notifying the UI** (`acp/connect.ts`). A caller answering synchronously finds no pending entry and the agent hangs — the "tap Approve, nothing happens" bug.
- **Child processes need `error` *and* `spawn` listeners.** An unresolvable command emits `error` asynchronously; unhandled it kills the daemon and every other session. Providers are PATH-checked at load so a missing binary reads as unavailable.
- **Agent failures arrive twice and the useful half is in `data`.** An agent streams its error as message text *then* rejects the turn. `humanError()` (`errors.ts`) normalises every failure at the one point all transports share; the real reason sits in JSON-RPC `data.details`, sometimes double-encoded, so `RequestError.message` alone throws it away.
- **A clean exit is not an error.** Closing a session kills the child, so `kind: "exit"` fires with a null/zero code on every normal finish. Only non-zero renders.
- **Under launchd cwd is `/`, and agents treat cwd as project root.** GG Coder died on `mkdir '/.gg'`. `resolveWorkspace()` (`workspace.ts`) is the single default: explicit → `PEW2_WORKSPACE` → daemon cwd → home. Session start *and* the capability probe both go through it; a third spawn path without it reintroduces the bug.
- **Warm spares: check `spares.has(id)` before booting; gate readiness on `spareReady`, not `warming`.** A disk-cached probe skips the boot path, so the wrong flag either spawns a duplicate agent or blocks a session open on a history read.
- **`config-prefs.json` is one file shared by all providers** — read-modify-write it. The probe cache is overwritten wholesale by the next probe, which is why user model/mode choices cannot live there.
- **Two transports, one handler.** `handler.ts` owns every message case; `server.ts` (LAN) and `relay-client.ts` (remote) only supply `reply`/`broadcast`. A case added to one makes local and remote drift.
- **Relay must use `ctx.acceptWebSocket()`, not `server.accept()`** — only that permits Hibernation, which makes idle sessions free. It also **requires `deviceId` on `/connect`** (400 otherwise, seen as a socket that never opens) and **must forward `hello` after replaying cursors, not return** — it is the daemon's only signal an app joined, else the phone shows an empty app list forever.
- **Images are answered as a `reply`, never as a session event** (`images.ts`). Only this machine can read the path an agent names (`resource_link`, `![](.gg/generated/x.png)`, tool-call content), so `image.fetch` inlines the bytes on demand — putting them in the seq'd log would re-download every picture on every reconnect. The path comes from the *agent*, so it is realpath'd (roots too: on macOS `/tmp` is a symlink) and confined to the session cwd plus tempdir; 8MB ceiling keeps a frame under the DO's 32 MiB receive limit. Local history loaders flatten messages to text, so they must lift image blocks out separately or a resumed thread loses every screenshot.
- **The pairing token is a bearer secret (32-char floor), not auth; there is no E2EE.** Unpaired sockets are rejected at the HTTP upgrade so a bad token never connects; `/health` stays open so `doctor` distinguishes "not running" from "unpaired". `PEW2_TOKEN` overrides the stored token and is never written to disk; `PEW2_HOME` relocates `~/.pew2`.

## Gotchas — app

- **Turn ids are `${sessionId}:${seq}`.** `seq` restarts at 0 per session, so seq alone collides and React merges unrelated turns.
- **Filter `session.event`/`session.idle` against `sessionRef.current`.** The daemon broadcasts every session to every client; an abandoned one still streaming otherwise renders into the conversation on screen.
- **Replay and the live stream overlap** — drop events at or below the per-session cursor (`cursors.ts`). Replayed events take the same `onmessage` path as live ones, so there is only one rendering path.
- **A replay batch must not set `busy` or raise `permission`** (`replayFold.ts`): those describe a turn happening *now*. A replay's last chunk is not work in progress (perpetual spinner) and its permission was answered long ago (phantom approve sheet). Likewise **hold the skeleton until `session.started`**, or the thread flashes empty.
- **Map `user_message_chunk`, not just live prompts** (`chunks.ts`). GG Coder replays user turns that way; unmapped, every user turn vanishes and agent chunks coalesce into one wall of text. Replayed history also carries internal markers (`[Previous conversation summary]`, compaction acks) that must be filtered.
- **A turn is empty only when it has no text *and* no images** (`chunks.ts`). An image generation tool's result is tool-call content with no message chunk at all, so text-only emptiness checks dropped it — the blank-chat bug. Pictures ride beside the text (`turn.images`), not spliced into the markdown, and `Turn`'s memo compares that array by identity because inline base64 is megabytes. Fetches are deduped by uri in a ref, since a recycling list mounts the same image repeatedly. Saving lives in the full-screen viewer, not on the thumbnail, where a button fights the scroll: `saveImage.ts` stays Expo-free, `ui/imageSaver.ts` binds media-library/sharing, and a denied permission falls back to the share sheet rather than losing the picture.
- **An agent error already on screen is *promoted* to the error role, not appended** (`errorDedup.ts`) — only the client knows what is rendered.
- **The transcript is FlashList v2 (`ui/ChatThread.tsx`) and owns its scroll position.** `maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}` is the whole mechanism. Never scroll imperatively from `onLayout`/`onContentSizeChange` — a state-driven scroll racing native repositioning is the jump this replaced; the only legitimate `scrollToEnd` is the tap-driven jump-to-latest. Contract: `keyExtractor` is `turn.key ?? turn.id` (an optimistic prompt keeps its key until the server echo adopts it, else the cell tears down mid-stream), every prop is memo-stable, and `key={sessionId}` remounts the list so `startRenderingFromBottom` re-arms. Cells recycle, so a mount no longer means "new message": `Turn` is memoized with no per-mount fade, the streaming dots are a `ListFooterComponent`, and an empty agent turn renders `null` (it is committed before its chunks arrive and would reserve a visible gap).
- **Slash command names end at the first non-word char, allowing `:` and `-`** (`slashCommands.ts`), because the composer lifts the command into a badge and rejoins later keystrokes after a space — matching the first word would assemble `/h elp` letter by letter. Normalise via `offeredCommands()` on *both* the probe list and the agent's `available_commands_update`, or the menu changes contents the moment the first prompt is sent.
- **`useDaemon` keeps `sessionRef`/`providerRef` mirrors.** React may invoke a `setState` updater twice, so updaters stay pure — never send a message or assign a ref inside one.
- **Pure modules stay Expo-free**: `pairingLink.ts`/`hapticsPolicy.ts` are testable, `pairing.ts`/`ui/haptics.ts` bind the native SDKs. Importing `expo-secure-store`/`expo-haptics` into the pure half breaks `bun test`, which cannot parse React Native's Flow syntax. Haptics are named by meaning (`sent`, `failed`, `finished`) and throttled — a failed turn errors *and* goes idle milliseconds apart, otherwise felt as one mushy double-buzz.
- **The conversation pane needs `zIndex: 1`** or the absolutely-positioned drawer paints over it and swallows touches; **`theme.gutter`/`theme.headerInset` are shared rails** or the title drifts from the hamburger as the drawer slides; **Composer subtracts `HALF_LEADING`** because iOS puts the whole leading above glyphs in a multiline `TextInput`.

## Workflows

- **Runtime is Bun** (`engines: bun >=1.2.0`). CI is ubuntu-only: frozen-lockfile install, typecheck, test.
- **`npm run daemon` is not the server.** It runs `index.ts`, which only prints JSON to stdout. The WebSocket server the app talks to is `bun run packages/daemon/src/server.ts` (8787, `PEW2_PORT`). The `echo` provider is a real ACP agent needing no key or network — the only way to exercise the pipeline offline.
- **Live app loop:** start that server, then `cd packages/app && npx expo start --ios`; scan the QR the daemon prints. Expo Go caches aggressively — if an edit doesn't appear, kill the app and re-open `exp://127.0.0.1:8081`; a stale bundle looks exactly like a failed fix.
- **`npm run typecheck` chains three tsc passes** because the root config excludes the app, the relay needs `@cloudflare/workers-types` (globals conflict with Node's), and the app needs React Native's config.
- **Two integration checks need a server already running and are not in `npm test`:** `npm run relay:dev` then `npm run relay:check`; and, with the daemon up, `bun run packages/daemon/src/testing/e2e-check.mjs`.
- **`providers validate` proves only that the JSON parses.** `providers verify <id>` spawns the process, does the handshake, sends a real prompt and counts updates. Always finish with `verify`.
- **Remote needs a relay; without one it is same-Wi-Fi only.** `pew2 relay <url>` stores it; `pew2 pair` then prints `wss://`. `wrangler dev --local` silently breaks WebSocket upgrades (requests never reach the Worker, `relay:check` hangs), so `relay:dev` does not pass it.
- **`pew2` is not on PATH until `cd packages/daemon && bun link`** — the package is private with a `bin` entry, and without the link the pairing screen names a command the user does not have.
- **launchd starts the daemon with almost no environment.** The plist must state `PATH` explicitly (including bun's dir, or `npx` providers all appear missing), and any manifest arg that is a local script must be `./`-relative so the registry resolves it against the manifest. `pew2 service install|restart|uninstall`; logs in `~/.pew2/logs/`.
- **`pew2 setup --json` / `doctor --json` are the agent-facing surface.** `ok` is the stop condition, every problem carries a stable `id` and a runnable `fix`, and the exit code mirrors `ok`. Missing secrets and LAN-only are `warning`, never `error` — an agent cannot supply a secret or make a product decision and must not loop on one.
<!-- gg:init:end -->
