/**
 * Pairing tests.
 *
 * The token is the only thing between the network and every agent on the
 * machine, so the properties worth pinning are the security ones: it is long
 * and unpredictable, it survives a restart, comparing it does not leak its
 * contents through timing, and a diagnosis never mints one by accident.
 */
import { test, expect } from "bun:test";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePairing,
  loadPairing,
  pairingPath,
  pairingUrl,
  renderQr,
  rotatePairing,
  tokenFromUrl,
  tokenMatches,
  qrCode,
} from "./pairing.js";
import { doctor } from "./cli/doctor.js";

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "pew2-pairing-"));
  return { home, env: { PEW2_HOME: home } as NodeJS.ProcessEnv };
}

test("a minted pairing is long, hex, and unpredictable", () => {
  const pairings = Array.from({ length: 200 }, generatePairing);

  // 200 draws with no collision is the cheap proof that this is not a counter
  // or a timestamp.
  expect(new Set(pairings.map((p) => p.token)).size).toBe(200);
  expect(new Set(pairings.map((p) => p.key)).size).toBe(200);

  for (const pairing of pairings) {
    // The relay rejects anything under 32 characters, so that is the floor the
    // daemon must clear too.
    expect(pairing.token.length).toBeGreaterThanOrEqual(32);
    expect(pairing.token).toMatch(/^[0-9a-f]+$/);
    // 32 bytes of root key, hex.
    expect(pairing.key).toMatch(/^[0-9a-f]{64}$/);
    // The room id must not contain the key it was derived from: the relay is
    // given one and must not be able to recover the other.
    expect(pairing.token).not.toContain(pairing.key);
  }
});

test("the token survives a restart and is not world-readable", async () => {
  const { env } = await sandbox();

  const first = await loadPairing(env);
  const second = await loadPairing(env);

  // Restarting the daemon must not unpair the phone.
  expect(second.token).toBe(first.token);

  const path = pairingPath(env);
  const mode = (await stat(path)).mode & 0o777;
  // A token any other user on the box can read grants them every agent on it.
  expect(mode).toBe(0o600);
  expect(await readFile(path, "utf8")).toContain(first.token);
});

test("a too-short stored token is replaced rather than trusted", async () => {
  const { env } = await sandbox();
  await mkdir(join(env.PEW2_HOME!), { recursive: true });
  await writeFile(pairingPath(env), JSON.stringify({ token: "guessme" }));

  const pairing = await loadPairing(env);

  // Accepting it would mean the server honours a guessable secret.
  expect(pairing.token).not.toBe("guessme");
  expect(pairing.token.length).toBeGreaterThanOrEqual(32);
});

test("a pairing stored without a key is replaced rather than reused", async () => {
  // Written before encryption existed. Reusing it would leave a daemon that
  // still accepts unencrypted connections \u2014 the silent downgrade this change
  // exists to remove \u2014 so it is treated as no pairing at all.
  const { env } = await sandbox();
  await mkdir(join(env.PEW2_HOME!), { recursive: true });
  const legacy = "a".repeat(48);
  await writeFile(pairingPath(env), JSON.stringify({ token: legacy }));

  const pairing = await loadPairing(env);

  expect(pairing.token).not.toBe(legacy);
  expect(pairing.key).toMatch(/^[0-9a-f]{64}$/);
});

test("an explicit PEW2_TOKEN still yields a usable, stable pairing", async () => {
  // Tests and containers run this way. Deriving a key rather than skipping
  // encryption keeps those runs on the same protocol as production, so the
  // encrypted path is the one actually exercised.
  const env = { PEW2_TOKEN: "fixed-test-secret" } as NodeJS.ProcessEnv;

  const first = await loadPairing(env);
  const second = await loadPairing(env);

  expect(first.key).toMatch(/^[0-9a-f]{64}$/);
  expect(second.token).toBe(first.token);
  expect(second.key).toBe(first.key);
  // Derived, not echoed: the room id must not be the raw secret.
  expect(first.token).not.toBe("fixed-test-secret");
});

test("the key travels in the fragment, which is never sent to a server", async () => {
  // The whole reason a relay can route this connection without being able to
  // read it: a URL fragment is not transmitted in an HTTP request.
  const { token, key } = generatePairing();

  const relayUrl = pairingUrl({ token, key, port: 8787, relay: "wss://relay.example.com" });
  const parsed = new URL(relayUrl);

  expect(parsed.searchParams.get("pairing")).toBe(token);
  expect(parsed.hash).toMatch(/^#k=[A-Za-z0-9_-]+$/);
  // Everything the relay actually receives \u2014 path and query \u2014 must be free of it.
  expect(`${parsed.pathname}${parsed.search}`).not.toContain(parsed.hash.slice(3));

  // Same shape on the LAN, so the app needs no second code path.
  expect(pairingUrl({ token, key, port: 8787, host: "192.168.1.24" })).toContain("#k=");
  // And omitted entirely when there is no key to carry.
  expect(pairingUrl({ token, port: 8787, host: "192.168.1.24" })).not.toContain("#");
});

test("rotating invalidates the previous token", async () => {
  const { env } = await sandbox();

  const before = await loadPairing(env);
  const after = await rotatePairing(env);

  expect(after.token).not.toBe(before.token);
  expect((await loadPairing(env)).token).toBe(after.token);
  expect(tokenMatches(after.token, before.token)).toBe(false);
});

test("token comparison rejects wrong, short, long and missing values", () => {
  const token = generatePairing().token;

  expect(tokenMatches(token, token)).toBe(true);
  expect(tokenMatches(token, null)).toBe(false);
  expect(tokenMatches(token, "")).toBe(false);
  expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
  expect(tokenMatches(token, `${token}0`)).toBe(false);
  // A near-miss must not pass: the comparison is constant-time, not lenient.
  expect(tokenMatches(token, `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`)).toBe(false);
});

test("the pairing url round-trips through the app's parser", () => {
  const token = generatePairing().token;

  const url = pairingUrl({ token, port: 8787, host: "192.168.1.24" });

  expect(url).toBe(`ws://192.168.1.24:8787/?token=${token}`);
  // One string carries both facts, so scanning or pasting it is enough.
  expect(tokenFromUrl(url)).toBe(token);
  expect(new URL(url).host).toBe("192.168.1.24:8787");
  expect(tokenFromUrl("not a url")).toBeNull();
  expect(tokenFromUrl("ws://192.168.1.24:8787/")).toBeNull();
});

test("the quiet zone can be widened for a code a camera has to find", async () => {
  // Scanners locate the finder patterns by the margin around them, and the QR
  // specification requires four modules. The default stays narrow to keep the
  // block small in incidental output; anywhere a human is asked to point a
  // phone at the screen passes 4, because a thin margin against scrolled-back
  // terminal text is the most common reason a printed code will not scan.
  const url = `ws://192.168.1.24:8787/?token=${"a".repeat(48)}`;
  const narrow = await qrCode(url);
  const wide = await qrCode(url, 4);

  expect(narrow).toBeDefined();
  expect(wide).toBeDefined();

  const widthOf = (block: string) => (block.split("\n")[0]!.match(/\u2580/g) ?? []).length;
  // Two extra modules of margin on each side, horizontally and vertically.
  expect(widthOf(wide!) - widthOf(narrow!)).toBe(4);
  expect(wide!.split("\n").length).toBe(narrow!.split("\n").length + 2);

  // The margin is still margin: the outer rows carry no dark modules at all.
  const lines = wide!.split("\n");
  expect(lines[0]).not.toContain("\x1b[30m");
  expect(lines[1]).not.toContain("\x1b[30m");
  expect(lines.at(-1)).not.toContain("\x1b[30m");
});

test("a QR renders with an explicit background so it cannot come out inverted", async () => {
  const block = await qrCode("ws://192.168.1.24:8787/?token=abc");

  expect(block).toBeDefined();
  // Both colours are set on every cell; relying on the terminal's own theme
  // inverts the code roughly half the time, and an inverted QR will not scan.
  expect(block).toContain("\x1b[107m");
  expect(block).toContain("\x1b[40m");

  // A quiet zone is mandatory: without it, scanners cannot find the finder
  // patterns against surrounding terminal output. The top row must therefore be
  // entirely light — no dark foreground anywhere in it.
  const lines = block!.split("\n");
  expect(lines[0]).not.toContain("\x1b[30m");
  expect(lines.at(-1)).not.toContain("\x1b[30m");

  // Two module rows per line, and the code stays square: a stretched QR is a
  // QR that does not scan.
  const width = (lines[0]!.match(/\u2580/g) ?? []).length;
  expect(lines.length).toBe(Math.ceil(width / 2));
  expect(width).toBeGreaterThan(21);
});

test("renderQr places dark modules where the bitmap says", () => {
  // A 1x1 dark module, no quiet zone: the smallest case where an inverted or
  // transposed renderer is visible.
  const single = renderQr(new Uint8Array([1]), 1, 0);
  expect(single).toBe("\x1b[30m\x1b[107m\u2580\x1b[0m");

  // Upper module dark, lower light -> dark foreground, light background.
  const column = renderQr(new Uint8Array([1, 0, 0, 0]), 2, 0).split("\n");
  expect(column).toHaveLength(1);
  expect(column[0]!.startsWith("\x1b[30m\x1b[107m")).toBe(true);
});

test("doctor reports pairing without minting a token", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    addresses: () => ["192.168.1.24"],
  });

  // Nothing to pair with yet, and crucially no token written: a diagnosis must
  // be free of side effects.
  expect(report.pairing.url).toBeUndefined();
  expect(report.pairing.addresses).toEqual(["192.168.1.24"]);
  await expect(readFile(pairingPath(env), "utf8")).rejects.toThrow();

  // Once one exists, the report carries the exact string the phone needs.
  const { token } = await loadPairing(env);
  const paired = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    addresses: () => ["192.168.1.24"],
  });
  expect(paired.pairing.url).toBe(`ws://192.168.1.24:8787/?token=${token}`);
});

test("a running daemon with no token blocks, and points at `pew2 pair`", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    addresses: () => ["192.168.1.24"],
  });

  const problem = report.problems.find((p) => p.id === "not-paired");
  expect(problem?.severity).toBe("error");
  expect(problem?.fix).toBe("pew2 pair");
  expect(report.ok).toBe(false);
});

test("an unreachable daemon does not also report being unpaired", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => false,
    service: async () => ({ state: "running" }),
    addresses: () => ["192.168.1.24"],
  });

  // Starting the daemon mints the token, so reporting both would hand an agent
  // two fixes for one cause and make the loop look like it is not converging.
  expect(report.problems.map((p) => p.id)).toContain("daemon-unreachable");
  expect(report.problems.map((p) => p.id)).not.toContain("not-paired");
});

test("no LAN address and no relay blocks: nothing could reach this machine", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    addresses: () => [],
    pairing: async () => ({ token: "t".repeat(48) }),
  });

  const problem = report.problems.find((p) => p.id === "no-lan-address");
  expect(problem?.severity).toBe("error");
  expect(report.ok).toBe(false);
  expect(report.pairing.url).toBeUndefined();
});

test("a relay makes the LAN address irrelevant", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    // No network interface at all: with a relay the daemon dials out, so this
    // machine is still reachable from anywhere.
    addresses: () => [],
    pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }),
  });

  expect(report.problems.map((p) => p.id)).not.toContain("no-lan-address");
  expect(report.pairing.remote).toBe(true);
  expect(report.pairing.url).toBe(`wss://relay.test/connect?pairing=${"t".repeat(48)}&role=app&deviceId=phone`);
});

test("without a relay, doctor warns that it is local-network only", async () => {
  const { env } = await sandbox();

  const report = await doctor({
    env,
    searchDirs: [],
    probeDaemon: async () => true,
    service: async () => ({ state: "running" }),
    addresses: () => ["192.168.1.24"],
    pairing: async () => ({ token: "t".repeat(48) }),
  });

  const problem = report.problems.find((p) => p.id === "local-only");
  expect(problem?.fix).toContain("pew2 relay");
  // A warning, not an error: LAN-only is a working setup, just a limited one,
  // and an agent must not loop trying to "fix" a deliberate choice.
  expect(problem?.severity).toBe("warning");
  expect(report.pairing.remote).toBe(false);
  // Local-only must never be what blocks the setup loop.
  expect(report.problems.filter((p) => p.severity === "error").map((p) => p.id)).not.toContain(
    "local-only",
  );
});
