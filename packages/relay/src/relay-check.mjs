/**
 * Integration check for a locally running relay (`wrangler dev --port 8799`).
 *
 * Proves the behaviours the product depends on:
 *   1. cross-role delivery (app -> daemon, daemon -> app)
 *   2. no echo back to the sender
 *   3. keepalives are answered without the message reaching the room
 *   4. a live daemon keeps its place; a room with no daemon turns apps away
 *
 * Catch-up is deliberately not among them. The relay stores nothing: it has no
 * key, so it could never seal the frame a replay would have to arrive in, and
 * the log it used to keep was written by anyone holding the room id and read by
 * nobody. Reconnect history comes from the daemon.
 */
// Hex, and at least 32 characters: `isPairingToken` refuses anything else
// before it can name a Durable Object, so a memorable-but-invalid string here
// fails every check below with a 400 that looks like a relay bug.
const PAIRING = "0123456789abcdef0123456789abcdef01";
const URL_BASE = `ws://127.0.0.1:8799/connect?pairing=${PAIRING}`;

const open = (role, id) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_BASE}&role=${role}&deviceId=${id}`);
    const inbox = [];
    ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
    ws.addEventListener("error", () => reject(new Error(`${role} ${id} was refused`)));
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "hello", wire: 1, role, deviceId: id }));
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

daemon.ws.send(
  JSON.stringify({ t: "session.event", sessionId: "s1", seq: 0, at: Date.now(), payload: { text: "first" } }),
);
daemon.ws.send(
  JSON.stringify({ t: "session.event", sessionId: "s1", seq: 1, at: Date.now(), payload: { text: "second" } }),
);
await wait(400);

const events = app.inbox.filter((m) => m.t === "session.event");
check("app receives daemon events", events.length === 2);
check(
  "events arrive in order",
  events[0]?.payload.text === "first" && events[1]?.payload.text === "second",
);

app.ws.send(JSON.stringify({ t: "session.prompt", sessionId: "s1", text: "hi" }));
await wait(300);
check("daemon receives app prompt", daemon.inbox.some((m) => m.t === "session.prompt"));
check("no echo back to sender", !app.inbox.some((m) => m.t === "session.prompt"));

// Answered by the runtime's hibernation auto-response, so the room never wakes
// and the app never sees it.
daemon.ws.send('{"t":"ping"}');
await wait(300);
check("keepalive is answered", daemon.inbox.some((m) => m.t === "pong"));
check("keepalive is not forwarded", !app.inbox.some((m) => m.t === "ping"));

// A daemon that is still answering keeps the room. Anyone can open this socket
// — the room id is not the key — so "newest wins" was a way to keep a working
// machine permanently offline.
const impostor = await open("daemon", "impostor").catch(() => null);
check("a live daemon cannot be displaced", impostor === null);

daemon.ws.close();
await wait(500);
const orphan = await open("app", "a2").catch(() => null);
check("an app is turned away when no daemon is present", orphan === null);

app.ws.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
