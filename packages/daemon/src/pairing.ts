/**
 * Pairing: how a phone learns where the daemon is, and proves it may connect.
 *
 * A pairing is one 32-byte **root key**, and everything else derives from it:
 *
 *   - the **room id** the relay routes on, via a one-way HKDF. The relay is
 *     given this and cannot work backwards to the key, so it can order traffic
 *     without being able to read it. It doubles as the LAN connection token,
 *     where there is no relay in between.
 *   - the two **message keys**, one per direction, which never leave the two
 *     endpoints.
 *
 * The root key reaches the phone in the QR's URL *fragment*, which is never
 * transmitted to a server — so the relay never sees it, even at pairing time.
 *
 * Generated with real entropy, stored 0600, and printed nowhere but the QR.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { e2e } from "@pew2/protocol";
import { userProvidersDir } from "./providers/registry.js";

export interface Pairing {
  /**
   * The room id the relay routes on, and the token the LAN transport checks.
   * Derived from `key`; not a secret the relay must be trusted with.
   */
  token: string;
  /**
   * The root key, hex.
   *
   * Absent only in a pairing written before encryption existed. Both sides
   * treat that as unpaired rather than falling back to plaintext: a silent
   * downgrade is how encryption gets switched off in practice.
   */
  key?: string;
  /** When the token was minted, so the CLI can show its age. */
  createdAt: string;
  /**
   * The device that claimed this pairing, if one has.
   *
   * A pairing link admits exactly one device: the first to complete a
   * handshake is recorded here, and every later device is refused. That is what
   * makes a leaked link — a QR caught on video — worthless once the real phone
   * has connected. Cleared by `rotate`, which is the only revocation.
   */
  claimedBy?: string;
  /**
   * Relay origin, when one is configured. Its presence is what decides whether
   * this machine is reachable from anywhere or only from the same network, so
   * it is stored beside the token rather than passed per-command.
   */
  relay?: string;
}

/**
 * The shortest secret a pairing may be built from.
 *
 * A minted pairing is 32 bytes of real entropy and never comes near this floor.
 * It exists for `PEW2_TOKEN`, where a human types the value — and where the
 * derivation is a single HKDF pass with no salt and no stretching, so the key
 * inherits exactly the entropy of what it is given. `PEW2_TOKEN=pew2-staging`
 * is a root key someone can brute-force offline against the public room id, and
 * from there read and write every message on that pairing.
 */
export const MIN_TOKEN_LENGTH = 32;

/** `~/.pew2/pairing.json`, or `$PEW2_HOME/pairing.json` when overridden. */
export function pairingPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userProvidersDir(env)), "pairing.json");
}

/**
 * A fresh pairing: one root key, with the room id derived from it.
 *
 * The two are never generated independently. If they were, the relay would be
 * routing on a value with no relationship to the key, and a mismatch would
 * surface as a phone that connects to the right room and cannot read anything
 * in it.
 */
export function generatePairing(): { token: string; key: string } {
  const key = e2e.randomRootKey();
  return { token: e2e.roomId(key), key: e2e.toHex(key) };
}

/**
 * Derive a pairing deterministically from an explicit token.
 *
 * `PEW2_TOKEN` exists so a test or a container can run without touching a real
 * home directory. Hashing it into a key keeps that path working end to end
 * rather than leaving those runs unencrypted — which would mean the tests
 * exercised a different protocol than production uses.
 *
 * Refuses a short secret rather than deriving a weak key from it. Checked here,
 * at the derivation, so every caller is covered by one rule — the stored path
 * has enforced this floor all along, and this was the way around it.
 */
export function pairingFromToken(token: string): { token: string; key: string } {
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `PEW2_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters: it is the only ` +
        `entropy behind this pairing's encryption key, so a short one can be ` +
        `brute-forced offline against the room id the relay already knows. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  const key = e2e.deriveKeyFromSecret(token);
  return { token: e2e.roomId(key), key: e2e.toHex(key) };
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
    // Derived, not stored: the same input always yields the same pairing, so a
    // fixed PEW2_TOKEN keeps working across restarts exactly as it did before.
    // Throws on a short one — loudly, at startup, rather than running with an
    // encryption key that can be guessed.
    const derived = pairingFromToken(env.PEW2_TOKEN);
    return { ...derived, createdAt: new Date(0).toISOString(), relay: env.PEW2_RELAY };
  }

  const path = pairingPath(env);
  let storedRelay: string | undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Pairing>;
    // A pairing without a key predates encryption. Treated as absent rather
    // than reused, because carrying it forward would mean a daemon that still
    // accepts unencrypted connections — the downgrade this change exists to
    // remove.
    if (
      typeof parsed.token === "string" &&
      parsed.token.length >= MIN_TOKEN_LENGTH &&
      typeof parsed.key === "string" &&
      parsed.key.length === 64
    ) {
      return {
        token: parsed.token,
        key: parsed.key,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        // Carried through explicitly. Dropping it here would unclaim the
        // pairing on every daemon restart, which is the whole defence.
        ...(typeof parsed.claimedBy === "string" && parsed.claimedBy
          ? { claimedBy: parsed.claimedBy }
          : {}),
        // The environment wins, so a relay can be pointed elsewhere for one run
        // without rewriting stored configuration.
        relay: env.PEW2_RELAY ?? parsed.relay,
      };
    }
    // A short or malformed token is worse than none: it would be accepted by
    // the server while being guessable. Replace it rather than trusting it.
    // Keep the relay even when the rest is discarded. Losing it turns a machine
    // that worked from anywhere into one that only works on the same Wi-Fi —
    // silently, on upgrade, with nothing in the output to explain it.
    storedRelay = typeof parsed.relay === "string" ? parsed.relay : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return writePairing(
    {
      ...generatePairing(),
      createdAt: new Date().toISOString(),
      relay: env.PEW2_RELAY ?? storedRelay,
    },
    env,
  );
}

/** Mint a fresh token, invalidating every phone currently paired. */
export async function rotatePairing(env: NodeJS.ProcessEnv = process.env): Promise<Pairing> {
  const existing = await loadPairing(env).catch(() => undefined);
  return writePairing(
    {
      ...generatePairing(),
      createdAt: new Date().toISOString(),
      // Rotating a token must not silently drop remote access.
      relay: env.PEW2_RELAY ?? existing?.relay,
    },
    env,
  );
}

/**
 * Record the device that has claimed this pairing.
 *
 * Written straight through to disk so the claim survives a restart — an
 * in-memory claim would quietly reopen the pairing every time the daemon
 * relaunched, which is exactly when nobody is watching.
 *
 * Does nothing under `PEW2_TOKEN`: that pairing is derived, never stored, and
 * writing a claim beside it would create a file `loadPairing` then ignores.
 * Tests and containers re-claim on each run, which is what they want anyway.
 */
export async function claimPairing(
  deviceId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.PEW2_TOKEN) return;
  const existing = await loadPairing(env);
  // Re-reading first means a claim never resurrects a token that was rotated
  // out from under this process.
  if (existing.claimedBy) return;
  await writePairing({ ...existing, claimedBy: deviceId }, env);
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
  /**
   * The root key, hex. Carried in the URL *fragment*, which is never sent to a
   * server — so the relay routes this connection without ever seeing the key
   * that decrypts it.
   */
  key?: string;
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
export function pairingUrl({ token, key, port, host, relay }: PairingUrlOptions): string {
  // base64url, and appended last: a fragment must be the final component of a
  // URL, and this one has to survive being copied by hand as well as scanned.
  const fragment = key ? `#k=${e2e.toBase64Url(e2e.fromHex(key))}` : "";
  if (relay) {
    const base = relay.replace(/\/$/, "").replace(/^http/, "ws");
    // `deviceId` is required by the relay, which answers 400 without it. The
    // app replaces this placeholder with its own stable id; including it here
    // keeps the printed link valid on its own.
    return `${base}/connect?pairing=${token}&role=app&deviceId=phone${fragment}`;
  }
  const address = host ?? lanAddresses()[0] ?? "127.0.0.1";
  return `ws://${address}:${port}/?token=${token}${fragment}`;
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

/**
 * Encode a string as a scannable QR block, or `undefined` if it cannot be.
 *
 * `quiet` defaults to 2 to keep the block narrow in constrained output. Pass 4,
 * the value the QR specification actually requires, wherever a human is
 * expected to point a camera at it: phone scanners locate the finder patterns
 * by the margin around them, and a thin quiet zone against scrolled-back
 * terminal text is the most common reason a printed code will not scan.
 */
export async function qrCode(content: string, quiet = 2): Promise<string | undefined> {
  try {
    const { toQR } = await import("toqr");
    const modules = toQR(content);
    const size = Math.sqrt(modules.length);
    if (!Number.isInteger(size)) return undefined;
    return renderQr(modules, size, quiet);
  } catch {
    // A missing or broken encoder must not stop pairing: the URL alone is
    // enough to pair by hand.
    return undefined;
  }
}
