# 📱 pew2

<p align="center">
  <img src="docs/icon.png" alt="pew2" width="160">
</p>

<p align="center">
  <strong>Your coding agents. On your phone. From anywhere.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/pew2/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/pew2?style=for-the-badge&label=CLI&color=d97757" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

---

Claude Code, Codex, Gemini and about ten others already run on your computer.
They just can't leave the room. pew2 puts them in your pocket.

Your computer keeps doing the work. Your phone becomes the way you talk to it.
Kick something off from the couch, check on it from the train, approve a file
write while you're getting coffee.

**Nothing runs in the cloud.** No API keys leave your machine. The agent is the
one you already installed, running on your own hardware, on your own files.

---

## 🚀 Get it running

Two things: the app on your phone, and a small program on your computer.

### 1. The app

Coming to TestFlight. Android APK builds are in
[Releases](https://github.com/KenKaiii/pew2/releases/latest).

### 2. The computer bit

Open Terminal (macOS) or PowerShell (Windows) and paste one line.

**macOS and Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh
```

**Windows**

```powershell
irm https://raw.githubusercontent.com/KenKaiii/pew2/main/install.ps1 | iex
```

Then:

```bash
pew2 setup
```

That looks at your computer, finds the coding agents you already have, gets
everything running in the background, and shows you a QR code. Scan it with the
app. Done.

You do not need Node, Bun, Docker, a GitHub account or a copy of this repo. It is
one file that runs on its own.

On macOS it also sets itself to start again after a reboot. On Windows and Linux
that part is not built yet, so you start it yourself after restarting. Everything
else is identical.

> Want to read the script before you run it? Sensible.
> [install.sh](install.sh) and [install.ps1](install.ps1) are short on purpose.

---

## 🤖 Which agents work

pew2 does not include an AI. It drives the agents already installed on your
machine, so you keep your own subscription, your own keys, your own limits.

| Agent | Get it | Notes |
| --- | --- | --- |
| **Claude Code** | [claude.ai/code](https://claude.ai/code) | Works out of the box |
| **Codex** | [OpenAI Codex CLI](https://github.com/openai/codex) | Works out of the box |
| **GG Coder** | [gg-framework](https://github.com/KenKaiii/gg-framework) | Mine. Obviously it works |
| **Gemini CLI** | `npm i -g @google/gemini-cli` | Needs a `GEMINI_API_KEY` |
| **OpenCode** | `npm i -g opencode-ai` | Works out of the box |
| **GitHub Copilot** | `npm i -g @github/copilot` | Needs a Copilot subscription |
| **Cline** | `npm i -g cline` | Works out of the box |
| **Qwen Code** | `npm i -g @qwen-code/qwen-code` | Run `qwen` once to log in first |
| **goose** | [block.github.io/goose](https://block.github.io/goose) | Works out of the box |
| **Cursor Agent** | [cursor.com/cli](https://cursor.com/cli) | Works out of the box |
| **Hermes** | `pip install 'hermes-agent[acp]'` | Nous Research |
| **OpenClaw** | `npm i -g openclaw` | Needs a Gateway running |

Do not have any of them? `pew2 setup` tells you what is missing and where to get
it. You only need one.

Anything that speaks [ACP](https://agentclientprotocol.com) works, and adding one
is a single JSON file. There are 40-odd more in the public registry:

```bash
pew2 registry sync
```

---

## ✨ What it does

### Picks up where you left off

Every conversation lives on your computer, not the phone. Start on your laptop,
carry on from your phone, go back to the laptop. Same thread, nothing lost.

### Switch models mid-thought

Sonnet to Opus, standard thinking to extended, without leaving the chat. The app
reads what your agent actually offers, so you get its real options rather than a
guess.

### Approve things without being at your desk

When an agent wants to write a file or run a command, the request comes to your
phone. Approve or deny with a thumb.

### Every project on your machine

It finds your git repos on its own and lists them newest first. Pick one and
start. Never worked in it before? Browse straight to it from the phone.

### Talk instead of typing

Hold the mic, say what you want. Phone keyboards are miserable for prompts.

### Photos and screenshots

Send a screenshot of a bug, a design, a whiteboard. Straight into the
conversation.

### It tells you when it is done

Push notification the moment a long run finishes, so you can put the phone down
and get on with your life.

---

## 🔒 About your data

**Your machine, your agents, your files.** pew2 runs no AI and has no server that
sees your work.

**Traffic is end-to-end encrypted.** The phone and your computer share a key that
travels by QR code, and nothing in between can read the messages. Not even the
relay that connects them, which only ever sees ciphertext.

**The relay is yours too.** Off your home Wi-Fi, the connection goes through a
small Cloudflare Worker you deploy to your own account. No shared server, no
signup. The free tier is plenty.

```bash
npm run relay:deploy
pew2 relay wss://your-worker.workers.dev
```

Straight about the limits: your pairing key is a bearer secret with no expiry.
Anyone holding it can drive the agents on your machine, so treat it like an SSH
key, and run `pew2 pair --rotate` if it ever ends up somewhere it should not be.
Full detail in [SECURITY.md](SECURITY.md).

---

## 🛠 Everyday commands

```bash
pew2 setup             # find agents, start the service, show the QR
pew2 pair              # pair another phone
pew2 doctor            # what is broken, and how to fix it
pew2 providers list    # what is installed and what is missing
pew2 registry sync     # add every agent in the public ACP registry
```

---

## 🏗 How it works

Three pieces, and only one of them is doing anything clever.

| Piece | What it does |
| --- | --- |
| **Daemon** | Runs on your computer. Owns the agents, the sessions and the history. |
| **App** | Runs on your phone. A remote control, not a client. |
| **Relay** | Optional. A dumb pipe on Cloudflare for when you are not home. |

The daemon holds the state, so both ends can drop off the network and pick up
again without losing a conversation. Agents are spoken to over
[ACP](https://agentclientprotocol.com), which is why adding one is a JSON
manifest and no code.

---

## 👨‍💻 Build it yourself

Everything above is the shipped path. If you want to hack on it:

```bash
git clone https://github.com/KenKaiii/pew2.git
cd pew2
bun install
cd packages/daemon && bun link     # puts `pew2` on your PATH
```

Then the app:

```bash
cd packages/app

# The npm package is `eas-cli`. A bare `npx eas` is an unrelated package
# and fails with "could not determine executable to run".
npx eas-cli@latest init                                       # links YOUR Expo account
npx eas-cli@latest build --profile apk --platform android     # APK, install it, done
npx eas-cli@latest build --profile device --platform ios      # signed for your own device
npx eas-cli@latest build --profile simulator --platform ios   # no signing, no account
```

Builds run on Expo's machines, so no local Xcode or NDK needed. `eas init` comes
first because nobody's Expo account is committed here. Put what it gives you in
`packages/app/eas-project.json`, which is gitignored:

```json
{ "owner": "your-expo-username", "projectId": "the-uuid-from-eas-init" }
```

**On iOS signing:** you do not need the $99 Apple Developer Program to run this
on your own phone. The free tier gives you a **7-day** signature and caps you at
3 sideloaded apps. That is Apple policy, not a pew2 thing.
[AltStore](https://altstore.io) or [SideStore](https://sidestore.io) re-sign in
the background on a schedule, which normally needs a computer awake on your
network at the right moment. pew2 already requires exactly that.

**Android needs no developer account, ever.** A signed APK installs once and
keeps working.

### Layout

| Path | What |
| --- | --- |
| `packages/protocol` | Manifest + wire schemas (zod) |
| `packages/daemon` | Provider registry, ACP client, session log, CLI |
| `packages/relay` | Cloudflare Worker + Durable Object |
| `packages/app` | Expo app (iOS + Android) |
| `providers/` | One JSON manifest per agent |

### Checks

```bash
npm run typecheck            # daemon + protocol + relay + app
npm test                     # daemon pipeline against the local echo agent
npm run providers:validate   # every manifest parses and validates
```

Adding an agent is one JSON file and no code. See
[docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md).

---

## 🕳 Known gaps

Being straight with you:

1. **No forward secrecy, no per-device revocation.** One key lasts the life of a
   pairing, so a key leaked tomorrow decrypts traffic captured today, and
   removing one device means re-pairing all of them.
2. **Autostart is macOS only.** On Windows and Linux the daemon does not come
   back by itself after a reboot yet.
3. **`pty` transport is reserved but unimplemented.** `verify` skips it.

---

## 👥 Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai), tutorials and demos
- [Skool community](https://skool.com/kenkai), come hang out

---

## 📄 Licence

AGPL-3.0. Use it, change it, run it for yourself. If you run a modified version
as a service other people use, share your changes.

---

<p align="center">
  <strong>Your agents already work. Now they follow you around.</strong>
</p>
