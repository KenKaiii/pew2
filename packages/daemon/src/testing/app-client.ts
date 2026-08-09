/**
 * A phone, as far as the daemon can tell.
 *
 * Speaks the same handshake `useDaemon.ts` does — cleartext `hello` carrying a
 * sealed proof, everything after it encrypted — so a test can drive the daemon
 * the way the app does and read back exactly what the app would receive. The
 * point is not to re-test the crypto (`channel.test.ts` does that); it is that
 * a scenario written against this client exercises the real transport, so a
 * frame the daemon fails to send, seals wrongly, or sends to the wrong device
 * shows up as a test failure rather than as a phone that will not load.
 *
 * Deliberately not a reimplementation of the app's reducer. This records
 * frames; what the app *does* with them is `replayFold.ts` and its tests. The
 * seam is exactly the wire, which is the part neither side could test alone.
 */
import { SecureChannel, e2e, envelopeHeader, wire } from "@pew2/protocol";
import type { RunningDaemon } from "./daemon-process.js";

/** A frame the daemon sent, after decryption. */
export type Frame = Record<string, any>;

/**
 * How long `waitFor` waits before giving up.
 *
 * Long enough for a real agent to spawn and answer — the echo agent is fast,
 * but a cold `bun run` under a loaded CI box is not — and deliberately shorter
 * than the timeout every test in `e2e.test.ts` declares.
 *
 * That ordering is load-bearing, not tidiness. A test killed by the runner's
 * own timeout takes the shared daemon down with it: the daemon is spawned into
 * the same process group, so it receives the signal and runs its clean shutdown
 * (exit code 0, which is what makes it so puzzling to read). Every later test
 * in the file then fails to connect, and the one real failure is buried under a
 * dozen that mean nothing. Failing here first keeps the daemon alive and the
 * error specific.
 */
const WAIT_TIMEOUT_MS = 8_000;

export interface ClientOptions {
  /**
   * The device this client claims to be.
   *
   * Distinct ids matter: the daemon admits one device per pairing and refuses
   * the second, and `session.started` carries the request id of whichever
   * device asked. A test about two phones that gave them the same id would
   * quietly be a test about one.
   */
  deviceId?: string;
  /** Per-session cursors, as `hello` carries them. Empty on a first connect. */
  cursors?: Record<string, number>;
}

export class AppClient {
  private readonly socket: WebSocket;
  private readonly channel: SecureChannel;
  /** Every decrypted frame, in arrival order. */
  readonly frames: Frame[] = [];
  /** Cleartext frames, which are only ever handshake plumbing. */
  readonly plain: Frame[] = [];
  private waiters: Array<() => void> = [];
  private closedWith?: { code: number; reason: string };

  private constructor(
    socket: WebSocket,
    channel: SecureChannel,
    readonly deviceId: string,
    private readonly daemon: RunningDaemon,
  ) {
    this.socket = socket;
    this.channel = channel;
  }

  /**
   * Connect, prove the pairing, and wait until the daemon has answered.
   *
   * Resolves once `providers` has arrived, which the daemon sends after
   * admitting the device — so a test that gets a client back has a fully joined
   * one, rather than one that might still be mid-handshake.
   */
  static async connect(daemon: RunningDaemon, options: ClientOptions = {}): Promise<AppClient> {
    const deviceId = options.deviceId ?? `test-device-${Math.random().toString(36).slice(2, 10)}`;
    const channel = new SecureChannel(e2e.fromHex(daemon.key), "app");
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/?token=${daemon.token}`);
    const client = new AppClient(socket, channel, deviceId, daemon);

    socket.onmessage = (event) => client.receive(String(event.data));
    socket.onclose = (event) => {
      client.closedWith = { code: event.code, reason: event.reason };
      client.wake();
    };

    await new Promise<void>((resolve, reject) => {
      // A connection failure is almost never about the socket — it is a daemon
      // that crashed a test or two earlier. Reporting that instead turns a
      // suite-wide cascade of "socket failed to open" back into the one error
      // that actually happened.
      const fail = (why: string) => new Error(daemon.died() ?? why);
      const timer = setTimeout(() => reject(fail("socket never opened")), WAIT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(fail(`socket failed to open on port ${daemon.port}`));
      };
    });

    // Cleartext, because it is what establishes the connection, with a sealed
    // proof beside it so the daemon can tell a paired phone from anyone who
    // merely learned the port and token.
    socket.send(
      JSON.stringify({
        t: "hello",
        wire: wire.WIRE_VERSION,
        role: "app",
        deviceId,
        cursors: options.cursors ?? {},
        proof: channel.proof(deviceId),
      }),
    );

    // The daemon announces the installed agents after admitting the device, so
    // this is the first frame that proves the handshake was accepted rather
    // than silently ignored — which is what an unauthenticated socket gets.
    await client.waitFor((frame) => frame.t === "providers");
    return client;
  }

  /** Seal and send, exactly as the app's `post` does. */
  send(message: unknown): void {
    this.socket.send(JSON.stringify(this.channel.seal(message, envelopeHeader(message))));
  }

  /**
   * Wait for a frame matching `predicate`, including ones already received.
   *
   * Searching the backlog first is what makes scenarios readable: a test can
   * send a prompt, await the reply, then await the `session.idle` that arrived
   * while it was awaiting the reply. Requiring frames to be consumed in order
   * would turn every scenario into a state machine of its own.
   */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    what = "frame",
    timeout = WAIT_TIMEOUT_MS,
  ): Promise<Frame> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found) return found;
      if (this.closedWith) {
        throw new Error(
          `socket closed (${this.closedWith.code} ${this.closedWith.reason}) while waiting for ${what}`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          this.daemon.died() ??
            `timed out waiting for ${what}. Received: ${this.summary()}`,
        );
      }
      await this.settled(remaining);
    }
  }

  /**
   * Assert a frame does *not* arrive within a window.
   *
   * The bugs this harness exists for are mostly frames going to the wrong
   * place, so "the other phone was not told" is as much a requirement as "this
   * phone was". Necessarily a timed wait: absence cannot be observed any other
   * way, so the window is kept short and the assertions using it are ones where
   * the frame would arrive immediately if it arrived at all.
   */
  async expectNo(predicate: (frame: Frame) => boolean, within = 400): Promise<void> {
    await Bun.sleep(within);
    const found = this.frames.find(predicate);
    if (found) throw new Error(`did not expect this frame: ${JSON.stringify(found).slice(0, 300)}`);
  }

  /** Every frame of a type, for assertions about how many arrived. */
  all(t: string): Frame[] {
    return this.frames.filter((frame) => frame.t === t);
  }

  /**
   * Drop the socket without a close handshake.
   *
   * `close()` is a negotiated goodbye; a phone losing signal is not. The
   * reconnect path under test is the one a dead radio takes, so this terminates
   * rather than closes where the runtime allows it.
   */
  kill(): void {
    const terminate = (this.socket as { terminate?: () => void }).terminate;
    if (typeof terminate === "function") terminate.call(this.socket);
    else this.socket.close();
  }

  close(): void {
    this.socket.close();
  }

  /** The cursor a reconnect should resume from, as the app tracks it. */
  cursors(): Record<string, number> {
    const seen: Record<string, number> = {};
    for (const frame of this.frames) {
      if (frame.t !== "session.event" || typeof frame.seq !== "number") continue;
      const at = seen[frame.sessionId];
      if (at === undefined || frame.seq > at) seen[frame.sessionId] = frame.seq;
    }
    return seen;
  }

  private receive(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const kind = (frame as { t?: unknown } | null)?.t;
    if (kind !== "e") {
      this.plain.push(frame as Frame);
      this.wake();
      return;
    }
    const opened = this.channel.open(frame);
    // Undecryptable, which for a correctly paired client means a replay or a
    // frame sealed for someone else. Recorded nowhere, exactly as the app
    // ignores it — a test asserting on frame counts should not see it.
    if (opened === undefined) return;
    this.frames.push(opened as Frame);
    this.wake();
  }

  /** Resolve on the next frame or close, or when `ms` elapses. */
  private settled(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve();
      }, Math.min(ms, 50));
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter();
  }

  /** What did arrive, for a timeout message that can be acted on. */
  private summary(): string {
    const counts = new Map<string, number>();
    for (const frame of this.frames) {
      counts.set(String(frame.t), (counts.get(String(frame.t)) ?? 0) + 1);
    }
    const seen = [...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ");
    return seen || "(nothing)";
  }
}
