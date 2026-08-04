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
import { loadPairing, pairingUrl, qrCode, tokenMatches } from "./pairing.js";
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";
import { handleMessage } from "./handler.js";
import { RelayClient } from "./relay-client.js";
import { hostname } from "node:os";
import { daemonLogPaths, rotateLog } from "./logs.js";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PEW2_PORT ?? 8787);

// Under launchd this process's stdout is an append-only file that nothing else
// ever trims. Startup is the one moment it can be resized safely, so it is done
// here, before anything is written.
const rotations = await Promise.all(daemonLogPaths().map((path) => rotateLog(path)));
const trimmed = rotations.reduce((total, r) => total + (r.rotated ? r.before - r.after : 0), 0);

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
const rootKey = e2e.fromHex(pairing.key);

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
    if (!tokenMatches(pairing.token, url.searchParams.get("token"))) {
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
        const hello = frame as { wire?: unknown; deviceId?: unknown; proof?: unknown };

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

        client.authenticated = true;
        // Announced only now: the provider list names every agent installed on
        // this machine, which is not something to hand to an unproven socket.
        await daemon.refreshProviders();
        broadcast({ t: "device.joined", deviceId, at: Date.now() });
        return;
      }

      // Anything else must be a sealed frame from an authenticated peer. An
      // unauthenticated socket is ignored entirely rather than answered, so it
      // learns nothing from what it does or does not get back.
      if (!client.authenticated) return;
      const message = client.channel.open(frame);
      if (message === undefined) return;

      // Shared with the relay transport, so a message type can never work on
      // one path and not the other.
      await handleMessage(JSON.stringify(message), {
        daemon,
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

// A misbehaving agent process must never take the daemon down with it; every
// client would lose its session.
process.on("uncaughtException", (error) => console.error("[uncaught]", error));
process.on("unhandledRejection", (error) => console.error("[unhandled]", error));

process.on("SIGINT", () => {
  relay?.stop();
  daemon.closeAll();
  process.exit(0);
});
