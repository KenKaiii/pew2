/**
 * Outbound connection to the relay. This is what makes pew2 work from anywhere.
 *
 * The daemon *dials out*, so the user's machine needs no public address, no port
 * forwarding and no hole in their firewall — the same reason a laptop can reach
 * a chat server from a café. The phone dials out too, from whatever mobile
 * network it is on, and the relay's Durable Object is the meeting point.
 *
 * Reconnection is the whole job. A desktop sleeps, a Wi-Fi network changes, a
 * relay deploys: all of these drop the socket, and the user is not there to
 * restart anything. So this reconnects forever, with backoff and jitter, and
 * never gives up — an agent that stops being reachable after one blip is worse
 * than no remote access at all.
 */
import { handleMessage } from "./handler.js";
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";
import type { Daemon } from "./index.js";

export interface RelayClientOptions {
  daemon: Daemon;
  /** Relay origin, e.g. `wss://relay.example.com`. */
  url: string;
  /**
   * The relay room id. Selects the Durable Object both sides meet in.
   *
   * Derived one-way from the pairing key, so handing it to the relay does not
   * hand over the ability to read anything.
   */
  token: string;
  /** The pairing key, hex. Never sent — only used to seal and open frames. */
  key: string;
  /** Stable identity for this machine, so the relay can tell devices apart. */
  deviceId: string;
  cwd?: string;
  onStatus?: (status: RelayStatus, detail?: string) => void;
  /**
   * Also deliver relay-originated broadcasts to locally connected clients.
   *
   * Without this the two transports are one-way mirrors: a phone acting over
   * the relay is invisible to a client on the LAN, even though the daemon
   * owning one log is the entire reason both can watch the same session. It is
   * also what lets `pew2 pair` confirm a phone that arrived from a mobile
   * network rather than the local Wi-Fi.
   */
  onBroadcast?: (message: unknown) => void;
  /**
   * Decide whether a device that has proved it holds the key may connect.
   *
   * Supplied by the daemon so the relay and the LAN socket enforce one rule: a
   * pairing link admits a single device, and a leaked copy of it is refused.
   * Absent in tests that predate the gate, which then admit every prover.
   */
  admitDevice?: (deviceId: string) => { ok: boolean; message?: string };
  /** Injectable for tests. Defaults to the global WebSocket. */
  createSocket?: (url: string) => WebSocket;
}

export type RelayStatus = "connecting" | "online" | "offline";

/** Backoff bounds. One second is fast enough to feel instant after a blip. */
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Ping interval. Long-lived idle WebSockets are silently dropped by NATs and
 * mobile carriers; without traffic the daemon believes it is connected while
 * the phone sees nothing.
 */
const HEARTBEAT_MS = 25_000;

/**
 * The keepalive, in cleartext and byte-for-byte fixed.
 *
 * The relay answers this exact string from the Durable Object's hibernation
 * auto-response, so it never wakes the object at all — see `KEEPALIVE_REQUEST`
 * in `packages/relay/src/index.ts`, which must match this character for
 * character. Sealed it could not be: every frame carries a fresh nonce, so no
 * two pings look alike and the runtime would wake for every one of them.
 *
 * Nothing is given away by sending it in the open. It carries no content, and
 * the relay can already see the timing of every frame that passes through it.
 */
export const KEEPALIVE_FRAME = '{"t":"ping"}';

export class RelayClient {
  private socket: WebSocket | null = null;
  /**
   * Encryption state for the current connection.
   *
   * Rebuilt on every reconnect, because the counters that make replay
   * detectable are only meaningful within one socket: carrying them across a
   * reconnect would make the fresh connection's first frames look like replays.
   */
  private channel: SecureChannel | null = null;
  private attempts = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RelayClientOptions) {}

  /**
   * Point this client at a new pairing and reconnect into its room.
   *
   * `pew2 pair --rotate` mints a new token and writes it to disk, but a daemon
   * that is already running holds the old one — and the relay room is derived
   * from it. Without this the daemon sits in a room the freshly paired phone
   * will never join: the phone shows "connecting" forever, re-pairing makes it
   * worse rather than better, and only a restart clears it.
   */
  rekey(nextToken: string, nextKey: string): void {
    if (nextToken === this.options.token && nextKey === this.options.key) return;
    // Written through a computed key: the fields are readonly to everyone
    // else, and this is the one place allowed to move them.
    const opts = this.options as unknown as Record<string, unknown>;
    opts["token"] = nextToken;
    opts["key"] = nextKey;
    // Straight back out and in: the room id is fixed at connect time, so an
    // open socket cannot be moved to the new one.
    const wasRunning = !this.stopped;
    this.stop();
    if (wasRunning) this.start();
  }

  /** Where this daemon connects. The token never appears in logs. */
  get endpoint(): string {
    const base = this.options.url.replace(/\/$/, "");
    const params = new URLSearchParams({
      pairing: this.options.token,
      role: "daemon",
      deviceId: this.options.deviceId,
    });
    return `${base}/connect?${params}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.socket?.close();
    } catch {
      // Already closed; nothing to do.
    }
    this.socket = null;
  }

  /** Push a sealed message to the relay. Silently dropped while offline. */
  send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.channel) return;
    try {
      this.socket.send(JSON.stringify(this.channel.seal(message, envelopeHeader(message))));
    } catch {
      // A send failing means the socket is already gone; `close` will fire and
      // reconnection will take over.
    }
  }

  get online(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private status(status: RelayStatus, detail?: string) {
    this.options.onStatus?.(status, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    this.status("connecting");

    let socket: WebSocket;
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.endpoint);
    } catch (error) {
      // A malformed URL throws synchronously. Treat it as any other failure so
      // a typo'd relay does not kill the daemon.
      this.scheduleRetry((error as Error).message);
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.status("online");
      this.channel = new SecureChannel(e2e.fromHex(this.options.key), "daemon");
      // `hello` is cleartext because it is what establishes the connection, and
      // carries a sealed proof beside it so the far side can tell a real daemon
      // from anyone who merely learned the room id.
      socket.send(
        JSON.stringify({
          t: "hello",
          wire: wire.WIRE_VERSION,
          role: "daemon",
          deviceId: this.options.deviceId,
          proof: this.channel.proof(this.options.deviceId),
        }),
      );
      // The app may have been waiting on the relay long before this machine woke
      // up, so re-announce rather than assuming it saw the last one.
      //
      // Deliberately not awaited — `onopen` is synchronous and the connection is
      // already usable without it. But the rejection still has to be caught:
      // re-scanning providers touches the disk and spawns probes, and an
      // unhandled rejection here takes down the whole daemon on a transient
      // failure, at the exact moment the user is trying to reconnect.
      void this.options.daemon.refreshProviders().catch(() => {
        // The next refresh picks it up; losing one re-announce is not worth
        // dropping the connection that just came up.
      });
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (raw === null || !this.channel) return;

      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }

      if (typeof frame !== "object" || frame === null) return;
      const kind = (frame as { t?: unknown }).t;

      // An app announcing itself. Cleartext, because it is what establishes the
      // far end of the connection — so it carries a sealed proof beside it, and
      // is worth nothing without one.
      if (kind === "hello") {
        const hello = frame as { wire?: unknown; deviceId?: unknown; proof?: unknown };
        const deviceId = typeof hello.deviceId === "string" ? hello.deviceId : "";

        // Checked first, so a client too old to carry a proof is told to update
        // rather than dismissed as unpaired — different problems, different fixes.
        const mismatch = wire.wireMismatch(hello.wire);
        if (mismatch) {
          socket.send(JSON.stringify({ t: "error", code: "wire-version", message: mismatch }));
          return;
        }
        // A `hello` is a new socket, and the peer's counters restart at zero
        // with it, so the window this channel remembers from the last connection
        // has to be cleared or that first frame reads as a replay — which
        // stranded the app on "getting the list of agents" and left `pew2 pair`
        // waiting for a phone that had already arrived.
        //
        // The proof comes first, and the clearing is only reachable through it.
        // The other order let a cleartext `hello` naming any device wipe that
        // device's replay protection without holding the key at all: whoever
        // knew the relay room id could then replay a captured `session.permission`
        // and re-approve a tool call the user approved once.
        if (!deviceId) return;
        if (!this.channel.verifyProof(hello.proof, deviceId)) return;

        // One pairing, one device. Enforced here as well as on the LAN socket:
        // a leaked link is most useful to an attacker from off the network, so
        // the relay is the path that actually needs this.
        //
        // Decided before the handshake is accepted, so a refused device never
        // gets its replay window cleared — which was the whole reason the proof
        // has to come first. Synchronous by design: this runs inside the socket's
        // message handler, and an await here would let the next frame overtake
        // the handshake it depends on.
        const decision = this.options.admitDevice?.(deviceId);
        if (decision && !decision.ok) {
          // Cleartext, like the version mismatch above and for the same reason:
          // this refusal is what stops the channel being established, so there
          // is no sealed path to send it down. It carries no user content — only
          // that this pairing belongs to another device.
          //
          // Addressed to the device it refuses, because the relay fans cleartext
          // out to every app in the room: only sealed frames are stamped and
          // routed. Unaddressed, this refusal would also land on the phone that
          // legitimately owns the pairing, which treats it as fatal and stops
          // reconnecting — handing an attacker a one-frame way to knock the real
          // device offline with the very gate meant to stop them.
          socket.send(
            JSON.stringify({
              t: "error",
              code: "device-refused",
              deviceId,
              message: decision.message,
            }),
          );
          return;
        }
        this.channel.acceptHandshake(deviceId);

        // The app may have been waiting here long before this machine woke up,
        // so re-announce rather than assume it saw the last list.
        //
        // Caught, like the call in `onopen`. This one was missed when that was
        // fixed, and it is the worse of the two: it runs the moment a phone
        // arrives, so a transient scan failure took the daemon down at exactly
        // the moment someone was watching `pew2 pair` for confirmation.
        void this.options.daemon.refreshProviders().catch(() => {
          // The phone is joined either way; the next refresh carries the list.
        });
        const joined = { t: "device.joined", deviceId, at: Date.now() };
        this.send(joined);
        this.options.onBroadcast?.(joined);
        return;
      }

      // Everything else must be sealed. A cleartext frame from the relay itself
      // — `ready`, or an error — carries nothing this needs to act on.
      if (kind !== "e") return;

      // Partitioned by the sender the relay names, so several phones sharing
      // this one socket do not invalidate each other's counters.
      //
      // Required, not defaulted: the relay stamps every sealed frame with the
      // sending socket's device id, so a frame without one did not come through
      // the path this channel's replay windows describe. Falling back to the
      // unlabelled sender would put it in a window no device ever proved.
      const sender = (frame as { from?: unknown }).from;
      if (typeof sender !== "string" || sender === "") return;
      const message = this.channel.open(frame, sender);
      if (message === undefined) return;

      void handleMessage(JSON.stringify(message), {
        daemon: this.options.daemon,
        // The relay stamps each sealed frame with the sending socket's device
        // id, and `open` above only succeeded because that id's channel state
        // decrypted it — so this is the sender the frame was actually verified
        // against, not a label it chose for itself.
        deviceId: sender,
        // Over the relay there is no per-client socket to reply to: the relay
        // fans out to whichever apps are attached to this pairing. Both paths
        // therefore go back the same way.
        reply: (message) => this.send(message),
        broadcast: (message) => {
          this.send(message);
          this.options.onBroadcast?.(message);
        },
        cwd: this.options.cwd,
      });
    };

    socket.onerror = () => {
      // Errors are always followed by close; retrying here as well would open
      // two sockets for one failure.
    };

    socket.onclose = () => {
      this.clearTimers();
      // Only tear down state that still belongs to *this* socket. `rekey`
      // closes the old one and immediately opens a new one, and `onclose`
      // arrives after that \u2014 so an unconditional reset here would null the new
      // socket and schedule a retry beside it, leaving two connections racing
      // and the relay flapping between online and offline.
      if (this.socket !== socket) return;
      this.socket = null;
      this.channel = null;
      this.scheduleRetry();
    };
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send(KEEPALIVE_FRAME);
      } catch {
        // The socket is already gone; `close` fires and reconnection takes over.
      }
    }, HEARTBEAT_MS);
    // Do not hold the process open for the sake of a keepalive.
    this.heartbeat.unref?.();
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(detail?: string): void {
    if (this.stopped) return;
    this.status("offline", detail);

    // Exponential backoff with jitter. Without jitter, every daemon that lost
    // the same relay deploy reconnects in lockstep and knocks it over again.
    const backoff = Math.min(MIN_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.attempts++;

    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }
}

/** Compute the delay for a given attempt. Exported for testing the curve. */
export function backoffBounds(attempt: number): { min: number; max: number } {
  const backoff = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return { min: backoff / 2, max: backoff };
}
