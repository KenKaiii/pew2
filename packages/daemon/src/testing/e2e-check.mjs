/**
 * End-to-end check against a running daemon server
 * (`PEW2_EXPERIMENTAL=1 bun run packages/daemon/src/server.ts`).
 *
 * Drives exactly what the app does: connect, list providers, start a session,
 * prompt, stream, and answer a permission request.
 */
const ws = new WebSocket("ws://127.0.0.1:8787");
const inbox = [];
let failures = 0;

const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (m) => ws.send(JSON.stringify(m));

ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
await new Promise((r) => ws.addEventListener("open", r));

send({ t: "hello", wire: 1, role: "app", deviceId: "check", cursors: {} });
await wait(500);

const announce = inbox.find((m) => m.t === "providers");
check("daemon announces providers", !!announce);
check("echo is available", announce?.providers.some((p) => p.id === "echo" && p.available));
check(
  "uninstalled provider marked unavailable, not crashing",
  announce?.providers.some((p) => p.id === "codex" && !p.available),
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
check("signals idle when the turn ends", inbox.some((m) => m.t === "session.idle"));

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

ws.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
