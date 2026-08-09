#!/usr/bin/env bun
/**
 * Local WebSocket server for the daemon.
 *
 * This is the direct phone <-> daemon path used in development: the simulator
 * talks to the daemon on localhost, so no relay and no cloud account is needed
 * to see the whole pipeline working. The relay (packages/relay) is the same
 * envelope over the public internet for real remote use.
 *
 * It is also the fan-out point in practice: every connected client receives
 * every session event, which is what lets a phone and a desktop watch the same
 * conversation at once.
 */
import { Daemon } from "./index.js";
import { claimPairing, loadPairing, pairingPath, pairingUrl, qrCode, tokenMatches } from "./pairing.js";
import { watchPairing } from "./pairing-watch.js";
import { decideClaim, type ClaimDecision } from "./device-claim.js";
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";
import { handleMessage } from "./handler.js";
import { RelayClient } from "./relay-client.js";
import { hostname } from "node:os";
import { daemonLogPaths, rotateLog } from "./logs.js";
import { sweepOrphans } from "./children.js";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PEW2_PORT ?? 8787);

// Under launchd this process's stdout is an append-only file that nothing else
// ever trims. Startup is the one moment it can be resized safely, so it is done
// here, before anything is written.
const rotations = await Promise.all(daemonLogPaths().map((path) => rotateLog(path)));
const trimmed = rotations.reduce((total, r) => total + (r.rotated ? r.before - r.after : 0), 0);

// Agents left behind by a daemon that died without running its shutdown
// handler. Nothing inside a SIGKILL'd process can clean up after itself, so the
// next start does it: children of daemons that are still running are untouched.
const reaped = await sweepOrphans();
if (reaped.length > 0) {
  console.log(`[children] reaped ${reaped.length} orphaned agent(s) from a previous daemon`);
}

// Minted on first run and reused thereafter, so restarting the daemon does not
// unpair the phone.
const pairing = await loadPairing();

// PEW2_EXPERIMENTAL=1 also surfaces test fixtures such as the echo agent.
const daemon = new Daemon(
  { id: "local", name: "this machine" },
  process.env.PEW2_EXPERIMENTAL === "1",
);
/**
 * The pairing key, as bytes.
 *
 * `loadPairing` always mints one, so its absence means a pairing file was
 * hand-edited or written by a build from before encryption existed. Refusing to
 * start is the point: the alternative is a daemon that quietly serves plaintext,
 * which is exactly the downgrade this is meant to remove.
 */
if (!pairing.key) {
  console.error("This pairing has no encryption key. Run `pew2 pair --rotate` and pair again.");
  process.exit(1);
}
// Both transports read the pairing through these rather than closing over the
// values loaded at startup, because `pew2 pair --rotate` changes them while the
// daemon is running. See `watchPairing` at the bottom of this file.
let currentToken = pairing.token;
let rootKey = e2e.fromHex(pairing.key);
// The device this pairing belongs to, once one has claimed it. Held here for
// the same reason as the two above: a rotation clears it while the daemon runs.
let claimedBy = pairing.claimedBy;

/**
 * Admit a device that has already proved it holds the key, claiming the pairing
 * for it if nothing has yet.
 *
 * Both transports go through here. Two copies of this rule would mean the LAN
 * socket and the relay could disagree about who owns a pairing, and only the
 * more permissive one would matter.
 */
function admitDevice(deviceId: string): ClaimDecision {
  const decision = decideClaim(claimedBy, deviceId);
  if (!decision.ok) {
    console.error(`[pairing] refused '${deviceId}': already claimed by '${claimedBy}'`);
    return decision;
  }
  if (decision.claim) {
    // The in-memory value is the authority for this process, and it is set
    // synchronously: both transports decide against it inside one turn of the
    // event loop, so two devices racing the same unclaimed pairing cannot both
    // be admitted. The disk write only has to survive a restart.
    claimedBy = decision.claim;
    void claimPairing(decision.claim).catch((error: unknown) => {
      console.error("[pairing] could not persist the device claim:", error);
    });
    console.error(`[pairing] claimed by '${deviceId}' — this link now admits only that device`);
  }
  return decision;
}

/**
 * One connection's encryption state.
 *
 * Per socket, never shared: the counters that make replay detectable are only
 * meaningful within a single connection, and two sockets sharing them would read
 * each other's traffic as replays.
 */
interface Client {
  channel: SecureChannel;
  /** True once a valid `hello` proof has arrived. */
  authenticated: boolean;
  /**
   * The device this socket proved itself as.
   *
   * Kept so inbound frames are opened under the sender the channel verified,
   * rather than the unlabelled default — which is the shape of the bug the
   * relay transport had.
   */
  deviceId?: string;
}

const clients = new Map<ServerWebSocket<unknown>, Client>();

/**
 * Broadcast to every connected client, dropping any that have gone away.
 *
 * Sealed once per socket rather than once overall: each connection has its own
 * counter, and reusing one frame across sockets would make the second and later
 * recipients read it as a replay.
 *
 * Only authenticated clients are written to. An unauthenticated socket has not
 * proved it holds the key, so sending it session traffic would leak the fact and
 * shape of a conversation to whoever opened it.
 */
function broadcast(message: unknown, header: { sid?: string; seq?: number } = {}) {
  for (const [ws, client] of clients) {
    if (!client.authenticated) continue;
    try {
      ws.send(JSON.stringify(client.channel.seal(message, header)));
    } catch {
      clients.delete(ws);
    }
  }
}

/**
 * Outbound relay connection, when one is configured.
 *
 * This is what lifts pew2 off the local network: the daemon dials out, so the
 * phone can be on a mobile network on the other side of the world and still
 * reach this machine. Without it, pairing only works on the same Wi-Fi.
 */
const relay = pairing.relay
  ? new RelayClient({
      daemon,
      url: pairing.relay,
      token: pairing.token,
      key: pairing.key,
      deviceId: hostname(),
      // Relay traffic is fanned out locally too, so a desktop client and a
      // phone on 5G genuinely see the same conversation.
      onBroadcast: (message) => broadcast(message),
      // The same single-device rule the LAN socket enforces. The relay is the
      // path a leaked link is actually usable from, so leaving it ungated would
      // make the gate decorative.
      admitDevice,
      onStatus: (status, detail) =>
        console.log(`[relay] ${status}${detail ? ` — ${detail}` : ""}`),
    })
  : null;

// One fan-out point for both transports. The daemon owns the log precisely so
// that a phone on 5G and a desktop on the LAN see the same conversation.
daemon.attach((message) => {
  broadcast(message, envelopeHeader(message));
  relay?.send(message);
});

relay?.start();

const { errors } = await daemon.refreshProviders();
for (const error of errors) console.error(error.message);

/** Send one sealed message to one client. */
function send(ws: ServerWebSocket<unknown>, message: unknown) {
  const client = clients.get(ws);
  if (!client) return;
  ws.send(JSON.stringify(client.channel.seal(message, envelopeHeader(message))));
}

/** Send one cleartext frame. Only for handshake plumbing carrying no content. */
function sendPlain(ws: ServerWebSocket<unknown>, message: unknown) {
  ws.send(JSON.stringify(message));
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(request, server) {
    const url = new URL(request.url);

    // Unauthenticated on purpose: `doctor` uses it to tell "not running" from
    // "running but unpaired", and it reveals nothing.
    if (url.pathname === "/health") return Response.json({ ok: true });

    // The token is the only thing standing between the open network and every
    // agent on this machine, so it is checked before the upgrade rather than in
    // the first message: an unpaired socket is never established at all.
    if (!tokenMatches(currentToken, url.searchParams.get("token"))) {
      console.error(`[pairing] rejected connection from ${server.requestIP(request)?.address ?? "unknown"}`);
      return new Response("pairing token required", { status: 401 });
    }

    if (server.upgrade(request)) return undefined;
    return new Response("expected websocket upgrade", { status: 426 });
  },

  websocket: {
    open(ws) {
      clients.set(ws, { channel: new SecureChannel(rootKey, "daemon"), authenticated: false });
      // Cleartext, and one of the few frames that can be: it carries no content,
      // and the client has not proved it can decrypt anything yet.
      sendPlain(ws, { t: "ready", wire: wire.WIRE_VERSION, now: Date.now() });
    },

    close(ws) {
      clients.delete(ws);
    },

    async message(ws, raw) {
      if (typeof raw !== "string") return;

      const client = clients.get(ws);
      if (!client) return;

      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      // `hello` arrives in cleartext because it is what establishes the
      // connection. Everything after it must be sealed.
      if (typeof frame === "object" && frame !== null && (frame as { t?: unknown }).t === "hello") {
        const hello = frame as {
          wire?: unknown;
          deviceId?: unknown;
          proof?: unknown;
          cursors?: unknown;
        };

        // Checked before the proof, so a client too old to *have* a proof is
        // told to update rather than silently refused as unauthenticated.
        const mismatch = wire.wireMismatch(hello.wire);
        if (mismatch) {
          sendPlain(ws, { t: "error", code: "wire-version", message: mismatch });
          ws.close(1002, "protocol version");
          return;
        }

        const deviceId = typeof hello.deviceId === "string" ? hello.deviceId : "";
        if (!deviceId || !client.channel.verifyProof(hello.proof, deviceId)) {
          sendPlain(ws, {
            t: "error",
            code: "unpaired",
            message: "This device is not paired with this machine. Run `pew2 pair` and scan again.",
          });
          ws.close(1008, "unpaired");
          return;
        }

        // A pairing link admits one device. Checked after the proof so a
        // stranger without the key is refused as unpaired and never learns
        // whether this pairing is claimed — that answer is only for someone who
        // already holds the key, which a leaked link does give them.
        const decision = admitDevice(deviceId);
        if (!decision.ok) {
          // Named, though this socket serves one device and needs no routing.
          // The relay path must address its refusals or they reach the phone
          // that owns the pairing, and a frame that means the same thing on both
          // transports should not have two shapes.
          sendPlain(ws, {
            t: "error",
            code: "device-refused",
            deviceId,
            message: decision.message,
          });
          ws.close(1008, "device refused");
          return;
        }

        client.authenticated = true;
        client.deviceId = deviceId;
        // Admits this device on the channel and lets its counters start from
        // zero. Same call as the relay transport makes, so one rule covers both:
        // a sealed frame is only read from a sender that proved it holds the key.
        client.channel.acceptHandshake(deviceId);
        // Confirmed first, and not behind the provider scan.
        //
        // `refreshProviders` reads every manifest off disk, which is slow on a
        // cold cache and can throw outright on an unreadable file. Awaiting it
        // here meant the phone was fully joined while `pew2 pair` still showed
        // "waiting for your phone" \u2014 and if the scan threw, that confirmation
        // never arrived at all. The join is a fact the moment the proof checks
        // out; the agent list is a separate thing that follows.
        broadcast({ t: "device.joined", deviceId, at: Date.now() });

        // Everything this client missed while its socket was down, before the
        // provider scan: a turn running right now is the thing it is waiting to
        // see, and `refreshProviders` touches the disk.
        for (const catchUp of daemon.catchUp(wire.readCursors(hello.cursors))) send(ws, catchUp);

        // Announced only now: the provider list names every agent installed on
        // this machine, which is not something to hand to an unproven socket.
        await daemon.refreshProviders().catch((error: unknown) => {
          console.error("[providers] refresh on join failed:", error);
          return { errors: [] };
        });
        return;
      }

      // Anything else must be a sealed frame from an authenticated peer. An
      // unauthenticated socket is ignored entirely rather than answered, so it
      // learns nothing from what it does or does not get back.
      if (!client.authenticated || !client.deviceId) return;
      // The device this socket actually proved itself as — not the default, which
      // would open a window nothing was verified against.
      const message = client.channel.open(frame, client.deviceId);
      if (message === undefined) return;

      // Shared with the relay transport, so a message type can never work on
      // one path and not the other.
      await handleMessage(JSON.stringify(message), {
        daemon,
        deviceId: client.deviceId,
        reply: (reply) => send(ws, reply),
        broadcast: (event) => {
          broadcast(event, envelopeHeader(event));
          relay?.send(event);
        },
      });
    },
  },
});

const url = pairingUrl({
  token: pairing.token,
  key: pairing.key,
  port: server.port ?? PORT,
  relay: pairing.relay,
});
// Drawn only for a human at a terminal. Under launchd stdout is a log file, and
// writing a 27-line block of colour escapes there on every restart was both the
// bulk of the log's growth and a copy of the pairing token in plain text on
// disk. Four modules of quiet zone when it is drawn, because this banner is
// scanned by a phone camera exactly as `pew2 pair` is.
const interactive = Boolean(process.stdout.isTTY);
const qr = interactive ? await qrCode(url, 4) : undefined;

console.log(`\npew2 daemon listening on port ${server.port}\n`);
if (trimmed > 0) console.log(`[logs] trimmed ${Math.round(trimmed / 1024)}KB of old log\n`);
if (qr) console.log(`${qr}\n`);
// The URL carries the token, so it follows the QR: shown to whoever ran this,
// withheld from the log file. `pew2 pair` is where it belongs either way.
console.log(interactive ? `Scan this, or paste into the app:\n  ${url}\n` : `Pair with: pew2 pair\n`);
console.log(
  pairing.relay
    ? `Works from anywhere via ${pairing.relay}\n`
    : `Same network only. For anywhere: pew2 relay <url>\n`,
);

// `pew2 pair --rotate` rewrites this file while the daemon is running. Watching
// it is what stops a rotation from stranding the daemon in the old relay room,
// where the newly paired phone can never reach it.
const stopWatching = watchPairing(pairingPath(), pairing, () => loadPairing(), {
  onPairing: (next) => {
    // Decoded first. `loadPairing` only checks the key's length, so a
    // hand-edited file can hold 64 non-hex characters and throw here — and
    // assigning the token before that throw would leave the daemon accepting a
    // token it has no matching key for, which is worse than not rotating.
    const decoded = e2e.fromHex(next.key!);
    currentToken = next.token;
    rootKey = decoded;
    // A rotation mints an unclaimed pairing, so the next device to arrive takes
    // it. Not carried over: the point of rotating is to hand the pairing to a
    // different phone.
    claimedBy = next.claimedBy;
  },
  disconnectClients: () => {
    // Sealed with the previous key, so they cannot be carried across. The app
    // reconnects by itself and the new pairing takes effect on the next socket.
    for (const [ws] of clients) {
      try {
        ws.close(1012, "pairing rotated");
      } catch {
        // Already gone.
      }
    }
    clients.clear();
  },
  rekeyRelay: relay ? (token, key) => relay.rekey(token, key) : undefined,
  log: (message) => console.log(message),
});

// A misbehaving agent process must never take the daemon down with it; every
// client would lose its session.
process.on("uncaughtException", (error) => console.error("[uncaught]", error));
process.on("unhandledRejection", (error) => console.error("[unhandled]", error));

/**
 * Shut down without leaving agents behind.
 *
 * SIGTERM matters more than SIGINT here and was missing: `launchctl` stops and
 * restarts a service with SIGTERM, so every restart orphaned every agent this
 * daemon had spawned. They reparent to launchd and run forever — a day of
 * ordinary restarts left 33 of them holding 2.3GB, and nothing on screen said
 * so. SIGHUP is included for a terminal that closes on a foreground run.
 */
function shutdown() {
  stopWatching();
  relay?.stop();
  daemon.closeAll();
  // `closeAll` asks each agent to exit; this is the half-second it gets to do
  // so before the process ends and `children.ts`'s exit hook kills whatever is
  // still up. The delay is what makes that a backstop rather than the normal
  // path: an agent mid-write deserves the chance to finish. Safe to wait —
  // launchd allows 20s, and a terminal will not notice half a second.
  setTimeout(() => process.exit(0), 500);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, shutdown);
}
