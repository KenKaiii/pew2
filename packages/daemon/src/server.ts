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
import { handleMessage } from "./handler.js";
import { RelayClient } from "./relay-client.js";
import { hostname } from "node:os";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PEW2_PORT ?? 8787);

// Minted on first run and reused thereafter, so restarting the daemon does not
// unpair the phone.
const pairing = await loadPairing();

// PEW2_EXPERIMENTAL=1 also surfaces test fixtures such as the echo agent.
const daemon = new Daemon(
  { id: "local", name: "this machine" },
  process.env.PEW2_EXPERIMENTAL === "1",
);
const clients = new Set<ServerWebSocket<unknown>>();

/** Broadcast to every connected client, dropping any that have gone away. */
function broadcast(message: unknown) {
  const encoded = JSON.stringify(message);
  for (const client of clients) {
    try {
      client.send(encoded);
    } catch {
      clients.delete(client);
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
      deviceId: hostname(),
      onStatus: (status, detail) =>
        console.log(`[relay] ${status}${detail ? ` — ${detail}` : ""}`),
    })
  : null;

// One fan-out point for both transports. The daemon owns the log precisely so
// that a phone on 5G and a desktop on the LAN see the same conversation.
daemon.attach((message) => {
  broadcast(message);
  relay?.send(message);
});

relay?.start();

const { errors } = await daemon.refreshProviders();
for (const error of errors) console.error(error.message);

function send(ws: ServerWebSocket<unknown>, message: unknown) {
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
      clients.add(ws);
      send(ws, { t: "ready", wire: 1, now: Date.now() });
      // Re-announce so a client that connects later still sees the provider list.
      daemon.refreshProviders();
    },

    close(ws) {
      clients.delete(ws);
    },

    async message(ws, raw) {
      if (typeof raw !== "string") return;

      // Shared with the relay transport, so a message type can never work on
      // one path and not the other.
      await handleMessage(raw, {
        daemon,
        reply: (message) => send(ws, message),
        broadcast: (message) => {
          broadcast(message);
          relay?.send(message);
        },
      });
    },
  },
});

const url = pairingUrl({
  token: pairing.token,
  port: server.port ?? PORT,
  relay: pairing.relay,
});
const qr = await qrCode(url);

console.log(`\npew2 daemon listening on port ${server.port}\n`);
if (qr) console.log(`${qr}\n`);
console.log(`Scan this, or paste into the app:\n  ${url}\n`);
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
