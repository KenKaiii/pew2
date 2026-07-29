/**
 * Provider registry: turns a directory of JSON manifests into runnable providers.
 *
 * The whole "add your own app" story lives here. A coding agent adds a provider by
 * writing one file into `providers/`. No code changes, no registration call, no
 * rebuild — the daemon rescans and re-announces to connected phones.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute, delimiter, dirname } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ProviderManifest,
  formatManifestError,
  resolveCommand,
  type ProviderManifest as Manifest,
} from "@pew2/protocol";

export interface LoadedProvider {
  manifest: Manifest;
  /** Absolute path of the manifest, used in error messages. */
  source: string;
  command: string;
  args: string[];
  /** Env var names declared required but missing from the daemon's environment. */
  missingEnv: string[];
  /** True when `command` could not be found on PATH. */
  commandMissing: boolean;
}

/**
 * Resolve an executable the way a shell would, or `undefined` if it is not
 * installed. Checked up front so an uninstalled agent is shown as unavailable
 * in the app rather than failing at spawn time, and reused by `detect` to work
 * out which adapters this machine already has.
 *
 * For `npx`/`uvx` distributions this checks the launcher itself, not the
 * package: those fetch on demand, so a missing `npx` is the only thing that can
 * be known ahead of time — and it is worth knowing, since without it the
 * provider cannot start at all.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isAbsolute(command) || command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function canResolveCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  return findOnPath(command, env) !== undefined;
}

export interface LoadResult {
  providers: LoadedProvider[];
  /** Manifests that failed to parse or validate. Never throws — one bad file
   *  must not take the daemon down and hide every other provider. */
  errors: { source: string; message: string }[];
}

/** Manifests bundled with the checkout. Independent of the working directory. */
export function defaultProvidersDir(): string {
  // Resolved from this file, not the working directory. Once `pew2` is linked
  // onto PATH it runs from wherever the user happens to be, and a cwd-relative
  // path finds nothing there. Walks up from src/providers/ to the repo root.
  return resolve(fileURLToPath(new URL("../../../..", import.meta.url)), "providers");
}

/**
 * Where manifests the user (or their coding agent) creates live.
 *
 * Kept out of the repo on purpose: `pew2 detect` runs on a machine that may
 * have no checkout at all, and a globally installed CLI must not write into
 * whatever directory it happened to be invoked from. `PEW2_HOME` overrides it
 * so tests never touch a real home directory.
 */
export function userProvidersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PEW2_HOME ?? join(homedir(), ".pew2"), "providers");
}

/**
 * Every directory searched, in precedence order.
 *
 * The user's directory comes first so a manifest they wrote shadows a bundled
 * one with the same id instead of colliding with it.
 */
export function providerDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [userProvidersDir(env), defaultProvidersDir()];
}

async function loadOneDir(
  dir: string,
  env: NodeJS.ProcessEnv,
  seen: Map<string, string>,
  providers: LoadedProvider[],
  errors: LoadResult["errors"],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // A directory that does not exist yet contributes nothing and is not a
    // problem: a fresh machine has no `~/.pew2/providers`, and the CLI is run
    // from outside the repo. Anything else (permissions, not a directory) is
    // real and must be reported.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    errors.push({
      source: dir,
      message: `Cannot read providers directory: ${(error as Error).message}`,
    });
    return;
  }

  for (const entry of entries.filter((f) => f.endsWith(".json")).sort()) {
    const source = join(dir, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      errors.push({ source, message: `Not valid JSON: ${(error as Error).message}` });
      continue;
    }

    const parsed = ProviderManifest.safeParse(raw);
    if (!parsed.success) {
      errors.push({ source, message: formatManifestError(parsed.error, source) });
      continue;
    }

    const manifest = parsed.data;

    // Two manifests claiming the same id would make provider selection
    // ambiguous. Within one directory that is a mistake worth reporting; across
    // directories it is deliberate shadowing, and the earlier (higher
    // precedence) directory simply wins.
    const previous = seen.get(manifest.id);
    if (previous) {
      if (previous.startsWith(`${dir}/`)) {
        errors.push({
          source,
          message: `Duplicate provider id '${manifest.id}' (already defined in ${previous})`,
        });
      }
      continue;
    }
    seen.set(manifest.id, source);

    const { command, args: rawArgs } = resolveCommand(manifest);
    // Resolve explicitly relative arguments against the manifest, not the
    // working directory. Under launchd there is no meaningful cwd, and a session
    // sets its own to the user's workspace, so `./agent.ts` would resolve
    // somewhere unrelated and the provider would fail at spawn.
    //
    // Only for `command` distributions, and only for `./`-prefixed values: an
    // npx argument like `@scope/pkg@latest` contains a slash but is a package
    // name, and rewriting it into a path breaks the provider entirely.
    const args =
      manifest.distribution.type === "command"
        ? rawArgs.map((arg) => (/^\.{1,2}\//.test(arg) ? resolve(dirname(source), arg) : arg))
        : rawArgs;
    const missingEnv = manifest.pew.env
      .filter((v) => v.required && !env[v.name])
      .map((v) => v.name);
    const commandMissing = !canResolveCommand(command, env);

    providers.push({ manifest, source, command, args, missingEnv, commandMissing });
  }
}

export async function loadProviders(
  dirs: string | string[] = providerDirs(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadResult> {
  const providers: LoadedProvider[] = [];
  const errors: LoadResult["errors"] = [];
  const seen = new Map<string, string>();

  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    await loadOneDir(dir, env, seen, providers, errors);
  }

  // Stable regardless of which directory a manifest came from, so the app's
  // provider list does not reorder itself when a user manifest appears.
  providers.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));

  return { providers, errors };
}

export function isAvailable(provider: LoadedProvider): boolean {
  return provider.missingEnv.length === 0 && !provider.commandMissing;
}

export function unavailableReason(provider: LoadedProvider): string | undefined {
  if (provider.commandMissing) {
    return `Not installed: '${provider.command}' is not on PATH`;
  }
  if (provider.missingEnv.length > 0) {
    return `Missing required environment ${provider.missingEnv.length === 1 ? "variable" : "variables"}: ${provider.missingEnv.join(", ")}`;
  }
  return undefined;
}
