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
import { admit, isPairingToken, MIN_PAIRING_TOKEN_LENGTH } from "./admission.js";

interface Env {
  PAIRING: DurableObjectNamespace<PairingRoom>;
}

interface Attachment {
  role: "daemon" | "app";
  deviceId: string;
}

export class PairingRoom extends DurableObject {
  /**
   * Created on first write rather than in the constructor.
   *
   * The constructor runs for *every* room the runtime materialises, including
   * one named by a token nobody has ever paired with — so creating the table
   * there meant any string of 32 hex characters left durable storage behind. A
   * room that never carries an event now leaves nothing at all.
   */
  private schemaReady = false;

  private ensureSchema() {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        at         INTEGER NOT NULL,
        payload    TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    this.schemaReady = true;
  }

  /** Sockets currently attached in the given role. */
  private peers(role: Attachment["role"]): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((peer) => (peer.deserializeAttachment() as Attachment | null)?.role === role);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The rules themselves live in ./admission.ts, where they can be tested
    // without a Workers runtime. The validated role and deviceId come back out,
    // so what gets attached below is what was actually checked.
    const decision = admit({
      role: url.searchParams.get("role"),
      deviceId: url.searchParams.get("deviceId"),
      daemons: this.peers("daemon").length,
      total: this.ctx.getWebSockets().length,
    });
    if (!decision.ok) {
      return new Response(decision.reason, { status: decision.status });
    }

    if (decision.evictDaemons) {
      for (const stale of this.peers("daemon")) {
        try {
          stale.close(1012, "replaced by a newer daemon connection");
        } catch {
          // Already gone; the point was only to not leave it attached.
        }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // acceptWebSocket (not server.accept) is what permits hibernation.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role: decision.role,
      deviceId: decision.deviceId,
    } satisfies Attachment);

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
      this.ensureSchema();
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
      // A room that has never stored an event has no table to read, and creating
      // it here keeps that query from throwing on a first connection.
      this.ensureSchema();
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
      // Deliberately falls through rather than returning: `hello` is also the
      // only signal the daemon gets that an app has joined. The daemon dialled
      // in long before, so without this it never re-announces its providers and
      // the phone shows an empty app list forever.
    }

    // Otherwise relay to the opposite role. Daemons talk to apps, apps to daemons.
    for (const peer of this.peers(from.role === "daemon" ? "app" : "daemon")) {
      peer.send(raw);
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
      // Checked before the token names a Durable Object, because naming one is
      // what brings it into existence — so a value that could never have come
      // from `pew2` must not get that far.
      if (!isPairingToken(token)) {
        return new Response(
          `pairing token must be at least ${MIN_PAIRING_TOKEN_LENGTH} hex characters`,
          { status: 400 },
        );
      }

      const id = env.PAIRING.idFromName(token);
      return env.PAIRING.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
