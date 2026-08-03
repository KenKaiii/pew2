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
import type { Daemon } from "./index.js";

export interface RelayClientOptions {
  daemon: Daemon;
  /** Relay origin, e.g. `wss://relay.example.com`. */
  url: string;
  /** The pairing token. Selects the Durable Object both sides meet in. */
  token: string;
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

export class RelayClient {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RelayClientOptions) {}

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

  /** Push a message to the relay. Silently dropped while offline. */
  send(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
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
      // Announce as the daemon and re-send the provider list: the app may have
      // been waiting on the relay long before this machine woke up.
      this.send({ t: "hello", wire: 1, role: "daemon", deviceId: this.options.deviceId });
      this.options.daemon.refreshProviders();
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : null;
      if (raw === null) return;
      void handleMessage(raw, {
        daemon: this.options.daemon,
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
      this.socket = null;
      this.scheduleRetry();
    };
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => this.send({ t: "ping" }), HEARTBEAT_MS);
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
