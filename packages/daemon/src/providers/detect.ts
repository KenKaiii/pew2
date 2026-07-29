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
      description: "Google's Gemini CLI, the original ACP launch partner. Speaks ACP natively.",
      distribution: {
        type: "npx",
        package: "@google/gemini-cli",
        version: "latest",
        args: ["--experimental-acp"],
      },
      repository: "https://github.com/google-gemini/gemini-cli",
      license: "Apache-2.0",
      pew: {
        transport: "acp",
        color: "#4285f4",
        env: [
          {
            name: "GEMINI_API_KEY",
            description: "Gemini API key. Omit if the Gemini CLI is already authenticated.",
            required: false,
          },
        ],
      },
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    probe: ["openclaw"],
    install: "See https://docs.openclaw.ai/start/onboarding-overview",
    manifest: {
      id: "openclaw",
      name: "OpenClaw",
      version: "1.0.0",
      description:
        "OpenClaw's ACP bridge, forwarding prompts to a local or remote Gateway session.",
      distribution: { type: "command", command: "openclaw", args: ["acp"] },
      repository: "https://github.com/openclaw/acpx",
      pew: { transport: "acp", color: "#c2410c" },
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
