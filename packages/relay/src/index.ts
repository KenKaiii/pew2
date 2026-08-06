/**
 * pew2 relay — a Cloudflare Worker + Durable Object.
 *
 * One Durable Object per pairing (one user's machines + devices). The DO is the
 * meeting point: the daemon dials out from behind the user's NAT, the phone
 * dials out from a mobile network, and neither needs a public address.
 *
 * Why a Durable Object rather than a normal server: agent sessions are idle
 * almost all the time, and the Hibernation API means idle sockets cost nothing
 * while staying connected.
 *
 * The relay stores nothing. It forwards sealed frames between the two roles and
 * never interprets them: under E2EE a payload is opaque ciphertext, and the one
 * field read off the outside — the sender's device id — is routing metadata
 * stamped on the way past. A room that goes quiet leaves nothing behind.
 */
import { DurableObject } from "cloudflare:workers";
import {
  admit,
  DAEMON_STALE_MS,
  isPairingToken,
  MIN_PAIRING_TOKEN_LENGTH,
} from "./admission.js";

interface Env {
  PAIRING: DurableObjectNamespace<PairingRoom>;
}

interface Attachment {
  role: "daemon" | "app";
  deviceId: string;
  /**
   * When this socket was admitted.
   *
   * The floor for liveness. A daemon that connected ten seconds ago has not
   * sent a keepalive yet, and treating "no keepalive" as "dead" would make
   * every fresh connection instantly evictable.
   */
  connectedAt: number;
  /**
   * When a frame from this socket last reached the object, if one has.
   *
   * The auto-response timestamp is the cheap signal, but it only exists for a
   * peer whose keepalive matches {@link KEEPALIVE_REQUEST} exactly. Daemons
   * older than that pair *sealed* their ping, so every one looked different and
   * none of them ever matched — and judging those on the auto-response alone
   * would have closed a perfectly healthy machine every 90 seconds, forever,
   * for the crime of not having been updated yet.
   *
   * Any frame proves the far end is there. Recording it costs nothing extra
   * because the object is already awake to have received it.
   */
  lastMessageAt?: number;
}

/**
 * The keepalive the runtime answers without waking this object.
 *
 * Both strings must match the daemon's `KEEPALIVE_FRAME` byte for byte
 * (`packages/daemon/src/relay-client.ts`) — the runtime compares the raw
 * message, not its meaning. Without the pair, every ping from every paired
 * machine pulled the Durable Object out of hibernation and billed wall-clock
 * for answering nothing.
 *
 * It doubles as the only liveness signal the relay has. The relay cannot
 * authenticate anyone — it has no key, by design — so "is the daemon in this
 * room still there" is answerable only by when it last spoke.
 */
const KEEPALIVE_REQUEST = '{"t":"ping"}';
const KEEPALIVE_RESPONSE = '{"t":"pong"}';

/**
 * How rarely {@link Attachment.lastMessageAt} is rewritten.
 *
 * Writing it on every frame would put a storage write in front of every message
 * the room carries. This is only ever compared against a 90-second window, so a
 * value up to this stale answers the same question with a fraction of the
 * writes.
 */
const SEEN_WRITE_INTERVAL_MS = 20_000;

/**
 * How often an occupied room looks itself over.
 *
 * Generous on purpose: the sweep exists to stop dead sockets accumulating until
 * a room hits its connection cap and refuses the machines that actually live
 * there, which is a slow failure. Waking every minute to find nothing wrong
 * would cost more than the problem.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000;

export class PairingRoom extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Set here because the constructor is what runs when a hibernated object is
    // brought back — the pair does not survive hibernation on its own.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE_REQUEST, KEEPALIVE_RESPONSE),
    );
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
    const daemons = this.peers("daemon");
    const decision = admit({
      role: url.searchParams.get("role"),
      deviceId: url.searchParams.get("deviceId"),
      daemons: daemons.length,
      total: this.ctx.getWebSockets().length,
      // The most recently alive of them, so one zombie left over from an earlier
      // connection cannot make a working daemon look evictable.
      daemonLastSeen: daemons.reduce<number | null>((newest, peer) => {
        const attachment = peer.deserializeAttachment() as Attachment | null;
        if (!attachment) return newest;
        const seen = this.lastSeen(peer, attachment);
        return newest === null || seen > newest ? seen : newest;
      }, null),
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
      connectedAt: Date.now(),
    } satisfies Attachment);

    server.send(JSON.stringify({ t: "ready", wire: 1, now: Date.now() }));

    await this.scheduleSweep();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * When this socket was last known to be alive.
   *
   * Three sources, newest wins: the hibernation auto-response (free, but only
   * for a peer whose keepalive matches ours exactly), the last frame that
   * actually arrived (covers every other peer, including daemons too old to
   * know about the auto-response pair), and failing both, the moment it
   * connected.
   */
  private lastSeen(ws: WebSocket, attachment: Attachment): number {
    const answered = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(
      answered?.getTime() ?? 0,
      attachment.lastMessageAt ?? 0,
      attachment.connectedAt,
    );
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;

    let message: { t?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ t: "error", code: "bad_json", message: "Message was not valid JSON" }));
      return;
    }

    const from = ws.deserializeAttachment() as Attachment | null;
    if (!from) return;

    // This frame is proof the far end is alive, which matters for a peer whose
    // keepalive the runtime does not recognise. Throttled, so the room does not
    // pay a storage write per message.
    const now = Date.now();
    if (now - (from.lastMessageAt ?? from.connectedAt) > SEEN_WRITE_INTERVAL_MS) {
      ws.serializeAttachment({ ...from, lastMessageAt: now } satisfies Attachment);
    }

    // Every frame is forwarded and none is kept, `hello` included — it is the
    // only signal the daemon gets that an app has joined, and answering it here
    // instead of passing it on meant the machine never re-announced its
    // providers and the phone showed an empty agent list forever.
    //
    // Nothing is written down. This object used to log every sealed frame so a
    // reconnecting client could replay it, which no client ever read: the replay
    // was cleartext, the app discards anything that is not a sealed envelope,
    // and the relay has no key to seal one with. What the log did do was take a
    // row from any admitted socket, with no cap and no expiry.
    //
    // Sealed frames are stamped with the sender's device id on the way past. The
    // daemon has one socket here but many devices behind it, and their replay
    // counters are independent — without something to tell them apart, a second
    // phone's first frame looks like a replay of the first phone's and that phone
    // silently never works.
    //
    // This is routing metadata, not a credential: it grants nothing, and a frame
    // still has to carry a valid tag to be read at all.
    const forwarded =
      message.t === "e" ? JSON.stringify({ ...message, from: from.deviceId }) : raw;
    // Daemons talk to apps, apps to daemons — never an echo to the sender.
    for (const peer of this.peers(from.role === "daemon" ? "app" : "daemon")) {
      peer.send(forwarded);
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string) {
    // With compatibility_date >= 2026-04-07 the runtime auto-replies to Close
    // frames, so no explicit close() is needed here.
  }

  /**
   * A socket that failed rather than closed.
   *
   * Without this handler the runtime has nowhere to deliver the failure and the
   * socket can stay attached — counted against the room's cap, and counted as a
   * live daemon by admission, while nothing is on the other end.
   */
  async webSocketError(ws: WebSocket, _error: unknown) {
    try {
      ws.close(1011, "socket error");
    } catch {
      // Already gone; the point was only to not leave it attached.
    }
  }

  /**
   * Close sockets that are no longer answering, and stop when the room empties.
   *
   * A socket whose far end vanished without a close frame stays attached until
   * the runtime notices, which can be a long time on a mobile network. Sixteen
   * of those and the room refuses the machines that belong in it.
   *
   * Only daemons are judged on silence, because only daemons send keepalives.
   * An app is bounded by the room's connection cap instead.
   */
  async alarm() {
    const now = Date.now();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      if (attachment.role !== "daemon") continue;
      // The same threshold admission uses, deliberately shared rather than
      // restated: if the sweep tolerated more silence than admission does, a
      // socket a newcomer is allowed to evict would never be swept on its own,
      // and the room would sit on a dead daemon until someone tried to replace
      // it.
      if (now - this.lastSeen(ws, attachment) <= DAEMON_STALE_MS) continue;
      try {
        ws.close(1001, "keepalive timed out");
      } catch {
        // Already gone; the point was only to not leave it attached.
      }
    }

    if (this.ctx.getWebSockets().length === 0) {
      // Nobody left, so nothing to sweep and no alarm to reschedule.
      //
      // The one thing worth doing on the way out is dropping the event table an
      // earlier version of this object created. Rooms that ran that version are
      // still holding those rows, and they are billed storage for a log nothing
      // reads. `IF EXISTS` makes this a no-op everywhere else.
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS events`);
      return;
    }

    await this.scheduleSweep();
  }

  /**
   * Keep the sweep running while anyone is here, and let it stop when nobody
   * is.
   *
   * An empty room that kept rescheduling would wake forever for a pairing
   * nobody uses any more — the exact cost hibernation exists to avoid.
   */
  private async scheduleSweep(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
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
