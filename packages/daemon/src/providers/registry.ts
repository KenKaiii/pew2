/**
 * Provider registry: turns a directory of JSON manifests into runnable providers.
 *
 * The whole "add your own app" story lives here. A coding agent adds a provider by
 * writing one file into `providers/`. No code changes, no registration call, no
 * rebuild — the daemon rescans and re-announces to connected phones.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute, delimiter } from "node:path";
import { existsSync } from "node:fs";
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
 * Whether an executable is resolvable. Checked up front so an uninstalled agent
 * is shown as unavailable in the app rather than failing at spawn time.
 * `npx`/`uvx` are assumed present; they fetch their own packages on demand.
 */
function canResolveCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  if (isAbsolute(command) || command.includes("/")) return existsSync(command);
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return paths.some((dir) => existsSync(join(dir, command)));
}

export interface LoadResult {
  providers: LoadedProvider[];
  /** Manifests that failed to parse or validate. Never throws — one bad file
   *  must not take the daemon down and hide every other provider. */
  errors: { source: string; message: string }[];
}

/** Default location of provider manifests, relative to the repo root. */
export function defaultProvidersDir(): string {
  return resolve(process.cwd(), "providers");
}

export async function loadProviders(
  dir: string = defaultProvidersDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadResult> {
  const providers: LoadedProvider[] = [];
  const errors: LoadResult["errors"] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    return {
      providers,
      errors: [
        {
          source: dir,
          message: `Cannot read providers directory: ${(error as Error).message}`,
        },
      ],
    };
  }

  const seen = new Map<string, string>();

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

    // Two manifests claiming the same id would make provider selection ambiguous.
    const previous = seen.get(manifest.id);
    if (previous) {
      errors.push({
        source,
        message: `Duplicate provider id '${manifest.id}' (already defined in ${previous})`,
      });
      continue;
    }
    seen.set(manifest.id, source);

    const { command, args } = resolveCommand(manifest);
    const missingEnv = manifest.pew.env
      .filter((v) => v.required && !env[v.name])
      .map((v) => v.name);
    const commandMissing = !canResolveCommand(command, env);

    providers.push({ manifest, source, command, args, missingEnv, commandMissing });
  }

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
