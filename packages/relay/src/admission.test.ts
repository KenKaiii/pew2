/**
 * The relay's access control.
 *
 * These rules are the only thing standing between a pairing token and someone
 * else's machine, and they run in a Durable Object where a mistake is invisible
 * until it is exploited — so they are tested here as a pure decision rather than
 * inferred from a deploy that "seemed fine".
 */
import { expect, test } from "bun:test";
import {
  admit,
  DAEMON_STALE_MS,
  isPairingToken,
  MAX_SOCKETS_PER_ROOM,
  MIN_PAIRING_TOKEN_LENGTH,
} from "./admission.js";

const TOKEN = "a".repeat(48);

test("only tokens shaped like a minted one may name a room", () => {
  // Naming a Durable Object is what creates it, so this check has to happen
  // before that — anything reaching it is a room that now exists.
  expect(isPairingToken(TOKEN)).toBe(true);
  expect(isPairingToken("F".repeat(32))).toBe(true);

  expect(isPairingToken(null)).toBe(false);
  expect(isPairingToken("")).toBe(false);
  expect(isPairingToken("a".repeat(MIN_PAIRING_TOKEN_LENGTH - 1))).toBe(false);
  // Long enough, but not hex — never something `pew2` produced.
  expect(isPairingToken("not-a-real-token-but-long-enough-xxxxx")).toBe(false);
  expect(isPairingToken(`${TOKEN}/../other`)).toBe(false);
  expect(isPairingToken(`${"a".repeat(40)} `)).toBe(false);
});

test("a device is refused when no daemon is there to answer it", () => {
  // What makes rotation actually take effect. The room named by a retired token
  // has no daemon in it, so a phone still holding that token is turned away
  // instead of sitting in an empty room looking connected to a machine that
  // will never reply.
  expect(admit({ role: "app", deviceId: "phone", daemons: 0, total: 0 })).toEqual({
    ok: false,
    status: 409,
    reason: "no daemon connected for this pairing",
  });

  // And admitted once the desktop is present.
  expect(admit({ role: "app", deviceId: "phone", daemons: 1, total: 1 })).toEqual({
    ok: true,
    role: "app",
    deviceId: "phone",
    evictDaemons: false,
  });
});

test("a reconnecting daemon replaces a socket that has stopped answering", () => {
  // The failure this avoids is self-inflicted and certain: a dropped socket
  // stays attached until the runtime notices, and the daemon retries within a
  // second of a network blip. "First claim wins" would shut a machine out of
  // its own room behind exponential backoff every time a laptop changed
  // network.
  const now = Date.now();

  expect(admit({ role: "daemon", deviceId: "mac", daemons: 0, total: 0, now })).toEqual({
    ok: true,
    role: "daemon",
    deviceId: "mac",
    evictDaemons: false,
  });

  // Silent for well past the keepalive budget: nothing is on the other end.
  expect(
    admit({
      role: "daemon",
      deviceId: "mac",
      daemons: 1,
      total: 3,
      daemonLastSeen: now - DAEMON_STALE_MS - 1,
      now,
    }),
  ).toEqual({ ok: true, role: "daemon", deviceId: "mac", evictDaemons: true });

  // A room whose daemon predates keepalives, or that has never reported one, is
  // treated as unknown rather than live — the old behaviour, so an upgrade does
  // not strand a machine.
  expect(admit({ role: "daemon", deviceId: "mac", daemons: 1, total: 3, now }).ok).toBe(true);
});

test("a daemon that is still answering cannot be pushed out of its own room", () => {
  // Nobody opening this socket has proved anything: the room id is derived from
  // the root key and is not the key. Under "newest wins", someone who learned it
  // could evict the real daemon on repeat — they pay no backoff and the daemon
  // does, so they win every race and the machine never gets back in. The user
  // sees a laptop that is plainly running and plainly unreachable.
  const now = Date.now();

  expect(
    admit({
      role: "daemon",
      deviceId: "impostor",
      daemons: 1,
      total: 2,
      daemonLastSeen: now - 5_000,
      now,
    }),
  ).toEqual({
    ok: false,
    status: 409,
    reason: "a live daemon is already connected",
  });

  // Right up to the boundary, and over it.
  expect(
    admit({
      role: "daemon",
      deviceId: "impostor",
      daemons: 1,
      total: 2,
      daemonLastSeen: now - DAEMON_STALE_MS,
      now,
    }).ok,
  ).toBe(false);
  expect(
    admit({
      role: "daemon",
      deviceId: "mac",
      daemons: 1,
      total: 2,
      daemonLastSeen: now - DAEMON_STALE_MS - 1,
      now,
    }).ok,
  ).toBe(true);

  // Apps are unaffected: they never contend for the daemon slot.
  expect(
    admit({
      role: "app",
      deviceId: "phone",
      daemons: 1,
      total: 2,
      daemonLastSeen: now - 5_000,
      now,
    }).ok,
  ).toBe(true);
});

test("one room cannot accumulate unbounded sockets", () => {
  // Bounds what a leaked token can pile up. Checked for both roles, so the cap
  // cannot be walked around by asking to be the daemon.
  for (const role of ["app", "daemon"] as const) {
    expect(admit({ role, deviceId: "x", daemons: 1, total: MAX_SOCKETS_PER_ROOM })).toEqual({
      ok: false,
      status: 429,
      reason: "too many connections for this pairing",
    });
  }

  // One below the cap is still fine.
  expect(
    admit({ role: "app", deviceId: "x", daemons: 1, total: MAX_SOCKETS_PER_ROOM - 1 }).ok,
  ).toBe(true);
});

test("a malformed connection is rejected before anything is attached", () => {
  expect(admit({ role: null, deviceId: "x", daemons: 1, total: 1 }).ok).toBe(false);
  expect(admit({ role: "observer", deviceId: "x", daemons: 1, total: 1 }).ok).toBe(false);
  expect(admit({ role: "app", deviceId: null, daemons: 1, total: 1 }).ok).toBe(false);
  expect(admit({ role: "app", deviceId: "", daemons: 1, total: 1 }).ok).toBe(false);
});

test("the socket cap is checked before the daemon rules, so neither can bypass it", () => {
  // A full room refuses even a daemon that would otherwise evict its way in,
  // which is what keeps the cap a cap.
  const full = admit({ role: "daemon", deviceId: "mac", daemons: 1, total: MAX_SOCKETS_PER_ROOM });
  expect(full.ok).toBe(false);
  expect(full).toMatchObject({ status: 429 });
});
