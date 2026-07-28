/**
 * Integration check for a locally running relay (`wrangler dev --port 8799`).
 *
 * Proves the three behaviours the product depends on:
 *   1. cross-role delivery (app -> daemon, daemon -> app)
 *   2. durable session events
 *   3. gap-free replay to a client that reconnects with a cursor
 */
// Must satisfy the relay's minimum pairing-token length.
const PAIRING = "testpairingtoken0123456789abcdef01";
const URL_BASE = `ws://127.0.0.1:8799/connect?pairing=${PAIRING}`;

const open = (role, id, cursors = {}) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${URL_BASE}&role=${role}&deviceId=${id}`);
    const inbox = [];
    ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "hello", wire: 1, role, deviceId: id, cursors }));
      resolve({ ws, inbox });
    });
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const daemon = await open("daemon", "d1");
const app = await open("app", "a1");
await wait(300);

daemon.ws.send(JSON.stringify({ t: "session.event", sessionId: "s1", seq: 0, at: Date.now(), payload: { text: "first" } }));
daemon.ws.send(JSON.stringify({ t: "session.event", sessionId: "s1", seq: 1, at: Date.now(), payload: { text: "second" } }));
await wait(400);

const events = app.inbox.filter((m) => m.t === "session.event");
check("app receives daemon events", events.length === 2);
check("events arrive in order", events[0]?.payload.text === "first" && events[1]?.payload.text === "second");

app.ws.send(JSON.stringify({ t: "session.prompt", sessionId: "s1", text: "hi" }));
await wait(300);
check("daemon receives app prompt", daemon.inbox.some((m) => m.t === "session.prompt"));
check("no echo back to sender", !app.inbox.some((m) => m.t === "session.prompt"));

app.ws.close();
await wait(300);
const app2 = await open("app", "a1", { s1: 0 });
await wait(600);

const replay = app2.inbox.find((m) => m.t === "session.replay");
check("reconnect triggers replay", !!replay);
check("replay contains only newer events", replay?.events.length === 1 && replay.events[0].seq === 1);

daemon.ws.close();
app2.ws.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
