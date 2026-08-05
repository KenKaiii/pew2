import { test, expect } from "bun:test";
import { applyPairing, reloader, type PairingTargets } from "./pairing-watch.js";
import type { Pairing } from "./pairing.js";

function pairing(over: Partial<Pairing> = {}): Pairing {
  return {
    token: "a".repeat(48),
    key: "b".repeat(64),
    createdAt: "2026-08-05T00:00:00.000Z",
    ...over,
  };
}

function targets() {
  const calls: string[] = [];
  const spy: PairingTargets = {
    onPairing: (next) => calls.push(`pairing:${next.token.slice(0, 4)}`),
    disconnectClients: () => calls.push("disconnect"),
    rekeyRelay: (token) => calls.push(`relay:${token.slice(0, 4)}`),
    log: (message) => calls.push(`log:${message}`),
  };
  return { calls, spy };
}

test("a rotated token moves both transports", () => {
  // The bug: `pew2 pair --rotate` writes a new token, the running daemon keeps
  // the old one, and the relay room is derived from it. The daemon ends up in a
  // room the freshly paired phone will never join.
  const { calls, spy } = targets();
  const next = pairing({ token: "c".repeat(48), key: "d".repeat(64) });

  const applied = applyPairing(next, { token: "a".repeat(48), key: "b".repeat(64) }, spy);

  expect(applied).toBe(true);
  expect(calls).toContain("pairing:cccc");
  expect(calls).toContain("relay:cccc");
});

test("sockets sealed with the old key are dropped, after the swap", () => {
  // They cannot be salvaged: every frame on them is sealed with a key that no
  // longer applies. Order matters — closing first would race the new key in.
  const { calls, spy } = targets();

  applyPairing(pairing({ token: "c".repeat(48) }), { token: "a".repeat(48), key: "b".repeat(64) }, spy);

  expect(calls.indexOf("disconnect")).toBeGreaterThan(calls.indexOf("pairing:cccc"));
});

test("an unchanged file is not a rotation", () => {
  // The writer touches the file more than once per save, and every reconnect
  // costs the phone its live session.
  const { calls, spy } = targets();
  const same = pairing();

  expect(applyPairing(same, { token: same.token, key: same.key }, spy)).toBe(false);
  expect(calls).toEqual([]);
});

test("changing only the relay still reloads", () => {
  // `pew2 relay <url>` rewrites the same file. A daemon that ignored it would
  // keep using the old relay until someone restarted it.
  const { calls, spy } = targets();
  const next = pairing({ key: "e".repeat(64) });

  expect(applyPairing(next, { token: next.token, key: "b".repeat(64) }, spy)).toBe(true);
  expect(calls.some((c) => c.startsWith("pairing:"))).toBe(true);
});

test("a pairing with no key is refused rather than applied", () => {
  // Predates encryption, or was hand-edited. Applying it would downgrade a
  // running connection; keeping the current credentials is the safe read.
  const { calls, spy } = targets();
  const broken = { token: "c".repeat(48), createdAt: "x" } as Pairing;

  expect(applyPairing(broken, { token: "a".repeat(48), key: "b".repeat(64) }, spy)).toBe(false);
  expect(calls.some((c) => c.startsWith("pairing:"))).toBe(false);
  expect(calls.some((c) => c.startsWith("relay:"))).toBe(false);
  expect(calls.join(" ")).toContain("no encryption key");
});

test("a machine with no relay still rotates its LAN credentials", () => {
  // `rekeyRelay` is absent when the daemon is LAN-only, and that must not stop
  // the local listener from accepting the new token.
  const calls: string[] = [];
  const applied = applyPairing(
    pairing({ token: "c".repeat(48) }),
    { token: "a".repeat(48), key: "b".repeat(64) },
    {
      onPairing: () => calls.push("pairing"),
      disconnectClients: () => calls.push("disconnect"),
    },
  );

  expect(applied).toBe(true);
  expect(calls).toEqual(["pairing", "disconnect"]);
});

test("a second rotation during a reload is applied, not dropped", async () => {
  // Found by rotating twice against a live daemon: the first version guarded
  // re-entry with `if (reloading) return`, which drops any event landing
  // mid-read. The newest write is then lost for good and the daemon keeps
  // credentials nothing can reach it with — the original bug, one layer down.
  //
  // Driven through `reloader` rather than a real file: an earlier version of
  // this test wrote to disk and passed even with the bug reintroduced, because
  // the OS decides whether two writes are one event or two.
  const seen: string[] = [];
  const reads = [pairing({ token: "c".repeat(48) }), pairing({ token: "d".repeat(48) })];
  let call = 0;
  const read = async () => {
    const next = reads[Math.min(call++, reads.length - 1)]!;
    await new Promise((r) => setTimeout(r, 20));
    return next;
  };

  const reload = reloader(pairing(), read, {
    onPairing: (next) => seen.push(next.token.slice(0, 1)),
    disconnectClients: () => {},
  });

  reload();
  // Lands while the first read is still in flight. This is the exact race.
  reload();
  await new Promise((r) => setTimeout(r, 200));

  // The last write wins. With the bug, `seen` ends at "c" and the daemon never
  // learns about "d".
  expect(seen).toEqual(["c", "d"]);
});

test("a pairing that always throws is retried a few times, then left alone", async () => {
  // A 64-character key that is not hex passes `loadPairing`'s length check and
  // then throws in `fromHex` on every pass. The first version chained its
  // `.catch` after the `.then`, so that throw looked like a half-written file
  // and re-ran immediately \u2014 forever, at full speed, on one core.
  const logs: string[] = [];
  let reads = 0;
  const reload = reloader(
    pairing(),
    async () => {
      reads += 1;
      return pairing({ token: "c".repeat(48) });
    },
    {
      onPairing: () => {
        throw new Error("Key must be hex");
      },
      disconnectClients: () => {},
      log: (m) => logs.push(m),
    },
    // Immediate, so the bound is what is under test rather than the clock.
    (_ms, run) => queueMicrotask(run),
  );

  reload();
  await new Promise((r) => setTimeout(r, 100));

  // Bounded: a handful of attempts, not thousands.
  expect(reads).toBeLessThanOrEqual(6);
  expect(logs.some((m) => m.includes("rotation failed"))).toBe(true);
  expect(logs.some((m) => m.includes("leaving it alone"))).toBe(true);
});

test("a transient read failure still recovers", async () => {
  // The retry has to survive one bad read, which is the common case: the file
  // is caught half-written between the daemon's own truncate and write.
  const seen: string[] = [];
  let call = 0;
  const reload = reloader(
    pairing(),
    async () => {
      if (call++ === 0) throw new Error("Unexpected end of JSON input");
      return pairing({ token: "d".repeat(48) });
    },
    {
      onPairing: (next) => seen.push(next.token.slice(0, 1)),
      disconnectClients: () => {},
    },
    (_ms, run) => queueMicrotask(run),
  );

  reload();
  await new Promise((r) => setTimeout(r, 100));

  expect(seen).toEqual(["d"]);
});
