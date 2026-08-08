/**
 * Remote push, sent by the machine that is still awake.
 *
 * The app can only raise a local banner while its JavaScript is running, and
 * iOS suspends that within seconds of the app being backgrounded — taking the
 * relay socket with it. So the notification that matters most, a long turn
 * finishing while the phone is in a pocket, arrived only when the app was next
 * opened. This closes that: the daemon never sleeps, so the daemon sends it.
 *
 * Two deliberate non-choices:
 *
 * - **The relay is not involved.** It would be the obvious place for a device
 *   registry, and it is the one component that must stay a dumb pipe holding no
 *   user state. The desktop has internet; it can call the push service itself.
 * - **Tokens are held in memory only.** A push token identifies a phone, and
 *   writing one to disk gives the daemon a persistent record of a device for no
 *   gain: the app re-registers on every connect, and a daemon that just started
 *   has nothing to announce yet anyway.
 *
 * The cost of the feature is honest and belongs here rather than buried: the
 * banner's title and body are rendered by iOS with no JavaScript involved, so
 * they cannot be encrypted end-to-end. Expo, Apple and Google see the project
 * name and the agent's opening line. Everything else in pew2 stays sealed; this
 * one string does not, and that is the price of an instant notification.
 */
import { noticeBody, noticeTitle, type NoticeOrigin } from "@pew2/protocol";

/** Expo's push endpoint. Needs no credentials of ours; EAS holds those. */
const PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Matches what `getExpoPushTokenAsync` returns, so junk never reaches Expo. */
const TOKEN_SHAPE = /^Expo(nent)?PushToken\[[^\]]+\]$/;

/** A phone that has asked to be told when its agents finish. */
interface Target {
  token: string;
  platform: "ios" | "android";
  /** Android needs the channel named on the message, not just on the device. */
  channelId?: string;
}

export interface FinishedTurnPush extends NoticeOrigin {
  sessionId: string;
  /** The agent's closing message, if it ended the turn by saying something. */
  lastText?: string;
}

/**
 * The Android channel the app creates in `ui/notifier.ts`.
 *
 * Restated rather than imported because the daemon cannot depend on the app
 * package. Worth the visible duplication: Expo documents that naming a channel
 * the device has not created means the notification is **not shown at all**, so
 * a drift here is silent and total rather than merely untidy.
 */
const ANDROID_CHANNEL = "agent-turns";

/** The notification category the app registers, which carries the reply box. */
const CATEGORY = "agentTurn";

/**
 * Every phone paired to this daemon, keyed by device.
 *
 * Keyed by `deviceId` rather than by token so that a phone whose token rotated
 * replaces its old entry instead of accumulating one per launch — otherwise a
 * week of app restarts means a week of duplicate banners.
 */
export class PushRegistry {
  private readonly targets = new Map<string, Target>();

  /**
   * Remember where to push for a device, or reject a token that is not one.
   *
   * @returns whether the token was accepted, so a caller can log the refusal.
   */
  register(deviceId: string, token: string, platform: "ios" | "android"): boolean {
    if (!TOKEN_SHAPE.test(token)) return false;
    this.targets.set(deviceId, {
      token,
      platform,
      ...(platform === "android" ? { channelId: ANDROID_CHANNEL } : null),
    });
    return true;
  }

  /**
   * Stop pushing to a token the push service has told us is dead.
   *
   * Expo reports `DeviceNotRegistered` when the app was uninstalled or the user
   * revoked permission. Continuing to send to it is what gets a sender rate
   * limited, so this is not merely tidy.
   */
  forget(token: string): void {
    for (const [deviceId, target] of this.targets) {
      if (target.token === token) this.targets.delete(deviceId);
    }
  }

  list(): Target[] {
    return [...this.targets.values()];
  }

  get size(): number {
    return this.targets.size;
  }
}

/** One message in Expo's push API shape. */
interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { sessionId: string };
  sound: "default";
  categoryId: string;
  channelId?: string;
  /**
   * High, which is what makes this instant on Android.
   *
   * Normal priority lets FCM hold a message back on a sleeping device to save
   * battery — precisely the phone-in-a-pocket case this whole feature exists
   * for, and it would reproduce the original complaint (the banner arriving
   * long after the turn ended) through a different mechanism. On iOS high is
   * already the default.
   */
  priority: "high";
}

/** Expo's per-message result. Errors are reported here, not as an HTTP status. */
interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export function pushMessages(registry: PushRegistry, turn: FinishedTurnPush): ExpoMessage[] {
  const title = noticeTitle(turn);
  const body = noticeBody(turn.lastText);
  return registry.list().map((target) => ({
    to: target.token,
    title,
    body,
    // Read back on tap to open the right conversation, and on an inline reply
    // to address the right agent. Matches the local banner's payload exactly,
    // so the app's existing handling works unchanged for both.
    data: { sessionId: turn.sessionId },
    sound: "default",
    categoryId: CATEGORY,
    ...(target.channelId ? { channelId: target.channelId } : null),
    priority: "high",
  }));
}

/**
 * Interpret Expo's reply and drop tokens it has declared dead.
 *
 * Exported for tests: the failure that matters is a token that keeps being sent
 * to forever, and that is invisible without asserting on this.
 */
export function applyTickets(
  registry: PushRegistry,
  messages: ExpoMessage[],
  tickets: unknown,
): void {
  if (!Array.isArray(tickets)) return;
  tickets.forEach((ticket: ExpoTicket, index) => {
    if (ticket?.status !== "error") return;
    if (ticket.details?.error !== "DeviceNotRegistered") return;
    const message = messages[index];
    if (message) registry.forget(message.to);
  });
}

/**
 * Announce a finished turn to every paired phone.
 *
 * Never throws and never blocks the turn: a notification is an addition to the
 * session, and a push service outage must not surface as a failed prompt. The
 * caller deliberately does not await it.
 *
 * No retry. Expo's guidance is exponential backoff on 429/5xx, but this
 * particular message is worthless once it is late — the whole point is
 * immediacy, and a banner arriving after the user has already picked up the
 * phone and read the reply is noise. A dropped push degrades to what the app did
 * before: the banner appears when the socket reconnects.
 */
export async function pushFinishedTurn(
  registry: PushRegistry,
  turn: FinishedTurnPush,
): Promise<void> {
  if (registry.size === 0) return;
  const messages = pushMessages(registry, turn);
  try {
    const response = await fetch(PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(messages),
      // A push that has not been accepted in ten seconds has already lost the
      // race with the user reaching for their phone.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { data?: unknown };
    applyTickets(registry, messages, payload?.data);
  } catch {
    // Offline desktop, DNS failure, Expo outage. Nothing here is worth
    // interrupting the session that just finished successfully.
  }
}
