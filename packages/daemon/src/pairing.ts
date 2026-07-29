/**
 * Pairing: how a phone learns where the daemon is, and proves it may connect.
 *
 * The token is a bearer secret. It is *not* authentication — anyone holding it
 * can drive every agent on this machine — so it is generated with real entropy,
 * stored 0600, and never printed anywhere except the QR the user scans. The
 * relay enforces a 32-character floor for the same reason; this stays well
 * above it.
 *
 * Until end-to-end encryption exists, this is safe only on a trusted LAN. That
 * is a deliberate scope limit, not an oversight: it makes the phone work on a
 * real device today without pretending the transport is secure enough for the
 * public internet.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";

/** 48 hex chars. Well above the relay's 32-character floor. */
const TOKEN_BYTES = 24;

export interface Pairing {
  token: string;
  /** When the token was minted, so the CLI can show its age. */
  createdAt: string;
  /**
   * Relay origin, when one is configured. Its presence is what decides whether
   * this machine is reachable from anywhere or only from the same network, so
   * it is stored beside the token rather than passed per-command.
   */
  relay?: string;
}

/** `~/.pew2/pairing.json`, or `$PEW2_HOME/pairing.json` when overridden. */
export function pairingPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "pairing.json");
}

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Read the stored pairing, minting one on first use.
 *
 * Idempotent on purpose: `setup`, the server and `pair` all call this, and none
 * of them should invalidate a phone that is already paired. Use `rotate` to
 * deliberately break existing pairings.
 */
export async function loadPairing(env: NodeJS.ProcessEnv = process.env): Promise<Pairing> {
  // An explicit token wins and is never written to disk — this is what lets a
  // test, or a container, run without touching a real home directory.
  if (env.PEW2_TOKEN) {
    return { token: env.PEW2_TOKEN, createdAt: new Date(0).toISOString(), relay: env.PEW2_RELAY };
  }

  const path = pairingPath(env);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Pairing>;
    if (typeof parsed.token === "string" && parsed.token.length >= 32) {
      return {
        token: parsed.token,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        // The environment wins, so a relay can be pointed elsewhere for one run
        // without rewriting stored configuration.
        relay: env.PEW2_RELAY ?? parsed.relay,
      };
    }
    // A short or malformed token is worse than none: it would be accepted by
    // the server while being guessable. Replace it rather than trusting it.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return writePairing(
    { token: generateToken(), createdAt: new Date().toISOString(), relay: env.PEW2_RELAY },
    env,
  );
}

/** Mint a fresh token, invalidating every phone currently paired. */
export async function rotatePairing(env: NodeJS.ProcessEnv = process.env): Promise<Pairing> {
  const existing = await loadPairing(env).catch(() => undefined);
  return writePairing(
    {
      token: generateToken(),
      createdAt: new Date().toISOString(),
      // Rotating a token must not silently drop remote access.
      relay: env.PEW2_RELAY ?? existing?.relay,
    },
    env,
  );
}

/** Point this machine at a relay, or clear it with `undefined`. */
export async function setRelay(
  relay: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pairing> {
  const existing = await loadPairing(env);
  return writePairing({ ...existing, relay }, env);
}

async function writePairing(pairing: Pairing, env: NodeJS.ProcessEnv): Promise<Pairing> {
  const path = pairingPath(env);
  await mkdir(dirname(path), { recursive: true });
  // 0600 from the moment it exists: a token readable by other users on the box
  // is a token that grants them every agent on it.
  await writeFile(path, `${JSON.stringify(pairing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return pairing;
}

/**
 * Constant-time comparison, so a wrong token cannot be discovered one character
 * at a time by measuring how long the rejection took.
 */
export function tokenMatches(expected: string, received: string | null): boolean {
  if (!received || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/**
 * This machine's LAN addresses, best candidate first.
 *
 * `localhost` is useless to a phone, so the daemon has to advertise an address
 * the phone can actually route to. Link-local (169.254.x) is excluded because
 * it means DHCP failed and nothing will reach it.
 */
export function lanAddresses(): string[] {
  const found: { address: string; rank: number }[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;

      // Prefer the interface most likely to be the one the phone shares: real
      // Wi-Fi/Ethernet over the virtual bridges Docker and VMs leave behind.
      const rank = /^(en|eth|wl)/.test(name) ? 0 : /^(bridge|docker|veth|utun|tun|tap)/.test(name) ? 2 : 1;
      found.push({ address: entry.address, rank });
    }
  }

  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.address);
}

export interface PairingUrlOptions {
  token: string;
  port: number;
  host?: string;
  /** When set, the URL points at the relay and works from any network. */
  relay?: string;
}

/**
 * The single string the phone needs: where to connect, and the secret to
 * present. Kept as one URL so the QR encodes one thing and manual entry is one
 * paste rather than two fields to get wrong.
 *
 * With a relay configured this is a public `wss://` address that works from a
 * mobile network; without one it is a LAN address that only works on the same
 * Wi-Fi. Same shape either way, so the app needs no second code path.
 */
export function pairingUrl({ token, port, host, relay }: PairingUrlOptions): string {
  if (relay) {
    const base = relay.replace(/\/$/, "").replace(/^http/, "ws");
    // `deviceId` is required by the relay, which answers 400 without it. The
    // app replaces this placeholder with its own stable id; including it here
    // keeps the printed link valid on its own.
    return `${base}/connect?pairing=${token}&role=app&deviceId=phone`;
  }
  const address = host ?? lanAddresses()[0] ?? "127.0.0.1";
  return `ws://${address}:${port}/?token=${token}`;
}

/**
 * Extract the token from a connection URL, accepting either transport's
 * parameter name. Returns null when absent.
 */
export function tokenFromUrl(url: string): string | null {
  try {
    const params = new URL(url).searchParams;
    return params.get("token") ?? params.get("pairing");
  } catch {
    return null;
  }
}

const DARK_FG = "\x1b[30m";
const LIGHT_FG = "\x1b[97m";
const DARK_BG = "\x1b[40m";
const LIGHT_BG = "\x1b[107m";
const RESET = "\x1b[0m";
const UPPER_HALF = "\u2580";

/**
 * Render a QR bitmap as text.
 *
 * One character per module horizontally and two modules per character
 * vertically, so the code stays square and fits an 80-column terminal. Colours
 * are set explicitly for both foreground and background because a QR rendered
 * in the terminal's own theme is inverted half the time, and an inverted QR
 * will not scan.
 */
export function renderQr(modules: Uint8Array, size: number, quiet = 2): string {
  const at = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    return modules[y * size + x] === 1;
  };

  const lines: string[] = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = "";
    let current = "";
    for (let x = -quiet; x < size + quiet; x++) {
      // The glyph paints the upper half in the foreground colour and leaves the
      // lower half showing the background, so one row of characters carries two
      // rows of modules.
      const style = `${at(x, y) ? DARK_FG : LIGHT_FG}${at(x, y + 1) ? DARK_BG : LIGHT_BG}`;
      if (style !== current) {
        line += style;
        current = style;
      }
      line += UPPER_HALF;
    }
    lines.push(`${line}${RESET}`);
  }
  return lines.join("\n");
}

/** Encode a string as a scannable QR block, or `undefined` if it cannot be. */
export async function qrCode(content: string): Promise<string | undefined> {
  try {
    const { toQR } = await import("toqr");
    const modules = toQR(content);
    const size = Math.sqrt(modules.length);
    if (!Number.isInteger(size)) return undefined;
    return renderQr(modules, size);
  } catch {
    // A missing or broken encoder must not stop pairing: the URL alone is
    // enough to pair by hand.
    return undefined;
  }
}
