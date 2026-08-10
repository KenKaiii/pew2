/**
 * End-to-end check against a running daemon server
 * (`PEW2_EXPERIMENTAL=1 bun run packages/daemon/src/server.ts`).
 *
 * Drives exactly what the app does: connect, list providers, start a session,
 * prompt, stream, and answer a permission request.
 */
// The daemon's own pairing decides both halves of this: the query token that
// gets the socket upgraded, and the key every frame after `hello` is sealed
// with. Loaded the same way the daemon loads it, so a scratch daemon
// (`PEW2_HOME`/`PEW2_TOKEN`/`PEW2_PORT`) can be driven without disturbing the
// one a phone is paired to.
import { loadPairing } from "../pairing.js";
import { CLI_DEVICE_PREFIX } from "../device-claim.js";
import { SecureChannel, e2e, wire } from "@pew2/protocol";

const port = process.env.PEW2_PORT ?? "8787";
const pairing = await loadPairing();
const channel = new SecureChannel(e2e.fromHex(pairing.key), "app");
// The local-watcher identity, not a device name. A pairing belongs to one
// device, and proving the key is what claims it — so a plain id here would take
// an unclaimed pairing (the phone that scanned next is refused until
// `pew2 pair --rotate`) or be refused itself by the phone that already owns it,
// which is every run on a machine actually in use. This prefix is admitted and
// never recorded, exactly as `pew2 pair`'s own watching socket is.
const deviceId = `${CLI_DEVICE_PREFIX}e2e-check`;
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${pairing.token}`);
const inbox = [];
let failures = 0;

const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Everything after `hello` is sealed in both directions, exactly as the app
// sends it. An unsealed frame is dropped without a word — which is what this
// check was silently doing to itself, failing every step after the handshake.
const send = (m) => ws.send(JSON.stringify(channel.seal(m)));

ws.addEventListener("message", (e) => {
  const frame = JSON.parse(e.data);
  const message = e2e.isEnvelope(frame) ? channel.open(frame) : frame;
  if (message !== undefined) inbox.push(message);
});
// A rejected upgrade (wrong or missing token) otherwise hangs here forever.
ws.addEventListener("error", () => {
  console.log("FAIL  connects to the daemon");
  process.exit(1);
});
await new Promise((r) => ws.addEventListener("open", r));

// Cleartext, and the only frame that may be: it is what establishes the
// connection. The proof beside it is what the daemon checks before doing any
// work for this socket.
ws.send(
  JSON.stringify({
    t: "hello",
    wire: wire.WIRE_VERSION,
    role: "app",
    deviceId,
    proof: channel.proof(deviceId),
    cursors: {},
  }),
);
await wait(500);
check(
  "the handshake is accepted",
  !inbox.some((m) => m.t === "error" && ["unpaired", "device-refused", "wire-version"].includes(m.code)),
);

const announce = inbox.find((m) => m.t === "providers");
check("daemon announces providers", !!announce);
check("echo is available", announce?.providers.some((p) => p.id === "echo" && p.available));
// Named `codex` once, which made this a check on what happens to be installed
// on the machine running it — an agent whose command is missing entirely is not
// announced at all, so it failed for a reason that had nothing to do with the
// daemon. What matters is that an agent this machine cannot run is reported as
// such, with a reason the phone can show, instead of taking the announce down.
check(
  "an unavailable agent says why, and the rest still announce",
  announce?.providers.every((p) => p.available || typeof p.unavailableReason === "string"),
);

send({ t: "session.start", providerId: "echo" });
await wait(1500);
const started = inbox.find((m) => m.t === "session.started");
check("session starts", !!started);
if (!started) {
  // Everything below dereferences the session id; bail with a clear result
  // rather than a TypeError that hides which check failed.
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}

// Models and thinking levels must come from the agent, not from pew2.
const models = started.configOptions?.find((o) => o.category === "model");
const thinking = started.configOptions?.find((o) => o.category === "thought_level");
check("agent advertises its models", models?.options?.length > 0);
check("agent advertises thinking levels", thinking?.options?.length > 0);

inbox.length = 0;
send({
  t: "session.config",
  sessionId: started.sessionId,
  configId: "model",
  value: "echo-max",
});
await wait(1200);
const applied = inbox
  .find((m) => m.t === "session.config")
  ?.configOptions?.find((o) => o.id === "model");
check("changing the model round-trips", applied?.currentValue === "echo-max");

// A value outside the advertised set must be refused, not silently stored.
inbox.length = 0;
send({
  t: "session.config",
  sessionId: started.sessionId,
  configId: "model",
  value: "not-a-real-model",
});
await wait(1200);
check(
  "invalid model value is rejected",
  inbox.some((m) => m.t === "error") && !inbox.some((m) => m.t === "session.config"),
);

inbox.length = 0;
send({ t: "session.prompt", sessionId: started.sessionId, text: "hello from the simulator" });
await wait(2000);

const events = inbox.filter((m) => m.t === "session.event");
check("streams multiple events", events.length > 3);
const text = events.map((e) => e.payload?.update?.content?.text ?? "").join("");
check("echoes the prompt back", text.includes("hello from the simulator"));
// Without this the app's working indicator would spin forever.
const idle = inbox.find((m) => m.t === "session.idle");
check("signals idle when the turn ends", Boolean(idle));
// The phone is usually looking at something else by the time a turn lands, and
// only this machine knows which project finished: without the stamp the
// "agent finished" notification cannot name the work.
check("names the project on the finished turn", Boolean(idle?.folder));

// Permission round trip.
inbox.length = 0;
send({ t: "session.prompt", sessionId: started.sessionId, text: "ask permission please" });
await wait(2000);
const request = inbox
  .filter((m) => m.t === "session.event")
  .find((m) => m.payload?.kind === "permission_request");
check("permission request reaches the client", !!request);

if (request) {
  inbox.length = 0;
  send({
    t: "session.permission",
    sessionId: started.sessionId,
    requestId: request.payload.requestId,
    optionId: "allow",
  });
  await wait(1500);
  const after = inbox
    .filter((m) => m.t === "session.event")
    .map((e) => e.payload?.update?.content?.text ?? "")
    .join("");
  check("approval reaches the agent", after.includes("You chose: allow"));
}

// Images. The agent names a file on this machine; only the daemon can read it,
// so this round trip is the whole reason a generated picture is not a blank box.
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const imageDir = mkdtempSync(join(tmpdir(), "pew2-e2e-image-"));
writeFileSync(join(imageDir, "plot.png"), PNG);

inbox.length = 0;
send({ t: "image.fetch", requestId: "img-1", sessionId: started.sessionId, uri: join(imageDir, "plot.png") });
await wait(800);
const image = inbox.find((m) => m.t === "image" && m.requestId === "img-1");
check("daemon inlines an image the agent named by path", image?.dataUri?.startsWith("data:image/png;base64,"));

inbox.length = 0;
send({ t: "image.fetch", requestId: "img-2", sessionId: started.sessionId, uri: join(imageDir, "missing.png") });
await wait(800);
const missing = inbox.find((m) => m.t === "image" && m.requestId === "img-2");
// A failure must come back as a reason, or the app shows a blank frame forever.
check("a missing image answers with a reason, not silence", !!missing?.error);

ws.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
