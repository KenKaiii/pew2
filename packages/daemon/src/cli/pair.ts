/**
 * `pew2 pair` — the one screen a new user sees before anything works.
 *
 * It does three things the old version did not, in ascending order of how much
 * support time they save:
 *
 *   1. It *verifies* rather than asserts. "Works from anywhere" is printed only
 *      after the relay has answered a health check, because a confident status
 *      line next to a dead relay sends the user to debug their phone.
 *   2. It waits, and says so. The moment a device attaches — over the LAN or
 *      through the relay, on the far side of the world — the spinner resolves
 *      into a confirmation. "Did that work?" is the question this command
 *      existed to leave unanswered.
 *   3. It stays useful when it is not a terminal. `--json` is unchanged, the
 *      animation degrades to plain lines, and every colour and glyph is
 *      decoration over words that already say the same thing.
 *
 * Waiting is not required for pairing to succeed: the QR is valid the instant
 * it is printed, and `--no-wait` or Ctrl-C leaves it that way.
 */
import { hostname } from "node:os";
import { daemonPort, daemonUrl } from "./doctor.js";
import { lanAddresses, loadPairing, pairingUrl, qrCode, rotatePairing } from "../pairing.js";
import {
  PALETTE,
  colorLevel,
  copyToClipboard,
  glyphs,
  onKeypress,
  statusLine,
  styler,
  terminalWidth,
  unicodeOk,
} from "./ui.js";
import {
  hintLine,
  pairedLine,
  renderPair,
  timeoutLines,
  waitingLabel,
  type PairView,
  type Reach,
} from "./pair-view.js";

/** How long to watch for a phone before letting the shell have its prompt back. */
const WAIT_MS = 180_000;
/** A relay that has not answered in this long is not going to carry a pairing. */
const HEALTH_TIMEOUT_MS = 4_000;

/** Narrow enough that a test can supply one without restating `fetch`. */
export type Probe = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;

/** Ask a relay whether it is alive. */
export async function checkRelay(origin: string, fetchImpl: Probe = fetch): Promise<boolean> {
  const url = `${origin.replace(/\/$/, "").replace(/^ws/, "http")}/health`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    // Offline, DNS failure, TLS failure, timeout: from the user's point of view
    // these are one fact — the relay cannot be reached from here.
    return false;
  }
}

async function checkDaemon(fetchImpl: Probe = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${daemonUrl()}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Which of the three reach states this machine is actually in. */
export function reachOf(
  relayHealthy: boolean | null,
  hasRelay: boolean,
  addresses: string[],
): Reach {
  if (hasRelay) return relayHealthy === false ? "unreachable" : "anywhere";
  return addresses.length > 0 ? "local" : "unreachable";
}

export interface WaitResult {
  deviceId: string;
  elapsedMs: number;
}

/**
 * Watch the daemon for a device attaching.
 *
 * The CLI connects as an ordinary local client, which is why this works for a
 * phone on a mobile network too: the daemon announces `device.joined` on every
 * transport it is attached to, so a relay-side arrival reaches this socket.
 *
 * Deliberately silent about failure. Not being able to watch is not a pairing
 * problem, and the QR above is valid either way.
 */
export function waitForDevice(options: {
  url: string;
  timeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
  signal?: AbortSignal;
}): Promise<WaitResult | null> {
  const started = Date.now();

  return new Promise((resolve) => {
    let socket: WebSocket | null = null;
    let settled = false;

    const finish = (result: WaitResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      resolve(result);
    };

    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? WAIT_MS);
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      socket = (options.createSocket ?? ((url) => new WebSocket(url)))(options.url);
    } catch {
      finish(null);
      return;
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as { t?: string; deviceId?: string };
        if (message.t !== "device.joined") return;
        // This socket deliberately never sends `hello`, so it does not announce
        // itself and should never see its own id here. The guard costs nothing
        // and means the day that changes, the command does not congratulate the
        // user on pairing with the machine they are already sitting at.
        if (message.deviceId === cliDeviceId()) return;
        finish({ deviceId: message.deviceId ?? "a device", elapsedMs: Date.now() - started });
      } catch {
        // Not our message.
      }
    };

    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

/** Stable, obviously-not-a-phone identity for the watching socket. */
export function cliDeviceId(): string {
  return `pew2-cli@${hostname()}`;
}

/** Human-facing device name. Ids are opaque; this is the part worth reading. */
export function deviceLabel(deviceId: string): string {
  const trimmed = deviceId.trim();
  if (!trimmed) return "a device";
  // Relay device ids are frequently `<name>-<uuid>`; the uuid is noise here.
  return trimmed.replace(/[-_]?[0-9a-f]{8}-[0-9a-f-]{20,}$/i, "") || trimmed;
}

export interface PairOptions {
  json?: boolean;
  rotate?: boolean;
  wait?: boolean;
}

export async function cmdPair(flags: Set<string>): Promise<number> {
  const options: PairOptions = {
    json: flags.has("--json"),
    rotate: flags.has("--rotate"),
    wait: !flags.has("--no-wait"),
  };

  const pairing = options.rotate ? await rotatePairing() : await loadPairing();
  const port = daemonPort();
  const addresses = lanAddresses();
  const url = pairingUrl({ token: pairing.token, port, relay: pairing.relay });

  // Both probes are independent and both are slow enough to notice. Running
  // them together keeps the QR on screen in well under a second.
  const [daemonRunning, relayHealthy] = await Promise.all([
    checkDaemon(),
    pairing.relay ? checkRelay(pairing.relay) : Promise.resolve(null),
  ]);

  const reach = reachOf(relayHealthy, Boolean(pairing.relay), addresses);

  if (options.json) {
    // Unchanged contract: an agent driving setup reads this, and the token is
    // included because handing it to the user is the whole job.
    console.log(
      JSON.stringify(
        {
          url,
          token: pairing.token,
          port,
          addresses,
          relay: pairing.relay ?? null,
          relayHealthy,
          daemonRunning,
          remote: reach === "anywhere",
          reach,
        },
        null,
        2,
      ),
    );
    return reach === "unreachable" ? 1 : 0;
  }

  const view: PairView = {
    url,
    token: pairing.token,
    createdAt: pairing.createdAt,
    reach,
    relay: pairing.relay ? { url: pairing.relay, healthy: relayHealthy } : undefined,
    addresses,
    port,
    daemonRunning,
    rotated: Boolean(options.rotate),
  };

  const style = styler(colorLevel());
  const glyph = glyphs(unicodeOk());
  const columns = terminalWidth();
  const render = { style, glyph, columns };

  const qr = await qrCode(url, 4);
  for (const line of renderPair(view, qr, render)) console.log(line);

  if (!options.wait || !daemonRunning) {
    if (!daemonRunning) {
      console.log("");
      console.log(
        `  ${style.hex(PALETTE.danger, glyph.cross)} ${style.dim("start the daemon before scanning:")} ${style.bold("pew2 service install")}`,
      );
    }
    console.log("");
    return reach === "unreachable" ? 1 : 0;
  }

  return waitInteractively(view, render);
}

/**
 * The live half of the screen: a spinner that resolves the moment a device
 * attaches, plus the two keys worth having while staring at a QR code.
 */
async function waitInteractively(
  view: PairView,
  render: { style: ReturnType<typeof styler>; glyph: ReturnType<typeof glyphs>; columns: number },
): Promise<number> {
  const { style, glyph } = render;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  for (const line of hintLine(interactive, render)) console.log(line);
  console.log("");

  const controller = new AbortController();
  const spinner = statusLine(waitingLabel(view, render), { frames: glyph.spinner, indent: 2 });

  const stopKeys = onKeypress(
    (pressed) => {
      const lower = pressed.toLowerCase();
      if (lower === "q") controller.abort();
      if (lower === "c") {
        void copyToClipboard(view.url).then((copied) => {
          spinner.update(
            copied
              ? `${style.hex(PALETTE.success, "link copied")} ${style.dim("— waiting for your phone")}`
              : `${style.dim("could not reach a clipboard — waiting for your phone")}`,
          );
        });
      }
    },
    { onAbort: () => controller.abort() },
  );

  const result = await waitForDevice({
    url: `ws://127.0.0.1:${view.port}/?token=${encodeURIComponent(view.token)}`,
    signal: controller.signal,
  });

  stopKeys();

  if (result) {
    spinner.stop(pairedLine(deviceLabel(result.deviceId), result.elapsedMs, render));
    console.log(
      `  ${style.dim(view.reach === "anywhere" ? `${glyph.dot} it will reconnect from any network while the daemon runs` : `${glyph.dot} it will reconnect whenever it is on this Wi-Fi`)}`,
    );
    console.log("");
    return 0;
  }

  spinner.stop();
  for (const line of timeoutLines(render)) console.log(line);
  console.log("");
  return 0;
}
