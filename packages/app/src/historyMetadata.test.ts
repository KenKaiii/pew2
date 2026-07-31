import { expect, test } from "bun:test";
import { replaceAgentSessionStub } from "./agentHistory";
import { formatHistoryMetadata } from "./historyMetadata";
import type { Session } from "./useDaemon";

test("resumed history renders message count and retained working directory", () => {
  const stub: Session = {
    id: "agent:claude-code:disk-session",
    providerId: "claude-code",
    title: "Fix the build",
    startedAt: 1,
    turns: [],
    configOptions: [],
    agentSessionId: "disk-session",
    cwd: "/Users/kenkai/gg-projects/pew2",
  };
  const live: Session = {
    ...stub,
    id: "live-session",
    turns: [
      { id: "live-session:0", role: "user", text: "Fix it" },
      { id: "live-session:1", role: "agent", text: "Done" },
    ],
    cwd: undefined,
  };

  const [resumed] = replaceAgentSessionStub([stub], live);

  expect(resumed!.cwd).toBe("/Users/kenkai/gg-projects/pew2");
  expect(formatHistoryMetadata(resumed!)).toBe("2 messages · pew2");
});
