/**
 * Getting this phone a push address, so a finished turn can reach it while the
 * app is asleep.
 *
 * The local banner in `notifier.ts` can only fire while this app's JavaScript is
 * running, and iOS suspends that within seconds of the app leaving the screen.
 * Everything the daemon sent in the meantime queues on a dead socket and lands
 * at once on reopening — which is why a turn that finished twenty minutes ago
 * announced itself the moment you unlocked the phone, long after it was useful.
 *
 * A remote push does not need this app to be running at all. The daemon sends
 * it; this module is only the part that says where.
 *
 * Expo-only, and deliberately separate from the wire code: everything here can
 * fail for ordinary reasons — a simulator, a fresh clone with no EAS project, a
 * refused permission — and none of them may break a session.
 */
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { ensureNotificationPermission } from "./notifier";

/** What the daemon needs to reach this phone. */
export interface PushAddress {
  token: string;
  platform: "ios" | "android";
}

/**
 * The EAS project this build belongs to, which the push service requires.
 *
 * Absent on a fresh clone by design — see `app.config.js`, which keeps one
 * person's Expo account out of everyone's repository. That is the case this
 * whole module has to survive: no project id means no push token, which means
 * the app keeps the local-only banners it had before instead of failing.
 */
function projectId(): string | undefined {
  const id = Constants.expoConfig?.extra?.eas?.projectId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * This device's push address, or undefined if it cannot have one.
 *
 * Not cached. Tokens rotate — on reinstall, on restore to a new phone, and at
 * the push service's discretion — and a stale one is a notification delivered
 * to nobody, with nothing to indicate it happened. Asking again per connection
 * is a cheap native call against a failure that is invisible from this side.
 *
 * Resolves undefined rather than throwing, for every reason it can fail:
 *
 * - no EAS project id (a fresh clone, or Expo Go)
 * - notification permission refused
 * - a simulator, which cannot register with APNs at all
 */
export async function pushAddress(): Promise<PushAddress | undefined> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return undefined;
  const id = projectId();
  if (!id) return undefined;
  // Permission first, and load-bearing beyond permission: this is also what
  // creates the Android channel and the reply category. Expo does not show a
  // push at all if it names a channel the device has not created, so a token
  // handed over before this ran would earn silence rather than banners.
  if (!(await ensureNotificationPermission())) return undefined;
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    return data ? { token: data, platform: Platform.OS } : undefined;
  } catch {
    // Simulator, no network, or a build without push entitlements. The app
    // works; it just falls back to announcing turns it is awake for.
    return undefined;
  }
}
