/**
 * The system notification binding.
 *
 * A finished turn reaches the phone by two routes, and this module is where they
 * are reconciled:
 *
 * - **Local**, scheduled here from a `session.idle` that arrived on the socket.
 *   Instant, private, and only possible while this app's JavaScript is running.
 * - **Remote**, pushed by the daemon (`daemon/src/push.ts`). The only route that
 *   works once iOS has suspended us, which it does within seconds of the app
 *   leaving the screen — the case the whole feature exists for, and the one the
 *   local route could never cover. Before it, a turn that finished while the
 *   phone was in a pocket announced itself on reopening, minutes late.
 *
 * The daemon pushes unconditionally, because it cannot know what this phone is
 * doing (see the note at the `session.idle` broadcast). So both routes can fire
 * for one turn, and deciding between them belongs here: this is the only place
 * that knows whether the app is on screen and which conversation is open.
 *
 * Expo-only. What a banner *says*, and whether a turn deserves one at all, lives
 * in `notificationPolicy.ts`, which stays importable by `bun test`.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { Notice } from "../notificationPolicy";
import { duplicatePush } from "../notificationPolicy";

/**
 * The conversation currently open, as far as an arriving push is concerned.
 *
 * Module state rather than a hook because `setNotificationHandler` is a global
 * registered once at import, long before any component exists, and it runs for
 * notifications that arrive at arbitrary moments.
 */
let onScreenSessionId: string | undefined;

/** Told by the screen, so an arriving push knows what the user can already see. */
export function setOpenConversation(sessionId: string | undefined): void {
  onScreenSessionId = sessionId;
}

/**
 * Turns this app has already raised a local banner for, and when.
 *
 * The window that follows is short because these two routes race by design: the
 * socket message and the push are sent by the same daemon at the same moment,
 * and differ only by the trip through Apple or Google.
 */
const announcedAt = new Map<string, number>();

/**
 * Long enough to cover a push crossing the internet, short enough that a genuine
 * second turn in the same conversation is never swallowed. Agents do not finish
 * twice in ten seconds.
 */
const DUPLICATE_WINDOW_MS = 10_000;

function rememberAnnounced(sessionId: string): void {
  const now = Date.now();
  announcedAt.set(sessionId, now);
  // Bounded without a timer: a map keyed by session would otherwise grow for
  // the life of the process, and this path runs on every finished turn.
  for (const [id, at] of announcedAt) {
    if (now - at > DUPLICATE_WINDOW_MS) announcedAt.delete(id);
  }
}

/**
 * Whether to show a notification that has arrived while the app is awake.
 *
 * Only ever consulted in the foreground: once iOS suspends this app the system
 * presents pushes without asking, which is the entire point of them.
 *
 * Locally scheduled banners are shown unconditionally, because `finishedNotice`
 * already decided they were worth showing — re-judging them here would apply the
 * same rule twice and get it wrong the second time.
 */
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as
      | { sessionId?: unknown; local?: unknown }
      | undefined;
    const suppressed = duplicatePush({
      local: data?.local === true,
      sessionId: typeof data?.sessionId === "string" ? data.sessionId : undefined,
      openSessionId: onScreenSessionId,
      announcedAt: typeof data?.sessionId === "string" ? announcedAt.get(data.sessionId) : undefined,
      now: Date.now(),
      windowMs: DUPLICATE_WINDOW_MS,
    });
    return {
      shouldShowBanner: !suppressed,
      shouldShowList: !suppressed,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

/** Android requires a channel before anything is delivered. */
const CHANNEL = "agent-turns";

/**
 * Groups the reply box onto the banner. No `:` or `-`: the SDK documents those
 * as breaking category matching.
 */
const CATEGORY = "agentTurn";

/** The reply action's id, echoed back on the response. */
export const REPLY_ACTION = "reply";

/** A granted permission, remembered so every turn is not a native round trip. */
let granted: Promise<boolean> | undefined;

/**
 * Register the inline reply box.
 *
 * Both platforms support a text-input action, and both surface it the same
 * way: long-press (or pull down) the banner and a field appears. Answering an
 * agent is usually one line — "yes, do that" — so making the round trip through
 * app launch, drawer, session, keyboard is most of the cost of the answer.
 *
 * `opensAppToForeground: false` keeps the user where they are; the reply is
 * sent over the existing socket instead.
 */
async function registerCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(CATEGORY, [
    {
      identifier: REPLY_ACTION,
      buttonTitle: "Reply",
      textInput: { submitButtonTitle: "Send", placeholder: "Reply to the agent…" },
      options: { opensAppToForeground: false },
    },
  ]);
}

async function request(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: "Agent activity",
      // The agent finishing is the thing the user is waiting on: it earns a
      // heads-up banner rather than a silent tray entry.
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  // Registered before the first banner, or it is delivered without the reply
  // box. Failing here must not cost the notification itself.
  await registerCategory().catch(() => {});
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  if (!existing.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Ask for permission, caching only a yes.
 *
 * A no is re-checked because the user can grant it in Settings later, and
 * remembering the refusal would keep the app silent until it was relaunched.
 * That costs a native read per finished turn and never a second prompt: iOS
 * clears `canAskAgain` after the first refusal.
 *
 * Failures resolve false rather than throwing: notifications are an addition to
 * the app, and a simulator or a locked-down device must not break the session
 * that triggered this.
 */
export function ensureNotificationPermission(): Promise<boolean> {
  if (granted) return granted;
  const attempt = request().catch(() => false);
  granted = attempt.then((ok) => {
    // Drop the cache on a no, so the next turn asks the system again.
    if (!ok) granted = undefined;
    return ok;
  });
  return granted;
}

/**
 * Present a banner now.
 *
 * `trigger: null` means immediately. Deliberately not awaited by callers, and
 * errors are swallowed for the same reason as haptics: a denied permission must
 * never interfere with rendering the turn that just arrived.
 */
export async function notify(notice: Notice): Promise<void> {
  try {
    if (!(await ensureNotificationPermission())) return;
    // Recorded before the await that presents it: the daemon's push for this
    // same turn is in flight right now, and marking this late would let it
    // through as a second banner.
    rememberAnnounced(notice.sessionId);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notice.title,
        body: notice.body,
        // Read back on tap to open the right conversation, and on a reply to
        // address the right agent. `local` marks who scheduled it, so the
        // handler above can tell this banner from the daemon's push for the
        // same turn and drop the loser rather than showing both.
        data: { sessionId: notice.sessionId, local: true },
        // What attaches the inline reply box.
        categoryIdentifier: CATEGORY,
        ...(Platform.OS === "android" ? { channelId: CHANNEL } : null),
      },
      trigger: null,
    });
  } catch {
    // Nothing to do about it, and nothing worth interrupting the user for.
  }
}

/** What the user did with a banner. */
export interface NotificationChoice {
  sessionId: string;
  /** Present when they replied inline rather than tapping through. */
  text?: string;
}

function choiceOf(
  response: Notifications.NotificationResponse | null,
): NotificationChoice | undefined {
  const sessionId = response?.notification.request.content.data?.sessionId;
  if (typeof sessionId !== "string") return undefined;
  const replied = response?.actionIdentifier === REPLY_ACTION;
  const text = replied ? response?.userText?.trim() : undefined;
  // An empty reply box submitted is not a prompt; treat it as a plain tap.
  return { sessionId, text: text ? text : undefined };
}

/**
 * Responses already acted on, so one interaction is never handled twice.
 *
 * The launch response is *also* delivered to a listener subscribed soon after,
 * and a remounting subscriber reads it again. Opening a session twice is
 * invisible, but a reply is a prompt: sending it twice would put the same
 * message to the agent two or three times.
 */
const handled = new Set<string>();

/**
 * Report what the user did with a banner: tapped it, or replied inline.
 *
 * Also fires for the interaction that launched the app from cold:
 * `getLastNotificationResponse` holds it, and without that the most common
 * path — phone locked, banner arrives, tap — would open the app on whatever was
 * last on screen instead of the conversation the banner was about.
 *
 * A reply sent while the app is not running arrives here at the next launch
 * for the same reason. That is the honest bound on a text action with no
 * server: the socket only exists while the app does.
 *
 * @returns an unsubscribe function.
 */
export function onNotificationChoice(act: (choice: NotificationChoice) => void): () => void {
  const once = (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    // Keyed by the interaction rather than the banner, so a tap and a reply on
    // one notification stay distinct. A banner is consumed when answered, so
    // there is no second identical response to lose.
    const key = `${response.notification.request.identifier}:${response.actionIdentifier}:${response.userText ?? ""}`;
    if (handled.has(key)) return;
    const choice = choiceOf(response);
    if (!choice) return;
    handled.add(key);
    act(choice);
  };

  once(Notifications.getLastNotificationResponse());
  const subscription = Notifications.addNotificationResponseReceivedListener(once);
  return () => subscription.remove();
}
