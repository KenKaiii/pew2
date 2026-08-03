/**
 * Adapter detection: turn "what is already installed on this machine" into
 * provider manifests, with no questions asked.
 *
 * This is the first half of the one-command setup story. A coding agent should
 * not have to know that Claude Code needs an npx adapter while OpenClaw has a
 * built-in `acp` subcommand — it runs `pew2 detect --json`, reads what was
 * found, and acts on what was not.
 *
 * Two rules make it safe to run repeatedly, which is what lets an agent loop on
 * it: an id that already loads from anywhere is never written again, and an
 * existing file is never overwritten.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderManifestInput } from "@pew2/protocol";
import { findOnPath, loadProviders, providerDirs, userProvidersDir } from "./registry.js";

export interface CatalogEntry {
  id: string;
  name: string;
  /**
   * Commands that prove the underlying tool is installed. Any one is enough.
   *
   * This is deliberately not the manifest's own command: an `npx` distribution
   * has nothing on PATH to look for, so what is probed is the CLI the adapter
   * wraps. Finding `claude` is what tells us a Claude Code adapter is worth
   * configuring.
   */
  probe: string[];
  /** Shown when the tool is absent, so the caller knows how to get it. */
  install: string;
  manifest: ProviderManifestInput;
}

/**
 * Known ACP adapters.
 *
 * Kept to entries that have been verified to speak ACP over stdio. Adding one
 * here is the only code change any agent integration should ever need, and even
 * that is optional — a hand-written manifest in `~/.pew2/providers` works
 * identically.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    probe: ["claude", "claude-code-acp"],
    install: "npm install -g @anthropic-ai/claude-code",
    manifest: {
      id: "claude-code",
      name: "Claude Code",
      version: "1.0.0",
      description: "Anthropic's Claude Code, via the official ACP adapter.",
      distribution: {
        type: "npx",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "latest",
      },
      repository: "https://github.com/zed-industries/claude-agent-acp",
      license: "Apache-2.0",
      pew: {
        transport: "acp",
        color: "#d97757",
        env: [
          {
            name: "ANTHROPIC_API_KEY",
            description:
              "Anthropic API key. Omit if you are already logged in via the Claude Code CLI.",
            required: false,
          },
        ],
      },
    },
  },
  {
    id: "codex",
    name: "Codex",
    probe: ["codex-acp", "codex"],
    install: "npm install -g @openai/codex",
    manifest: {
      id: "codex",
      name: "Codex",
      version: "1.0.0",
      description: "OpenAI Codex CLI, via Zed's official ACP adapter.",
      distribution: { type: "command", command: "codex-acp", args: [] },
      repository: "https://github.com/zed-industries/codex-acp",
      license: "Apache-2.0",
      pew: {
        transport: "acp",
        color: "#10a37f",
        env: [
          {
            name: "OPENAI_API_KEY",
            description: "OpenAI API key. Omit if the Codex CLI is already authenticated.",
            required: false,
          },
        ],
      },
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    probe: ["gemini"],
    install: "npm install -g @google/gemini-cli",
    manifest: {
      id: "gemini-cli",
      name: "Gemini CLI",
      version: "1.0.0",
      description:
        "Google's Gemini CLI. Speaks ACP natively, but needs GEMINI_API_KEY: Google withdrew Sign-in-with-Google for Gemini Code Assist for individuals, so OAuth-authenticated installs now fail.",
      // `--acp`, not `--experimental-acp`. The CLI's own option help now reads
      // "deprecated, use --acp instead"; the old spelling still works today but
      // is on its way out.
      distribution: {
        type: "npx",
        package: "@google/gemini-cli",
        version: "latest",
        args: ["--acp"],
      },
      repository: "https://github.com/google-gemini/gemini-cli",
      license: "Apache-2.0",
      pew: {
        transport: "acp",
        color: "#4285f4",
        env: [
          {
            name: "GEMINI_API_KEY",
            description:
              "Gemini API key from https://aistudio.google.com/apikey. Now required: Google rejects Sign-in-with-Google for Gemini Code Assist for individuals, so an OAuth-only install fails every request with 'This client is no longer supported'.",
            required: true,
          },
        ],
      },
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    probe: ["openclaw"],
    install: "npm install -g openclaw",
    manifest: {
      id: "openclaw",
      name: "OpenClaw",
      version: "1.0.0",
      description:
        "OpenClaw's ACP bridge. Speaks ACP over stdio and forwards prompts to a local or remote OpenClaw Gateway, so a Gateway must already be running.",
      // `openclaw acp` is the bridge itself. The `@openclaw/acpx` npm package is
      // a Gateway *plugin* with no bin, and the unscoped `acpx` on npm is an
      // unrelated project by another author — neither can launch this.
      distribution: { type: "command", command: "openclaw", args: ["acp"] },
      repository: "https://github.com/openclaw/openclaw",
      license: "MIT",
      pew: {
        transport: "acp",
        color: "#c2410c",
        env: [
          {
            name: "OPENCLAW_GATEWAY_TOKEN",
            description:
              "Token auth for a remote Gateway. Optional: a local Gateway on the same machine resolves its own credentials, so requiring this would wrongly gate the common setup.",
            required: false,
          },
          {
            name: "OPENCLAW_GATEWAY_PASSWORD",
            description:
              "Password auth for a remote Gateway. The alternative to OPENCLAW_GATEWAY_TOKEN, not an addition to it.",
            required: false,
          },
        ],
      },
    },
  },
  {
    id: "hermes",
    name: "Hermes",
    probe: ["hermes"],
    // The ACP transport is an extra, not part of the base install: without it
    // the `hermes acp` subcommand cannot import agent-client-protocol.
    install: "pip install 'hermes-agent[acp]'",
    manifest: {
      id: "hermes",
      name: "Hermes",
      version: "1.0.0",
      description:
        "Nous Research's Hermes Agent. Speaks ACP natively over stdio — no adapter process. Credentials come from ~/.hermes/.env, set up with `hermes model`.",
      // The wheel ships three console scripts — `hermes`, `hermes-acp` and
      // `hermes-agent`. `hermes acp` and `hermes-acp` reach the same ACP entry
      // point; the subcommand is used so detection probes the one binary a user
      // will have anyway.
      //
      // Not a `uvx` distribution: that resolves to `uvx <package> <args>`, which
      // cannot express the `--from 'hermes-agent[acp]'` needed to select the
      // extra — and bare `uvx hermes-agent` runs the third script, which is the
      // agent runner rather than the ACP server.
      distribution: { type: "command", command: "hermes", args: ["acp"] },
      repository: "https://github.com/NousResearch/hermes-agent",
      license: "MIT",
      // No env declared on purpose. Hermes resolves provider credentials itself
      // from ~/.hermes/.env, so naming any one key required would gate a
      // correctly configured install — the inverse of the Gemini case, where the
      // key genuinely is the only way in.
      pew: { transport: "acp", color: "#6366f1" },
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    probe: ["opencode"],
    install: "npm install -g opencode-ai",
    manifest: {
      id: "opencode",
      name: "OpenCode",
      version: "1.0.0",
      description: "The open source coding agent. Speaks ACP natively over stdio.",
      distribution: { type: "npx", package: "opencode-ai", version: "latest", args: ["acp"] },
      repository: "https://github.com/anomalyco/opencode",
      license: "MIT",
      // Colours here are drawn as an Orb on the app's dark surface (#1b1b1e), so
      // they are picked for contrast against it rather than matched exactly to a
      // brand mark. OpenCode's and Cursor's marks are near-black and would be
      // invisible dots.
      pew: { transport: "acp", color: "#e4e4e7" },
    },
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot CLI",
    probe: ["copilot"],
    install: "npm install -g @github/copilot",
    manifest: {
      id: "github-copilot",
      name: "GitHub Copilot CLI",
      version: "1.0.0",
      description:
        "GitHub's AI pair programmer, in ACP mode. Requires a Copilot subscription.",
      distribution: {
        type: "npx",
        package: "@github/copilot",
        version: "latest",
        args: ["--acp"],
      },
      repository: "https://github.com/github/copilot-cli",
      license: "proprietary",
      pew: { transport: "acp", color: "#a371f7" },
    },
  },
  {
    id: "cline",
    name: "Cline",
    probe: ["cline"],
    install: "npm install -g cline",
    manifest: {
      id: "cline",
      name: "Cline",
      version: "1.0.0",
      description: "Autonomous coding agent CLI, in ACP mode.",
      distribution: { type: "npx", package: "cline", version: "latest", args: ["--acp"] },
      repository: "https://github.com/cline/cline",
      license: "Apache-2.0",
      pew: { transport: "acp", color: "#818cf8" },
    },
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    // The package is `@qwen-code/qwen-code`, but the binary it installs is
    // `qwen` — probing the package name would never match.
    probe: ["qwen"],
    install: "npm install -g @qwen-code/qwen-code",
    manifest: {
      id: "qwen-code",
      name: "Qwen Code",
      version: "1.0.0",
      description: "Alibaba's Qwen coding assistant, in ACP mode.",
      // `--experimental-skills` comes from the registry's own launch line. Qwen
      // answers the handshake without it, so dropping it looks harmless right up
      // until a skill-dependent feature silently does nothing.
      distribution: {
        type: "npx",
        package: "@qwen-code/qwen-code",
        version: "latest",
        args: ["--acp", "--experimental-skills"],
      },
      repository: "https://github.com/QwenLM/qwen-code",
      license: "Apache-2.0",
      pew: { transport: "acp", color: "#615ced" },
    },
  },
  {
    id: "goose",
    name: "goose",
    probe: ["goose"],
    // Distributed as a platform binary rather than on a package registry, so
    // there is no npx/uvx form to fall back on: it has to be on PATH already.
    install: "See https://block.github.io/goose/docs/getting-started/installation",
    manifest: {
      id: "goose",
      name: "goose",
      version: "1.0.0",
      description:
        "Block's local, extensible open source agent. Install from block.github.io/goose, then it speaks ACP over stdio.",
      distribution: { type: "command", command: "goose", args: ["acp"] },
      repository: "https://github.com/block/goose",
      license: "Apache-2.0",
      pew: { transport: "acp", color: "#26c6da" },
    },
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    probe: ["cursor-agent"],
    install: "See https://cursor.com/cli",
    manifest: {
      id: "cursor-agent",
      name: "Cursor Agent",
      version: "1.0.0",
      description:
        "Cursor's coding agent CLI. Install from cursor.com/cli, then it speaks ACP over stdio.",
      distribution: { type: "command", command: "cursor-agent", args: ["acp"] },
      repository: "https://cursor.com/docs/cli/acp",
      license: "proprietary",
      pew: { transport: "acp", color: "#94a3b8" },
    },
  },
];

/** What happened to one catalog entry that was found on this machine. */
export interface DetectedProvider {
  id: string;
  name: string;
  /** The executable that proved it is installed. */
  foundAt: string;
  /**
   * `written` — a new manifest was created.
   * `already-configured` — a provider with this id already loads.
   * `file-exists` — a file is in the way but did not load; left untouched.
   */
  action: "written" | "already-configured" | "file-exists";
  /** Absolute path of the manifest this entry resolves to. */
  manifestPath: string;
}

export interface MissingProvider {
  id: string;
  name: string;
  /** The commands that were looked for and not found. */
  probe: string[];
  install: string;
}

export interface DetectResult {
  /** Where new manifests are written. */
  providersDir: string;
  detected: DetectedProvider[];
  missing: MissingProvider[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  /** Where new manifests are written. Defaults to `~/.pew2/providers`. */
  targetDir?: string;
  /** Directories scanned for providers that already exist. */
  searchDirs?: string[];
  catalog?: CatalogEntry[];
  /** Report what would happen without touching the disk. */
  dryRun?: boolean;
}

export async function detectProviders(options: DetectOptions = {}): Promise<DetectResult> {
  const env = options.env ?? process.env;
  const targetDir = options.targetDir ?? userProvidersDir(env);
  const searchDirs = options.searchDirs ?? providerDirs(env);
  const catalog = options.catalog ?? CATALOG;

  // Ids that already resolve, from any directory. Detection must never write a
  // second manifest for a provider the user has already configured by hand.
  const { providers } = await loadProviders(searchDirs, env);
  const configured = new Map(providers.map((p) => [p.manifest.id, p.source]));

  const detected: DetectedProvider[] = [];
  const missing: MissingProvider[] = [];

  for (const entry of catalog) {
    const foundAt = entry.probe
      .map((command) => findOnPath(command, env))
      .find((path): path is string => path !== undefined);

    if (!foundAt) {
      missing.push({
        id: entry.id,
        name: entry.name,
        probe: entry.probe,
        install: entry.install,
      });
      continue;
    }

    const existing = configured.get(entry.id);
    if (existing) {
      detected.push({
        id: entry.id,
        name: entry.name,
        foundAt,
        action: "already-configured",
        manifestPath: existing,
      });
      continue;
    }

    const manifestPath = join(targetDir, `${entry.id}.json`);
    if (options.dryRun) {
      detected.push({ id: entry.id, name: entry.name, foundAt, action: "written", manifestPath });
      continue;
    }

    await mkdir(targetDir, { recursive: true });
    let action: DetectedProvider["action"] = "written";
    try {
      // `wx` fails rather than truncating. A file that exists but did not load
      // is broken user work, and silently replacing it would destroy it.
      await writeFile(manifestPath, `${JSON.stringify(entry.manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      action = "file-exists";
    }

    detected.push({ id: entry.id, name: entry.name, foundAt, action, manifestPath });
  }

  return { providersDir: targetDir, detected, missing };
}
