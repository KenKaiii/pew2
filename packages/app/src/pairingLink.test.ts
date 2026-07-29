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

test("accepts the URL the daemon prints", () => {
  const result = parsePairing(`ws://192.168.0.102:8787/?token=${TOKEN}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pairing.url).toBe(`ws://192.168.0.102:8787/?token=${TOKEN}`);
  // The label is what appears in settings, so it must never carry the secret.
  expect(result.pairing.label).toBe("192.168.0.102:8787");
  expect(result.pairing.label).not.toContain(TOKEN);
});

test("tolerates surrounding whitespace from a paste", () => {
  const result = parsePairing(`  ws://192.168.0.102:8787/?token=${TOKEN}\n`);
  expect(result.ok).toBe(true);
});

test("accepts a relay link, and marks it as working from anywhere", () => {
  const result = parsePairing(`wss://relay.example.com/connect?pairing=${TOKEN}&role=app`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // This is the flag the UI uses to say "works from anywhere" rather than
  // "same network only", so it must follow the link shape, not a guess.
  expect(result.pairing.remote).toBe(true);
  expect(result.pairing.label).toBe("relay.example.com");
});

test("a direct link is not remote", () => {
  const result = parsePairing(`ws://192.168.0.102:8787/?token=${TOKEN}`);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.pairing.remote).toBe(false);
});

test("adds the device id the relay requires", () => {
  // Without it the relay answers 400 and the socket simply never opens, with
  // nothing on screen to explain why.
  const result = parsePairing(
    `wss://relay.example.com/connect?pairing=${TOKEN}&role=app`,
    "phone-abc123",
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(new URL(result.pairing.url).searchParams.get("deviceId")).toBe("phone-abc123");
});

test("keeps a device id already present in the link", () => {
  const result = parsePairing(
    `wss://relay.example.com/connect?pairing=${TOKEN}&role=app&deviceId=existing`,
    "phone-abc123",
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(new URL(result.pairing.url).searchParams.get("deviceId")).toBe("existing");
});

test("corrects a relay link pasted with the daemon role", () => {
  // Copying the wrong line of terminal output would otherwise put the phone on
  // the daemon side of the relay, where it silently sees no traffic at all.
  const result = parsePairing(`wss://relay.example.com/connect?pairing=${TOKEN}&role=daemon`);

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
  const result = parsePairing(`http://192.168.0.102:8787/?token=${TOKEN}`);

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
  const result = parsePairing(`ws://localhost:8787/?token=${TOKEN}`);
  expect(result.ok).toBe(true);
});
