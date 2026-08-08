/**
 * Proving a pairing before the app commits to it.
 *
 * The bug this exists to prevent: a rotated link parses perfectly, so the app
 * stored it, moved to the main screen, and sat on "Connecting to your
 * machine..." forever. Both refusals happen below the WebSocket — 401 from the
 * daemon, 409 from the relay for a room with no machine in it — so there is no
 * open socket to carry an explanation, and trying is the only way to know.
 */
import { test, expect } from "bun:test";
import { SecureChannel, e2e } from "@pew2/protocol";
import { verifyPairing, UNREACHABLE_MESSAGE } from "./verifyPairing";
import type { Pairing } from "./pairingLink";

const KEY = "a".repeat(64);

const pairing: Pairing = {
  url: "wss://relay.example.com/connect?pairing=" + "b".repeat(48) + "&role=app&deviceId=phone-aaaa",
  label: "relay.example.com",
  remote: true,
  deviceId: "phone-aaaa",
  key: KEY,
};

/** A socket whose behaviour each test drives by hand. */
class FakeSocket {
  static last: FakeSocket | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.closed = true;
  }
  /** The machine's side of the conversation. */
  reply(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function attempt(overrides: { timeoutMs?: number } = {}) {
  const result = verifyPairing(pairing, {
    timeoutMs: overrides.timeoutMs ?? 50,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  return { result, socket: () => FakeSocket.last! };
}

/** The daemon's side of the shared key. */
function machine() {
  return new SecureChannel(e2e.fromHex(KEY), "daemon");
}

test("a sealed answer is what counts as proof", async () => {
  // Not the socket opening, and not the relay's greeting: only a frame this
  // device can decrypt shows the machine is there, accepted us, and holds the
  // same key.
  const { result, socket } = attempt();
  socket().onopen!();
  socket().reply({ t: "ready", wire: 1, now: Date.now() });
  socket().reply(machine().seal({ t: "device.joined", devices: ["phone-aaaa"] }));

  expect(await result).toEqual({ ok: true });
});

test("the handshake carries a proof for this device", async () => {
  const { result, socket } = attempt();
  socket().onopen!();

  const hello = JSON.parse(socket().sent[0]!) as { t: string; deviceId: string; proof: unknown };
  expect(hello.t).toBe("hello");
  // The id the daemon binds its single-device claim to. Sending anything else
  // would have the probe claim the pairing under a name the app never uses.
  expect(hello.deviceId).toBe("phone-aaaa");
  expect(hello.proof).toBeDefined();

  socket().reply(machine().seal({ t: "device.joined" }));
  await result;
});

test("the relay's greeting alone is not an answer", async () => {
  // The exact shape of the old bug: the relay lets anyone into a room and says
  // `ready`, which used to look enough like success to move on. An empty room
  // is what a rotated token names.
  const { result, socket } = attempt({ timeoutMs: 30 });
  socket().onopen!();
  socket().reply({ t: "ready", wire: 1, now: Date.now() });

  expect(await result).toEqual({ ok: false, message: UNREACHABLE_MESSAGE });
});

test("a socket refused before it opens fails rather than hanging", async () => {
  // 401 from the daemon, 409 from the relay. No frame can be delivered, so the
  // transport error is the only signal there will ever be.
  const { result, socket } = attempt({ timeoutMs: 5000 });
  socket().onerror!();

  expect(await result).toEqual({ ok: false, message: UNREACHABLE_MESSAGE });
});

test("silence fails on a timer instead of waiting forever", async () => {
  const { result, socket } = attempt({ timeoutMs: 30 });
  socket().onopen!();

  expect(await result).toEqual({ ok: false, message: UNREACHABLE_MESSAGE });
});

test("a refusal the daemon explained is shown in its own words", async () => {
  // The single-device gate names the fix — `pew2 pair --rotate` — and only the
  // user can tell a stolen link from their own reinstalled phone. Replacing
  // that with a generic failure would throw away the one useful sentence.
  const { result, socket } = attempt({ timeoutMs: 5000 });
  socket().onopen!();
  socket().reply({
    t: "error",
    code: "device-refused",
    deviceId: "phone-aaaa",
    message: "This pairing is already in use by another device.",
  });

  expect(await result).toEqual({
    ok: false,
    message: "This pairing is already in use by another device.",
  });
});

test("a refusal aimed at another device is ignored", async () => {
  // The relay forwards cleartext to every app in the room, so an attacker
  // probing with a leaked link produces a refusal that lands here too. Acting
  // on it would report a perfectly good code as broken at the exact moment
  // someone else is attacking the pairing.
  const { result, socket } = attempt({ timeoutMs: 5000 });
  socket().onopen!();
  socket().reply({
    t: "error",
    code: "device-refused",
    deviceId: "phone-someone-else",
    message: "This pairing is already in use by another device.",
  });
  socket().reply(machine().seal({ t: "device.joined" }));

  expect(await result).toEqual({ ok: true });
});

test("an answer this device cannot decrypt is a failure, not something to wait past", async () => {
  // A token and key from different pairings, or a link assembled by hand. The
  // machine is reachable; the key is wrong.
  const other = new SecureChannel(e2e.fromHex("c".repeat(64)), "daemon");
  const { result, socket } = attempt({ timeoutMs: 5000 });
  socket().onopen!();
  socket().reply(other.seal({ t: "device.joined" }));

  const outcome = await result;
  expect(outcome.ok).toBe(false);
  expect(outcome.ok === false && outcome.message).toContain("cannot read");
});

test("the probe never leaves its socket open", async () => {
  // This is not the app's connection. Leaving it attached would hold a slot in
  // a room that caps them, and the daemon would see a device that then goes
  // quiet forever.
  const { result, socket } = attempt();
  socket().onopen!();
  socket().reply(machine().seal({ t: "device.joined" }));
  await result;

  expect(socket().closed).toBe(true);
});

test("a close arriving after the answer does not overturn it", async () => {
  // The probe closes its own socket on success, which fires `onclose` right
  // after. Left attached, that would report failure for a pairing that just
  // proved itself.
  const { result, socket } = attempt();
  socket().onopen!();
  socket().reply(machine().seal({ t: "device.joined" }));
  socket().onclose?.();

  expect(await result).toEqual({ ok: true });
});
