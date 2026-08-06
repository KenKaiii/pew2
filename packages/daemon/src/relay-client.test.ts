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
import { SecureChannel, e2e, wire } from "@pew2/protocol";

const { WIRE_VERSION } = wire;
import type { Daemon } from "./index.js";

/** The pairing both ends of these tests share. */
const KEY = "11".repeat(32);

/**
 * Stands in for the phone.
 *
 * Traffic to the daemon is encrypted, so a test that sends bare JSON is testing
 * a path that no longer exists — the client would drop it, correctly, and the
 * test would prove nothing.
 */
function phone() {
  return new SecureChannel(e2e.fromHex(KEY), "app");
}

/** Enough of a Daemon for the client to drive. */
function fakeDaemon({ refreshFails = false } = {}) {
  const calls: string[] = [];
  return {
    calls,
    daemon: {
      refreshProviders: async () => {
        calls.push("refreshProviders");
        // Re-scanning providers reads the disk and spawns probe processes, so
        // it can genuinely fail on a machine that just woke up.
        if (refreshFails) throw new Error("EMFILE: too many open files");
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
  /** Deliver a raw frame, exactly as the relay would. */
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function client(
  overrides: Partial<RelayClientOptions> = {},
  daemonOptions: { refreshFails?: boolean } = {},
) {
  FakeSocket.instances = [];
  const { daemon, calls } = fakeDaemon(daemonOptions);
  const statuses: string[] = [];
  const relay = new RelayClient({
    daemon,
    url: "wss://relay.example.com",
    token: "t".repeat(48),
    key: "11".repeat(32),
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

test("a failed provider re-announce does not bring down the connection", async () => {
  // `refreshProviders` is fired without being awaited, because the connection
  // is usable before it finishes. That makes an unhandled rejection here fatal
  // to the whole daemon — both Bun and Node exit on one by default — and it
  // would land at the exact moment the user is trying to reconnect, which is
  // the worst possible time to lose the process.
  //
  // The rejection hook is what actually guards this. The status and `online`
  // assertions below would pass with or without the `.catch`, since the
  // rejection happens after `onopen` has already returned.
  const rejections: unknown[] = [];
  const onRejection = (error: unknown) => rejections.push(error);
  process.on("unhandledRejection", onRejection);

  try {
    const { relay, statuses, calls } = client({}, { refreshFails: true });

    relay.start();
    FakeSocket.instances[0]!.open();

    // Let the rejected promise settle, then give Node a turn to notice an
    // unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(calls).toContain("refreshProviders");
    expect(rejections).toEqual([]);
    // The connection is up and stays up: losing one re-announce is recoverable,
    // losing the socket is not.
    expect(statuses).toEqual(["connecting", "online"]);
    expect(relay.online).toBe(true);
    relay.stop();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
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
  const app = phone();
  // Sealed frames are only read from a device that has proved it holds the key,
  // so the handshake is part of getting a message to the handler at all.
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));
  socket.receive({ ...app.seal({ t: "nonsense" }), from: "Kens-iPhone" });
  await new Promise((r) => setTimeout(r, 20));

  // The reply is sealed too, so reading it means decrypting it — which is also
  // the proof that what went back out was not plaintext.
  const errors = socket.sent
    .map((raw) => app.open(JSON.parse(raw)))
    .filter((m): m is { t: string; code: string } => (m as { t?: string })?.t === "error");
  expect(errors).toHaveLength(1);
  expect(errors[0]!.code).toBe("unknown_message");
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
  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  // `hello` awaits a provider refresh before broadcasting, so let the
  // microtask queue drain the same way the neighbouring cases do.
  await new Promise((r) => setTimeout(r, 20));

  const joined = local.find((m) => (m as { t?: string }).t === "device.joined");
  expect(joined).toMatchObject({ t: "device.joined", deviceId: "Kens-iPhone" });

  // Still sent up the relay as well: the fan-out is additional, not a redirect.
  expect(
    socket.sent.some((raw) => (app.open(JSON.parse(raw)) as { t?: string })?.t === "device.joined"),
  ).toBe(true);
  relay.stop();
});

test("a relay client with no local listener is still handled", async () => {
  // `onBroadcast` is optional, and omitting it must not turn every relay
  // message into a crash inside the daemon's only remote transport.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const app = phone();
  socket.receive({
    t: "hello",
    wire: WIRE_VERSION,
    role: "app",
    deviceId: "Kens-iPhone",
    proof: app.proof("Kens-iPhone"),
  });
  await new Promise((r) => setTimeout(r, 20));

  expect(
    socket.sent.some((raw) => (app.open(JSON.parse(raw)) as { t?: string })?.t === "device.joined"),
  ).toBe(true);
  relay.stop();
});

test("a malformed or unsealed frame is dropped, not answered", async () => {
  // Answering would be a favour to a stranger. Nothing here has proved it holds
  // the pairing key, so a reply would confirm the room is live and leak the
  // daemon's protocol version — and no legitimate peer ever sends any of this.
  const { relay } = client();

  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();
  const before = socket.sent.length;

  socket.onmessage?.({ data: "{ not json" });
  socket.receive({ t: "session.prompt", text: "unsealed" });
  socket.receive({ t: "e", ctr: 0, n: "AA", ct: "AA" });
  await new Promise((r) => setTimeout(r, 20));

  // Still alive, and it said nothing.
  expect(socket.sent.length).toBe(before);
  expect(() => relay.send({ t: "ping" })).not.toThrow();
  relay.stop();
});

test("rotating the pairing moves the daemon into the new relay room", () => {
  // The room id is derived from the token and fixed when the socket opens, so a
  // rotation cannot be applied to a live connection. Before this, `pew2 pair`
  // left the daemon listening in the old room while the freshly paired phone
  // joined the new one, and only a restart cleared it.
  const { relay } = client();
  relay.start();
  FakeSocket.instances[0]!.open();

  const before = FakeSocket.instances.length;
  relay.rekey("new-token", "ff".repeat(32));

  // A fresh socket, pointed at the new room.
  expect(FakeSocket.instances.length).toBe(before + 1);
  expect(relay.endpoint).toContain("pairing=new-token");
  expect(FakeSocket.instances.at(-1)!.url).toContain("pairing=new-token");
  relay.stop();
});

test("rekeying with the same credentials does not drop the connection", () => {
  // The pairing file is written more than once per save, so an unchanged
  // rotation must not cost the phone its live session.
  const { relay } = client({ token: "same-token", key: "aa".repeat(32) });
  relay.start();
  FakeSocket.instances[0]!.open();

  const before = FakeSocket.instances.length;
  relay.rekey("same-token", "aa".repeat(32));

  expect(FakeSocket.instances.length).toBe(before);
  relay.stop();
});

test("a stopped client does not silently start on rekey", () => {
  // `stop()` is called on shutdown. A rotation racing it must not resurrect the
  // socket after the daemon has decided to go away.
  const { relay } = client();
  relay.start();
  FakeSocket.instances[0]!.open();
  relay.stop();

  const before = FakeSocket.instances.length;
  relay.rekey("another-token", "bb".repeat(32));

  expect(FakeSocket.instances.length).toBe(before);
});

test("a rekeyed client does not leave the old socket scheduling retries", () => {
  // Found by rotating twice against a live daemon: the relay flapped between
  // online and offline and nothing could reach it. `rekey` closes the old
  // socket and opens a new one, but the old `onclose` fires *after* that — and
  // unguarded it nulled the new socket and scheduled a retry beside it, so two
  // connections raced each other indefinitely.
  const { relay, statuses } = client();
  relay.start();
  const first = FakeSocket.instances[0]!;
  first.open();

  relay.rekey("rotated-token", "cc".repeat(32));
  const second = FakeSocket.instances.at(-1)!;
  second.open();

  // The old socket's close lands late, after the replacement is already up.
  first.close();

  // Still exactly the two sockets: no retry was scheduled on top of the new one.
  expect(FakeSocket.instances.length).toBe(2);
  expect(relay.online).toBe(true);
  expect(statuses.at(-1)).toBe("online");
  relay.stop();
});

test("the same phone can reconnect over and over", async () => {
  // The bug this exists to stop, and the reason it went unnoticed for a day.
  //
  // A phone builds a fresh SecureChannel per socket, so its replay counter
  // restarts at zero on every reconnect. The daemon's relay channel is one
  // long-lived object shared by every device, and it remembered the highest
  // counter from the last connection — so the *second* connection from the same
  // device was rejected as a replay, permanently, until the daemon restarted.
  //
  // It never showed up in a test because every test used a fresh device id,
  // which sidesteps it completely. Real phones do not: they keep one id for
  // their lifetime, so every reconnect after the first one failed.
  const seen: unknown[] = [];
  const { relay } = client({ onBroadcast: (message) => seen.push(message) });
  relay.start();
  const socket = FakeSocket.instances[0]!;
  socket.open();

  for (let attempt = 0; attempt < 3; attempt++) {
    // A new channel each time, exactly as the app does on reconnect.
    const app = phone();
    socket.receive({
      t: "hello",
      wire: WIRE_VERSION,
      role: "app",
      deviceId: "Kens-iPhone",
      proof: app.proof("Kens-iPhone"),
    });
    await new Promise((r) => setTimeout(r, 20));

    const joins = seen.filter((m) => (m as { t?: string }).t === "device.joined");
    expect(joins.length, `reconnect ${attempt + 1} was not accepted`).toBe(attempt + 1);

    // And the connection is usable, not merely admitted: a sealed frame from
    // the new channel must still open.
    expect(relay.online).toBe(true);
  }

  relay.stop();
});
