import { describe, expect, it } from "bun:test";
import { finishedNotice, summarise } from "./notificationPolicy";

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
