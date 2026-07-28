#!/usr/bin/env bun
/**
 * pew2 CLI — the surface a coding agent uses to wire up a new provider.
 *
 * Deliberately small and verb-oriented:
 *   pew2 providers list              what is installed, and is it usable
 *   pew2 providers validate          static check of every manifest
 *   pew2 providers add <id>          scaffold a new manifest
 *   pew2 providers verify <id>       actually spawn it and prove it works
 *
 * `verify` is the important one: it is the difference between "the JSON parsed"
 * and "this thing genuinely speaks ACP and answered me".
 */
import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { loadProviders, defaultProvidersDir, isAvailable, unavailableReason } from "../providers/registry.js";
import { connectProvider } from "../acp/connect.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = (s: string) => `${GREEN}✓${RESET} ${s}`;
const bad = (s: string) => `${RED}✗${RESET} ${s}`;
const warn = (s: string) => `${YELLOW}!${RESET} ${s}`;

async function cmdList() {
  const { providers, errors } = await loadProviders();
  if (providers.length === 0 && errors.length === 0) {
    console.log(`No providers found in ${defaultProvidersDir()}`);
    console.log(`${DIM}Create one with: pew2 providers add my-agent${RESET}`);
    return 0;
  }

  for (const p of providers) {
    const available = isAvailable(p);
    const head = `${BOLD}${p.manifest.id}${RESET} ${DIM}${p.manifest.version}${RESET}`;
    console.log(available ? ok(head) : warn(head));
    console.log(`    ${p.manifest.description}`);
    console.log(`    ${DIM}${p.command} ${p.args.join(" ")}${RESET}`);
    if (!available) console.log(`    ${YELLOW}${unavailableReason(p)}${RESET}`);
  }

  for (const e of errors) console.log(bad(e.message));
  return errors.length > 0 ? 1 : 0;
}

async function cmdValidate() {
  const { providers, errors } = await loadProviders();
  for (const p of providers) console.log(ok(`${p.manifest.id} ${DIM}(${p.source})${RESET}`));
  for (const e of errors) console.log(bad(e.message));

  if (errors.length > 0) {
    console.log(`\n${RED}${errors.length} manifest(s) invalid.${RESET}`);
    return 1;
  }
  console.log(`\n${GREEN}${providers.length} provider(s) valid.${RESET}`);
  return 0;
}

async function cmdAdd(id: string | undefined) {
  if (!id) {
    console.error("Usage: pew2 providers add <id>");
    return 1;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    console.error(bad(`'${id}' is not a valid id: lowercase letters, digits and hyphens, starting with a letter.`));
    return 1;
  }

  const dir = defaultProvidersDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);

  try {
    await access(path);
    console.error(bad(`${path} already exists.`));
    return 1;
  } catch {
    // Not existing is the happy path.
  }

  const template = {
    $schema: "../schemas/provider.schema.json",
    id,
    name: id,
    version: "0.1.0",
    description: `TODO: what ${id} does.`,
    distribution: { type: "command", command: `${id}-acp`, args: [] },
    pew: { transport: "acp", env: [] },
  };

  await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  console.log(ok(`Created ${path}`));
  console.log(`\nNext:`);
  console.log(`  1. Point ${BOLD}distribution${RESET} at your agent (npx / uvx / command).`);
  console.log(`  2. Run ${BOLD}pew2 providers verify ${id}${RESET}`);
  return 0;
}

async function cmdVerify(id: string | undefined) {
  const { providers, errors } = await loadProviders();
  for (const e of errors) console.log(bad(e.message));

  const targets = id ? providers.filter((p) => p.manifest.id === id) : providers;
  if (id && targets.length === 0) {
    console.error(bad(`No provider with id '${id}'. Known: ${providers.map((p) => p.manifest.id).join(", ") || "(none)"}`));
    return 1;
  }

  let failures = 0;
  for (const provider of targets) {
    process.stdout.write(`${BOLD}${provider.manifest.id}${RESET} … `);

    if (!isAvailable(provider)) {
      console.log(`${YELLOW}skipped${RESET} — ${unavailableReason(provider)}`);
      continue;
    }
    if (provider.manifest.pew.transport !== "acp") {
      console.log(`${DIM}skipped — transport '${provider.manifest.pew.transport}' is not verifiable${RESET}`);
      continue;
    }

    const updates: unknown[] = [];
    let handle: Awaited<ReturnType<typeof connectProvider>> | undefined;
    const timeout = setTimeout(() => {
      console.log(bad("timed out after 60s"));
      handle?.close();
      process.exit(1);
    }, 60_000);

    try {
      handle = await connectProvider({
        provider,
        cwd: process.cwd(),
        onUpdate: (payload) => updates.push(payload),
        onPermissionRequest: ({ requestId }) => {
          // Auto-approve during verification so the round trip completes.
          handle?.answerPermission(requestId, "allow");
        },
      });

      await handle.prompt("Hello from pew2 verify.");
      clearTimeout(timeout);
      console.log(
        `${GREEN}ok${RESET} ${DIM}session=${handle.sessionId} updates=${updates.length}${RESET}`,
      );
      handle.close();
    } catch (error) {
      clearTimeout(timeout);
      failures++;
      console.log(bad((error as Error).message));
      handle?.close();
    }
  }

  return failures > 0 || errors.length > 0 ? 1 : 0;
}

async function main() {
  const [group, command, arg] = process.argv.slice(2);

  if (group !== "providers") {
    console.log(`${BOLD}pew2${RESET}\n`);
    console.log("  pew2 providers list              List installed providers");
    console.log("  pew2 providers validate          Validate every manifest");
    console.log("  pew2 providers add <id>          Scaffold a new manifest");
    console.log("  pew2 providers verify [id]       Spawn a provider and prove it speaks ACP");
    return group ? 1 : 0;
  }

  switch (command) {
    case "list":
      return cmdList();
    case "validate":
      return cmdValidate();
    case "add":
      return cmdAdd(arg);
    case "verify":
      return cmdVerify(arg);
    default:
      console.error(`Unknown command 'providers ${command ?? ""}'.`);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(bad((error as Error).stack ?? String(error)));
    process.exit(1);
  },
);
