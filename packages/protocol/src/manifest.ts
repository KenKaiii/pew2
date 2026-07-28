/**
 * Provider manifest schema.
 *
 * A "provider" is any agent/app/CLI that can be surfaced in the pew2 mobile app.
 * Adding one = dropping a JSON file in `providers/`. Nothing else.
 *
 * The core fields are deliberately identical to the ACP Agent Registry manifest
 * (`<id>/agent.json`) so that any manifest published to
 * https://github.com/agentclientprotocol/registry can be copied here verbatim.
 * pew2-specific additions live under the `pew` key so they never collide.
 *
 * Spec: https://agentclientprotocol.com/rfds/acp-agent-registry
 */
import { z } from "zod";

/** Registry id: lowercase letters, digits, hyphens; must start with a letter. */
export const ProviderId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "must be lowercase letters, digits and hyphens, and start with a letter (e.g. 'my-agent')",
  );

const SemVer = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, "must be a semantic version, e.g. '1.0.0'");

/**
 * Environment variables the provider needs in order to run.
 * The daemon forwards these from its own environment; it never invents values.
 * Anything marked `required` is checked before spawn so failures are loud and early
 * rather than a confusing crash mid-session.
 */
const EnvVar = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().default(false),
  })
  .strict();

/** Run a Node package via npx. The most common case. */
const NpxDistribution = z.object({
  type: z.literal("npx"),
  package: z.string().min(1),
  version: z.string().default("latest"),
  args: z.array(z.string()).default([]),
});

/** Run a Python package via uvx. */
const UvxDistribution = z.object({
  type: z.literal("uvx"),
  package: z.string().min(1),
  version: z.string().default("latest"),
  args: z.array(z.string()).default([]),
});

/**
 * Run an already-installed executable found on PATH (or an absolute path).
 * This is the escape hatch for "my own app" — no publishing required.
 */
const CommandDistribution = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const Distribution = z.discriminatedUnion("type", [
  NpxDistribution,
  UvxDistribution,
  CommandDistribution,
]);

/**
 * How the daemon talks to the process once spawned.
 *
 * - `acp`  — JSON-RPC over stdio per the ACP spec. Full fidelity: streamed
 *            message chunks, tool calls, diffs, plans, permission prompts.
 * - `pty`  — raw pseudo-terminal. Works with literally any CLI, but the app
 *            can only render a terminal; no structured approvals.
 *
 * Prefer `acp`. Use `pty` only when the target cannot speak ACP.
 */
export const Transport = z.enum(["acp", "pty"]);

const PewExtensions = z.object({
  transport: Transport.default("acp"),
  /** Short label shown in the app's provider list. Defaults to `name`. */
  label: z.string().optional(),
  /** Hex colour used for the provider's avatar in the app. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a hex colour like '#d97757'")
    .optional(),
  env: z.array(EnvVar).default([]),
  /**
   * Whether the app should ask the user to pick a working directory before
   * starting a session. Set false for agents that do not operate on a
   * project folder (e.g. a general-purpose chat agent).
   */
  requiresWorkspace: z.boolean().default(true),
  /** Marks a provider as a local test fixture; hidden from the app by default. */
  experimental: z.boolean().default(false),
});

/** Strict so that a mistyped key is a loud error, never a silently ignored field. */
const StrictPewExtensions = PewExtensions.strict();

export const ProviderManifest = z
  .object({
    $schema: z.string().optional(),
    id: ProviderId,
    name: z.string().min(1),
    version: SemVer,
    description: z.string().min(1),
    distribution: Distribution,
    repository: z.string().url().optional(),
    authors: z.array(z.string()).default([]),
    license: z.string().optional(),
    pew: StrictPewExtensions.default({}),
  })
  .strict();

export type ProviderManifest = z.output<typeof ProviderManifest>;
export type ProviderManifestInput = z.input<typeof ProviderManifest>;
export type Distribution = z.output<typeof Distribution>;
export type Transport = z.output<typeof Transport>;

/**
 * Resolve a manifest's distribution into a concrete argv.
 * Kept pure so it is trivially testable and so the CLI and daemon can never
 * disagree about how a provider is launched.
 */
export function resolveCommand(manifest: ProviderManifest): {
  command: string;
  args: string[];
} {
  const d = manifest.distribution;
  switch (d.type) {
    case "npx":
      return {
        command: "npx",
        args: ["-y", `${d.package}@${d.version}`, ...d.args],
      };
    case "uvx":
      return {
        command: "uvx",
        args:
          d.version === "latest"
            ? [d.package, ...d.args]
            : [`${d.package}==${d.version}`, ...d.args],
      };
    case "command":
      return { command: d.command, args: d.args };
  }
}

/** Human-readable, line-oriented validation errors. */
export function formatManifestError(error: z.ZodError, source: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
  return `Invalid provider manifest: ${source}\n${lines.join("\n")}`;
}
