/**
 * The system notification binding.
 *
 * Local notifications only — scheduled by this app, from a socket message it
 * received itself. That is deliberate for now: it needs no push credentials, no
 * device registry in the relay, and works in Expo Go, where remote push does
 * not. The limit is honest and worth knowing: JavaScript is suspended some
 * seconds after the app leaves the screen, and the socket dies with it, so a
 * turn that lands long after the phone was locked cannot be announced this way.
 * Covering that needs the relay to send a real push while no app socket is
 * attached — a strictly larger change on top of this same event.
 *
 * Expo-only. The decision of whether and what to announce lives in
 * `notificationPolicy.ts`, which stays importable by `bun test`.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import type { Notice } from "../notificationPolicy";

/**
 * Show the banner even while the app is in the foreground.
 *
 * A finished turn is only ever announced for a conversation the user is *not*
 * looking at (see `finishedNotice`), so suppressing it in the foreground would
 * silence exactly the case this exists for: switching to another project while
 * the first one works.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
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
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notice.title,
        body: notice.body,
        // Read back on tap to open the right conversation, and on a reply to
        // address the right agent.
        data: { sessionId: notice.sessionId },
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
