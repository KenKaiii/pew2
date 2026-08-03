/**
 * Relay client tests.
 *
 * The relay is what makes pew2 usable from anywhere, and the failure that
 * matters is not the first connection — it is the thousandth. Desktops sleep,
 * Wi-Fi changes, relays deploy. The user is not at the machine to restart
 * anything, so reconnection is the feature under test here.
 */
import { test, expect } from "bun:test";
import { RelayClient, backoffBounds, type RelayClientOptions } from "./relay-client.js";
import type { Daemon } from "./index.js";

/** Enough of a Daemon for the client to drive. */
function fakeDaemon() {
  const calls: string[] = [];
  return {
    calls,
    daemon: {
      refreshProviders: async () => {
        calls.push("refreshProviders");
        return { providers: [], errors: [] };
      },
    } as unknown as Daemon,
  };
}

/** A WebSocket that never really connects, driven by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client(overrides: Partial<RelayClientOptions> = {}) {
  FakeSocket.instances = [];
  const { daemon, calls } = fakeDaemon();
  const statuses: string[] = [];
  const relay = new RelayClient({
    daemon,
    url: "wss://relay.example.com",
    token: "t".repeat(48),
    deviceId: "test-machine",
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  });
  return { relay, statuses, calls };
}

test("dials out with the pairing token, as the daemon role", () => {
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;

  // Dialling *out* is the whole point: no port forwarding, no public address,
  // works from behind any NAT.
  const url = new URL(socket.url);
  expect(url.protocol).toBe("wss:");
  expect(url.pathname).toBe("/connect");
  expect(url.searchParams.get("pairing")).toBe("t".repeat(48));
  expect(url.searchParams.get("role")).toBe("daemon");
  expect(url.searchParams.get("deviceId")).toBe("test-machine");
  relay.stop();
});

test("announces itself and re-announces providers on connect", () => {
  const { relay, statuses, calls } = client();

  relay.start();
  FakeSocket.instances[0]!.open();

  const hello = JSON.parse(FakeSocket.instances[0]!.sent[0]!);
  expect(hello).toMatchObject({ t: "hello", role: "daemon", deviceId: "test-machine" });
  // The phone may have been waiting on the relay long before this machine woke
  // up, so the provider list has to be pushed again rather than assumed sent.
  expect(calls).toContain("refreshProviders");
  expect(statuses).toEqual(["connecting", "online"]);
  relay.stop();
});

test("reconnects after the socket drops", async () => {
  const { relay, statuses } = client();

  relay.start();
  FakeSocket.instances[0]!.open();
  expect(relay.online).toBe(true);

  // A sleeping laptop, a changed network, a relay deploy — all look like this.
  FakeSocket.instances[0]!.close();
  expect(relay.online).toBe(false);
  expect(statuses).toEqual(["connecting", "online", "offline"]);

  // Backoff is randomised, so wait past the upper bound of the first attempt.
  await new Promise((r) => setTimeout(r, backoffBounds(0).max + 50));
  expect(FakeSocket.instances.length).toBeGreaterThan(1);
  relay.stop();
});

test("backoff grows, is jittered, and is capped", () => {
  const first = backoffBounds(0);
  const later = backoffBounds(3);
  const far = backoffBounds(50);

  expect(first.max).toBe(1_000);
  expect(later.max).toBeGreaterThan(first.max);
  // Jitter: the window is a range, not a fixed delay. Without it every daemon
  // that lost the same relay deploy reconnects in lockstep and re-floors it.
  expect(later.min).toBeLessThan(later.max);
  // Capped, or a machine left asleep for a week would back off for hours.
  expect(far.max).toBe(30_000);
});

test("stop() ends reconnection for good", async () => {
  const { relay } = client();

  relay.start();
  FakeSocket.instances[0]!.open();
  relay.stop();
  FakeSocket.instances[0]!.close();

  await new Promise((r) => setTimeout(r, backoffBounds(0).max + 50));
  // Shutting down must actually shut down; a lingering retry loop would keep
  // the process alive and keep hitting the relay.
  expect(FakeSocket.instances).toHaveLength(1);
});

test("sending while offline is dropped rather than thrown", () => {
  const { relay } = client();

  // Before connecting, and after dropping, the daemon still emits events. They
  // must not become unhandled exceptions that take the process down.
  expect(() => relay.send({ t: "session.event" })).not.toThrow();
  relay.start();
  expect(() => relay.send({ t: "session.event" })).not.toThrow();
  relay.stop();
});

test("relayed messages reach the daemon handler", async () => {
  const { relay, calls } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  calls.length = 0;

  // An unknown type must produce an error reply rather than a crash: the app
  // and daemon can be different versions once this is remote. It carries its
  // own code so a newer app can tell "this daemon is older than me" apart from
  // a real failure and keep it out of the transcript.
  socket.receive({ t: "nonsense" });
  await new Promise((r) => setTimeout(r, 20));

  const errors = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0].code).toBe("unknown_message");
  relay.stop();
});

test("a phone on the relay is visible to clients on the LAN", async () => {
  // The two transports must be a two-way mirror. Before `onBroadcast` existed,
  // a broadcast triggered by a relay client went back out the relay only, so a
  // desktop client on the same machine never saw a phone that arrived over a
  // mobile network — despite the daemon owning one log precisely so that both
  // can watch the same conversation.
  const local: unknown[] = [];
  const { relay } = client({ onBroadcast: (message) => local.push(message) });

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ t: "hello", wire: 1, role: "app", deviceId: "Kens-iPhone" });
  // `hello` awaits a provider refresh before broadcasting, so let the
  // microtask queue drain the same way the neighbouring cases do.
  await new Promise((r) => setTimeout(r, 20));

  const joined = local.find((m) => (m as { t?: string }).t === "device.joined");
  expect(joined).toMatchObject({ t: "device.joined", deviceId: "Kens-iPhone" });

  // Still sent up the relay as well: the fan-out is additional, not a redirect.
  expect(socket.sent.some((raw) => raw.includes("device.joined"))).toBe(true);
  relay.stop();
});

test("a relay client with no local listener is still handled", async () => {
  // `onBroadcast` is optional, and omitting it must not turn every relay
  // message into a crash inside the daemon's only remote transport.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.receive({ t: "hello", wire: 1, role: "app", deviceId: "Kens-iPhone" });
  await new Promise((r) => setTimeout(r, 20));

  expect(socket.sent.some((raw) => raw.includes("device.joined"))).toBe(true);
  relay.stop();
});

test("a malformed frame is answered, not fatal", async () => {
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  socket.onmessage?.({ data: "{ not json" });
  await new Promise((r) => setTimeout(r, 20));

  const errors = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "error");
  expect(errors[0]?.code).toBe("bad_json");
  relay.stop();
});
