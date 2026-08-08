import { describe, expect, it } from "bun:test";
import { PushRegistry, applyTickets, pushMessages } from "./push.js";

const TOKEN = "ExponentPushToken[abcdef123456]";

describe("PushRegistry", () => {
  it("keeps one address per device, so a rotated token replaces the old one", () => {
    // Otherwise every app restart adds another copy of every banner.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    registry.register("phone", "ExponentPushToken[rotated]", "ios");
    expect(registry.list()).toEqual([{ token: "ExponentPushToken[rotated]", platform: "ios" }]);
  });

  it("keeps two phones apart", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    registry.register("tablet", "ExponentPushToken[other]", "android");
    expect(registry.size).toBe(2);
  });

  it("refuses anything that is not an Expo push token", () => {
    // A rejected token is reported to the client; a silently stored one looks
    // exactly like a working one until a notification never arrives.
    const registry = new PushRegistry();
    expect(registry.register("phone", "not-a-token", "ios")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("names the Android channel, without which the banner is filed silently", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "android");
    expect(registry.list()[0]?.channelId).toBe("agent-turns");
  });
});

describe("pushMessages", () => {
  const registry = new PushRegistry();
  registry.register("phone", TOKEN, "ios");

  it("says which project and agent, and quotes the reply", () => {
    const [message] = pushMessages(registry, {
      sessionId: "s1",
      folder: "pew2",
      agentName: "Claude Code",
      lastText: "## Done\n\nRenamed the handler and fixed the test.",
    });
    expect(message?.title).toBe("pew2 · Claude Code");
    expect(message?.body).toBe("Done");
    // Read back by the app on tap, to open the conversation the banner is
    // about — the same payload the local banner carries.
    expect(message?.data).toEqual({ sessionId: "s1" });
    // The field that makes this instant on Android: normal priority lets FCM
    // hold a message back on a sleeping device, which is the phone-in-a-pocket
    // case the whole feature exists for.
    expect(message?.priority).toBe("high");
  });

  it("still says something for a turn that ended without a message", () => {
    const [message] = pushMessages(registry, { sessionId: "s1", folder: "pew2" });
    expect(message?.body).toBe("Finished and waiting on you.");
  });

  it("sends nothing when no phone has registered", () => {
    expect(pushMessages(new PushRegistry(), { sessionId: "s1" })).toEqual([]);
  });
});

describe("applyTickets", () => {
  it("forgets a token the push service says is gone", () => {
    // Uninstalled app or revoked permission. Continuing to send to it is what
    // gets a sender rate limited.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    const messages = pushMessages(registry, { sessionId: "s1" });
    applyTickets(registry, messages, [
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    ]);
    expect(registry.size).toBe(0);
  });

  it("keeps a token through a transient failure", () => {
    // A rate limit or an Expo outage says nothing about whether the phone is
    // still there; dropping it would silence that device for good.
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    const messages = pushMessages(registry, { sessionId: "s1" });
    applyTickets(registry, messages, [
      { status: "error", message: "too many", details: { error: "MessageRateExceeded" } },
    ]);
    expect(registry.size).toBe(1);
  });

  it("ignores a malformed reply rather than throwing on it", () => {
    const registry = new PushRegistry();
    registry.register("phone", TOKEN, "ios");
    applyTickets(registry, pushMessages(registry, { sessionId: "s1" }), "nonsense");
    expect(registry.size).toBe(1);
  });
});
