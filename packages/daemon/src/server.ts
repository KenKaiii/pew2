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
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PEW2_PORT ?? 8787);

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

daemon.attach(broadcast);

const { errors } = await daemon.refreshProviders();
for (const error of errors) console.error(error.message);

function send(ws: ServerWebSocket<unknown>, message: unknown) {
  ws.send(JSON.stringify(message));
}

function fail(ws: ServerWebSocket<unknown>, code: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${code}] ${message}`);
  send(ws, { t: "error", code, message });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",

  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
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

      let message: {
        t?: string;
        providerId?: string;
        cwd?: string;
        sessionId?: string;
        text?: string;
        requestId?: string;
        optionId?: string;
        configId?: string;
        value?: string | boolean;
      };
      try {
        message = JSON.parse(raw);
      } catch {
        return fail(ws, "bad_json", "Message was not valid JSON");
      }

      try {
        switch (message.t) {
          case "hello":
            // Handshake. The provider list is pushed on connect, so there is
            // nothing to do beyond accepting it.
            break;

          case "session.start": {
            if (!message.providerId) throw new Error("providerId required");
            const sessionId = await daemon.startSession(
              message.providerId,
              message.cwd ?? process.cwd(),
            );
            broadcast({
              t: "session.started",
              sessionId,
              providerId: message.providerId,
              // Models and thinking levels come from the agent itself, so a
              // newly connected app brings its own without any mapping here.
              configOptions: daemon.configOptions(sessionId),
            });
            break;
          }
          case "session.prompt": {
            if (!message.sessionId || message.text === undefined) {
              throw new Error("sessionId and text required");
            }
            // Deliberately not awaited: a turn can run for minutes, and the
            // client is driven by streamed events rather than this reply.
            const sessionId = message.sessionId;
            daemon
              .prompt(sessionId, message.text)
              .catch((error) => fail(ws, "prompt_failed", error))
              // Tell every client the turn is over, so they can stop showing a
              // working indicator. Broadcast, not reply: other devices watching
              // this session need it too.
              .finally(() => broadcast({ t: "session.idle", sessionId }));
            break;
          }
          case "session.cancel": {
            if (!message.sessionId) throw new Error("sessionId required");
            await daemon.cancel(message.sessionId);
            break;
          }
          case "session.config": {
            if (!message.sessionId || !message.configId || message.value === undefined) {
              throw new Error("sessionId, configId and value required");
            }
            broadcast({
              t: "session.config",
              sessionId: message.sessionId,
              configOptions: await daemon.setConfigOption(
                message.sessionId,
                message.configId,
                message.value,
              ),
            });
            break;
          }

          case "session.permission": {
            if (!message.sessionId || !message.requestId || !message.optionId) {
              throw new Error("sessionId, requestId and optionId required");
            }
            daemon.answerPermission(message.sessionId, message.requestId, message.optionId);
            break;
          }
          default:
            throw new Error(`Unknown message type '${message.t}'`);
        }
      } catch (error) {
        fail(ws, "command_failed", error);
      }
    },
  },
});

console.log(`pew2 daemon listening on ws://localhost:${server.port}`);

// A misbehaving agent process must never take the daemon down with it; every
// client would lose its session.
process.on("uncaughtException", (error) => console.error("[uncaught]", error));
process.on("unhandledRejection", (error) => console.error("[unhandled]", error));

process.on("SIGINT", () => {
  daemon.closeAll();
  process.exit(0);
});
