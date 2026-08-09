/**
 * The whole pipeline, over a real socket, against a real agent.
 *
 * Every bug behind `REMOTE_QA_CHECKLIST.md` lived between the parts rather than
 * inside one: a frame broadcast to a client that did not ask for it, a socket
 * that died mid-turn, a request whose answer nobody could match back to it.
 * The unit suites could not see any of them — they pass a `Daemon` a message
 * and read what comes back, which is exactly the seam the bugs were not at.
 * They were all found by hand, on a phone, and this file exists so the next one
 * is not.
 *
 * These are wire facts, deliberately. What the app *does* with a frame belongs
 * to `replayFold.test.ts` and its neighbours, which are pure and fast. What is
 * asserted here is the half neither side could check alone: that the daemon
 * sends the right frame, to the right socket, with enough in it for a client to
 * tell its own work from someone else's.
 *
 * One daemon is shared by every test, because spawning one costs about a second
 * and nothing here needs a private machine. Sessions are per test, so they
 * cannot interfere.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { AppClient } from "./testing/app-client.js";
import { startDaemon, type RunningDaemon } from "./testing/daemon-process.js";

/**
 * Per-test budget, comfortably above the client's own eight-second wait.
 *
 * The runner's default is five seconds, which is under that wait — and a test
 * the runner kills takes the shared daemon down with it, since the daemon sits
 * in the same process group. Declaring this everywhere is what keeps a single
 * slow scenario from failing every scenario after it.
 */
const TEST_TIMEOUT = 20_000;

let daemon: RunningDaemon;

// The single-device rule means every client in this file must present the same
// id, or the second one is refused. That is the production shape too: a phone
// and a desktop on one pairing are one claimed device with two sockets.
const DEVICE = "e2e-device";

beforeAll(async () => {
  daemon = await startDaemon();
});

afterAll(async () => {
  await daemon?.stop();
});

/** Connect, and start a session on the echo agent, returning both. */
async function withSession(requestId: string) {
  const app = await AppClient.connect(daemon, { deviceId: DEVICE });
  app.send({ t: "session.start", requestId, providerId: "echo" });
  const started = await app.waitFor((f) => f.t === "session.started", "session.started");
  return { app, sessionId: started.sessionId as string, started };
}

test("a paired device is admitted and told what agents this machine has", async () => {
  const app = await AppClient.connect(daemon, { deviceId: DEVICE });

  const providers = await app.waitFor((f) => f.t === "providers", "providers");
  expect(Array.isArray(providers.providers)).toBe(true);
  // The echo agent is what every scenario below runs against, so its absence
  // should fail here rather than as a confusing timeout later.
  expect(providers.providers.some((p: { id: string }) => p.id === "echo")).toBe(true);
  app.close();
}, TEST_TIMEOUT);

test("a device the pairing does not belong to is refused, in the clear", async () => {
  // Cleartext on purpose: a refusal has to be readable by a client whose proof
  // was just rejected, which by definition cannot decrypt anything.
  const stranger = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=${daemon.token}`);
  const frames: any[] = [];
  stranger.onmessage = (event) => frames.push(JSON.parse(String(event.data)));

  await new Promise<void>((resolve) => {
    stranger.onopen = () => resolve();
  });
  // A valid token but no proof: the shape an attacker who read the QR over
  // someone's shoulder, or scraped a leaked link, actually has.
  stranger.send(
    JSON.stringify({ t: "hello", wire: 2, role: "app", deviceId: "someone-elses-phone" }),
  );
  // The daemon closes the socket immediately after refusing it, and frames on
  // one socket arrive in order — so by the time this resolves the refusal is
  // already in hand. Sleeping a fixed 300ms instead would be asserting the
  // presence of a frame on a timer, which is the shape of every flaky test
  // anyone has ever had to re-run.
  await new Promise<void>((resolve) => {
    stranger.onclose = () => resolve();
  });

  const error = frames.find((f) => f.t === "error");
  expect(error?.code).toBe("unpaired");
  // Nothing about this machine leaks to an unproven socket.
  expect(frames.some((f) => f.t === "providers")).toBe(false);
  stranger.close();
}, TEST_TIMEOUT);

test("a sealed message from a socket that never said hello is ignored entirely", async () => {
  const silent = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=${daemon.token}`);
  const frames: any[] = [];
  silent.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve) => {
    silent.onopen = () => resolve();
  });

  silent.send(JSON.stringify({ t: "session.start", requestId: "r", providerId: "echo" }));
  await Bun.sleep(400);

  // Only the cleartext `ready` that every socket gets on open. No answer, and
  // no error either: an unauthenticated socket learns nothing from what it does
  // or does not get back.
  expect(frames.map((f) => f.t)).toEqual(["ready"]);
  silent.close();
}, TEST_TIMEOUT);

test("a prompt runs end to end: agent spawned, chunks streamed, turn closed", async () => {
  const { app, sessionId } = await withSession("r-pipeline");

  app.send({ t: "session.prompt", sessionId, text: "hello there" });
  await app.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "session.idle");

  const events = app.all("session.event").filter((f) => f.sessionId === sessionId);
  // The agent really ran: an empty turn would still produce `session.idle`, so
  // the events are what prove the pipeline carried anything.
  expect(events.length).toBeGreaterThan(0);
  // Sequence numbers are what reconnect resumes from, so they must be dense and
  // ordered on the wire rather than merely present.
  expect(events.map((f) => f.seq)).toEqual(events.map((_, at) => at));
  app.close();
}, TEST_TIMEOUT);

test("session.started carries the request id that asked for it", async () => {
  const { app, started } = await withSession("r-echoed");

  // Without this a client cannot tell its own session from one announced by
  // another device — which is precisely how a slow `session.start` used to
  // blank whichever conversation the user had switched to.
  expect(started.requestId).toBe("r-echoed");
  app.close();
}, TEST_TIMEOUT);

test("session.started says which project the conversation is in", async () => {
  const { app, started } = await withSession("r-project");

  // Clients file sessions by project and hide the ones they cannot place, so a
  // session announced without this is one the drawer will not show while a
  // project is selected — which used to be every new conversation until its
  // first turn finished, because `session.idle` was the only frame carrying it.
  expect(typeof started.cwd).toBe("string");
  expect(started.cwd.length).toBeGreaterThan(0);
  app.close();
}, TEST_TIMEOUT);

test("session.started reaches sockets that did not ask for it, marked as another's", async () => {
  const watcher = await AppClient.connect(daemon, { deviceId: DEVICE });
  const { app, sessionId } = await withSession("r-mine");

  const seen = await watcher.waitFor(
    (f) => f.t === "session.started" && f.sessionId === sessionId,
    "the other socket's session.started",
  );

  // The broadcast is deliberate — a second device must learn the session
  // exists — and this is the field that stops it being a hijack. A client
  // matches this against the request it sent; anything else belongs to someone
  // else and must not take over the screen. See `claimsScreen` in useDaemon.ts.
  expect(seen.requestId).toBe("r-mine");
  expect(watcher.frames.filter((f) => f.t === "session.started").length).toBe(1);

  app.close();
  watcher.close();
}, TEST_TIMEOUT);

test("a turn started on one socket streams to the other one too", async () => {
  const watcher = await AppClient.connect(daemon, { deviceId: DEVICE });
  const { app, sessionId } = await withSession("r-fanout");

  app.send({ t: "session.prompt", sessionId, text: "watch this" });
  // Both are awaited before either is read. Nothing orders delivery across two
  // sockets, so snapshotting one at the moment the *other* finished would be
  // comparing a complete list against a possibly partial one.
  await watcher.waitFor(
    (f) => f.t === "session.idle" && f.sessionId === sessionId,
    "the turn ending, as seen by the other socket",
  );
  await app.waitFor(
    (f) => f.t === "session.idle" && f.sessionId === sessionId,
    "the turn ending, as seen by the socket that started it",
  );

  const here = app.all("session.event").filter((f) => f.sessionId === sessionId);
  const there = watcher.all("session.event").filter((f) => f.sessionId === sessionId);
  // Non-empty first. Fan-out breaking for *everyone* would leave two empty
  // lists, and a test that only compared them would call that agreement.
  expect(there.length).toBeGreaterThan(0);
  // Both sockets see the same conversation, which is the point of fanning out
  // at the daemon rather than at the client.
  expect(there.map((f) => f.seq)).toEqual(here.map((f) => f.seq));

  app.close();
  watcher.close();
}, TEST_TIMEOUT);

test("a socket that dies mid-turn is caught up on what it missed", async () => {
  const { app, sessionId } = await withSession("r-drop");
  app.send({ t: "session.prompt", sessionId, text: "first turn" });
  await app.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "first idle");

  // Everything seen so far, exactly as the app tracks it.
  const cursors = app.cursors();
  expect(cursors[sessionId]).toBeGreaterThanOrEqual(0);

  // The radio dies. Not a negotiated close: the daemon learns nothing, and the
  // turn below runs with nobody listening.
  app.kill();
  const offline = await AppClient.connect(daemon, { deviceId: DEVICE });
  offline.send({ t: "session.prompt", sessionId, text: "second turn, unwatched" });
  await offline.waitFor(
    (f) => f.t === "session.idle" && f.sessionId === sessionId,
    "the unwatched turn ending",
  );
  offline.close();

  // The phone comes back and says where it got to.
  const back = await AppClient.connect(daemon, { deviceId: DEVICE, cursors });
  const replay = await back.waitFor(
    (f) => f.t === "session.replay" && f.sessionId === sessionId,
    "the catch-up",
  );

  expect(replay.catchUp).toBe(true);
  // The events of the turn that ran while the socket was down. Without these
  // the phone resumed silently at the live edge and showed nothing at all until
  // the agent happened to start its next tool.
  expect(replay.events.length).toBeGreaterThan(0);
  expect(Math.min(...replay.events.map((e: { seq: number }) => e.seq))).toBe(
    cursors[sessionId]! + 1,
  );
  back.close();
}, TEST_TIMEOUT);

test("a catch-up says the turn is still running, which no replayed event can", async () => {
  const { app, sessionId } = await withSession("r-working");
  // A turn with tool calls in it, which the echo agent spaces out over several
  // seconds. A one-line reply finishes faster than a socket can be dropped and
  // rebuilt, so racing it would be the flakiest possible way to ask this.
  app.send({ t: "session.prompt", sessionId, text: "run some tools" });
  // Far enough in to have missed something, nowhere near the end.
  await app.waitFor((f) => f.t === "session.event" && f.sessionId === sessionId, "first chunk");
  const cursors = app.cursors();
  app.kill();

  const back = await AppClient.connect(daemon, { deviceId: DEVICE, cursors });
  const replay = await back.waitFor(
    (f) => f.t === "session.replay" && f.sessionId === sessionId,
    "a catch-up for the turn still running",
  );

  // The flag is the whole reason the daemon sends one: `session.idle` is
  // broadcast and never logged, so no amount of replayed history can say
  // whether the turn ended. Without it a phone that blinked mid-turn came back
  // showing a finished conversation and sat there until the agent happened to
  // produce a notification.
  expect(replay.working).toBe(true);
  expect(replay.catchUp).toBe(true);

  // And it really was still running: the turn ends after the reconnect, on the
  // socket that was not there when it started.
  await back.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "the turn ending");
  back.close();
}, 30_000);

test("a finished turn catches up as settled, with no events and nothing pending", async () => {
  const { app, sessionId } = await withSession("r-settled");
  app.send({ t: "session.prompt", sessionId, text: "settle down" });
  await app.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "idle");
  const cursors = app.cursors();
  app.kill();

  const back = await AppClient.connect(daemon, { deviceId: DEVICE, cursors });
  // Silence used to be the answer here, and it cost the one case it could not
  // express: an approval answered at the desk while this phone was away left a
  // sheet up for ever, because "no permissions" was indistinguishable from "an
  // older daemon that never mentions permissions". An empty frame says both
  // things plainly — the turn is over, and there is nothing to approve.
  const frame = (await back.waitFor(
    (f) => f.t === "session.replay" && f.sessionId === sessionId,
    "catch-up",
  )) as { events: unknown[]; working: boolean; permissions: unknown[] };
  expect(frame.events).toEqual([]);
  expect(frame.working).toBe(false);
  expect(frame.permissions).toEqual([]);
  back.close();
}, TEST_TIMEOUT);

test("reconnecting with current cursors replays nothing, so nothing is doubled", async () => {
  const { app, sessionId } = await withSession("r-nodupes");
  app.send({ t: "session.prompt", sessionId, text: "once only" });
  await app.waitFor((f) => f.t === "session.idle" && f.sessionId === sessionId, "idle");
  const cursors = app.cursors();
  const delivered = app.all("session.event").filter((f) => f.sessionId === sessionId).length;
  app.close();

  const back = await AppClient.connect(daemon, { deviceId: DEVICE, cursors });
  await Bun.sleep(400);

  // A replay that resent seen events would duplicate the agent's words on
  // screen, which is the failure the cursor exists to prevent.
  const replayed = back
    .all("session.replay")
    .filter((f) => f.sessionId === sessionId)
    .flatMap((f) => f.events as Array<{ seq: number }>);
  expect(replayed).toEqual([]);
  expect(delivered).toBeGreaterThan(0);
  back.close();
}, TEST_TIMEOUT);

test("a cursor for a session the daemon has never heard of is ignored, not fatal", async () => {
  // A phone holding a cursor for a session from a daemon that has since
  // restarted. Reconnecting must still work: the alternative is an app that
  // cannot get back in until it is reinstalled.
  const back = await AppClient.connect(daemon, {
    deviceId: DEVICE,
    cursors: { "echo-does-not-exist": 40 },
  });

  expect(back.frames.some((f) => f.t === "providers")).toBe(true);
  await back.expectNo((f) => f.t === "session.replay" && f.sessionId === "echo-does-not-exist");
  back.close();
}, TEST_TIMEOUT);

test("a prompt for an unknown session is answered, not swallowed", async () => {
  const app = await AppClient.connect(daemon, { deviceId: DEVICE });

  app.send({ t: "session.prompt", sessionId: "echo-never-existed", text: "anyone there?" });

  // Silence here is what leaves a phone spinning forever with no way back. The
  // reply is the app's cue to stop, whatever it decides to show.
  const answer = await app.waitFor(
    (f) => f.t === "error" || f.t === "session.idle",
    "an answer to a prompt for a session that does not exist",
  );
  expect(answer.t).toBe("error");
  expect(answer.code).toBe("prompt_failed");
  // Names the session rather than failing generically, because the phone shows
  // this text and "something went wrong" is not a thing anyone can act on.
  expect(answer.message).toContain("echo-never-existed");
  app.close();
}, TEST_TIMEOUT);

test("cancelling a turn actually stops the agent, and closes the turn", async () => {
  const { app, sessionId } = await withSession("r-cancel");

  // A turn long enough that finishing it and stopping it are distinguishable.
  // Cancelling a one-line reply proves nothing: it was going to end in
  // milliseconds either way, so the test would pass with the cancel path
  // deleted outright.
  app.send({ t: "session.prompt", sessionId, text: "run some tools" });
  await app.waitFor((f) => f.t === "session.event" && f.sessionId === sessionId, "first chunk");

  const startedAt = Date.now();
  app.send({ t: "session.cancel", sessionId });

  // The turn must close: a session that never announces its end is the stuck
  // pulsing dot from the checklist.
  const idle = await app.waitFor(
    (f) => f.t === "session.idle" && f.sessionId === sessionId,
    "the cancelled turn ending",
  );
  // And close *early*. This turn runs for about five seconds when left alone,
  // so ending within two is the part that says the agent was actually
  // interrupted rather than merely allowed to finish.
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  // Carries where the turn happened, which is what lets a client announce a
  // conversation it is not currently showing — by the time a long turn ends the
  // phone is usually somewhere else, and only this machine knows the path.
  expect(idle.providerId).toBe("echo");
  expect(idle.folder).toBeTruthy();
  app.close();
}, TEST_TIMEOUT);
