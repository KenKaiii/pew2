import { describe, expect, it, test } from "bun:test";
import { duplicatePush, finishedNotice, summarise } from "./notificationPolicy";

const base = {
  sessionId: "s1",
  folder: "pew2",
  agentName: "Claude Code",
  foreground: true,
};

describe("finishedNotice", () => {
  it("stays quiet for the conversation already on screen", () => {
    expect(finishedNotice({ ...base, activeSessionId: "s1" })).toBeNull();
  });

  it("announces a session finishing while another is open", () => {
    const notice = finishedNotice({ ...base, activeSessionId: "other" });
    expect(notice?.title).toBe("pew2 · Claude Code");
    expect(notice?.sessionId).toBe("s1");
  });

  it("announces the open session when the app is backgrounded", () => {
    // The whole point: the phone is in a pocket and the turn just landed.
    const notice = finishedNotice({ ...base, activeSessionId: "s1", foreground: false });
    expect(notice).not.toBeNull();
  });

  it("names the project even when the agent is unknown", () => {
    const notice = finishedNotice({ ...base, agentName: undefined, foreground: false });
    expect(notice?.title).toBe("pew2");
  });

  it("falls back to a body when the turn produced no message", () => {
    const notice = finishedNotice({ ...base, foreground: false });
    expect(notice?.body).toBe("Finished and waiting on you.");
  });

  it("uses the agent's closing message as the body", () => {
    const notice = finishedNotice({ ...base, foreground: false, lastText: "Tests pass." });
    expect(notice?.body).toBe("Tests pass.");
  });

  it("leaves a backgrounded turn to the push that is already coming", () => {
    // Otherwise the same turn is announced twice on Android, where the socket
    // outlives the app leaving the screen so `session.idle` still arrives — and
    // the handler that drops a redundant push only runs in the foreground, so
    // nothing downstream can catch the pair.
    expect(finishedNotice({ ...base, foreground: false, pushExpected: true })).toBeNull();
  });

  it("still announces a backgrounded turn when there is no push to wait for", () => {
    // A simulator, a fresh clone with no EAS project, or a refused permission.
    // Losing the banner here would regress the old local-only behaviour.
    expect(finishedNotice({ ...base, foreground: false, pushExpected: false })).not.toBeNull();
  });

  it("still announces another session while the user is looking at this one", () => {
    // Foreground, so an arriving push is dropped by `duplicatePush` instead.
    // The local banner is the faster of the two and should not be given up.
    const notice = finishedNotice({ ...base, activeSessionId: "other", pushExpected: true });
    expect(notice).not.toBeNull();
  });
});

describe("summarise", () => {
  it("skips markdown headings' markers", () => {
    expect(summarise("## Done\n\nrest")).toBe("Done");
  });

  it("skips fenced code and finds the sentence after it", () => {
    expect(summarise("```ts\nconst a = 1;\n```\nAdded a constant.")).toBe(
      "Added a constant.",
    );
  });

  it("strips list markers and inline emphasis", () => {
    expect(summarise("- **fixed** the `bug`")).toBe("fixed the bug");
  });

  it("truncates a long line", () => {
    const body = summarise("x".repeat(400));
    expect(body).toHaveLength(140);
    expect(body?.endsWith("…")).toBe(true);
  });

  it("returns undefined for nothing usable", () => {
    expect(summarise("   \n\n")).toBeUndefined();
    expect(summarise(undefined)).toBeUndefined();
  });
});

describe("duplicatePush", () => {
  const push = {
    local: false,
    sessionId: "s1",
    openSessionId: undefined as string | undefined,
    announcedAt: undefined as number | undefined,
    now: 1_000_000,
    windowMs: 10_000,
  };

  it("shows a push for a session that is not on screen", () => {
    expect(duplicatePush(push)).toBe(false);
  });

  it("drops a push for the conversation already open", () => {
    // The reply is on screen; a banner over it announces what you are reading.
    expect(duplicatePush({ ...push, openSessionId: "s1" })).toBe(true);
  });

  it("drops a push for a turn this app just announced itself", () => {
    // Both routes fire when the app is awake but backgrounded — common on
    // Android, where the socket outlives the app leaving the screen.
    expect(duplicatePush({ ...push, announcedAt: 995_000 })).toBe(true);
  });

  it("shows a push once the local banner is old enough to be a different turn", () => {
    expect(duplicatePush({ ...push, announcedAt: 980_000 })).toBe(false);
  });

  it("never second-guesses a banner this app scheduled", () => {
    // `finishedNotice` already ruled on it; judging it twice can only be wrong.
    expect(duplicatePush({ ...push, local: true, openSessionId: "s1" })).toBe(false);
  });

  it("shows a push it cannot attribute to a session", () => {
    // Better a banner that cannot be deduped than a silently dropped turn.
    expect(duplicatePush({ ...push, sessionId: undefined, openSessionId: "s1" })).toBe(false);
  });
});

test("a pushed turn and a locally announced one are worded identically", async () => {
  // The wording lives in `@pew2/protocol` so the daemon can compose the same
  // banner for a turn the app slept through. This pins the arrangement: if
  // `finishedNotice` ever grows its own copy of the formatting, the same turn
  // would read one way when the app is awake and another when it is asleep, and
  // nothing else would catch it.
  const protocol = await import("@pew2/protocol");

  const turn = {
    sessionId: "s1",
    folder: "pew2",
    agentName: "Claude Code",
    lastText: "## Done\n\nRenamed the handler.",
    foreground: false,
  };

  expect(finishedNotice(turn)?.title).toBe(protocol.noticeTitle(turn));
  expect(finishedNotice(turn)?.body).toBe(protocol.noticeBody(turn.lastText));

  // The bodies worth checking, not just the happy one: a heading stripped, a
  // turn that ended without saying anything, and the truncation ceiling.
  expect(finishedNotice(turn)?.body).toBe("Done");
  expect(finishedNotice({ ...turn, lastText: undefined })?.body).toBe(
    "Finished and waiting on you.",
  );
  expect(finishedNotice({ ...turn, lastText: "```\ncode only\n```" })?.body).toBe(
    "Finished and waiting on you.",
  );
  expect(finishedNotice({ ...turn, lastText: "x".repeat(400) })?.body.length).toBe(140);

  // Title fallbacks, which differ per missing field.
  expect(finishedNotice({ ...turn, agentName: undefined })?.title).toBe("pew2");
  expect(finishedNotice({ ...turn, folder: undefined })?.title).toBe("Claude Code");
  expect(finishedNotice({ ...turn, folder: undefined, agentName: undefined })?.title).toBe("pew2");
});
