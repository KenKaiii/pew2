/**
 * The live half of `pew2 pair`.
 *
 * The property worth protecting is that waiting can never make pairing worse:
 * a missing daemon, a dead socket, a timeout or Ctrl-C all resolve quietly,
 * because the QR printed above is already valid.
 */
import { expect, test } from "bun:test";
import { checkRelay, cliDeviceId, deviceLabel, reachOf, rotationFor, waitForDevice } from "./pair.js";

/** A WebSocket stand-in with just the surface `waitForDevice` touches. */
class FakeSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }

  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function harness() {
  const socket = new FakeSocket();
  return {
    socket,
    create: () => socket as unknown as WebSocket,
  };
}

test("a device joining resolves the wait", async () => {
  const { socket, create } = harness();

  const pending = waitForDevice({ url: "ws://127.0.0.1:8787/", createSocket: create });
  socket.deliver({ t: "device.joined", deviceId: "Kens-iPhone", at: Date.now() });

  const result = await pending;
  expect(result?.deviceId).toBe("Kens-iPhone");
  expect(result?.elapsedMs).toBeGreaterThanOrEqual(0);
  // The watching socket is not left open behind the shell prompt.
  expect(socket.closed).toBe(true);
});

test("the CLI never counts its own id as the phone", async () => {
  const { socket, create } = harness();

  const pending = waitForDevice({ url: "ws://127.0.0.1:8787/", createSocket: create, timeoutMs: 60 });
  // The watching socket does not announce itself today, so this should be
  // unreachable — pinned so that adding a `hello` later cannot make the command
  // report success the instant it starts.
  socket.deliver({ t: "device.joined", deviceId: cliDeviceId(), at: Date.now() });
  socket.deliver({ t: "session.idle", sessionId: "s1" });

  expect(await pending).toBeNull();
});

test("unrelated and malformed traffic is ignored", async () => {
  const { socket, create } = harness();

  const pending = waitForDevice({ url: "ws://127.0.0.1:8787/", createSocket: create, timeoutMs: 60 });
  socket.onmessage?.({ data: "not json at all" });
  socket.onmessage?.({ data: new ArrayBuffer(4) });
  socket.deliver({ t: "providers", providers: [] });

  expect(await pending).toBeNull();
});

test("a socket that cannot be opened ends the wait instead of hanging", async () => {
  const result = await waitForDevice({
    url: "ws://127.0.0.1:8787/",
    createSocket: () => {
      throw new Error("connection refused");
    },
  });
  expect(result).toBeNull();
});

test("aborting returns immediately", async () => {
  const { create } = harness();
  const controller = new AbortController();

  const pending = waitForDevice({
    url: "ws://127.0.0.1:8787/",
    createSocket: create,
    signal: controller.signal,
  });
  controller.abort();

  expect(await pending).toBeNull();
});

test("reach follows the health check rather than the configuration", () => {
  // Configured and healthy.
  expect(reachOf(true, true, [])).toBe("anywhere");
  // Configured and dead: the one case the old output got wrong.
  expect(reachOf(false, true, ["192.168.1.24"])).toBe("unreachable");
  // Not checked: assume it works rather than crying wolf.
  expect(reachOf(null, true, [])).toBe("anywhere");
  // No relay, but a LAN address.
  expect(reachOf(null, false, ["192.168.1.24"])).toBe("local");
  // No relay and no network at all.
  expect(reachOf(null, false, [])).toBe("unreachable");
});

test("the relay check probes /health over http and treats any failure as down", async () => {
  const seen: string[] = [];
  const ok = await checkRelay("wss://relay.example.com/", async (input) => {
    seen.push(String(input));
    return new Response("ok", { status: 200 });
  });

  expect(ok).toBe(true);
  expect(seen[0]).toBe("https://relay.example.com/health");

  // A non-2xx is as unusable as an exception, and both must read as "down"
  // rather than propagating and killing the command.
  expect(await checkRelay("wss://relay.example.com", async () => new Response("", { status: 500 }))).toBe(false);
  expect(
    await checkRelay("wss://relay.example.com", async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }),
  ).toBe(false);
});

test("device names drop the relay's uuid suffix", () => {
  expect(deviceLabel("Kens-iPhone")).toBe("Kens-iPhone");
  expect(deviceLabel("iPhone-3f2a1b4c-9d8e-4f1a-b2c3-d4e5f6a7b8c9")).toBe("iPhone");
  expect(deviceLabel("   ")).toBe("a device");
});

test("printing a code for a claimed pairing re-mints it", () => {
  // The old code could not have onboarded anyone: the phone holding it never
  // needs to scan again, and everyone else is refused. The app's own refusal
  // tells people to run `pew2 pair`, so handing them the same dead code is a
  // loop with no way out of it.
  expect(rotationFor("phone-aaaa", false)).toEqual({
    rotate: true,
    supersededDevice: "phone-aaaa",
  });
});

test("running the command at all is the request for a fresh code", () => {
  // Someone typing `pew2 pair` wants to pair a phone, and only a new code can
  // do that. Printing the existing one used to be the default whenever the
  // pairing merely *looked* unclaimed - which is exactly how a half-failed
  // attempt looks, so the command handed back the code the phone had already
  // refused, over and over.
  expect(rotationFor(undefined)).toEqual({ rotate: true });
  expect(rotationFor(undefined, false)).toEqual({ rotate: true });
});

test("a pre-gate placeholder rotates without being named as a device", () => {
  // `phone` is what an older app called itself. It still gets a fresh code -
  // otherwise that user is the one person the command cannot help - but there
  // is no real device to tell them has been unpaired.
  expect(rotationFor("phone")).toEqual({ rotate: true });
});

test("--rotate is still accepted, and no longer decides anything", () => {
  // It existed to escape the cases above. Keeping it means every README line
  // and everyone's muscle memory keeps working.
  expect(rotationFor(undefined, true)).toEqual({ rotate: true });
  expect(rotationFor("phone-aaaa", true)).toEqual({
    rotate: true,
    supersededDevice: "phone-aaaa",
  });
});
