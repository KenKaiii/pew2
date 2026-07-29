# Adding a provider

> Read this file top to bottom before adding a provider. It is written to be
> followed exactly, by a person or a coding agent, with no other context.

A **provider** is any agent, app or CLI that shows up in the pew2 mobile app.
Adding one means **writing a single JSON file into `providers/`**. There is no
registration call, no code change, no rebuild.

---

## The 60-second version

Most of the time you do not need this file at all:

```bash
pew2 setup            # detect what is installed, configure it, verify it, diagnose
```

Read on only when `setup` reports an agent it does not know about.

```bash
bun run packages/daemon/src/cli/index.ts providers add my-agent   # scaffold
$EDITOR ~/.pew2/providers/my-agent.json                            # point it at your binary
bun run packages/daemon/src/cli/index.ts providers verify my-agent # prove it works
```

(`npm run providers:verify my-agent` is the same thing, if you prefer scripts.)

When `verify` prints `ok`, the provider is done. It will appear in the app the
next time the daemon announces its providers.

Manifests are read from two directories, highest precedence first:

| Directory | What lives there |
| --- | --- |
| `~/.pew2/providers` | Anything you or `pew2 detect` writes. Override the root with `PEW2_HOME`. |
| `./providers` | The manifests bundled with a checkout. |

Same id in both is deliberate shadowing — yours wins, silently. Same id twice in
**one** directory is an error.

---

## Decide the transport first

This is the only decision that really matters.

| Your app… | Use | You get |
| --- | --- | --- |
| speaks ACP, or has an ACP adapter | `acp` | Streamed messages, tool calls, diffs, plans, **approve/deny from the phone** |
| is any other CLI | `pty` | A raw terminal view only. No structured approvals. |

> **`pty` is reserved, not yet implemented.** The manifest accepts it, and
> `verify` will skip it rather than pretend it passed. Today, use `acp`.

**Always prefer `acp`.** Before reaching for a fallback, check whether an adapter
already exists — the [ACP agent list](https://agentclientprotocol.com/get-started/agents)
covers Claude, Codex, Gemini, Copilot, Cursor, Goose, OpenCode, OpenHands and
~30 more. Wrapping your own tool in ACP is usually under 100 lines; see
`packages/daemon/src/testing/echo-agent.ts` for a complete minimal agent.

---

## Choose a distribution

Exactly one of these. It tells the daemon how to launch the process.

**`npx`** — a published Node package:

```json
"distribution": { "type": "npx", "package": "@agentclientprotocol/claude-agent-acp", "version": "latest" }
```

**`uvx`** — a published Python package:

```json
"distribution": { "type": "uvx", "package": "my-agent-acp", "version": "latest" }
```

**`command`** — anything already on `PATH`, or an absolute path. This is the
escape hatch for your own app; nothing needs to be published:

```json
"distribution": { "type": "command", "command": "my-agent", "args": ["--acp"] }
```

---

## Declare the environment it needs

Do **not** hardcode secrets in the manifest. Declare the variable names; the
daemon forwards them from its own environment and refuses to start a provider
whose `required` variables are missing, so failures are loud and early instead
of a confusing mid-session crash.

```json
"pew": {
  "env": [
    { "name": "MY_API_KEY", "description": "Get one at example.com", "required": true }
  ]
}
```

Mark a key `required: false` when the underlying CLI can also authenticate via
its own login flow (this is why `claude-code` and `codex` do not force one).

---

## Full example

```json
{
  "$schema": "../schemas/provider.schema.json",
  "id": "my-agent",
  "name": "My Agent",
  "version": "1.0.0",
  "description": "One sentence on what it does.",
  "distribution": { "type": "command", "command": "my-agent", "args": ["--acp"] },
  "repository": "https://github.com/me/my-agent",
  "license": "MIT",
  "pew": {
    "transport": "acp",
    "color": "#4285f4",
    "env": [{ "name": "MY_API_KEY", "required": true }]
  }
}
```

Keep `$schema` on the first line. It gives editors autocomplete and inline
validation, which prevents most mistakes before the CLI ever runs.

---

## Verify

`verify` is not a lint. It spawns the process, performs the ACP `initialize`
handshake, opens a session, sends a real prompt, auto-approves any permission
request, and counts the updates that came back.

```
$ bun run packages/daemon/src/cli/index.ts providers verify my-agent
my-agent … ok session=sess_abc updates=7
```

`updates=0` means the process started but streamed nothing — usually a wrong
subcommand, or an agent that is not actually in ACP mode.

---

## Rules

1. **One provider per file**, named `<id>.json`, where `<id>` matches the `id` field.
2. **Ids are `^[a-z][a-z0-9-]*$`.** Duplicates are rejected — the whole file is skipped, not silently merged.
3. **`additionalProperties` is false.** A typo'd key is an error, not a field that silently does nothing.
4. **Never put a secret in a manifest.** These files are committed.
5. **A broken manifest never takes the daemon down.** It is reported and skipped so other providers keep working.
6. **Always finish with `verify`.** A manifest that only passes `validate` has proven nothing except that it is well-formed JSON.
7. **Never write a secret into a manifest**, including one generated by `detect`. Manifests declare variable names; the daemon supplies the values from its own environment.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Missing required environment variables` | Export the variable, or set `required: false` if the CLI has its own login. |
| `timed out after 60s` | The process starts but never completes `initialize` — it is probably not in ACP mode. Check the adapter's flags. |
| `Not valid JSON` | Trailing comma, or a comment. Manifests are strict JSON. |
| `Duplicate provider id` | Two files declare the same `id`. |
| Command not found | `command` is not on `PATH`. Use an absolute path to confirm, then fix `PATH`. |
