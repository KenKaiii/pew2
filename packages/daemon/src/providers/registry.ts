/**
 * Provider registry: turns a directory of JSON manifests into runnable providers.
 *
 * The whole "add your own app" story lives here. A coding agent adds a provider by
 * writing one file into `providers/`. No code changes, no registration call, no
 * rebuild — the daemon rescans and re-announces to connected phones.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute, delimiter, dirname } from "node:path";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { BUNDLED_MANIFESTS } from "./bundled.js";
import {
  ProviderManifest,
  formatManifestError,
  resolveCommand,
  type ProviderManifest as Manifest,
  type ProviderManifestInput,
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
 * The platform whose rules apply.
 *
 * Injectable purely so the Windows half can be tested — CI is Linux-only and
 * macOS runners bill 10x, so a `process.platform` read here means the rules that
 * broke Windows are the one part of resolution nothing can ever exercise. That
 * is exactly how a detector that could not work on Windows shipped.
 */
export type Platform = "win32" | "posix";

function platformOf(env: NodeJS.ProcessEnv): Platform {
  // An env override rather than an argument threaded through six call sites:
  // the tests that need it are about resolution, and everything else should not
  // have to know this exists.
  if (env.PEW2_FAKE_PLATFORM === "win32") return "win32";
  if (env.PEW2_FAKE_PLATFORM === "posix") return "posix";
  return process.platform === "win32" ? "win32" : "posix";
}

/**
 * The extensions that make a file runnable on Windows.
 *
 * PATHEXT is what the shell uses, so it is what decides whether a name resolves.
 * The fallback matches the system default; each is matched case-insensitively
 * because the registry value is conventionally uppercase and the files on disk
 * are not.
 */
function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}

/**
 * Is this file one the current platform would actually run?
 *
 * On Windows the name has to carry a PATHEXT suffix. That single rule is the
 * whole Windows bug: `npm install -g` writes *three* files per binary —
 * `agent.cmd`, `agent.ps1`, and an extensionless `agent` which is a **Bash**
 * script for Git Bash and Cygwin. An extensionless `existsSync` matched that sh
 * script, so every npm-installed agent was reported installed on Windows and
 * then failed at spawn with ENOENT, because libuv only ever tries `.com` and
 * `.exe` (it does not read PATHEXT at all). The same check missed
 * `cursor-agent.exe` entirely, since nothing on disk is named `cursor-agent`.
 *
 * On POSIX existence is not enough either: a non-executable file of the right
 * name is not a command, and reporting it as one produces EACCES at spawn.
 */
function runnable(path: string, env: NodeJS.ProcessEnv, platform: Platform): boolean {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return false;
  }
  // A directory named `goose` is not the goose command.
  if (!stats.isFile()) return false;

  if (platform === "win32") {
    const lower = path.toLowerCase();
    return windowsExtensions(env).some((ext) => lower.endsWith(ext));
  }

  // Any execute bit. Which one applies depends on the file's owner and group
  // versus this process's, and the kernel is the authority on that — so this is
  // deliberately the permissive check: a false positive fails informatively at
  // spawn, while a false negative hides an agent the user definitely has.
  return (stats.mode & 0o111) !== 0;
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
 *
 * Returns the **full path**, extension included, so callers spawn the exact file
 * that was found rather than a bare name the platform has to resolve a second
 * time by different rules.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const platform = platformOf(env);
  const windows = platform === "win32";

  // A path, not a name. Backslashes count on Windows, where `.\agent.cmd` is as
  // much a path as `./agent` is here — matching only `/` sent it to the PATH
  // scan, which then joined a path onto a directory and found nothing.
  const looksLikePath =
    isAbsolute(command) || command.includes("/") || (windows && command.includes("\\"));

  const candidates = (dir: string): string[] => {
    const base = dir ? join(dir, command) : command;
    if (!windows) return [base];
    // An explicit extension is honoured as given; otherwise every PATHEXT
    // suffix is tried, in the order the system lists them.
    const exts = windowsExtensions(env);
    const hasExt = exts.some((ext) => base.toLowerCase().endsWith(ext));
    return hasExt ? [base] : exts.map((ext) => base + ext);
  };

  // PATH uses `;` on Windows and `:` elsewhere, and `path.delimiter` reports the
  // *host's* — which is the wrong one whenever the platform is being simulated.
  const sep = windows ? ";" : delimiter;

  const dirs = looksLikePath
    ? [""]
    : // Windows resolves the current directory before PATH, and a user who
      // installed an agent into the folder they are standing in should not be
      // told it is missing.
      [...(windows ? [process.cwd()] : []), ...(env.PATH ?? "").split(sep).filter(Boolean)]
        // PATH entries are conventionally quoted on Windows when they contain
        // spaces; the quotes are syntax, not part of the directory name.
        .map((dir) => dir.replace(/^"(.*)"$/, "$1"));

  for (const dir of dirs) {
    for (const candidate of candidates(dir)) {
      if (runnable(candidate, env, platform)) return candidate;
    }
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

/**
 * Where the bundled manifests live in a checkout.
 *
 * Still resolved from this file rather than the working directory, and still
 * used by tooling that wants the real folder — `providers validate`, the
 * registry sync. It is deliberately *not* how the daemon loads them any more:
 * inside a compiled binary this path points into an embedded filesystem, lands
 * on `/providers`, and finds nothing. See `bundled.ts`.
 */
export function defaultProvidersDir(): string {
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

/**
 * Turn one validated manifest into a loaded provider.
 *
 * Shared by both sources so a bundled agent and a user-written one resolve
 * identically. Two copies of this drifting would mean an agent behaving one way
 * in development and another once shipped.
 */
function addManifest(
  manifest: ProviderManifestInput,
  source: string,
  env: NodeJS.ProcessEnv,
  seen: Map<string, string>,
  providers: LoadedProvider[],
): void {
  const parsed = ProviderManifest.parse(manifest);
  if (seen.has(parsed.id)) return;
  seen.set(parsed.id, source);

  const { command, args: rawArgs } = resolveCommand(parsed);
  const args =
    parsed.distribution.type === "command"
      ? rawArgs.map((arg) => (/^\.{1,2}\//.test(arg) ? resolve(dirname(source), arg) : arg))
      : rawArgs;
  const missingEnv = parsed.pew.env
    .filter((v) => v.required && !env[v.name])
    .map((v) => v.name);

  providers.push({
    manifest: parsed,
    source,
    command,
    args,
    missingEnv,
    commandMissing: !canResolveCommand(command, env),
  });
}

/**
 * The manifests compiled into this binary.
 *
 * Never throws: these were validated by `providers:validate` before release, so
 * a failure here is a build problem rather than something a user can fix, and
 * taking the daemon down would hide every working agent alongside the broken one.
 */
function loadBundled(
  env: NodeJS.ProcessEnv,
  seen: Map<string, string>,
  providers: LoadedProvider[],
  errors: LoadResult["errors"],
): void {
  for (const manifest of BUNDLED_MANIFESTS) {
    const id = (manifest as { id?: string }).id ?? "unknown";
    try {
      addManifest(manifest, `bundled:${id}`, env, seen, providers);
    } catch (error) {
      errors.push({ source: `bundled:${id}`, message: (error as Error).message });
    }
  }
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
  dirs?: string | string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { bundled?: boolean } = {},
): Promise<LoadResult> {
  // Naming directories means "these, and nothing else" — that is what makes a
  // test that points at a sandbox actually isolated. Production paths that want
  // the built-in agents as well ask for them explicitly.
  const searchDirs = dirs ?? providerDirs();
  const includeBundled = options.bundled ?? dirs === undefined;
  const providers: LoadedProvider[] = [];
  const errors: LoadResult["errors"] = [];
  const seen = new Map<string, string>();

  // User manifests first, so one they wrote shadows a bundled agent of the same
  // id rather than colliding with it.
  for (const dir of typeof searchDirs === "string" ? [searchDirs] : searchDirs) {
    await loadOneDir(dir, env, seen, providers, errors);
  }

  // Then the built-in set, from the array compiled into this binary. Callers
  // that are inspecting a specific directory — `providers validate`, the tests —
  // pass `bundled: false` and get only what they asked for.
  if (includeBundled) {
    loadBundled(env, seen, providers, errors);
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
