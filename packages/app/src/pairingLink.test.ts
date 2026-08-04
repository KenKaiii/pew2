/**
 * Pairing-link validation.
 *
 * Every case here is a real way a link arrives wrong — truncated by a scanner,
 * pasted without the query string, copied from the wrong line of terminal
 * output. Each must fail at parse time with a message that says what to do,
 * because the alternative is a socket that never connects and a blank screen.
 */
import { test, expect } from "bun:test";
import { parsePairing } from "./pairingLink";

const TOKEN = "a".repeat(48);
/** 32 bytes of key, base64url, as the daemon puts it in the fragment. */
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ";
const FRAGMENT = `#k=${KEY}`;

test("accepts the URL the daemon prints", () => {
  const result = parsePairing(`ws://192.168.0.102:8787/?token=${TOKEN}${FRAGMENT}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pairing.url).toBe(`ws://192.168.0.102:8787/?token=${TOKEN}`);
  // The label is what appears in settings, so it must never carry the secret.
  expect(result.pairing.label).toBe("192.168.0.102:8787");
  expect(result.pairing.label).not.toContain(TOKEN);
});

test("tolerates surrounding whitespace from a paste", () => {
  const result = parsePairing(`  ws://192.168.0.102:8787/?token=${TOKEN}\n${FRAGMENT}`);
  expect(result.ok).toBe(true);
});

test("accepts a relay link, and marks it as working from anywhere", () => {
  const result = parsePairing(`wss://relay.example.com/connect?pairing=${TOKEN}&role=app${FRAGMENT}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // This is the flag the UI uses to say "works from anywhere" rather than
  // "same network only", so it must follow the link shape, not a guess.
  expect(result.pairing.remote).toBe(true);
  expect(result.pairing.label).toBe("relay.example.com");
});

test("a direct link is not remote", () => {
  const result = parsePairing(`ws://192.168.0.102:8787/?token=${TOKEN}${FRAGMENT}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pairing.remote).toBe(false);
});

test("adds the device id the relay requires", () => {
  // Without it the relay answers 400 and the socket simply never opens, with
  // nothing on screen to explain why.
  const result = parsePairing(
    `wss://relay.example.com/connect?pairing=${TOKEN}&role=app${FRAGMENT}`,
    "phone-abc123",
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(new URL(result.pairing.url).searchParams.get("deviceId")).toBe("phone-abc123");
});

test("keeps a device id already present in the link", () => {
  const result = parsePairing(
    `wss://relay.example.com/connect?pairing=${TOKEN}&role=app&deviceId=existing${FRAGMENT}`,
    "phone-abc123",
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(new URL(result.pairing.url).searchParams.get("deviceId")).toBe("existing");
});

test("corrects a relay link pasted with the daemon role", () => {
  // Copying the wrong line of terminal output would otherwise put the phone on
  // the daemon side of the relay, where it silently sees no traffic at all.
  const result = parsePairing(`wss://relay.example.com/connect?pairing=${TOKEN}&role=daemon${FRAGMENT}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(new URL(result.pairing.url).searchParams.get("role")).toBe("app");
});

test("rejects a link with no token", () => {
  const result = parsePairing("ws://192.168.0.102:8787/");

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // Names the command that produces a correct link.
  expect(result.error).toContain("pew2 pair");
});

test("rejects a truncated token rather than failing later at the socket", () => {
  const result = parsePairing("ws://192.168.0.102:8787/?token=abc123");

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("cut off");
});

test("rejects the wrong scheme, and says which one it got", () => {
  const result = parsePairing(`http://192.168.0.102:8787/?token=${TOKEN}${FRAGMENT}`);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("ws://");
  expect(result.error).toContain("http://");
});

test("rejects empty and non-URL input", () => {
  for (const input of ["", "   ", "hello", "192.168.0.102:8787"]) {
    const result = parsePairing(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  }
});

test("localhost is allowed, because the simulator shares the host network", () => {
  // A real device cannot reach it, but rejecting it would break the development
  // path the daemon itself prints when off a network.
  const result = parsePairing(`ws://localhost:8787/?token=${TOKEN}${FRAGMENT}`);
  expect(result.ok).toBe(true);
});

test("the key is taken from the fragment and kept off the wire", () => {
  // The property the whole design rests on: a URL fragment is never transmitted
  // to a server, so the relay routes this connection without ever receiving what
  // decrypts it.
  const result = parsePairing(
    `wss://relay.example.com/connect?pairing=${TOKEN}&role=app${FRAGMENT}`,
    "phone-1",
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.pairing.key).toMatch(/^[0-9a-f]{64}$/);
  // Cleared from the URL that gets opened, so it cannot leak into a log or a
  // settings screen even locally.
  expect(result.pairing.url).not.toContain("#");
  expect(result.pairing.url).not.toContain(KEY);
  expect(result.pairing.label).not.toContain(KEY);
});

test("a link with no key is refused with something to do about it", () => {
  // A link from a build before encryption existed, or one truncated at the `#`
  // by a scanner treating it as a comment. Connecting would produce a socket
  // that opens and then silently decrypts nothing.
  const result = parsePairing(`wss://relay.example.com/connect?pairing=${TOKEN}&role=app`);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("pew2 pair");
});

test("a damaged or wrong-length key is refused rather than used", () => {
  // Checked here rather than at first use: a truncated key produces a connection
  // that opens and then decrypts nothing, which is the least diagnosable failure
  // this app has.
  for (const fragment of ["#k=", "#k=!!!!", "#k=AAAA", "#nothing=here"]) {
    const result = parsePairing(
      `wss://relay.example.com/connect?pairing=${TOKEN}&role=app${fragment}`,
    );
    expect(result.ok).toBe(false);
  }
});
