/**
 * When a finished turn is worth a notification, and what it should say.
 *
 * pew2's whole premise is that the agent keeps working while the phone is in a
 * pocket or on another conversation. A banner is therefore not decoration: it
 * is the only way to learn that a five-minute turn in another project has
 * landed. This module decides that, and nothing else — no Expo imports, so the
 * rule is testable under `bun test`, which cannot parse React Native's Flow
 * syntax. `ui/notifier.ts` binds the SDK. Same split as
 * `hapticsPolicy.ts`/`ui/haptics.ts`.
 */

/** What the app knows the moment a session goes idle. */
export interface FinishedTurn {
  sessionId: string;
  /** Last path segment of the agent's cwd, as the daemon stamped it. */
  folder?: string;
  /** Display name of the agent that ran the turn, e.g. "Claude Code". */
  agentName?: string;
  /** The agent's closing message, used as the banner body when there is one. */
  lastText?: string;
  /** The conversation currently on screen, if any. */
  activeSessionId?: string;
  /** False when the app is backgrounded or inactive. */
  foreground: boolean;
  /**
   * Whether the daemon has somewhere to push this turn.
   *
   * True once a push token has been handed over. False on a simulator, in a
   * fresh clone with no EAS project, or when notification permission was
   * refused — all of which leave the local banner as the only route.
   */
  pushExpected?: boolean;
}

export interface Notice {
  title: string;
  body: string;
  /** Carried through the notification so a tap can open this conversation. */
  sessionId: string;
}

// Imported, not restated. The daemon composes the same banner when it pushes a
// turn the app was asleep for, and it cannot import from the app package — so
// the wording lives in `@pew2/protocol`, which both sides can reach. A copy on
// each side would mean the same turn read differently depending on whether the
// app happened to still be awake, which is invisible until someone notices the
// wording changed for no reason.
//
// Metro resolves this: `metro.config.js` maps the package's `.js`-suffixed TS
// imports back, which is how `useDaemon.ts` imports the same package.
import { noticeBody, noticeTitle, summarise } from "@pew2/protocol";

// Re-exported because callers and tests reach for it here, alongside the rule
// that uses it.
export { summarise };

/**
 * The banner for a turn that just ended, or null when it is not worth showing.
 *
 * Two cases are left alone, for opposite reasons:
 *
 * - **Already looking at that conversation.** The reply is on screen and a
 *   banner over it is noise.
 * - **Backgrounded, with a push on its way.** Both routes would fire and the
 *   user would get the same turn twice. This is not hypothetical: on Android
 *   the socket outlives the app leaving the screen, so `session.idle` still
 *   arrives — and `setNotificationHandler`, which drops a redundant push, only
 *   runs while the app is in the foreground. Nothing on the device can dedupe
 *   the pair at that point, so the decision has to be made here, before the
 *   local banner is scheduled at all.
 *
 *   Deliberately yields to the push rather than the reverse: it is the only one
 *   of the two that also works once iOS has suspended this app, so preferring
 *   it keeps one code path warm instead of two that differ per platform. The
 *   cost is that a push lost to a network failure is not backfilled locally.
 *
 * Everything else — foreground on another session, or backgrounded with no push
 * token at all — gets the local banner, which is exactly what it is for.
 */
export function finishedNotice(turn: FinishedTurn): Notice | null {
  const watching = turn.foreground && turn.activeSessionId === turn.sessionId;
  if (watching) return null;
  if (!turn.foreground && turn.pushExpected) return null;

  return {
    // The project first: it is how people identify which of several running
    // agents this is, and the only word guaranteed to survive truncation in a
    // narrow banner.
    title: noticeTitle(turn),
    // Falls back to a statement rather than an empty body: a turn can finish
    // having only run tools, with no closing message at all.
    body: noticeBody(turn.lastText),
    sessionId: turn.sessionId,
  };
}

/** One notification that has arrived while the app is awake. */
export interface ArrivingNotification {
  /** True when this app scheduled it, false when it came from the push service. */
  local: boolean;
  sessionId?: string;
  /** The conversation on screen right now, if any. */
  openSessionId?: string;
  /** When a local banner was last raised for this session. */
  announcedAt?: number;
  now: number;
  windowMs: number;
}

/**
 * Whether an arriving notification should be swallowed.
 *
 * The daemon pushes on every finished turn without knowing what this phone is
 * doing — it cannot know, because a backgrounded iOS app holds a socket that
 * still looks connected after its JavaScript has stopped, and because the only
 * other source of that answer is the relay, which is assumed hostile. So the
 * push is sent optimistically and judged here, where the facts actually are.
 *
 * Two things make a push redundant:
 *
 * 1. The conversation is open on screen. The reply is already visible; a banner
 *    over it is noise. Same rule `finishedNotice` applies to the local route.
 * 2. This app already raised a banner for that turn moments ago. Both routes
 *    fire when the app is awake and backgrounded — common on Android, where the
 *    socket survives longer — and without this the user gets each turn twice.
 *
 * Local banners are never suppressed: `finishedNotice` has already ruled on
 * them, and applying a second rule here would only find new ways to be wrong.
 */
export function duplicatePush(arriving: ArrivingNotification): boolean {
  if (arriving.local) return false;
  if (!arriving.sessionId) return false;
  if (arriving.sessionId === arriving.openSessionId) return true;
  if (arriving.announcedAt === undefined) return false;
  return arriving.now - arriving.announcedAt < arriving.windowMs;
}
