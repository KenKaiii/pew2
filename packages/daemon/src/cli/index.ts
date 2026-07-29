#!/usr/bin/env bun
/**
 * pew2 CLI — the surface a coding agent uses to wire up a new provider.
 *
 * Deliberately small and verb-oriented:
 *   pew2 setup [--json]              detect, verify and diagnose in one call
 *   pew2 pair [--json] [--rotate]    show the QR a phone scans to connect
 *   pew2 relay <url|off>             reach this machine from anywhere
 *   pew2 service install|restart|uninstall
 *                                    keep the daemon running across reboots
 *   pew2 doctor [--json]             what is wrong, and the command that fixes it
 *   pew2 detect [--json]             find installed agents and configure them
 *   pew2 providers list              what is installed, and is it usable
 *   pew2 providers validate          static check of every manifest
 *   pew2 providers add <id>          scaffold a new manifest
 *   pew2 providers verify <id>       actually spawn it and prove it works
 *
 * `verify` is the important one: it is the difference between "the JSON parsed"
 * and "this thing genuinely speaks ACP and answered me".
 *
 * Every command that a coding agent is expected to drive takes `--json`, so it
 * can act on structured state instead of parsing decorated console output.
 */
import { writeFile, mkdir, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadProviders,
  defaultProvidersDir,
  userProvidersDir,
  isAvailable,
  unavailableReason,
} from "../providers/registry.js";
import { detectProviders } from "../providers/detect.js";
import { verifyProvider } from "../providers/verify.js";
import { doctor, daemonPort, type Problem } from "./doctor.js";
import { setup } from "./setup.js";
import {
  installService,
  isSupported,
  serviceStatus,
  uninstallService,
  type ServiceStatus,
} from "./service.js";
import {
  lanAddresses,
  loadPairing,
  pairingUrl,
  qrCode,
  rotatePairing,
  setRelay,
} from "../pairing.js";

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
    console.log(`No providers found in:`);
    console.log(`  ${userProvidersDir()}`);
    console.log(`  ${defaultProvidersDir()}`);
    console.log(`${DIM}Find installed agents with: pew2 detect${RESET}`);
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

/** Shared rendering: a problem list is the same shape everywhere it appears. */
function printProblems(problems: Problem[]) {
  for (const problem of problems) {
    const label = problem.provider ? `${problem.provider}: ` : "";
    console.log(
      problem.severity === "error"
        ? bad(`${label}${problem.detail}`)
        : warn(`${label}${problem.detail}`),
    );
    console.log(`    ${DIM}fix: ${problem.fix}${RESET}`);
  }
}

async function cmdSetup(flags: Set<string>) {
  const json = flags.has("--json");

  const result = await setup({
    verify: !flags.has("--skip-verify"),
    onProgress: json
      ? undefined
      : (stage, note) => {
          if (stage === "detect") console.log(`${BOLD}Scanning PATH for ACP agents…${RESET}`);
          if (stage === "verify") console.log(`${DIM}verifying ${note}…${RESET}`);
          if (stage === "doctor") console.log(`${BOLD}Checking…${RESET}\n`);
        },
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  for (const entry of result.detect.detected) {
    const note = entry.action === "written" ? `${GREEN}configured${RESET}` : `${DIM}already configured${RESET}`;
    console.log(`${ok(entry.name)} ${note}`);
  }
  for (const report of result.verify) {
    if (report.status === "ok") {
      console.log(ok(`${report.id} ${DIM}verified, ${report.updates} updates${RESET}`));
    } else if (report.status === "failed") {
      console.log(bad(`${report.id} ${DIM}${report.detail}${RESET}`));
    }
  }

  if (result.doctor.problems.length > 0) console.log("");
  printProblems(result.doctor.problems);

  if (result.ok) {
    console.log(`\n${GREEN}${BOLD}Ready.${RESET} Start the daemon and pair your phone.`);
    return 0;
  }

  console.log(`\n${BOLD}Next:${RESET}`);
  for (const step of result.nextSteps) console.log(`  ${step}`);
  return 1;
}

async function cmdPair(flags: Set<string>) {
  const pairing = flags.has("--rotate") ? await rotatePairing() : await loadPairing();
  const port = daemonPort();
  const addresses = lanAddresses();
  const url = pairingUrl({ token: pairing.token, port, relay: pairing.relay });
  const remote = Boolean(pairing.relay);

  if (flags.has("--json")) {
    // The token is deliberately included: an agent driving setup has to be able
    // to hand it to the user. It is already on disk in their home directory.
    console.log(
      JSON.stringify(
        { url, token: pairing.token, port, addresses, relay: pairing.relay ?? null, remote },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!remote && addresses.length === 0) {
    console.log(warn("No network address. A phone cannot reach this machine."));
    console.log(`${DIM}Connect to Wi-Fi, or run: pew2 relay <url>${RESET}\n`);
  }

  const qr = await qrCode(url);
  if (qr) console.log(`\n${qr}`);

  console.log(`\n${BOLD}Scan this${RESET}, or paste into the app:`);
  console.log(`  ${url}\n`);

  if (remote) {
    console.log(`${GREEN}Works from anywhere.${RESET} ${DIM}Keep the daemon running.${RESET}`);
  } else {
    if (addresses.length > 1) {
      console.log(`${DIM}Also on: ${addresses.slice(1).join(", ")}${RESET}`);
    }
    console.log(`${YELLOW}Same network only.${RESET} ${DIM}For anywhere: ${BOLD}pew2 relay <url>${RESET}`);
  }
  console.log(`${DIM}This token is a password. Do not share it.${RESET}`);
  if (flags.has("--rotate")) console.log(`\n${YELLOW}Token rotated. Paired devices must scan again.${RESET}`);
  return 0;
}

async function cmdRelay(arg: string | undefined, flags: Set<string>) {
  const current = await loadPairing();

  if (!arg) {
    if (flags.has("--json")) {
      console.log(JSON.stringify({ relay: current.relay ?? null, remote: Boolean(current.relay) }));
      return 0;
    }
    console.log(
      current.relay
        ? `${ok(`Relay: ${current.relay}`)}\n${DIM}Reachable from anywhere.${RESET}`
        : `${warn("No relay.")} ${DIM}Same network only.${RESET}\n\nSet one: ${BOLD}pew2 relay wss://your-relay.workers.dev${RESET}`,
    );
    return 0;
  }

  if (arg === "off") {
    await setRelay(undefined);
    console.log(ok("Relay cleared. Same network only."));
    console.log(`${DIM}Re-pair: pew2 pair${RESET}`);
    return 0;
  }

  // Validated here rather than at connect time: a typo'd relay otherwise shows
  // up much later as a daemon that silently never comes online.
  let parsed: URL;
  try {
    parsed = new URL(arg);
  } catch {
    console.error(bad(`'${arg}' is not a valid URL. Try wss://relay.example.com`));
    return 1;
  }
  if (!/^(wss?|https?):$/.test(parsed.protocol)) {
    console.error(bad(`Need a wss:// URL, got ${parsed.protocol}//`));
    return 1;
  }
  if (parsed.protocol === "ws:" || parsed.protocol === "http:") {
    // The token crosses the public internet on this connection. Plaintext would
    // hand every agent on this machine to anyone on the path.
    console.log(warn("Not encrypted. Use wss:// outside local testing."));
  }

  await setRelay(arg);
  console.log(ok(`Relay set to ${arg}`));
  console.log(`\n${BOLD}Next:${RESET}`);
  console.log(`  1. Restart the daemon.`);
  console.log(`  2. ${BOLD}pew2 pair${RESET}`);
  return 0;
}

function renderService(status: ServiceStatus) {
  if (status.state === "running") {
    console.log(ok(`Daemon running ${DIM}pid ${status.pid}${RESET}`));
  } else if (status.state === "installed") {
    console.log(warn(`Installed but not running.${status.detail ? ` ${status.detail}` : ""}`));
  } else if (status.state === "not-installed") {
    console.log(warn("Not installed."));
  } else {
    console.log(warn(status.detail ?? "Not supported here."));
  }
  if (status.lastExitCode) {
    console.log(`${DIM}Last exit code ${status.lastExitCode}. See ${status.logPath}${RESET}`);
  }
}

/**
 * Whether the installed service was started with fixtures enabled.
 *
 * Read back from the plist so `restart` preserves the flag rather than
 * silently reinstalling without it.
 */
async function isExperimental(): Promise<boolean> {
  const status = await serviceStatus();
  if (!status.plistPath) return false;
  try {
    return (await readFile(status.plistPath, "utf8")).includes("PEW2_EXPERIMENTAL");
  } catch {
    return false;
  }
}

async function cmdService(action: string | undefined, flags: Set<string>) {
  const json = flags.has("--json");

  if (!isSupported() && action !== undefined) {
    const status = await serviceStatus();
    if (json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(bad(status.detail ?? "Not supported here."));
      console.log(`${DIM}Run the daemon yourself: bun run packages/daemon/src/server.ts${RESET}`);
    }
    return 1;
  }

  // Restart is the same operation: rewrite the plist and re-bootstrap. Named
  // separately because "my code changed, pick it up" is the common case and
  // `install` does not read as the answer to it.
  if (action === "install" || action === "restart") {
    const status = await installService({
      env: process.env,
      // A restart must not silently drop the echo provider that the running
      // service was installed with.
      experimental:
        flags.has("--experimental") || (action === "restart" && (await isExperimental())),
    });
    if (json) {
      console.log(JSON.stringify(status, null, 2));
      return status.state === "running" ? 0 : 1;
    }
    renderService(status);
    if (status.state === "running") {
      console.log(`${DIM}Starts on login and restarts if it exits.${RESET}`);
      if (action === "install") console.log(`\nNext: ${BOLD}pew2 pair${RESET}`);
      return 0;
    }
    return 1;
  }

  if (action === "uninstall") {
    const status = await uninstallService();
    if (json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(ok("Service removed."));
      console.log(`${DIM}The phone stops working until you start the daemon again.${RESET}`);
    }
    return 0;
  }

  const status = await serviceStatus();
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status.state === "running" ? 0 : 1;
  }
  renderService(status);
  if (status.state === "not-installed") {
    console.log(`\nInstall it: ${BOLD}pew2 service install${RESET}`);
  }
  return status.state === "running" ? 0 : 1;
}

async function cmdDoctor(flags: Set<string>) {
  const report = await doctor();

  if (flags.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  for (const provider of report.providers) {
    console.log(provider.available ? ok(provider.id) : warn(`${provider.id} ${DIM}${provider.reason}${RESET}`));
  }
  console.log(
    report.daemon.reachable
      ? ok(`daemon ${DIM}${report.daemon.url}${RESET}`)
      : warn(`daemon ${DIM}not running${RESET}`),
  );

  if (report.problems.length > 0) console.log("");
  printProblems(report.problems);

  console.log(report.ok ? `\n${GREEN}All good.${RESET}` : `\n${RED}${report.problems.filter((p) => p.severity === "error").length} blocking problem(s).${RESET}`);
  return report.ok ? 0 : 1;
}

async function cmdDetect(flags: Set<string>) {
  const result = await detectProviders({ dryRun: flags.has("--dry-run") });

  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const written = result.detected.filter((d) => d.action === "written");
  const blocked = result.detected.filter((d) => d.action === "file-exists");

  console.log(`${BOLD}Scanning PATH for ACP agents${RESET}\n`);

  for (const entry of result.detected) {
    const note =
      entry.action === "written"
        ? `${GREEN}configured${RESET}`
        : entry.action === "already-configured"
          ? `${DIM}already configured${RESET}`
          : `${YELLOW}file already exists, left alone${RESET}`;
    console.log(`${ok(`${BOLD}${entry.name}${RESET}`)} — ${note}`);
    console.log(`    ${DIM}${entry.foundAt}${RESET}`);
  }

  for (const entry of result.missing) {
    console.log(warn(`${entry.name} ${DIM}not installed${RESET}`));
    console.log(`    ${DIM}${entry.install}${RESET}`);
  }

  if (result.detected.length === 0) {
    console.log(`\n${YELLOW}No ACP agents found on PATH.${RESET}`);
    console.log(`${DIM}Install one of the above, or write a manifest into${RESET}`);
    console.log(`${DIM}${result.providersDir} — see docs/ADDING_A_PROVIDER.md${RESET}`);
    return 0;
  }

  console.log(
    `\n${written.length} configured, ${result.detected.length - written.length - blocked.length} already present.`,
  );
  if (written.length > 0) console.log(`${DIM}Written to ${result.providersDir}${RESET}`);
  console.log(`\nNext: ${BOLD}pew2 providers verify${RESET}`);
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

  // New manifests go to the user's directory, not the checkout: the CLI may be
  // installed globally and run from anywhere.
  const dir = userProvidersDir();
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

async function cmdVerify(id: string | undefined, flags: Set<string>) {
  const { providers, errors } = await loadProviders();
  const json = flags.has("--json");
  if (!json) for (const e of errors) console.log(bad(e.message));

  const targets = id ? providers.filter((p) => p.manifest.id === id) : providers;
  if (id && targets.length === 0) {
    console.error(bad(`No provider with id '${id}'. Known: ${providers.map((p) => p.manifest.id).join(", ") || "(none)"}`));
    return 1;
  }

  const reports = [];
  for (const provider of targets) {
    if (!json) process.stdout.write(`${BOLD}${provider.manifest.id}${RESET} … `);
    const report = await verifyProvider(provider);
    reports.push(report);
    if (json) continue;

    if (report.status === "ok") {
      console.log(`${GREEN}ok${RESET} ${DIM}session=${report.sessionId} updates=${report.updates}${RESET}`);
    } else if (report.status === "skipped") {
      console.log(`${YELLOW}skipped${RESET} — ${report.detail}`);
    } else {
      console.log(bad(report.detail ?? "failed"));
    }
  }

  const failures = reports.filter((r) => r.status === "failed").length;
  if (json) console.log(JSON.stringify({ reports, errors }, null, 2));
  return failures > 0 || errors.length > 0 ? 1 : 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [group, command, arg] = argv.filter((a) => !a.startsWith("--"));

  if (group === "setup") return cmdSetup(flags);
  if (group === "pair") return cmdPair(flags);
  if (group === "relay") return cmdRelay(command, flags);
  if (group === "service") return cmdService(command, flags);
  if (group === "doctor") return cmdDoctor(flags);
  if (group === "detect") return cmdDetect(flags);

  if (group !== "providers") {
    console.log(`${BOLD}pew2${RESET}\n`);
    console.log("  pew2 setup [--json]              Detect, verify and diagnose in one call");
    console.log("  pew2 pair [--json] [--rotate]    Show the QR a phone scans to connect");
    console.log("  pew2 relay <url|off>             Reach this machine from anywhere");
    console.log("  pew2 service install|restart     Keep the daemon running across reboots");
    console.log("  pew2 doctor [--json]             What is wrong, and the command that fixes it");
    console.log("  pew2 detect [--json]             Find installed agents and configure them");
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
      return cmdVerify(arg, flags);
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
