/**
 * pew2 relay — a Cloudflare Worker + Durable Object.
 *
 * One Durable Object per pairing (one user's machines + devices). The DO is the
 * meeting point: the daemon dials out from behind the user's NAT, the phone
 * dials out from a mobile network, and neither needs a public address.
 *
 * Why a Durable Object rather than a normal server: agent sessions are idle
 * almost all the time, and the Hibernation API means idle sockets cost nothing
 * while staying connected. A DO also has SQLite built in, so the session event
 * log lives inside the object — no separate database.
 *
 * The relay never interprets `payload`. Under E2EE it is an opaque ciphertext
 * blob; the relay only orders it and hands it on.
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
  PAIRING: DurableObjectNamespace<PairingRoom>;
}

interface Attachment {
  role: "daemon" | "app";
  deviceId: string;
}

/**
 * The pairing token is the room key: anyone presenting it joins the room and
 * sees its traffic. Enforce enough entropy that a token cannot be guessed or
 * typed by hand. Generate with `crypto.randomUUID()` twice, or 32 random hex
 * chars — never a human-chosen string.
 *
 * This is a floor, not authentication. Before shipping to real users this must
 * be paired with end-to-end encryption, so that a leaked token exposes only
 * ciphertext the relay itself cannot read.
 */
const MIN_PAIRING_TOKEN_LENGTH = 32;

export class PairingRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep constructor work minimal: it runs again on every wake from hibernation.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          session_id TEXT NOT NULL,
          seq        INTEGER NOT NULL,
          at         INTEGER NOT NULL,
          payload    TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)
        );
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const deviceId = url.searchParams.get("deviceId");

    if (role !== "daemon" && role !== "app") {
      return new Response("role must be 'daemon' or 'app'", { status: 400 });
    }
    if (!deviceId) return new Response("deviceId required", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // acceptWebSocket (not server.accept) is what permits hibernation.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, deviceId } satisfies Attachment);

    server.send(JSON.stringify({ t: "ready", wire: 1, now: Date.now() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;

    let message: { t?: string; sessionId?: string; seq?: number; at?: number; cursors?: Record<string, number> };
    try {
      message = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ t: "error", code: "bad_json", message: "Message was not valid JSON" }));
      return;
    }

    const from = ws.deserializeAttachment() as Attachment | null;
    if (!from) return;

    // Persist session events so a client that reconnects can be caught up.
    if (message.t === "session.event" && message.sessionId && typeof message.seq === "number") {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO events (session_id, seq, at, payload) VALUES (?, ?, ?, ?)`,
        message.sessionId,
        message.seq,
        message.at ?? Date.now(),
        raw,
      );
    }

    // A client announcing its cursors gets everything it missed, in order.
    if (message.t === "hello" && message.cursors) {
      for (const [sessionId, cursor] of Object.entries(message.cursors)) {
        const rows = this.ctx.storage.sql
          .exec<{ payload: string }>(
            `SELECT payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC`,
            sessionId,
            cursor,
          )
          .toArray();
        if (rows.length > 0) {
          ws.send(
            JSON.stringify({
              t: "session.replay",
              sessionId,
              events: rows.map((r) => JSON.parse(r.payload)),
            }),
          );
        }
      }
      return;
    }

    // Otherwise relay to the opposite role. Daemons talk to apps, apps to daemons.
    const target = from.role === "daemon" ? "app" : "daemon";
    for (const peer of this.ctx.getWebSockets()) {
      const attachment = peer.deserializeAttachment() as Attachment | null;
      if (attachment?.role === target) peer.send(raw);
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string) {
    // With compatibility_date >= 2026-04-07 the runtime auto-replies to Close
    // frames, so no explicit close() is needed here.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      // The pairing token maps phone and desktop onto the same Durable Object.
      const token = url.searchParams.get("pairing");
      if (!token) return new Response("pairing token required", { status: 400 });
      if (token.length < MIN_PAIRING_TOKEN_LENGTH) {
        return new Response(
          `pairing token must be at least ${MIN_PAIRING_TOKEN_LENGTH} characters`,
          { status: 400 },
        );
      }

      const id = env.PAIRING.idFromName(token);
      return env.PAIRING.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
